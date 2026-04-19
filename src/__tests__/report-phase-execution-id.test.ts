/**
 * Unit tests for phaseExecutionId propagation in Phase 2 (report phase)
 *
 * Feature 18: Phase 2 should generate phaseExecutionId via buildPhaseExecutionId()
 * and pass it to all onPhaseStart/onPhaseComplete callbacks, matching Phase 3's behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runReportPhase, type PhaseRunnerContext } from '../core/workflow/phase-runner.js';
import type { WorkflowStep, AgentResponse } from '../core/models/types.js';
import { buildPhaseExecutionId } from '../shared/utils/phaseExecutionId.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

import { runAgent } from '../agents/runner.js';

function createStep(fileNames: string[]): WorkflowStep {
  return {
    name: 'implement',
    persona: 'coder',
    personaDisplayName: 'Coder',
    instruction: 'Implement task',
    passPreviousResponse: false,
    outputContracts: fileNames.map((name) => ({ name })),
  };
}

function createContext(
  reportDir: string,
  overrides: Partial<PhaseRunnerContext> = {},
): PhaseRunnerContext {
  let currentSessionId = 'session-1';

  return {
    cwd: reportDir,
    reportDir,
    language: 'en',
    iteration: 3,
    getSessionId: () => currentSessionId,
    buildResumeOptions: (_step, sessionId, overrides) => ({
      cwd: reportDir,
      sessionId,
      maxTurns: overrides.maxTurns,
    }),
    buildNewSessionReportOptions: (_step, overrides) => ({
      cwd: reportDir,
      allowedTools: overrides.allowedTools,
      maxTurns: overrides.maxTurns,
    }),
    updatePersonaSession: (_persona, sessionId) => {
      if (sessionId) {
        currentSessionId = sessionId;
      }
    },
    ...overrides,
  };
}

function queueRunAgentResponses(responses: AgentResponse[]): void {
  const runAgentMock = vi.mocked(runAgent);
  for (const response of responses) {
    runAgentMock.mockImplementationOnce(async (_persona, _task, options) => {
      options?.onPromptResolved?.({
        systemPrompt: '',
        userInstruction: _task,
      });
      return response;
    });
  }
}

describe('runReportPhase phaseExecutionId propagation', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = mkdtempSync(join(tmpdir(), 'takt-phase-exec-id-'));
    vi.resetAllMocks();
  });

  afterEach(() => {
    if (existsSync(tmpRoot)) {
      rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it('should pass phaseExecutionId to onPhaseStart callback', async () => {
    // Given
    const reportDir = join(tmpRoot, 'reports');
    const step = createStep(['01-plan.md']);
    const onPhaseStart = vi.fn();
    const ctx = createContext(reportDir, { iteration: 2, onPhaseStart });

    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: '# Plan\nDone',
      timestamp: new Date(),
      sessionId: 'session-2',
    }]);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(onPhaseStart).toHaveBeenCalledTimes(1);
    const [, phase, phaseName, , , phaseExecutionId, iteration] = onPhaseStart.mock.calls[0]!;
    expect(phase).toBe(2);
    expect(phaseName).toBe('report');
    expect(iteration).toBe(2);

    // phaseExecutionId should be a valid ID (not undefined)
    expect(phaseExecutionId).toBeDefined();
    expect(phaseExecutionId).toBe(
      buildPhaseExecutionId({ step: 'implement', iteration: 2, phase: 2, sequence: 1 }),
    );
  });

  it('should pass phaseExecutionId to onPhaseComplete callback on success', async () => {
    // Given
    const reportDir = join(tmpRoot, 'reports');
    const step = createStep(['01-plan.md']);
    const onPhaseComplete = vi.fn();
    const ctx = createContext(reportDir, { iteration: 5, onPhaseComplete });

    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: '# Report',
      timestamp: new Date(),
    }]);

    // When
    await runReportPhase(step, 1, ctx);

    // Then
    expect(onPhaseComplete).toHaveBeenCalledTimes(1);
    const [, phase, phaseName, , , , phaseExecutionId, iteration] = onPhaseComplete.mock.calls[0]!;
    expect(phase).toBe(2);
    expect(phaseName).toBe('report');
    expect(iteration).toBe(5);
    expect(phaseExecutionId).toBe(
      buildPhaseExecutionId({ step: 'implement', iteration: 5, phase: 2, sequence: 1 }),
    );
  });

  it('should pass phaseExecutionId to onPhaseComplete on blocked status', async () => {
    // Given
    const reportDir = join(tmpRoot, 'reports');
    const step = createStep(['01-plan.md']);
    const onPhaseComplete = vi.fn();
    const ctx = createContext(reportDir, { iteration: 1, onPhaseComplete });

    queueRunAgentResponses([{
      persona: 'coder',
      status: 'blocked',
      content: 'Need permission',
      timestamp: new Date(),
    }]);

    // When
    const result = await runReportPhase(step, 1, ctx);

    // Then
    expect(result).toEqual({
      blocked: true,
      response: expect.objectContaining({ status: 'blocked' }),
    });
    expect(onPhaseComplete).toHaveBeenCalledTimes(1);
    const [, , , , , , phaseExecutionId] = onPhaseComplete.mock.calls[0]!;
    expect(phaseExecutionId).toBe(
      buildPhaseExecutionId({ step: 'implement', iteration: 1, phase: 2, sequence: 1 }),
    );
  });

  it('should pass phaseExecutionId to onPhaseComplete on error status', async () => {
    // Given
    const reportDir = join(tmpRoot, 'reports');
    const step = createStep(['01-plan.md']);
    const onPhaseComplete = vi.fn();
    const ctx = createContext(reportDir, { iteration: 2, onPhaseComplete });

    // First attempt: error, second attempt: success
    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'error',
        content: 'Tool error',
        error: 'Tool error',
        timestamp: new Date(),
      },
      {
        persona: 'coder',
        status: 'done',
        content: 'Recovered',
        timestamp: new Date(),
      },
    ]);

    // When
    await runReportPhase(step, 1, ctx);

    // Then: two calls — error then success
    expect(onPhaseComplete).toHaveBeenCalledTimes(2);
    const expectedId = buildPhaseExecutionId({ step: 'implement', iteration: 2, phase: 2, sequence: 1 });

    // First call (error)
    const [, , , , , errorMsg1, phaseExecutionId1] = onPhaseComplete.mock.calls[0]!;
    expect(errorMsg1).toBeDefined();
    expect(phaseExecutionId1).toBe(expectedId);

    // Second call (success from retry)
    const [, , , , , , phaseExecutionId2] = onPhaseComplete.mock.calls[1]!;
    expect(phaseExecutionId2).toBe(expectedId);
  });

  it('should increment sequence for multiple report files', async () => {
    // Given: step with two report files
    const reportDir = join(tmpRoot, 'reports');
    const step = createStep(['01-plan.md', '02-review.md']);
    const onPhaseStart = vi.fn();
    const onPhaseComplete = vi.fn();
    const ctx = createContext(reportDir, { iteration: 1, onPhaseStart, onPhaseComplete });

    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: '# Plan',
        timestamp: new Date(),
        sessionId: 'session-2',
      },
      {
        persona: 'coder',
        status: 'done',
        content: '# Review',
        timestamp: new Date(),
        sessionId: 'session-3',
      },
    ]);

    // When
    await runReportPhase(step, 1, ctx);

    // Then: first file gets sequence=1, second gets sequence=2
    expect(onPhaseStart).toHaveBeenCalledTimes(2);

    const [, , , , , phaseExecId1] = onPhaseStart.mock.calls[0]!;
    const [, , , , , phaseExecId2] = onPhaseStart.mock.calls[1]!;

    expect(phaseExecId1).toBe(
      buildPhaseExecutionId({ step: 'implement', iteration: 1, phase: 2, sequence: 1 }),
    );
    expect(phaseExecId2).toBe(
      buildPhaseExecutionId({ step: 'implement', iteration: 1, phase: 2, sequence: 2 }),
    );
  });

  it('should use same sequence for first attempt and retry of same file', async () => {
    // Given: first attempt fails (empty), retry succeeds — both should use same sequence
    const reportDir = join(tmpRoot, 'reports');
    const step = createStep(['01-plan.md']);
    const onPhaseStart = vi.fn();
    const ctx = createContext(reportDir, { iteration: 4, onPhaseStart, lastResponse: 'Phase 1 output' });

    queueRunAgentResponses([
      {
        persona: 'coder',
        status: 'done',
        content: '  ',
        timestamp: new Date(),
      },
      {
        persona: 'coder',
        status: 'done',
        content: '# Recovered',
        timestamp: new Date(),
      },
    ]);

    // When
    await runReportPhase(step, 1, ctx);

    // Then: both attempts use sequence=1
    expect(onPhaseStart).toHaveBeenCalledTimes(2);
    const expectedId = buildPhaseExecutionId({ step: 'implement', iteration: 4, phase: 2, sequence: 1 });

    const [, , , , , phaseExecId1] = onPhaseStart.mock.calls[0]!;
    const [, , , , , phaseExecId2] = onPhaseStart.mock.calls[1]!;
    expect(phaseExecId1).toBe(expectedId);
    expect(phaseExecId2).toBe(expectedId);
  });

  it('should throw when iteration is missing', async () => {
    // Given: no iteration in context
    const reportDir = join(tmpRoot, 'reports');
    const step = createStep(['01-plan.md']);
    const ctx = createContext(reportDir, { iteration: undefined });

    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: '# Report',
      timestamp: new Date(),
    }]);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(/iteration/i);
  });

  it('should throw when iteration is zero', async () => {
    // Given: iteration is 0 (invalid)
    const reportDir = join(tmpRoot, 'reports');
    const step = createStep(['01-plan.md']);
    const ctx = createContext(reportDir, { iteration: 0 });

    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: '# Report',
      timestamp: new Date(),
    }]);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(/iteration/i);
  });

  it('should throw when iteration is negative', async () => {
    // Given: negative iteration
    const reportDir = join(tmpRoot, 'reports');
    const step = createStep(['01-plan.md']);
    const ctx = createContext(reportDir, { iteration: -1 });

    queueRunAgentResponses([{
      persona: 'coder',
      status: 'done',
      content: '# Report',
      timestamp: new Date(),
    }]);

    // When / Then
    await expect(runReportPhase(step, 1, ctx)).rejects.toThrow(/iteration/i);
  });
});
