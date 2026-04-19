/**
 * Executes parallel workflow steps concurrently and aggregates results.
 *
 * When onStream is provided, uses ParallelLogger to prefix each
 * sub-step output with `[name]` for readable interleaved display.
 */

import type {
  WorkflowStep,
  WorkflowCallStep,
  AgentWorkflowStep,
  WorkflowState,
  AgentResponse,
} from '../../models/types.js';
import { executeAgent } from '../../../agents/agent-usecases.js';
import { ParallelLogger } from './parallel-logger.js';
import { needsStatusJudgmentPhase, runReportPhase, runStatusJudgmentPhase } from '../phase-runner.js';
import { detectMatchedRule } from '../evaluation/index.js';
import type { StatusJudgmentPhaseResult } from '../phase-runner.js';
import { incrementStepIteration } from './state-manager.js';
import { createLogger, getErrorMessage, Semaphore } from '../../../shared/utils/index.js';
import { buildSessionKey } from '../session-key.js';
import { buildAbortSignal } from './abort-signal.js';
import { prepareSlotContext, type WorkflowCallSlotOverrides } from './slot-context.js';
import { mergeChildBranch } from './worktree-sync.js';
import { cleanupParallelWorktree } from './parallel-worktree.js';
import { DEFAULT_PARALLEL_TIMEOUT_MS } from '../../models/workflow-defaults.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import type { WorkflowEngineOptions, RuntimeStepResolution, PhaseName, PhasePromptParts, JudgeStageEntry } from '../types.js';
import type { ParallelLoggerOptions } from './parallel-logger.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type { RuleEvaluatorContext } from '../evaluation/RuleEvaluator.js';

const log = createLogger('parallel-runner');

export interface ParallelRunnerDeps {
  readonly optionsBuilder: OptionsBuilder;
  readonly stepExecutor: StepExecutor;
  readonly engineOptions: WorkflowEngineOptions;
  readonly getCwd: () => string;
  readonly getReportDir: () => string;
  readonly getInteractive: () => boolean;
  readonly detectRuleIndex: (content: string, stepName: string) => number;
  readonly structuredCaller: StructuredCaller;
  readonly workflowCallRunner?: {
    run: (
      step: WorkflowStep & { call: string },
      runtime?: RuntimeStepResolution,
      slotOverrides?: WorkflowCallSlotOverrides,
      abortSignal?: AbortSignal,
    ) => Promise<{ response: AgentResponse; instruction: string }>;
  };
  readonly getRunSlug?: () => string;
  readonly onPhaseStart?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    instruction: string,
    promptParts: PhasePromptParts,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  readonly onPhaseComplete?: (
    step: WorkflowStep,
    phase: 1 | 2 | 3,
    phaseName: PhaseName,
    content: string,
    status: string,
    error?: string,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
  readonly onJudgeStage?: (
    step: WorkflowStep,
    phase: 3,
    phaseName: 'judge',
    entry: JudgeStageEntry,
    phaseExecutionId?: string,
    iteration?: number,
  ) => void;
}

/** Context shared across sub-step executions within a single parallel step run */
interface ParallelRunContext {
  readonly step: WorkflowStep;
  readonly state: WorkflowState;
  readonly task: string;
  readonly maxSteps: number;
  readonly stepIteration: number;
  readonly parentRuleCtx: RuleEvaluatorContext;
  readonly parallelLogger: ParallelLogger | undefined;
  readonly updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
}

export class ParallelRunner {
  constructor(
    private readonly deps: ParallelRunnerDeps,
  ) {}

  /**
   * Run a parallel step: execute all sub-steps concurrently, then aggregate results.
   * The aggregated output becomes the parent step response for rules evaluation.
   */
  async runParallelStep(
    step: WorkflowStep,
    state: WorkflowState,
    task: string,
    maxSteps: number,
    updatePersonaSession: (persona: string, sessionId: string | undefined) => void,
  ): Promise<{ response: AgentResponse; instruction: string }> {
    if (!step.parallel) {
      throw new Error(`Step "${step.name}" has no parallel sub-steps`);
    }
    const subSteps = step.parallel;
    const stepIteration = incrementStepIteration(state, step.name);
    log.debug('Running parallel step', {
      step: step.name,
      subSteps: subSteps.map(s => s.name),
      stepIteration,
    });

    const parallelLogger = this.deps.engineOptions.onStream
      ? new ParallelLogger(buildParallelLoggerOptions(this.deps.engineOptions, step.name, stepIteration, subSteps.map((s) => s.name), state.iteration, maxSteps))
      : undefined;

    const parentPm = this.deps.optionsBuilder.resolveStepProviderModel(step);
    const ctx: ParallelRunContext = {
      step, state, task, maxSteps, stepIteration, parallelLogger, updatePersonaSession,
      parentRuleCtx: {
        state,
        cwd: this.deps.getCwd(),
        provider: parentPm.provider,
        resolvedProvider: parentPm.provider,
        resolvedModel: parentPm.model,
        interactive: this.deps.getInteractive(),
        detectRuleIndex: this.deps.detectRuleIndex,
        structuredCaller: this.deps.structuredCaller,
      },
    };

    const semaphore = step.concurrency != null
      ? new Semaphore(step.concurrency)
      : undefined;
    if (semaphore) {
      log.debug('Concurrency limit enabled', { step: step.name, concurrency: step.concurrency });
    }

    const cwd = this.deps.getCwd();
    const runSlug = this.deps.getRunSlug?.() ?? this.deps.engineOptions.reportDirName ?? '';
    const slotContext = prepareSlotContext(subSteps, state, runSlug, cwd);

    const settled = await Promise.allSettled(
      subSteps.map(async (subStep, index) => {
        if (semaphore) {
          await semaphore.acquire();
        }
        try {
          if (subStep.kind === 'workflow_call') {
            return await this.runWorkflowCallSubStep(subStep, step, state, slotContext, cwd);
          }
          return await this.runAgentSubStep(subStep, index, ctx);
        } finally {
          if (semaphore) {
            semaphore.release();
          }
        }
      }),
    );

    return this.aggregateResults(settled, subSteps, ctx);
  }

