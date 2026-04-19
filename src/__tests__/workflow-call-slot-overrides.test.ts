/**
 * Unit tests for WorkflowCallRunner/Executor slotOverrides and abortSignal support.
 *
 * Tests Feature A: slot-based overrides (cwd, reportDirName, initialPreviousResponse)
 * and abortSignal propagation to child workflow engine.
 *
 * Mocked: WorkflowCallExecutor dependencies (createEngine, resolveWorkflowCall, etc.)
 * Not mocked: WorkflowCallRunner orchestration logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  AgentResponse,
  WorkflowConfig,
  WorkflowCallStep,
  WorkflowState,
  WorkflowResumePointEntry,
} from '../core/models/types.js';
import type {
  WorkflowEngineOptions,
  WorkflowSharedRuntimeState,
  WorkflowCallChildEngine,
} from '../core/workflow/types.js';
import type { RunPaths } from '../core/workflow/run/run-paths.js';
import type { WorkflowCallSlotOverrides } from '../core/workflow/engine/slot-context.js';
import { WorkflowCallRunner } from '../core/workflow/engine/WorkflowCallRunner.js';

function makeWorkflowCallStep(overrides: Partial<WorkflowCallStep> = {}): WorkflowCallStep {
  return {
    name: 'delegate',
    kind: 'workflow_call',
    call: 'child-workflow',
    passPreviousResponse: true,
    instruction: '',
    rules: [
      { condition: 'COMPLETE', next: 'COMPLETE' },
      { condition: 'ABORT', next: 'ABORT' },
    ],
    ...overrides,
  } as WorkflowCallStep;
}

function makeChildWorkflow(): WorkflowConfig {
  return {
    name: 'child-workflow',
    maxSteps: 5,
    initialStep: 'work',
    subworkflow: { callable: true },
    steps: [
      {
        name: 'work',
        persona: 'coder',
        personaDisplayName: 'coder',
        instruction: 'Do work',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  } as WorkflowConfig;
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

function makeEngineOptions(overrides: Partial<WorkflowEngineOptions> = {}): WorkflowEngineOptions {
  return {
    projectCwd: '/project',
    provider: 'mock',
    model: 'test-model',
    ...overrides,
  } as WorkflowEngineOptions;
}

function createMockChildEngine(childState: WorkflowState): WorkflowCallChildEngine {
  return {
    on: vi.fn(),
    runWithResult: vi.fn().mockResolvedValue({
      state: childState,
    }),
  } as unknown as WorkflowCallChildEngine;
}

describe('WorkflowCallRunner slotOverrides and abortSignal', () => {
  let mockCreateEngine: ReturnType<typeof vi.fn>;
  let mockResolveWorkflowCall: ReturnType<typeof vi.fn>;
  let childWorkflow: WorkflowConfig;

  beforeEach(() => {
    vi.resetAllMocks();
    childWorkflow = makeChildWorkflow();
    mockCreateEngine = vi.fn();
    mockResolveWorkflowCall = vi.fn().mockReturnValue(childWorkflow);
  });

  function createRunner(overrides: {
    state?: WorkflowState;
    options?: Partial<WorkflowEngineOptions>;
  } = {}): WorkflowCallRunner {
    const state = overrides.state ?? makeState();
    const options = makeEngineOptions(overrides.options);

    return new WorkflowCallRunner({
      getConfig: () => ({
        name: 'parent-workflow',
        maxSteps: 10,
        initialStep: 'delegate',
        steps: [],
      }) as WorkflowConfig,
      getMaxSteps: () => 10,
      updateMaxSteps: vi.fn(),
      state,
      projectCwd: '/project',
      getCwd: () => '/project',
      task: 'test task',
      getOptions: () => options,
      sharedRuntime: { maxSteps: undefined } as WorkflowSharedRuntimeState,
      resumeStackPrefix: [] as WorkflowResumePointEntry[],
      runPaths: { slug: 'test-run' } as RunPaths,
      setActiveResumePoint: vi.fn(),
      emit: vi.fn(),
      resolveWorkflowCall: mockResolveWorkflowCall,
      createEngine: mockCreateEngine,
    });
  }

  it('should pass slotOverrides.cwd to child engine options', async () => {
    // Given
    const childState: WorkflowState = {
      ...makeState(),
      status: 'completed',
      lastOutput: { persona: 'coder', status: 'done', content: 'done', timestamp: new Date() },
    };
    mockCreateEngine.mockReturnValue(createMockChildEngine(childState));
    const runner = createRunner();
    const step = makeWorkflowCallStep();
    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: { persona: 'slot_1', status: 'done', content: 'slot instruction', timestamp: new Date() },
      cwd: '/worktree/slot-1',
      reportDirName: 'test-run-slot-1',
    };

    // When
    await runner.run(step, undefined, slotOverrides);

    // Then
    const createEngineCall = mockCreateEngine.mock.calls[0];
    expect(createEngineCall).toBeDefined();
    const [, cwdArg] = createEngineCall!;
    expect(cwdArg).toBe('/worktree/slot-1');
  });

  it('should pass slotOverrides.reportDirName to child engine options', async () => {
    // Given
    const childState: WorkflowState = {
      ...makeState(),
      status: 'completed',
      lastOutput: { persona: 'coder', status: 'done', content: 'done', timestamp: new Date() },
    };
    mockCreateEngine.mockReturnValue(createMockChildEngine(childState));
    const runner = createRunner();
    const step = makeWorkflowCallStep();
    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: { persona: 'slot_1', status: 'done', content: 'slot instruction', timestamp: new Date() },
      reportDirName: 'custom-report-dir',
    };

    // When
    await runner.run(step, undefined, slotOverrides);

    // Then
    const [, , , optionsArg] = mockCreateEngine.mock.calls[0]!;
    expect(optionsArg.reportDirName).toBe('custom-report-dir');
  });

  it('should pass abortSignal to child engine options', async () => {
    // Given
    const childState: WorkflowState = {
      ...makeState(),
      status: 'completed',
      lastOutput: { persona: 'coder', status: 'done', content: 'done', timestamp: new Date() },
    };
    mockCreateEngine.mockReturnValue(createMockChildEngine(childState));
    const runner = createRunner();
    const step = makeWorkflowCallStep();
    const controller = new AbortController();

    // When
    await runner.run(step, undefined, undefined, controller.signal);

    // Then
    const [, , , optionsArg] = mockCreateEngine.mock.calls[0]!;
    expect(optionsArg.abortSignal).toBe(controller.signal);
  });

  it('should use default cwd when slotOverrides has no cwd', async () => {
    // Given
    const childState: WorkflowState = {
      ...makeState(),
      status: 'completed',
      lastOutput: { persona: 'coder', status: 'done', content: 'done', timestamp: new Date() },
    };
    mockCreateEngine.mockReturnValue(createMockChildEngine(childState));
    const runner = createRunner();
    const step = makeWorkflowCallStep();

    // When
    await runner.run(step);

    // Then
    const [, cwdArg] = mockCreateEngine.mock.calls[0]!;
    expect(cwdArg).toBe('/project');
  });

  it('should not set abortSignal on child engine when not provided', async () => {
    // Given
    const childState: WorkflowState = {
      ...makeState(),
      status: 'completed',
      lastOutput: { persona: 'coder', status: 'done', content: 'done', timestamp: new Date() },
    };
    mockCreateEngine.mockReturnValue(createMockChildEngine(childState));
    const runner = createRunner();
    const step = makeWorkflowCallStep();

    // When
    await runner.run(step);

    // Then
    const [, , , optionsArg] = mockCreateEngine.mock.calls[0]!;
    expect(optionsArg.abortSignal).toBeUndefined();
  });

  it('should set initialPreviousResponse from slotOverrides as child lastOutput', async () => {
    // Given
    const slotResponse: AgentResponse = {
      persona: 'slot_1',
      status: 'done',
      content: 'slot-specific instruction',
      timestamp: new Date(),
    };
    const childState: WorkflowState = {
      ...makeState(),
      status: 'completed',
      lastOutput: { persona: 'coder', status: 'done', content: 'work done', timestamp: new Date() },
    };
    mockCreateEngine.mockReturnValue(createMockChildEngine(childState));
    const runner = createRunner();
    const step = makeWorkflowCallStep();
    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: slotResponse,
    };

    // When
    await runner.run(step, undefined, slotOverrides);

    // Then
    const [, , , optionsArg] = mockCreateEngine.mock.calls[0]!;
    expect(optionsArg.initialPreviousResponse).toBe(slotResponse);
  });

  it('should combine slotOverrides and abortSignal together', async () => {
    // Given
    const childState: WorkflowState = {
      ...makeState(),
      status: 'completed',
      lastOutput: { persona: 'coder', status: 'done', content: 'done', timestamp: new Date() },
    };
    mockCreateEngine.mockReturnValue(createMockChildEngine(childState));
    const runner = createRunner();
    const step = makeWorkflowCallStep();
    const controller = new AbortController();
    const slotOverrides: WorkflowCallSlotOverrides = {
      initialPreviousResponse: { persona: 'slot_1', status: 'done', content: 'instruction', timestamp: new Date() },
      cwd: '/worktree/slot-1',
      reportDirName: 'run-slot-1',
    };

    // When
    await runner.run(step, undefined, slotOverrides, controller.signal);

    // Then
    const [, cwdArg, , optionsArg] = mockCreateEngine.mock.calls[0]!;
    expect(cwdArg).toBe('/worktree/slot-1');
    expect(optionsArg.reportDirName).toBe('run-slot-1');
    expect(optionsArg.abortSignal).toBe(controller.signal);
  });
});
