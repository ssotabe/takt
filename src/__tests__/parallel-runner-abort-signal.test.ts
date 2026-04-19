/**
 * Unit tests for ParallelRunner buildAbortSignal integration.
 *
 * Tests Feature I: timeout/AbortSignal integration in ParallelRunner:
 * - buildAbortSignal used for normal agent sub-steps with timeoutMs
 * - buildAbortSignal used for workflow_call sub-steps
 * - timeoutMs resolution: subStep.timeoutMs → step.parallelConfig.timeoutMs → default
 * - dispose() called in finally block
 * - parent abortSignal propagation
 *
 * Mocked: executeAgent, buildAbortSignal, phase-runner, detectMatchedRule
 * Not mocked: ParallelRunner orchestration logic
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// --- Hoisted mocks ---

const {
  mockExecuteAgent,
  mockBuildAbortSignal,
  mockDetectMatchedRule,
  mockNeedsStatusJudgmentPhase,
  mockRunReportPhase,
  mockRunStatusJudgmentPhase,
  mockIncrementStepIteration,
  mockBuildSessionKey,
} = vi.hoisted(() => ({
  mockExecuteAgent: vi.fn(),
  mockBuildAbortSignal: vi.fn(),
  mockDetectMatchedRule: vi.fn(),
  mockNeedsStatusJudgmentPhase: vi.fn(),
  mockRunReportPhase: vi.fn(),
  mockRunStatusJudgmentPhase: vi.fn(),
  mockIncrementStepIteration: vi.fn(),
  mockBuildSessionKey: vi.fn(),
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
import { DEFAULT_PARALLEL_TIMEOUT_MS } from '../core/models/workflow-defaults.js';

function makeSubStep(name: string, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name,
    persona: name,
    personaDisplayName: name,
    instruction: `Do ${name}`,
    passPreviousResponse: true,
    rules: [
      { condition: 'approved', next: 'COMPLETE' },
      { condition: 'needs_fix', next: 'fix' },
    ],
    ...overrides,
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
      { condition: 'all("approved")', next: 'COMPLETE', isAggregateCondition: true, aggregateType: 'all', aggregateConditionText: 'approved' },
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
  } as WorkflowState;
}

function makeAgentResponse(persona: string, content: string): AgentResponse {
  return {
    persona,
    status: 'done',
    content,
    timestamp: new Date(),
    sessionId: `session-${persona}`,
  };
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
  mockBuildSessionKey.mockImplementation((step: WorkflowStep) => `${step.persona}:mock`);
  mockNeedsStatusJudgmentPhase.mockReturnValue(false);
  mockRunReportPhase.mockResolvedValue(undefined);
  mockDetectMatchedRule.mockResolvedValue({ index: 0, method: 'phase1_tag' });
}

describe('ParallelRunner buildAbortSignal integration', () => {
  let mockDispose: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();

    mockDispose = vi.fn();
    mockBuildAbortSignal.mockReturnValue({
      signal: new AbortController().signal,
      dispose: mockDispose,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should call buildAbortSignal for sub-step with timeoutMs', async () => {
    // Given
    const subStep = makeSubStep('reviewer', { timeoutMs: 5000 });
    const step = makeParallelStep([subStep]);
    const state = makeState();
    const deps = createDeps();
    const runner = new ParallelRunner(deps);

    mockExecuteAgent.mockImplementation(async (_persona: string, _instruction: string, options: { onPromptResolved?: (parts: unknown) => void }) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
      return makeAgentResponse('reviewer', 'approved');
    });

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockBuildAbortSignal).toHaveBeenCalledWith(5000, undefined);
    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('should use parallelConfig.timeoutMs when sub-step has no timeoutMs', async () => {
    // Given
    const subStep = makeSubStep('reviewer');
    const step = makeParallelStep([subStep], {
      parallelConfig: { timeoutMs: 120000 },
    });
    const state = makeState();
    const deps = createDeps();
    const runner = new ParallelRunner(deps);

    mockExecuteAgent.mockImplementation(async (_persona: string, _instruction: string, options: { onPromptResolved?: (parts: unknown) => void }) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
      return makeAgentResponse('reviewer', 'approved');
    });

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockBuildAbortSignal).toHaveBeenCalledWith(120000, undefined);
  });

  it('should use DEFAULT_PARALLEL_TIMEOUT_MS when neither sub-step nor parallelConfig has timeoutMs', async () => {
    // Given
    const subStep = makeSubStep('reviewer');
    const step = makeParallelStep([subStep]);
    const state = makeState();
    const deps = createDeps();
    const runner = new ParallelRunner(deps);

    mockExecuteAgent.mockImplementation(async (_persona: string, _instruction: string, options: { onPromptResolved?: (parts: unknown) => void }) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
      return makeAgentResponse('reviewer', 'approved');
    });

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockBuildAbortSignal).toHaveBeenCalledWith(DEFAULT_PARALLEL_TIMEOUT_MS, undefined);
  });

  it('should propagate parent abortSignal from engine options', async () => {
    // Given
    const parentController = new AbortController();
    const subStep = makeSubStep('reviewer', { timeoutMs: 5000 });
    const step = makeParallelStep([subStep]);
    const state = makeState();
    const deps = createDeps({
      engineOptions: {
        projectCwd: '/project',
        abortSignal: parentController.signal,
      } as WorkflowEngineOptions,
    });
    const runner = new ParallelRunner(deps);

    mockExecuteAgent.mockImplementation(async (_persona: string, _instruction: string, options: { onPromptResolved?: (parts: unknown) => void }) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
      return makeAgentResponse('reviewer', 'approved');
    });

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockBuildAbortSignal).toHaveBeenCalledWith(5000, parentController.signal);
  });

  it('should pass constructed signal to executeAgent options', async () => {
    // Given
    const constructedSignal = new AbortController().signal;
    mockBuildAbortSignal.mockReturnValue({ signal: constructedSignal, dispose: mockDispose });

    const subStep = makeSubStep('reviewer', { timeoutMs: 5000 });
    const step = makeParallelStep([subStep]);
    const state = makeState();
    const deps = createDeps();
    const runner = new ParallelRunner(deps);

    mockExecuteAgent.mockImplementation(async (_persona: string, _instruction: string, options: { onPromptResolved?: (parts: unknown) => void; abortSignal?: AbortSignal }) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
      expect(options.abortSignal).toBe(constructedSignal);
      return makeAgentResponse('reviewer', 'approved');
    });

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });

  it('should call dispose even when sub-step execution fails', async () => {
    // Given
    const subStep = makeSubStep('reviewer', { timeoutMs: 5000 });
    const step = makeParallelStep([subStep]);
    const state = makeState();
    const deps = createDeps();
    const runner = new ParallelRunner(deps);

    mockExecuteAgent.mockRejectedValue(new Error('Agent execution failed'));

    // When / Then
    await expect(
      runner.runParallelStep(step, state, 'test task', 10, vi.fn()),
    ).rejects.toThrow('All parallel sub-steps failed');

    expect(mockDispose).toHaveBeenCalledTimes(1);
  });

  it('should build separate abort signals for each sub-step', async () => {
    // Given
    const sub1 = makeSubStep('arch-review', { timeoutMs: 3000 });
    const sub2 = makeSubStep('security-review', { timeoutMs: 7000 });
    const step = makeParallelStep([sub1, sub2]);
    const state = makeState();
    const deps = createDeps();
    const runner = new ParallelRunner(deps);

    mockExecuteAgent.mockImplementation(async (_persona: string, _instruction: string, options: { onPromptResolved?: (parts: unknown) => void }) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
      return makeAgentResponse('reviewer', 'approved');
    });

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockBuildAbortSignal).toHaveBeenCalledTimes(2);
    expect(mockBuildAbortSignal).toHaveBeenCalledWith(3000, undefined);
    expect(mockBuildAbortSignal).toHaveBeenCalledWith(7000, undefined);
    expect(mockDispose).toHaveBeenCalledTimes(2);
  });

  it('should prioritize subStep.timeoutMs over parallelConfig.timeoutMs', async () => {
    // Given
    const subStep = makeSubStep('reviewer', { timeoutMs: 5000 });
    const step = makeParallelStep([subStep], {
      parallelConfig: { timeoutMs: 120000 },
    });
    const state = makeState();
    const deps = createDeps();
    const runner = new ParallelRunner(deps);

    mockExecuteAgent.mockImplementation(async (_persona: string, _instruction: string, options: { onPromptResolved?: (parts: unknown) => void }) => {
      options.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
      return makeAgentResponse('reviewer', 'approved');
    });

    // When
    await runner.runParallelStep(step, state, 'test task', 10, vi.fn());

    // Then
    expect(mockBuildAbortSignal).toHaveBeenCalledWith(5000, undefined);
  });

  it('should throw when workflow_call sub-step has no workflowCallRunner', async () => {
    // Given: workflow_call sub-step but no workflowCallRunner in deps
    const subStep = {
      name: 'child-call',
      kind: 'workflow_call',
      call: 'child-workflow',
      personaDisplayName: 'child-call',
      instruction: '',
      passPreviousResponse: true,
      rules: [{ condition: 'COMPLETE', next: 'done' }],
    } as unknown as WorkflowStep;
    const step = makeParallelStep([subStep]);
    const state = makeState();
    const deps = createDeps(); // no workflowCallRunner

    // When / Then
    await expect(
      new ParallelRunner(deps).runParallelStep(step, state, 'test task', 10, vi.fn()),
    ).rejects.toThrow('workflow_call sub-step "child-call" requires workflowCallRunner');
  });
});
