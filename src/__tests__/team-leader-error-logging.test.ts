/**
 * Tests for TeamLeaderRunner error logging improvements.
 *
 * Requirement 1: log.error in runSinglePart() .catch() block
 * Requirement 2: log.error summary before throwing on all-parts-failed
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { PieceMovement, PieceState, PartDefinition, AgentResponse } from '../core/models/types.js';

const { logMock } = vi.hoisted(() => ({
  logMock: {
    debug: vi.fn(),
    info: vi.fn(),
    error: vi.fn(),
    enter: vi.fn(),
    exit: vi.fn(),
  },
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => logMock,
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

vi.mock('../agents/agent-usecases.js', () => ({
  decomposeTask: vi.fn(),
  executeAgent: vi.fn(),
  requestMoreParts: vi.fn(),
}));

/**
 * Mock decomposeTask to return parts and trigger onPromptResolved callback
 * (required to pass the didEmitPhaseStart guard in runTeamLeaderMovement).
 */
function mockDecomposeTask(parts: PartDefinition[]): void {
  vi.mocked(decomposeTask).mockImplementation(async (_instruction, _maxParts, options) => {
    options.onPromptResolved?.({ systemPrompt: 'mock', userInstruction: 'mock' });
    return parts;
  });
}

vi.mock('../core/piece/engine/team-leader-execution.js', () => ({
  runTeamLeaderExecution: vi.fn(),
}));

vi.mock('../core/piece/engine/team-leader-aggregation.js', () => ({
  buildTeamLeaderAggregatedContent: vi.fn().mockReturnValue('aggregated'),
}));

vi.mock('../core/piece/engine/team-leader-streaming.js', () => ({
  buildTeamLeaderParallelLoggerOptions: vi.fn(),
  emitTeamLeaderProgressHint: vi.fn(),
}));

