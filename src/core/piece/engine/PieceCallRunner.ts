/**
 * Executes piece_call movements by creating and running a child PieceEngine.
 *
 * Pre-resolves matchedRuleIndex from the child piece's terminal status
 * (completed → COMPLETE rule, aborted → ABORT rule) when possible.
 * Callers fall back to detectMatchedRule only when pre-resolution is
 * not available (e.g. rules lack COMPLETE/ABORT keywords).
 * Does not mutate parent state (except iteration budget).
 */

import type {
  PieceMovement,
  PieceState,
  PieceConfig,
  AgentResponse,
  RuleMatchMethod,
} from '../../models/types.js';
import type { PieceEngineOptions, PieceEvents } from '../types.js';
import { MAX_PIECE_CALL_DEPTH } from '../constants.js';
import { createLogger, generateReportDir } from '../../../shared/utils/index.js';

const log = createLogger('piece-call-runner');

export interface PieceCallSlotOverrides {
  readonly initialPreviousResponse?: AgentResponse;
  readonly reportDirName?: string;
  readonly cwd?: string;
}

export interface PieceCallRunnerDeps {
  readonly engineOptions: PieceEngineOptions;
  readonly getCwd: () => string;
  readonly getProjectCwd: () => string;
  readonly onMovementStart?: PieceEvents['movement:start'];
  readonly onMovementComplete?: PieceEvents['movement:complete'];
}

export class PieceCallRunner {
  constructor(
    private readonly deps: PieceCallRunnerDeps,
  ) {}

  /**
   * Execute a piece_call movement and return a raw response.
   * Does NOT perform rule evaluation or parent state mutation (except iteration budget).
   */
  async runPieceCallMovement(
    step: PieceMovement,
    state: PieceState,
    task: string,
    parentMaxMovements: number,
    slotOverrides?: PieceCallSlotOverrides,
  ): Promise<{ response: AgentResponse; instruction: string }> {
    const callTarget = step.call;
    if (!callTarget) {
      throw new Error(`piece_call movement "${step.name}" is missing 'call' field`);
    }

    const nestingDepth = this.deps.engineOptions.nestingDepth ?? 0;
    const callStack = this.deps.engineOptions.callStack ?? [];

    if (nestingDepth >= MAX_PIECE_CALL_DEPTH) {
      throw new Error(`Maximum piece_call nesting depth (${MAX_PIECE_CALL_DEPTH}) exceeded`);
    }

    if (callStack.includes(callTarget)) {
      const chain = [...callStack, callTarget].join(' → ');
      throw new Error(`Circular piece_call detected: ${chain}`);
    }

    const loadPiece = this.deps.engineOptions.loadPieceByIdentifier;
    if (!loadPiece) {
      log.info('loadPieceByIdentifier not provided, aborting piece_call', { movement: step.name, call: callTarget });
      return this.buildResponse(step, `piece_call failed: loadPieceByIdentifier not available for "${callTarget}"`);
    }

    const projectCwd = this.deps.getProjectCwd();
    const childConfig = loadPiece(callTarget, projectCwd);
    if (!childConfig) {
      log.info('Child piece not found, aborting piece_call', { movement: step.name, call: callTarget });
      return this.buildResponse(step, `piece_call failed: child piece "${callTarget}" not found`);
    }

    if (childConfig.subpiece?.callable === false) {
      log.info('Child piece is not callable', { movement: step.name, call: callTarget });
      return this.buildResponse(step, `piece_call failed: child piece "${callTarget}" has callable: false`);
    }

    const remainingBudget = parentMaxMovements - state.iteration;
    const effectiveChildConfig: PieceConfig = {
      ...childConfig,
      maxMovements: Math.max(remainingBudget, 1),
    };

    const childCwd = slotOverrides?.cwd ?? this.deps.getCwd();
    const childReportDirName = slotOverrides?.reportDirName ?? generateReportDir(task);

    const childOptions: PieceEngineOptions = {
      ...this.deps.engineOptions,
      callStack: [...callStack, state.pieceName],
      nestingDepth: nestingDepth + 1,
      initialPreviousResponse: slotOverrides?.initialPreviousResponse ?? state.lastOutput,
      reportDirName: childReportDirName,
      ...(step.overrides?.provider != null && { provider: step.overrides.provider }),
      ...(step.overrides?.model != null && { model: step.overrides.model }),
      ...(step.overrides?.providerOptions != null && { providerOptions: step.overrides.providerOptions }),
      startMovement: undefined,
      retryNote: undefined,
      initialIteration: undefined,
      taskPrefix: undefined,
      taskColorIndex: undefined,
    };

    // Dynamically import to avoid circular dependency (PieceEngine → PieceCallRunner → PieceEngine)
    const { PieceEngine } = await import('./PieceEngine.js');

    log.info('Starting piece_call child engine', {
      movement: step.name,
      call: callTarget,
      childPiece: effectiveChildConfig.name,
      nestingDepth: nestingDepth + 1,
      remainingBudget,
    });

    const childEngine = new PieceEngine(effectiveChildConfig, childCwd, task, childOptions);

    this.deps.engineOptions.setupChildSessionLogging?.(
      childEngine,
      childCwd,
      task,
      childReportDirName,
      effectiveChildConfig.name,
    );

    if (this.deps.onMovementStart) {
      childEngine.on('movement:start', this.deps.onMovementStart);
    }
    if (this.deps.onMovementComplete) {
      childEngine.on('movement:complete', this.deps.onMovementComplete);
    }

    try {
      const childState = await childEngine.run();

      state.iteration += childState.iteration;

      log.info('piece_call child engine completed', {
        movement: step.name,
        childPiece: effectiveChildConfig.name,
        childStatus: childState.status,
        childIterations: childState.iteration,
      });

      const matchedRule = this.resolveMatchedRuleIndex(step, childState.status);
      return this.buildResponse(step, childState.lastOutput?.content ?? '', matchedRule);
    } finally {
      childEngine.removeAllListeners();
    }
  }

  /**
   * Resolve the matched rule index from the child piece's terminal status.
   *
   * Scans `step.rules` for a condition containing 'COMPLETE' or 'ABORT'
   * (case-insensitive) based on the child's status. Returns undefined when
   * no matching rule is found, allowing the caller to fall back to
   * content-based detectMatchedRule.
   */
  private resolveMatchedRuleIndex(
    step: PieceMovement,
    childStatus: PieceState['status'],
  ): { index: number; method: RuleMatchMethod } | undefined {
    if (!step.rules) return undefined;
    if (childStatus !== 'completed' && childStatus !== 'aborted') return undefined;

    const targetCondition = childStatus === 'completed' ? 'COMPLETE' : 'ABORT';

    for (let i = 0; i < step.rules.length; i++) {
      const rule = step.rules[i];
      if (!rule) continue;
      if (rule.condition.toUpperCase().includes(targetCondition)) {
        return { index: i, method: 'auto_select' };
      }
    }

    return undefined;
  }

  private buildResponse(
    step: PieceMovement,
    content: string,
    matchedRule?: { index: number; method: RuleMatchMethod },
  ): { response: AgentResponse; instruction: string } {
    return {
      response: {
        persona: step.name,
        status: 'done',
        content,
        timestamp: new Date(),
        ...(matchedRule && { matchedRuleIndex: matchedRule.index, matchedRuleMethod: matchedRule.method }),
      },
      instruction: '',
    };
  }
}
