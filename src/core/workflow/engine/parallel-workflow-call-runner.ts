/**
 * Workflow-call sub-step execution for ParallelRunner.
 *
 * Handles workflow_call sub-steps within parallel execution:
 * empty slot skipping, child workflow invocation, and worktree merge/cleanup.
 */

import type { WorkflowStep, WorkflowCallStep, WorkflowState, AgentResponse } from '../../models/types.js';
import type { WorkflowCallSlotOverrides } from './slot-context.js';
import type { prepareSlotContext } from './slot-context.js';
import { buildAbortSignal } from './abort-signal.js';
import { mergeChildBranch } from './worktree-sync.js';
import { cleanupParallelWorktree } from './parallel-worktree.js';
import { DEFAULT_PARALLEL_TIMEOUT_MS } from '../../models/workflow-defaults.js';

export interface WorkflowCallRunnerDeps {
  readonly workflowCallRunner: {
    run: (
      step: WorkflowStep & { call: string },
      runtime?: undefined,
      slotOverrides?: WorkflowCallSlotOverrides,
      abortSignal?: AbortSignal,
    ) => Promise<{ response: AgentResponse; instruction: string }>;
  };
  readonly emitStepReports: (step: WorkflowStep) => void;
  readonly parentAbortSignal?: AbortSignal;
}

export async function runWorkflowCallSubStep(
  deps: WorkflowCallRunnerDeps,
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

  const timeoutMs = subStep.timeoutMs ?? parentStep.parallelConfig?.timeoutMs ?? DEFAULT_PARALLEL_TIMEOUT_MS;
  const { signal, dispose } = buildAbortSignal(timeoutMs, deps.parentAbortSignal);

  let callResult: { response: AgentResponse; instruction: string } | undefined;
  try {
    callResult = await deps.workflowCallRunner.run(
      subStep,
      undefined,
      slotOverrides,
      signal,
    );
    state.stepOutputs.set(subStep.name, callResult.response);
    deps.emitStepReports(subStep);
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
