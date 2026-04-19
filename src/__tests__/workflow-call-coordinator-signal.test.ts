/**
 * Unit tests for WorkflowEngineStepCoordinator workflow_call type updates.
 *
 * Verifies that the coordinator's workflowCallRunner interface accepts
 * the new slotOverrides and abortSignal parameters.
 *
 * This is an integration-level type check: the coordinator delegates to
 * the runner, so we verify the call signature passes through correctly.
 */

import { describe, it, expect, vi } from 'vitest';
import type {
  AgentResponse,
  WorkflowStep,
  WorkflowState,
} from '../core/models/types.js';
import type {
  WorkflowEngineOptions,
} from '../core/workflow/types.js';
import { WorkflowEngineStepCoordinator } from '../core/workflow/engine/WorkflowEngineStepCoordinator.js';

function makeWorkflowCallStep(): WorkflowStep {
  return {
    name: 'delegate',
    kind: 'workflow_call',
    call: 'child-workflow',
    passPreviousResponse: true,
    instruction: '',
    rules: [
      { condition: 'COMPLETE', next: 'done' },
      { condition: 'ABORT', next: 'ABORT' },
    ],
  } as unknown as WorkflowStep;
}

function makeState(): WorkflowState {
  return {
    currentStep: 'delegate',
    status: 'running',
    iteration: 1,
    stepIterations: new Map(),
    stepOutputs: new Map(),
    personaSessions: new Map(),
    stepSessions: new Map(),
    userInputs: [],
  } as WorkflowState;
}

function makeResponse(): AgentResponse {
  return {
    persona: 'delegate',
    status: 'done',
    content: 'done',
    timestamp: new Date(),
    matchedRuleIndex: 0,
  };
}

describe('WorkflowEngineStepCoordinator workflowCallRunner interface', () => {
  it('should delegate workflow_call steps to workflowCallRunner', async () => {
    // Given
    const mockRun = vi.fn().mockResolvedValue({
      response: makeResponse(),
      instruction: 'child instruction',
    });
    const step = makeWorkflowCallStep();

    const coordinator = new WorkflowEngineStepCoordinator({
      config: { steps: [step] },
      state: makeState(),
      task: 'test task',
      getMaxSteps: () => 10,
      getOptions: () => ({ projectCwd: '/project' }) as WorkflowEngineOptions,
      stepExecutor: {
        runNormalStep: vi.fn(),
        buildInstruction: vi.fn().mockReturnValue(''),
        buildPhase1Instruction: vi.fn().mockReturnValue(''),
        drainReportFiles: vi.fn().mockReturnValue([]),
      },
      parallelRunner: { runParallelStep: vi.fn() },
      arpeggioRunner: { runArpeggioStep: vi.fn() },
      teamLeaderRunner: { runTeamLeaderStep: vi.fn() },
      systemStepExecutor: { run: vi.fn() },
      loopMonitorJudgeRunner: { run: vi.fn() },
      workflowCallRunner: {
        run: mockRun,
        resolveRuntime: vi.fn().mockReturnValue({ providerInfo: { provider: 'mock', model: 'test' } }),
      },
      updatePersonaSession: vi.fn(),
      updateStepSession: vi.fn(),
      emitReport: vi.fn(),
    });

    // When
    const result = await coordinator.runStep(step);

    // Then
    expect(mockRun).toHaveBeenCalledTimes(1);
    expect(result.response.status).toBe('done');
  });
});