  private async runAgentSubStep(
    subStep: AgentWorkflowStep,
    index: number,
    ctx: ParallelRunContext,
  ): Promise<{ subStep: AgentWorkflowStep; response: AgentResponse; instruction: string }> {
    const timeoutMs = subStep.timeoutMs ?? ctx.step.parallelConfig?.timeoutMs ?? DEFAULT_PARALLEL_TIMEOUT_MS;
    const { signal, dispose } = buildAbortSignal(timeoutMs, this.deps.engineOptions.abortSignal);
    try {
      const subIteration = incrementStepIteration(ctx.state, subStep.name);
      const subInstruction = this.deps.stepExecutor.buildInstruction(subStep, subIteration, ctx.state, ctx.task, ctx.maxSteps);
      const parentIteration = ctx.state.iteration;
      const subPm = this.deps.optionsBuilder.resolveStepProviderModel(subStep);
      const subRuleCtx = {
        ...ctx.parentRuleCtx,
        provider: subPm.provider,
        resolvedProvider: subPm.provider,
        resolvedModel: subPm.model,
      };

      const subSessionKey = buildSessionKey(subStep);
      const baseOptions = this.deps.optionsBuilder.buildAgentOptions(subStep);
      let didEmitPhaseStart = false;

      const agentOptions = ctx.parallelLogger
        ? { ...baseOptions, onStream: ctx.parallelLogger.createStreamHandler(subStep.name, index) }
        : { ...baseOptions };
      agentOptions.abortSignal = signal;
      agentOptions.onPromptResolved = (promptParts: PhasePromptParts) => {
        this.deps.onPhaseStart?.(subStep, 1, 'execute', subInstruction, promptParts, undefined, parentIteration);
        didEmitPhaseStart = true;
      };
      const subResponse = await executeAgent(subStep.persona, subInstruction, agentOptions);
      if (!didEmitPhaseStart) {
        throw new Error(`Missing prompt parts for phase start: ${subStep.name}:1`);
      }
      ctx.updatePersonaSession(subSessionKey, subResponse.sessionId);
      this.deps.onPhaseComplete?.(subStep, 1, 'execute', subResponse.content, subResponse.status, subResponse.error, undefined, parentIteration);

      const phaseCtx = this.deps.optionsBuilder.buildPhaseRunnerContext(
        ctx.state, subResponse.content, ctx.updatePersonaSession,
        this.deps.onPhaseStart, this.deps.onPhaseComplete, this.deps.onJudgeStage, parentIteration,
      );

      if (subStep.outputContracts && subStep.outputContracts.length > 0) {
        await runReportPhase(subStep, subIteration, phaseCtx);
      }

      let subPhase3: StatusJudgmentPhaseResult | undefined;
      try {
        subPhase3 = needsStatusJudgmentPhase(subStep)
          ? await runStatusJudgmentPhase(subStep, phaseCtx)
          : undefined;
      } catch (error) {
        log.info('Phase 3 status judgment failed for sub-step, falling back to phase1 rule evaluation', {
          step: subStep.name,
          error: getErrorMessage(error),
        });
      }

      let finalResponse: AgentResponse;
      if (subPhase3) {
        finalResponse = { ...subResponse, matchedRuleIndex: subPhase3.ruleIndex, matchedRuleMethod: subPhase3.method };
      } else {
        const match = await detectMatchedRule(subStep, subResponse.content, '', subRuleCtx);
        finalResponse = match
          ? { ...subResponse, matchedRuleIndex: match.index, matchedRuleMethod: match.method }
          : subResponse;
      }

      ctx.state.stepOutputs.set(subStep.name, finalResponse);
      this.deps.stepExecutor.emitStepReports(subStep);

      return { subStep, response: finalResponse, instruction: subInstruction };
    } finally {
      dispose();
    }
  }

