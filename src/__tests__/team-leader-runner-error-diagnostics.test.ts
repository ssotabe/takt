/**
 * Unit tests for TeamLeaderRunner error diagnostics (Feature B).
 *
 * Tests:
 * - Per-part error logging with structured details (partId, step, error, stack)
 * - All-parts-failed structured error log (step, partCount, errors array)
 * - Error message in thrown Error remains unchanged
 * - Partial failure (some parts succeed, some fail) does not trigger all-failed log
 *
 * Mocked: executeAgent, structuredCaller
 * Not mocked: TeamLeaderRunner error handling logic
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExecuteAgent,
  mockLogError,
} = vi.hoisted(() => ({
  mockExecuteAgent: vi.fn(),
  mockLogError: vi.fn(),
}));

vi.mock('../agents/agent-usecases.js', () => ({
  executeAgent: mockExecuteAgent,
}));

vi.mock('../shared/utils/index.js', async () => {
  const actual = await vi.importActual<typeof import('../shared/utils/index.js')>('../shared/utils/index.js');
  return {
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: mockLogError,
    }),
    getErrorMessage: actual.getErrorMessage,
  };
});

import { TeamLeaderRunner } from '../core/workflow/engine/TeamLeaderRunner.js';
import type { WorkflowStep, WorkflowState } from '../core/models/types.js';

function createStructuredCaller(parts: Array<{ id: string; title: string; instruction: string }>) {
  return {
    decomposeTask: vi.fn().mockImplementation(async (_instruction: string, _maxParts: number, options: { onPromptResolved?: (parts: unknown) => void }) => {
      options.onPromptResolved?.({
        systemPrompt: 'system',
        userInstruction: 'instruction',
      });
      return parts;
    }),
    requestMoreParts: vi.fn().mockResolvedValue({
      done: true,
      reasoning: 'enough',
      parts: [],
    }),
  };
}

function createDeps(structuredCaller: ReturnType<typeof createStructuredCaller>) {
  return {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({ cwd: '/project' }),
      resolveStepProviderModel: vi.fn().mockReturnValue({ provider: 'mock', model: 'test' }),
    },
    stepExecutor: {
      buildInstruction: vi.fn().mockReturnValue('instruction'),
      applyPostExecutionPhases: vi.fn(async (_step: unknown, _state: unknown, _iteration: unknown, response: unknown) => response),
      persistPreviousResponseSnapshot: vi.fn(),
      emitStepReports: vi.fn(),
    },
    engineOptions: {
      projectCwd: '/project',
      structuredCaller,
    },
    getCwd: () => '/project',
    getInteractive: () => false,
  } as ConstructorParameters<typeof TeamLeaderRunner>[0] & {
    engineOptions: { projectCwd: string; structuredCaller: ReturnType<typeof createStructuredCaller> };
  };
}

function makeStep(): WorkflowStep {
  return {
    name: 'implement',
    persona: 'coder',
    personaDisplayName: 'coder',
    instruction: 'Task: {task}',
    passPreviousResponse: true,
    teamLeader: {
      persona: 'team-leader',
      maxParts: 3,
      refillThreshold: 0,
      timeoutMs: 1000,
      partPersona: 'coder',
      partEdit: true,
      partPermissionMode: 'edit',
    },
    rules: [{ condition: 'done', next: 'COMPLETE' }],
  } as WorkflowStep;
}

function makeState(): WorkflowState {
  return {
    workflowName: 'workflow',
    currentStep: 'implement',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    lastOutput: undefined,
    previousResponseSourcePath: undefined,
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  } as WorkflowState;
}

describe('TeamLeaderRunner error diagnostics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should log per-part error with structured details when a part fails', async () => {
    // Given
    const partError = new Error('API connection failed');
    const parts = [
      { id: 'part-1', title: 'API', instruction: 'Implement API' },
      { id: 'part-2', title: 'DB', instruction: 'Implement DB' },
    ];
    const structuredCaller = createStructuredCaller(parts);
    const deps = createDeps(structuredCaller);
    const runner = new TeamLeaderRunner(deps);

    mockExecuteAgent
      .mockRejectedValueOnce(partError)
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'DB done',
        timestamp: new Date(),
      });

    // When
    await runner.runTeamLeaderStep(makeStep(), makeState(), 'implement feature', 5, vi.fn());

    // Then
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('part-1'),
      expect.objectContaining({
        partId: 'part-1',
        step: 'implement',
        error: expect.stringContaining('API connection failed'),
      }),
    );
  });

  it('should include stack trace in per-part error log when error is an Error instance', async () => {
    // Given
    const partError = new Error('timeout');
    const parts = [
      { id: 'part-1', title: 'Task', instruction: 'Do task' },
      { id: 'part-2', title: 'Other', instruction: 'Do other' },
    ];
    const structuredCaller = createStructuredCaller(parts);
    const deps = createDeps(structuredCaller);
    const runner = new TeamLeaderRunner(deps);

    mockExecuteAgent
      .mockRejectedValueOnce(partError)
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'done',
        timestamp: new Date(),
      });

    // When
    await runner.runTeamLeaderStep(makeStep(), makeState(), 'task', 5, vi.fn());

    // Then
    expect(mockLogError).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        stack: expect.stringContaining('Error: timeout'),
      }),
    );
  });

  it('should log structured error details when all parts fail', async () => {
    // Given
    const parts = [
      { id: 'part-1', title: 'API', instruction: 'Implement API' },
      { id: 'part-2', title: 'DB', instruction: 'Implement DB' },
    ];
    const structuredCaller = createStructuredCaller(parts);
    const deps = createDeps(structuredCaller);
    const runner = new TeamLeaderRunner(deps);

    mockExecuteAgent
      .mockRejectedValueOnce(new Error('API failed'))
      .mockRejectedValueOnce(new Error('DB failed'));

    // When / Then
    await expect(
      runner.runTeamLeaderStep(makeStep(), makeState(), 'implement', 5, vi.fn()),
    ).rejects.toThrow('All team leader parts failed');

    // Structured log with all error details
    expect(mockLogError).toHaveBeenCalledWith(
      expect.stringContaining('All team leader parts failed'),
      expect.objectContaining({
        step: 'implement',
        partCount: 2,
        errors: expect.arrayContaining([
          expect.objectContaining({ partId: 'part-1' }),
          expect.objectContaining({ partId: 'part-2' }),
        ]),
      }),
    );
  });

  it('should preserve error message in thrown Error when all parts fail', async () => {
    // Given
    const parts = [
      { id: 'part-1', title: 'Task A', instruction: 'Do A' },
    ];
    const structuredCaller = createStructuredCaller(parts);
    const deps = createDeps(structuredCaller);
    const runner = new TeamLeaderRunner(deps);

    mockExecuteAgent.mockRejectedValueOnce(new Error('crash'));

    // When / Then
    await expect(
      runner.runTeamLeaderStep(makeStep(), makeState(), 'task', 5, vi.fn()),
    ).rejects.toThrow(/part-1.*crash/);
  });

  it('should not log all-failed structured error when some parts succeed', async () => {
    // Given
    const parts = [
      { id: 'part-1', title: 'API', instruction: 'Implement API' },
      { id: 'part-2', title: 'DB', instruction: 'Implement DB' },
    ];
    const structuredCaller = createStructuredCaller(parts);
    const deps = createDeps(structuredCaller);
    const runner = new TeamLeaderRunner(deps);

    mockExecuteAgent
      .mockRejectedValueOnce(new Error('API failed'))
      .mockResolvedValueOnce({
        persona: 'coder',
        status: 'done',
        content: 'DB done',
        timestamp: new Date(),
      });

    // When
    await runner.runTeamLeaderStep(makeStep(), makeState(), 'implement', 5, vi.fn());

    // Then: per-part error log emitted, but NOT the "All team leader parts failed" structured log
    const allFailedCalls = mockLogError.mock.calls.filter(
      (call: unknown[]) => typeof call[0] === 'string' && (call[0] as string).includes('All team leader parts failed'),
    );
    expect(allFailedCalls).toHaveLength(0);
  });
});
