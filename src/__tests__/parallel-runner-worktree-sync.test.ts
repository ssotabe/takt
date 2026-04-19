/**
 * Unit tests for ParallelRunner worktree-sync integration.
 *
 * Tests merge-after-execution flow:
 * - shouldMerge judgment based on matched condition (not ABORT)
 * - mergeChildBranch called with worktree path, parent cwd, and slot instruction
 * - cleanupParallelWorktree called after merge (runs copy)
 * - merge skipped when matchedCondition === 'ABORT'
 * - slot instruction passed through to mergeChildBranch
 *
 * Mocked: worktree-sync, parallel-worktree, slot-context, executeAgent, etc.
 * Not mocked: ParallelRunner merge orchestration logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Hoisted mocks ---

const {
  mockMergeChildBranch,
  mockCleanupParallelWorktree,
  mockPrepareSlotContext,
  mockExecuteAgent,
  mockBuildAbortSignal,
  mockDetectMatchedRule,
  mockNeedsStatusJudgmentPhase,
  mockRunReportPhase,
  mockRunStatusJudgmentPhase,
  mockIncrementStepIteration,
  mockBuildSessionKey,
} = vi.hoisted(() => ({
  mockMergeChildBranch: vi.fn(),
  mockCleanupParallelWorktree: vi.fn(),
  mockPrepareSlotContext: vi.fn(),
  mockExecuteAgent: vi.fn(),
  mockBuildAbortSignal: vi.fn(),
  mockDetectMatchedRule: vi.fn(),
  mockNeedsStatusJudgmentPhase: vi.fn(),
  mockRunReportPhase: vi.fn(),
  mockRunStatusJudgmentPhase: vi.fn(),
  mockIncrementStepIteration: vi.fn(),
  mockBuildSessionKey: vi.fn(),
}));

vi.mock('../core/workflow/engine/worktree-sync.js', () => ({
  mergeChildBranch: mockMergeChildBranch,
}));

vi.mock('../core/workflow/engine/parallel-worktree.js', () => ({
  cleanupParallelWorktree: mockCleanupParallelWorktree,
  createParallelWorktree: vi.fn(),
}));

vi.mock('../core/workflow/engine/slot-context.js', () => ({
  prepareSlotContext: mockPrepareSlotContext,
}));

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: mockExecuteAgent,
}));

vi.mock('../core/workflow/engine/abort-signal.js', () => ({
  buildAbortSignal: mockBuildAbortSignal,
}));

vi.mock('../core/workflow/evaluation/index.js', () => ({
  detectMatchedRule: mockDetectMatchedRule,
}));

vi.mock('../core/workflow/phase-runner.js', () => ({
  needsStatusJudgmentPhase: mockNeedsStatusJudgmentPhase,
  runReportPhase: mockRunReportPhase,
  runStatusJudgmentPhase: mockRunStatusJudgmentPhase,
}));

vi.mock('../core/workflow/engine/state-manager.js', () => ({
  incrementStepIteration: mockIncrementStepIteration,
}));

vi.mock('../core/workflow/session-key.js', () => ({
  buildSessionKey: mockBuildSessionKey,
}));

vi.mock('../shared/utils/index.js', async () => {
  const actual = await vi.importActual<typeof import('../shared/utils/index.js')>('../shared/utils/index.js');
  return {
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
    getErrorMessage: (e: unknown) => String(e),
    Semaphore: actual.Semaphore,
  };
});

// --- Imports (after mocks) ---

import { ParallelRunner, type ParallelRunnerDeps } from '../core/workflow/engine/ParallelRunner.js';
import type { WorkflowStep, WorkflowState, AgentResponse } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';
import type { WorkflowCallSlotOverrides, SlotContext } from '../core/workflow/engine/slot-context.js';

function makeWorkflowCallSubStep(name: string): WorkflowStep {
  return {
    name,
    kind: 'workflow_call',
    call: 'child-workflow',
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: true,
    rules: [
      { condition: 'COMPLETE', next: 'COMPLETE' },
      { condition: 'ABORT', next: 'ABORT' },
    ],
  } as unknown as WorkflowStep;
}

function makeAgentSubStep(name: string): WorkflowStep {
  return {
    name,
    persona: name,
    personaDisplayName: name,
    instruction: `Do ${name}`,
    passPreviousResponse: true,
    rules: [
      { condition: 'approved', next: 'COMPLETE' },
    ],
  } as WorkflowStep;
}

function makeParallelStep(subSteps: WorkflowStep[], overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'parallel-step',
    persona: 'parallel',
    personaDisplayName: 'parallel',
    instruction: '',
    passPreviousResponse: true,
    parallel: subSteps,
    rules: [
      { condition: 'all("COMPLETE")', next: 'COMPLETE', isAggregateCondition: true, aggregateType: 'all', aggregateConditionText: 'COMPLETE' },
    ],
    ...overrides,
  } as unknown as WorkflowStep;
}

function makeState(): WorkflowState {
  return {
    currentStep: 'parallel-step',
    status: 'running',
    iteration: 1,
    stepIterations: new Map(),
    stepOutputs: new Map(),
    personaSessions: new Map(),
    userInputs: [],
    lastOutput: {
      persona: 'decomposer',
      status: 'done',
      content: '## slot_1\nImplement feature\n## slot_2\nWrite tests',
      timestamp: new Date(),
    },
  } as WorkflowState;
}

function createDeps(overrides: Partial<ParallelRunnerDeps> = {}): ParallelRunnerDeps {
  return {
    optionsBuilder: {
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'mock', model: 'test' }),
      buildAgentOptions: vi.fn().mockReturnValue({
        cwd: '/project',
        resolvedProvider: 'mock',
        resolvedModel: 'test',
      }),
      buildPhaseRunnerContext: vi.fn().mockReturnValue({}),
    } as unknown as ParallelRunnerDeps['optionsBuilder'],
    stepExecutor: {
      buildInstruction: vi.fn().mockReturnValue('test instruction'),
      emitStepReports: vi.fn(),
      persistPreviousResponseSnapshot: vi.fn(),
    } as unknown as ParallelRunnerDeps['stepExecutor'],
    engineOptions: {
      projectCwd: '/project',
    } as WorkflowEngineOptions,
    getCwd: () => '/project',
    getReportDir: () => '/project/.takt/runs/test/reports',
    getInteractive: () => false,
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    structuredCaller: {} as ParallelRunnerDeps['structuredCaller'],
    ...overrides,
  };
}

function applyDefaultMocks(): void {
  mockIncrementStepIteration.mockReturnValue(1);
  mockBuildSessionKey.mockImplementation((step: WorkflowStep) => `${step.persona ?? step.name}:mock`);
  mockNeedsStatusJudgmentPhase.mockReturnValue(false);
  mockRunReportPhase.mockResolvedValue(undefined);
  mockDetectMatchedRule.mockResolvedValue({ index: 0, method: 'phase1_tag' });
  mockBuildAbortSignal.mockReturnValue({
    signal: new AbortController().signal,
    dispose: vi.fn(),
  });
  mockMergeChildBranch.mockResolvedValue(undefined);
  mockCleanupParallelWorktree.mockResolvedValue(undefined);
}

describe('ParallelRunner worktree-sync integration', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
  });

  it('should call mergeChildBranch for workflow_call slot when condition is not ABORT', async () => {
    // Given
    const slot1 = makeWorkflowCallSubStep('slot_1');
    const step = makeParallelStep([slot1]);
    const state = makeState();
    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: { persona: 'slot_1', status: 'done', content: 'Implement feature', timestamp: new Date() },
      cwd: '/worktree/slot-1',
      reportDirName: 'test-run-slot-1',
    };
    const slotContext: SlotContext = {
      overrides: new Map([['slot_1', slotOverrides]]),
      worktrees: new Map([['slot_1', { path: '/worktree/slot-1', branch: 'slot-1-branch' }]]),
    };
    mockPrepareSlotContext.mockReturnValue(slotContext);

    const mockWorkflowCallRunner = {
      run: vi.fn().mockResolvedValue({
        response: {
          persona: 'slot_1',
          status: 'done',
          content: 'slot work done',
          timestamp: new Date(),
          matchedRuleIndex: 0,
        },
        instruction: 'test instruction',
      }),
    };

    const deps = createDeps({ workflowCallRunner: mockWorkflowCallRunner });
    const runner = new ParallelRunner(deps);

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockMergeChildBranch).toHaveBeenCalledWith(
      '/worktree/slot-1',
      '/project',
      'Implement feature',
    );
    expect(mockCleanupParallelWorktree).toHaveBeenCalledWith(
      '/worktree/slot-1',
      '/project',
    );
  });

  it('should skip merge when matchedCondition is ABORT', async () => {
    // Given
    const slot1 = makeWorkflowCallSubStep('slot_1');
    const step = makeParallelStep([slot1], {
      rules: [
        { condition: 'all("COMPLETE")', next: 'COMPLETE', isAggregateCondition: true, aggregateType: 'all', aggregateConditionText: 'COMPLETE' },
        { condition: 'any("ABORT")', next: 'ABORT', isAggregateCondition: true, aggregateType: 'any', aggregateConditionText: 'ABORT' },
      ],
    });
    const state = makeState();
    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: { persona: 'slot_1', status: 'done', content: 'Implement feature', timestamp: new Date() },
      cwd: '/worktree/slot-1',
    };
    const slotContext: SlotContext = {
      overrides: new Map([['slot_1', slotOverrides]]),
      worktrees: new Map([['slot_1', { path: '/worktree/slot-1', branch: 'slot-1-branch' }]]),
    };
    mockPrepareSlotContext.mockReturnValue(slotContext);

    // Sub-step matched ABORT condition (index 1)
    mockDetectMatchedRule.mockResolvedValue({ index: 1, method: 'phase1_tag' });

    const mockWorkflowCallRunner = {
      run: vi.fn().mockResolvedValue({
        response: {
          persona: 'slot_1',
          status: 'done',
          content: 'slot aborted',
          timestamp: new Date(),
          matchedRuleIndex: 1,
        },
        instruction: 'test instruction',
      }),
    };

    const deps = createDeps({ workflowCallRunner: mockWorkflowCallRunner });
    const runner = new ParallelRunner(deps);

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then: merge should NOT be called, but cleanup still runs
    expect(mockMergeChildBranch).not.toHaveBeenCalled();
    expect(mockCleanupParallelWorktree).toHaveBeenCalledWith(
      '/worktree/slot-1',
      '/project',
    );
  });

  it('should call cleanupParallelWorktree even when merge fails', async () => {
    // Given
    const slot1 = makeWorkflowCallSubStep('slot_1');
    const step = makeParallelStep([slot1]);
    const state = makeState();
    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: { persona: 'slot_1', status: 'done', content: 'Implement', timestamp: new Date() },
      cwd: '/worktree/slot-1',
    };
    const slotContext: SlotContext = {
      overrides: new Map([['slot_1', slotOverrides]]),
      worktrees: new Map([['slot_1', { path: '/worktree/slot-1', branch: 'slot-1-branch' }]]),
    };
    mockPrepareSlotContext.mockReturnValue(slotContext);
    mockMergeChildBranch.mockRejectedValue(new Error('merge conflict'));

    const mockWorkflowCallRunner = {
      run: vi.fn().mockResolvedValue({
        response: {
          persona: 'slot_1',
          status: 'done',
          content: 'work done',
          timestamp: new Date(),
          matchedRuleIndex: 0,
        },
        instruction: 'instruction',
      }),
    };

    const deps = createDeps({ workflowCallRunner: mockWorkflowCallRunner });
    const runner = new ParallelRunner(deps);

    // When / Then: should still cleanup even if merge fails
    // The exact error handling depends on implementation but cleanup must run
    try {
      await runner.runParallelStep(step, state, 'test task', 10, vi.fn());
    } catch {
      // merge failure may or may not propagate
    }

    expect(mockCleanupParallelWorktree).toHaveBeenCalledWith(
      '/worktree/slot-1',
      '/project',
    );
  });

  it('should pass slotInstruction to mergeChildBranch', async () => {
    // Given
    const slot1 = makeWorkflowCallSubStep('slot_1');
    const step = makeParallelStep([slot1]);
    const state = makeState();
    const slotInstruction = 'Implement the authentication module';
    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: {
        persona: 'slot_1',
        status: 'done',
        content: slotInstruction,
        timestamp: new Date(),
      },
      cwd: '/worktree/slot-1',
    };
    const slotContext: SlotContext = {
      overrides: new Map([['slot_1', slotOverrides]]),
      worktrees: new Map([['slot_1', { path: '/worktree/slot-1', branch: 'slot-1-branch' }]]),
    };
    mockPrepareSlotContext.mockReturnValue(slotContext);

    const mockWorkflowCallRunner = {
      run: vi.fn().mockResolvedValue({
        response: {
          persona: 'slot_1',
          status: 'done',
          content: 'done',
          timestamp: new Date(),
          matchedRuleIndex: 0,
        },
        instruction: slotInstruction,
      }),
    };

    const deps = createDeps({ workflowCallRunner: mockWorkflowCallRunner });
    const runner = new ParallelRunner(deps);

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockMergeChildBranch).toHaveBeenCalledWith(
      '/worktree/slot-1',
      '/project',
      slotInstruction,
    );
  });

  it('should not call worktree-sync for normal agent sub-steps', async () => {
    // Given
    const agentStep = makeAgentSubStep('reviewer');
    const step = makeParallelStep([agentStep]);
    const state = makeState();
    mockPrepareSlotContext.mockReturnValue(undefined);

    mockExecuteAgent.mockImplementation(async (_persona: string, _instruction: string, options: { onPromptResolved?: (parts: unknown) => void }) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
      return {
        persona: 'reviewer',
        status: 'done',
        content: 'approved',
        timestamp: new Date(),
        sessionId: 'session-1',
      };
    });

    const deps = createDeps();
    const runner = new ParallelRunner(deps);

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockMergeChildBranch).not.toHaveBeenCalled();
    expect(mockCleanupParallelWorktree).not.toHaveBeenCalled();
  });

  it('should handle multiple workflow_call slots independently', async () => {
    // Given
    const slot1 = makeWorkflowCallSubStep('slot_1');
    const slot2 = makeWorkflowCallSubStep('slot_2');
    const step = makeParallelStep([slot1, slot2]);
    const state = makeState();

    const slotContext: SlotContext = {
      overrides: new Map([
        ['slot_1', {
          initialPreviousResponse: { persona: 'slot_1', status: 'done', content: 'Task 1', timestamp: new Date() },
          cwd: '/worktree/slot-1',
        }],
        ['slot_2', {
          initialPreviousResponse: { persona: 'slot_2', status: 'done', content: 'Task 2', timestamp: new Date() },
          cwd: '/worktree/slot-2',
        }],
      ]),
      worktrees: new Map([
        ['slot_1', { path: '/worktree/slot-1', branch: 'slot-1-branch' }],
        ['slot_2', { path: '/worktree/slot-2', branch: 'slot-2-branch' }],
      ]),
    };
    mockPrepareSlotContext.mockReturnValue(slotContext);

    const mockWorkflowCallRunner = {
      run: vi.fn()
        .mockResolvedValueOnce({
          response: { persona: 'slot_1', status: 'done', content: 'done 1', timestamp: new Date(), matchedRuleIndex: 0 },
          instruction: 'Task 1',
        })
        .mockResolvedValueOnce({
          response: { persona: 'slot_2', status: 'done', content: 'done 2', timestamp: new Date(), matchedRuleIndex: 0 },
          instruction: 'Task 2',
        }),
    };

    const deps = createDeps({ workflowCallRunner: mockWorkflowCallRunner });
    const runner = new ParallelRunner(deps);

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockMergeChildBranch).toHaveBeenCalledTimes(2);
    expect(mockCleanupParallelWorktree).toHaveBeenCalledTimes(2);
    expect(mockMergeChildBranch).toHaveBeenCalledWith('/worktree/slot-1', '/project', expect.any(String));
    expect(mockMergeChildBranch).toHaveBeenCalledWith('/worktree/slot-2', '/project', expect.any(String));
  });
});
