/**
 * Unit tests for ParallelRunner parent cwd usage (Feature C).
 *
 * Tests that ParallelRunner uses getCwd() (parent worktree) instead of
 * engineOptions.projectCwd (main repo) for worktree operations.
 * When takt runs inside a worktree, cwd !== projectCwd.
 *
 * Mocked: worktree-sync, parallel-worktree, slot-context, executeAgent, etc.
 * Not mocked: ParallelRunner cwd resolution logic
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
import type { WorkflowStep, WorkflowState } from '../core/models/types.js';
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

function makeParallelStep(subSteps: WorkflowStep[]): WorkflowStep {
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
    stepSessions: new Map(),
    userInputs: [],
    lastOutput: {
      persona: 'decomposer',
      status: 'done',
      content: '## slot_1\nImplement feature',
      timestamp: new Date(),
    },
  } as WorkflowState;
}

const PARENT_WORKTREE_CWD = '/worktrees/parent-worktree';
const MAIN_REPO_PROJECT_CWD = '/main-repo';

function createDeps(): ParallelRunnerDeps {
  return {
    optionsBuilder: {
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'mock', model: 'test' }),
      buildAgentOptions: vi.fn().mockReturnValue({
        cwd: PARENT_WORKTREE_CWD,
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
      projectCwd: MAIN_REPO_PROJECT_CWD,
    } as WorkflowEngineOptions,
    getCwd: () => PARENT_WORKTREE_CWD,
    getReportDir: () => `${PARENT_WORKTREE_CWD}/.takt/runs/test/reports`,
    getInteractive: () => false,
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    structuredCaller: {} as ParallelRunnerDeps['structuredCaller'],
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

describe('ParallelRunner parent cwd (Feature C)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
  });

  it('should pass getCwd() to prepareSlotContext instead of projectCwd', async () => {
    // Given: getCwd() returns parent worktree path, projectCwd is main repo
    const slot1 = makeWorkflowCallSubStep('slot_1');
    const step = makeParallelStep([slot1]);
    const state = makeState();

    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: { persona: 'slot_1', status: 'done', content: 'Task 1', timestamp: new Date() },
      cwd: '/worktrees/child-slot-1',
    };
    const slotContext: SlotContext = {
      overrides: new Map([['slot_1', slotOverrides]]),
      worktrees: new Map([['slot_1', { path: '/worktrees/child-slot-1', branch: 'slot-1-branch' }]]),
    };
    mockPrepareSlotContext.mockReturnValue(slotContext);

    const mockWorkflowCallRunner = {
      run: vi.fn().mockResolvedValue({
        response: { persona: 'slot_1', status: 'done', content: 'done', timestamp: new Date(), matchedRuleIndex: 0 },
        instruction: 'Task 1',
      }),
    };

    const deps = createDeps();
    (deps as { workflowCallRunner?: unknown }).workflowCallRunner = mockWorkflowCallRunner;
    const runner = new ParallelRunner(deps);

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn(), vi.fn());

    // Then: prepareSlotContext should receive getCwd() value, not projectCwd
    expect(mockPrepareSlotContext).toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      expect.any(String),
      PARENT_WORKTREE_CWD,
    );
    // Must NOT be called with the main repo path
    expect(mockPrepareSlotContext).not.toHaveBeenCalledWith(
      expect.any(Array),
      expect.any(Object),
      expect.any(String),
      MAIN_REPO_PROJECT_CWD,
    );
  });

  it('should pass getCwd() to mergeChildBranch instead of projectCwd', async () => {
    // Given
    const slot1 = makeWorkflowCallSubStep('slot_1');
    const step = makeParallelStep([slot1]);
    const state = makeState();

    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: { persona: 'slot_1', status: 'done', content: 'Work', timestamp: new Date() },
      cwd: '/worktrees/child-slot-1',
    };
    const slotContext: SlotContext = {
      overrides: new Map([['slot_1', slotOverrides]]),
      worktrees: new Map([['slot_1', { path: '/worktrees/child-slot-1', branch: 'slot-1-branch' }]]),
    };
    mockPrepareSlotContext.mockReturnValue(slotContext);

    const mockWorkflowCallRunner = {
      run: vi.fn().mockResolvedValue({
        response: { persona: 'slot_1', status: 'done', content: 'done', timestamp: new Date(), matchedRuleIndex: 0 },
        instruction: 'Work',
      }),
    };

    const deps = createDeps();
    (deps as { workflowCallRunner?: unknown }).workflowCallRunner = mockWorkflowCallRunner;
    const runner = new ParallelRunner(deps);

    // When
    await runner.runParallelStep(step, state, 'test', 10, vi.fn(), vi.fn());

    // Then
    expect(mockMergeChildBranch).toHaveBeenCalledWith(
      '/worktrees/child-slot-1',
      PARENT_WORKTREE_CWD,
      expect.any(String),
    );
  });

  it('should pass getCwd() to cleanupParallelWorktree instead of projectCwd', async () => {
    // Given
    const slot1 = makeWorkflowCallSubStep('slot_1');
    const step = makeParallelStep([slot1]);
    const state = makeState();

    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: { persona: 'slot_1', status: 'done', content: 'Work', timestamp: new Date() },
      cwd: '/worktrees/child-slot-1',
    };
    const slotContext: SlotContext = {
      overrides: new Map([['slot_1', slotOverrides]]),
      worktrees: new Map([['slot_1', { path: '/worktrees/child-slot-1', branch: 'slot-1-branch' }]]),
    };
    mockPrepareSlotContext.mockReturnValue(slotContext);

    const mockWorkflowCallRunner = {
      run: vi.fn().mockResolvedValue({
        response: { persona: 'slot_1', status: 'done', content: 'done', timestamp: new Date(), matchedRuleIndex: 0 },
        instruction: 'Work',
      }),
    };

    const deps = createDeps();
    (deps as { workflowCallRunner?: unknown }).workflowCallRunner = mockWorkflowCallRunner;
    const runner = new ParallelRunner(deps);

    // When
    await runner.runParallelStep(step, state, 'test', 10, vi.fn(), vi.fn());

    // Then
    expect(mockCleanupParallelWorktree).toHaveBeenCalledWith(
      '/worktrees/child-slot-1',
      PARENT_WORKTREE_CWD,
    );
  });
});