vi.mock('../core/piece/engine/session-key.js', () => ({
  buildSessionKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('../core/piece/engine/abort-signal.js', () => ({
  buildAbortSignal: vi.fn().mockReturnValue({ signal: new AbortController().signal, dispose: vi.fn() }),
}));

vi.mock('../core/piece/engine/state-manager.js', () => ({
  incrementMovementIteration: vi.fn().mockReturnValue(1),
}));

import { TeamLeaderRunner } from '../core/piece/engine/TeamLeaderRunner.js';
import type { TeamLeaderRunnerDeps } from '../core/piece/engine/TeamLeaderRunner.js';
import type { OptionsBuilder } from '../core/piece/engine/OptionsBuilder.js';
import type { MovementExecutor } from '../core/piece/engine/MovementExecutor.js';
import type { PieceEngineOptions } from '../core/piece/types.js';
import { decomposeTask, executeAgent, requestMoreParts } from '../agents/agent-usecases.js';
import { runTeamLeaderExecution } from '../core/piece/engine/team-leader-execution.js';
import type { PartResult } from '../core/models/types.js';

function makeStep(overrides: Partial<PieceMovement> = {}): PieceMovement {
  return {
    name: 'implement',
    persona: 'team-leader',
    personaDisplayName: 'implement',
    instruction: 'do something',
    passPreviousResponse: true,
    teamLeader: {
      persona: 'team-leader',
      maxParts: 3,
      refillThreshold: 0,
      timeoutMs: 10000,
      partPersona: 'coder',
      partAllowedTools: ['Read', 'Edit'],
      partEdit: true,
      partPermissionMode: 'edit',
    },
    ...overrides,
  };
}

function makePart(id: string): PartDefinition {
  return { id, title: `Part ${id}`, instruction: `Do ${id}` };
}

function makeState(): PieceState {
  return {
    currentMovementName: 'implement',
    iteration: 1,
    movementIterations: new Map(),
    movementOutputs: new Map(),
    lastOutput: undefined,
    previousResponses: new Map(),
    status: 'running',
  };
}

function makeDeps(overrides: Partial<TeamLeaderRunnerDeps> = {}): TeamLeaderRunnerDeps {
  return {
    optionsBuilder: {
      buildAgentOptions: vi.fn().mockReturnValue({}),
    } as unknown as OptionsBuilder,
    movementExecutor: {
      buildInstruction: vi.fn().mockReturnValue('test instruction'),
      applyPostExecutionPhases: vi.fn().mockImplementation(async (_step, _state, _iter, response) => response),
      persistPreviousResponseSnapshot: vi.fn(),
      emitMovementReports: vi.fn(),
    } as unknown as MovementExecutor,
    engineOptions: {
      provider: 'mock',
    } as unknown as PieceEngineOptions,
    getCwd: () => '/tmp/test',
    getInteractive: () => false,
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    callAiJudge: vi.fn().mockResolvedValue(0),
    ...overrides,
  };
}

describe('TeamLeaderRunner error logging', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Requirement 1: runSinglePart() error logging', () => {
    it('パート実行が例外をスローした場合、log.errorでパートID・エラーメッセージ・スタックトレースを出力する', async () => {
      const deps = makeDeps();
      const runner = new TeamLeaderRunner(deps);
      const step = makeStep();
      const state = makeState();
      const partError = new Error('SDK connection failed');

      const part1 = makePart('part-1');
      const part2 = makePart('part-2');

      mockDecomposeTask([part1, part2]);
      vi.mocked(executeAgent)
        .mockRejectedValueOnce(partError)
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'done',
          content: 'part-2 done',
          timestamp: new Date(),
        });

      // Use runTeamLeaderExecution to simulate the real flow
      vi.mocked(runTeamLeaderExecution).mockImplementation(async (opts) => {
        const results: PartResult[] = [];
        for (let i = 0; i < opts.initialParts.length; i++) {
          const result = await opts.runPart(opts.initialParts[i]!, i);
          results.push(result);
          opts.onPartCompleted?.(result);
        }
        return { plannedParts: opts.initialParts, partResults: results };
      });

      // part-1 fails but part-2 succeeds → should not throw
      await runner.runTeamLeaderMovement(step, state, 'test task', 10, vi.fn());

      // Verify log.error was called for the failed part
      expect(logMock.error).toHaveBeenCalledWith(
        expect.stringContaining('part-1'),
        expect.objectContaining({
          partId: 'part-1',
          error: 'SDK connection failed',
          stack: expect.stringContaining('Error: SDK connection failed'),
        }),
      );
    });

    it('非Errorオブジェクトがスローされた場合、stackはundefinedで出力する', async () => {
      const deps = makeDeps();
      const runner = new TeamLeaderRunner(deps);
      const step = makeStep();
      const state = makeState();

      const part1 = makePart('part-1');

      mockDecomposeTask([part1]);
      vi.mocked(executeAgent).mockRejectedValueOnce('string error');

      vi.mocked(runTeamLeaderExecution).mockImplementation(async (opts) => {
        const results: PartResult[] = [];
        for (let i = 0; i < opts.initialParts.length; i++) {
          const result = await opts.runPart(opts.initialParts[i]!, i);
          results.push(result);
          opts.onPartCompleted?.(result);
        }
        return { plannedParts: opts.initialParts, partResults: results };
      });

      // All parts fail → should throw
      await expect(
        runner.runTeamLeaderMovement(step, state, 'test task', 10, vi.fn()),
      ).rejects.toThrow();

      expect(logMock.error).toHaveBeenCalledWith(
        expect.stringContaining('part-1'),
        expect.objectContaining({
          partId: 'part-1',
          stack: undefined,
        }),
      );
    });

    it('パート実行の.catch()内でlog.errorが呼ばれた後にbuildErrorPartResultの結果が返される', async () => {
      const deps = makeDeps();
      const runner = new TeamLeaderRunner(deps);
      const step = makeStep();
      const state = makeState();

      const part1 = makePart('part-1');
      const part2 = makePart('part-2');

      mockDecomposeTask([part1, part2]);
      vi.mocked(executeAgent)
        .mockRejectedValueOnce(new Error('part-1 error'))
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'done',
          content: 'part-2 done',
          timestamp: new Date(),
        });

      let capturedResults: PartResult[] = [];
      vi.mocked(runTeamLeaderExecution).mockImplementation(async (opts) => {
        const results: PartResult[] = [];
        for (let i = 0; i < opts.initialParts.length; i++) {
          const result = await opts.runPart(opts.initialParts[i]!, i);
          results.push(result);
          opts.onPartCompleted?.(result);
        }
        capturedResults = results;
        return { plannedParts: opts.initialParts, partResults: results };
      });

      await runner.runTeamLeaderMovement(step, state, 'test task', 10, vi.fn());

      // The failed part should have error status from buildErrorPartResult
      const failedResult = capturedResults.find((r) => r.part.id === 'part-1');
      expect(failedResult).toBeDefined();
      expect(failedResult!.response.status).toBe('error');
      expect(failedResult!.response.error).toBe('part-1 error');
    });
  });

  describe('Requirement 2: all parts failed error summary', () => {
    it('全パート失敗時にlog.errorで各パートのID・エラーの一覧を出力してからthrowする', async () => {
      const deps = makeDeps();
      const runner = new TeamLeaderRunner(deps);
      const step = makeStep();
      const state = makeState();

      const part1 = makePart('part-1');
      const part2 = makePart('part-2');

      mockDecomposeTask([part1, part2]);
      vi.mocked(executeAgent)
        .mockRejectedValueOnce(new Error('API timeout'))
        .mockRejectedValueOnce(new Error('Auth failure'));

      vi.mocked(runTeamLeaderExecution).mockImplementation(async (opts) => {
        const results: PartResult[] = [];
        for (let i = 0; i < opts.initialParts.length; i++) {
          const result = await opts.runPart(opts.initialParts[i]!, i);
          results.push(result);
          opts.onPartCompleted?.(result);
        }
        return { plannedParts: opts.initialParts, partResults: results };
      });

      await expect(
        runner.runTeamLeaderMovement(step, state, 'test task', 10, vi.fn()),
      ).rejects.toThrow('All team leader parts failed');

      // Verify log.error was called with error summary before throwing
      const allFailedCall = logMock.error.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('All team leader parts failed'),
      );
      expect(allFailedCall).toBeDefined();
      expect(allFailedCall![1]).toEqual(expect.objectContaining({
        movement: 'implement',
        partCount: 2,
      }));
      // Should contain error details for each part
      expect(allFailedCall![1].errors).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ partId: 'part-1' }),
          expect.objectContaining({ partId: 'part-2' }),
        ]),
      );
    });

    it('一部パートのみ失敗した場合はエラーサマリーのlog.errorは出力しない', async () => {
      const deps = makeDeps();
      const runner = new TeamLeaderRunner(deps);
      const step = makeStep();
      const state = makeState();

      const part1 = makePart('part-1');
      const part2 = makePart('part-2');

      mockDecomposeTask([part1, part2]);
      vi.mocked(executeAgent)
        .mockRejectedValueOnce(new Error('part-1 error'))
        .mockResolvedValueOnce({
          persona: 'coder',
          status: 'done',
          content: 'part-2 done',
          timestamp: new Date(),
        });

      vi.mocked(runTeamLeaderExecution).mockImplementation(async (opts) => {
        const results: PartResult[] = [];
        for (let i = 0; i < opts.initialParts.length; i++) {
          const result = await opts.runPart(opts.initialParts[i]!, i);
          results.push(result);
          opts.onPartCompleted?.(result);
        }
        return { plannedParts: opts.initialParts, partResults: results };
      });

      await runner.runTeamLeaderMovement(step, state, 'test task', 10, vi.fn());

      // "All team leader parts failed" log.error should NOT have been called
      const allFailedCall = logMock.error.mock.calls.find(
        (call: unknown[]) => typeof call[0] === 'string' && call[0].includes('All team leader parts failed'),
      );
      expect(allFailedCall).toBeUndefined();
    });
  });
});
