/**
 * Type definitions for ParallelRunner dependencies and context.
 */

import type { WorkflowStep, WorkflowState, AgentResponse } from '../../models/types.js';
import type { OptionsBuilder } from './OptionsBuilder.js';
import type { StepExecutor } from './StepExecutor.js';
import type { WorkflowEngineOptions, RuntimeStepResolution, PhaseName, PhasePromptParts, JudgeStageEntry } from '../types.js';
import type { WorkflowCallSlotOverrides } from './slot-context.js';
import type { StructuredCaller } from '../../../agents/structured-caller.js';
import type { RuleEvaluatorContext } from '../evaluation/RuleEvaluator.js';
import type { ParallelLogger } from './parallel-logger.js';

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
export interface ParallelRunContext {
  readonly step: WorkflowStep;
  readonly state: WorkflowState;
  readonly task: string;
  readonly maxSteps: number;
  readonly stepIteration: number;
  readonly parentRuleCtx: RuleEvaluatorContext;
  readonly parallelLogger: ParallelLogger | undefined;
  readonly updatePersonaSession: (persona: string, sessionId: string | undefined) => void;
  readonly updateStepSession: (stepName: string, sessionId: string | undefined) => void;
}