  private async runWorkflowCallSubStep(
    subStep: WorkflowCallStep,
    parentStep: WorkflowStep,
    state: WorkflowState,
    slotContext: ReturnType<typeof prepareSlotContext>,
    cwd: string,
  ): Promise<{ subStep: WorkflowStep; response: AgentResponse; instruction: string }> {
    const slotOverrides = slotContext?.overrides.get(subStep.name);
    const worktreeInfo = slotContext?.worktrees.get(subStep.name);

    if (slotContext && !slotOverrides) {
      const skipResponse: AgentResponse = {
        persona: subStep.name,
        status: 'done',
        content: '',
        timestamp: new Date(),
      };
      state.stepOutputs.set(subStep.name, skipResponse);
      return { subStep, response: skipResponse, instruction: '' };
    }

    if (!this.deps.workflowCallRunner) {
      throw new Error(`workflow_call sub-step "${subStep.name}" requires workflowCallRunner`);
    }

    const timeoutMs = subStep.timeoutMs ?? parentStep.parallelConfig?.timeoutMs ?? DEFAULT_PARALLEL_TIMEOUT_MS;
    const { signal, dispose } = buildAbortSignal(timeoutMs, this.deps.engineOptions.abortSignal);

    let callResult: { response: AgentResponse; instruction: string } | undefined;
    try {
      callResult = await this.deps.workflowCallRunner.run(
        subStep,
        undefined,
        slotOverrides,
        signal,
      );
      state.stepOutputs.set(subStep.name, callResult.response);
      this.deps.stepExecutor.emitStepReports(subStep);
      return { subStep, response: callResult.response, instruction: callResult.instruction };
    } finally {
      if (worktreeInfo) {
        try {
          if (callResult) {
            const matchedCondition = subStep.rules?.[callResult.response.matchedRuleIndex ?? -1]?.condition;
            const shouldMerge = matchedCondition !== 'ABORT';
            if (shouldMerge) {
              await mergeChildBranch(worktreeInfo.path, cwd, slotOverrides?.initialPreviousResponse?.content);
            }
          }
        } finally {
          await cleanupParallelWorktree(worktreeInfo.path, cwd);
        }
      }
      dispose();
    }
  }

  private async aggregateResults(
    settled: PromiseSettledResult<{ subStep: WorkflowStep | AgentWorkflowStep | WorkflowCallStep; response: AgentResponse; instruction: string }>[],
    subSteps: (AgentWorkflowStep | WorkflowCallStep)[],
    ctx: ParallelRunContext,
  ): Promise<{ response: AgentResponse; instruction: string }> {
    const subResults = settled.map((result, index) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      const failedStep = subSteps[index]!;
      const errorMsg = getErrorMessage(result.reason);
      log.error('Sub-step failed', { step: failedStep.name, error: errorMsg });
      const errorResponse: AgentResponse = {
        persona: failedStep.name,
        status: 'error',
        content: '',
        timestamp: new Date(),
        error: errorMsg,
      };
      ctx.state.stepOutputs.set(failedStep.name, errorResponse);
      return { subStep: failedStep, response: errorResponse, instruction: '' };
    });

    const allFailed = subResults.every(r => r.response.error != null);
    if (allFailed) {
      const errors = subResults.map(r => `${r.subStep.name}: ${r.response.error}`).join('; ');
      throw new Error(`All parallel sub-steps failed: ${errors}`);
    }

    if (ctx.parallelLogger) {
      ctx.parallelLogger.printSummary(
        ctx.step.name,
        subResults.map((r) => ({
          name: r.subStep.name,
          condition: r.response.matchedRuleIndex != null && r.subStep.rules
            ? r.subStep.rules[r.response.matchedRuleIndex]?.condition
            : undefined,
        })),
      );
    }

    const aggregatedContent = subResults
      .map((r) => `## ${r.subStep.name}\n${r.response.content}`)
      .join('\n\n---\n\n');

    const aggregatedInstruction = subResults
      .map((r) => r.instruction)
      .join('\n\n');

    const match = await detectMatchedRule(ctx.step, aggregatedContent, '', ctx.parentRuleCtx);

    const aggregatedResponse: AgentResponse = {
      persona: ctx.step.name,
      status: 'done',
      content: aggregatedContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

    ctx.state.stepOutputs.set(ctx.step.name, aggregatedResponse);
    ctx.state.lastOutput = aggregatedResponse;
    this.deps.stepExecutor.persistPreviousResponseSnapshot(
      ctx.state,
      ctx.step.name,
      ctx.stepIteration,
      aggregatedResponse.content,
    );
    this.deps.stepExecutor.emitStepReports(ctx.step);
    return { response: aggregatedResponse, instruction: aggregatedInstruction };
  }

}

function buildParallelLoggerOptions(
  engineOptions: WorkflowEngineOptions,
  stepName: string,
  stepIteration: number,
  subStepNames: string[],
  iteration: number,
  maxSteps: number,
): ParallelLoggerOptions {
  const options: ParallelLoggerOptions = {
    subStepNames,
    parentOnStream: engineOptions.onStream,
    progressInfo: { iteration, maxSteps },
  };

  if (engineOptions.taskPrefix != null && engineOptions.taskColorIndex != null) {
    return {
      ...options,
      taskLabel: engineOptions.taskPrefix,
      taskColorIndex: engineOptions.taskColorIndex,
      parentStepName: stepName,
      stepIteration,
    };
  }

  return options;
}
