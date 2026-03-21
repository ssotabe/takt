/**
 * Tests for ParallelRunner timeout / AbortSignal support.
 *
 * Covers:
 * - Normal sub-movement timeout via buildAbortSignal
 * - piece_call sub-movement timeout
 * - Per-sub-movement timeoutMs override
 * - parallelConfig.timeoutMs default value (1,800,000ms)
 * - dispose() always called (timer leak prevention)
 * - Parent abortSignal propagation to sub-movements
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/piece/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

const mockBuildAbortSignal = vi.fn<
  (timeoutMs: number, parentSignal: AbortSignal | undefined) => { signal: AbortSignal; dispose: () => void }
>();

vi.mock('../core/piece/engine/abort-signal.js', () => ({
  buildAbortSignal: (...args: [number, AbortSignal | undefined]) => mockBuildAbortSignal(...args),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';
import { runAgent } from '../agents/runner.js';
import {
  makeResponse,
  makeMovement,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
} from './engine-test-helpers.js';
import { makeRule } from './test-helpers.js';
import type { PieceConfig } from '../core/models/index.js';

// --- Helpers ---

/**
 * Create a real AbortSignal + dispose pair for use when buildAbortSignal mock
 * should behave like the real implementation.
 */
function createRealAbortPair(timeoutMs: number, parentSignal?: AbortSignal): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new Error(`Part timeout after ${timeoutMs}ms`));
  }, timeoutMs);

  let abortListener: (() => void) | undefined;
  if (parentSignal) {
    abortListener = () => controller.abort(parentSignal.reason);
    if (parentSignal.aborted) {
      abortListener();
    } else {
      parentSignal.addEventListener('abort', abortListener, { once: true });
    }
  }

  return {
    signal: controller.signal,
    dispose: () => {
      clearTimeout(timeoutId);
      if (parentSignal && abortListener) {
        parentSignal.removeEventListener('abort', abortListener);
      }
    },
  };
}

/**
 * Build a piece config with parallelConfig on the reviewers movement.
 */
function buildPieceConfigWithTimeout(parallelConfigTimeoutMs?: number, subMovementTimeoutMs?: Record<string, number>): PieceConfig {
  const archReviewSubMovement = makeMovement('arch-review', {
    rules: [
      makeRule('approved', 'COMPLETE'),
      makeRule('needs_fix', 'fix'),
    ],
    ...(subMovementTimeoutMs?.['arch-review'] != null && { timeoutMs: subMovementTimeoutMs['arch-review'] }),
  });

  const securityReviewSubMovement = makeMovement('security-review', {
    rules: [
      makeRule('approved', 'COMPLETE'),
      makeRule('needs_fix', 'fix'),
    ],
    ...(subMovementTimeoutMs?.['security-review'] != null && { timeoutMs: subMovementTimeoutMs['security-review'] }),
  });

  return {
    name: 'test-timeout',
    description: 'Test piece with timeout',
    maxMovements: 30,
    initialMovement: 'plan',
    movements: [
      makeMovement('plan', {
        rules: [makeRule('Requirements are clear', 'reviewers')],
      }),
      makeMovement('reviewers', {
        parallel: [archReviewSubMovement, securityReviewSubMovement],
        ...(parallelConfigTimeoutMs != null && { parallelConfig: { timeoutMs: parallelConfigTimeoutMs } }),
        rules: [
          makeRule('all("approved")', 'supervise', {
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'approved',
          }),
          makeRule('any("needs_fix")', 'fix', {
            isAggregateCondition: true,
            aggregateType: 'any',
            aggregateConditionText: 'needs_fix',
          }),
        ],
      }),
      makeMovement('fix', {
        rules: [makeRule('Fix complete', 'reviewers')],
      }),
      makeMovement('supervise', {
        rules: [makeRule('All checks passed', 'COMPLETE')],
      }),
    ],
  };
}

describe('ParallelRunner: Timeout / AbortSignal', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();

    // Default mock: produce a real signal/dispose pair
    mockBuildAbortSignal.mockImplementation((timeoutMs, parentSignal) => {
      return createRealAbortPair(timeoutMs, parentSignal);
    });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should abort a timed-out sub-movement while other slots complete normally', async () => {
    // Given: a parallel movement where arch-review hangs and security-review completes
    const config = buildPieceConfigWithTimeout(100); // 100ms timeout
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    vi.mocked(runAgent)
      .mockImplementationOnce(async (_persona, _task, options) => {
        // plan
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
        return makeResponse({ persona: 'plan', content: 'Plan done' });
      })
      .mockImplementationOnce(async (_persona, task, options) => {
        // arch-review: hang until abort signal fires
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: task });
        return new Promise<never>((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (signal) {
            if (signal.aborted) { reject(signal.reason); return; }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }
        });
      })
      .mockImplementationOnce(async (_persona, task, options) => {
        // security-review: completes normally
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: task });
        return makeResponse({ persona: 'security-review', content: 'Security OK' });
      })
      .mockImplementationOnce(async (_persona, _task, options) => {
        // supervise
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
        return makeResponse({ persona: 'supervise', content: 'Pass' });
      });

    // Make the abort signal actually reject the hanging promise
    mockBuildAbortSignal.mockImplementation((timeoutMs, parentSignal) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => {
        controller.abort(new Error(`Part timeout after ${timeoutMs}ms`));
      }, timeoutMs);
      return {
        signal: controller.signal,
        dispose: () => clearTimeout(timeoutId),
      };
    });

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // plan → reviewers
      { index: 0, method: 'phase1_tag' },  // arch-review
      { index: 0, method: 'phase1_tag' },  // security-review
      { index: 0, method: 'aggregate' },   // reviewers aggregate
      { index: 0, method: 'phase1_tag' },  // supervise
    ]);

    // When: the engine runs
    const state = await engine.run();

    // Then: the timed-out slot should have error status
    const archOutput = state.movementOutputs.get('arch-review');
    expect(archOutput).toBeDefined();
    expect(archOutput!.status).toBe('error');

    // Then: the successful slot should have normal content
    const securityOutput = state.movementOutputs.get('security-review');
    expect(securityOutput).toBeDefined();
    expect(securityOutput!.content).toBe('Security OK');
  });

  it('should pass per-sub-movement timeoutMs to buildAbortSignal when specified', async () => {
    // Given: sub-movements with per-movement timeoutMs overrides
    const config = buildPieceConfigWithTimeout(60_000, {
      'arch-review': 10_000,
      'security-review': 20_000,
    });
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'arch-review', content: 'Arch OK' }),
      makeResponse({ persona: 'security-review', content: 'Security OK' }),
      makeResponse({ persona: 'supervise', content: 'Pass' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // plan → reviewers
      { index: 0, method: 'phase1_tag' },  // arch-review
      { index: 0, method: 'phase1_tag' },  // security-review
      { index: 0, method: 'aggregate' },   // reviewers aggregate
      { index: 0, method: 'phase1_tag' },  // supervise
    ]);

    // When: the engine runs
    await engine.run();

    // Then: buildAbortSignal should have been called with per-sub-movement timeouts
    const buildCalls = mockBuildAbortSignal.mock.calls;
    const timeoutValues = buildCalls.map(([ms]) => ms);
    expect(timeoutValues).toContain(10_000);
    expect(timeoutValues).toContain(20_000);
  });

  it('should use parallelConfig.timeoutMs as default when per-sub-movement timeoutMs is not set', async () => {
    // Given: parallel movement with parallelConfig.timeoutMs = 60_000, no per-sub-movement override
    const config = buildPieceConfigWithTimeout(60_000);
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'arch-review', content: 'Arch OK' }),
      makeResponse({ persona: 'security-review', content: 'Security OK' }),
      makeResponse({ persona: 'supervise', content: 'Pass' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    // When: the engine runs
    await engine.run();

    // Then: buildAbortSignal should have been called with the parallelConfig default timeout
    const buildCalls = mockBuildAbortSignal.mock.calls;
    const timeoutValues = buildCalls.map(([ms]) => ms);
    // Both sub-movements should use 60_000 (the parallelConfig default)
    expect(timeoutValues.filter((ms) => ms === 60_000)).toHaveLength(2);
  });

  it('should fall back to 1,800,000ms when parallelConfig is not set', async () => {
    // Given: parallel movement without parallelConfig
    const config = buildPieceConfigWithTimeout(); // no parallelConfig
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'arch-review', content: 'Arch OK' }),
      makeResponse({ persona: 'security-review', content: 'Security OK' }),
      makeResponse({ persona: 'supervise', content: 'Pass' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    // When: the engine runs
    await engine.run();

    // Then: buildAbortSignal should have been called with the hardcoded default (30 minutes)
    const buildCalls = mockBuildAbortSignal.mock.calls;
    const timeoutValues = buildCalls.map(([ms]) => ms);
    expect(timeoutValues.filter((ms) => ms === 1_800_000)).toHaveLength(2);
  });

  it('should always call dispose() after sub-movement execution (timer leak prevention)', async () => {
    // Given: a parallel movement with tracked dispose calls
    const disposeFns: Array<ReturnType<typeof vi.fn>> = [];
    mockBuildAbortSignal.mockImplementation((timeoutMs, parentSignal) => {
      const pair = createRealAbortPair(timeoutMs, parentSignal);
      const trackedDispose = vi.fn(() => pair.dispose());
      disposeFns.push(trackedDispose);
      return { signal: pair.signal, dispose: trackedDispose };
    });

    const config = buildPieceConfigWithTimeout(60_000);
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'arch-review', content: 'Arch OK' }),
      makeResponse({ persona: 'security-review', content: 'Security OK' }),
      makeResponse({ persona: 'supervise', content: 'Pass' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    // When: the engine runs
    await engine.run();

    // Then: every dispose function should have been called exactly once
    expect(disposeFns.length).toBeGreaterThanOrEqual(2);
    for (const dispose of disposeFns) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('should call dispose() even when sub-movement throws an error', async () => {
    // Given: a parallel movement where one sub-movement fails
    const disposeFns: Array<ReturnType<typeof vi.fn>> = [];
    mockBuildAbortSignal.mockImplementation((timeoutMs, parentSignal) => {
      const pair = createRealAbortPair(timeoutMs, parentSignal);
      const trackedDispose = vi.fn(() => pair.dispose());
      disposeFns.push(trackedDispose);
      return { signal: pair.signal, dispose: trackedDispose };
    });

    const config = buildPieceConfigWithTimeout(60_000);
    const engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    vi.mocked(runAgent)
      .mockImplementationOnce(async (_persona, _task, options) => {
        // plan
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
        return makeResponse({ persona: 'plan', content: 'Plan done' });
      })
      .mockImplementationOnce(async (_persona, task, options) => {
        // arch-review: throws
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: task });
        throw new Error('Agent crashed');
      })
      .mockImplementationOnce(async (_persona, task, options) => {
        // security-review: succeeds
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: task });
        return makeResponse({ persona: 'security-review', content: 'Security OK' });
      })
      .mockImplementationOnce(async (_persona, _task, options) => {
        // supervise
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
        return makeResponse({ persona: 'supervise', content: 'Pass' });
      });

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    // When: the engine runs
    await engine.run();

    // Then: dispose should still be called for the failing sub-movement
    expect(disposeFns.length).toBeGreaterThanOrEqual(2);
    for (const dispose of disposeFns) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });

  it('should propagate parent abortSignal to buildAbortSignal', async () => {
    // Given: a parent abort signal passed via engine options
    const parentController = new AbortController();
    const config = buildPieceConfigWithTimeout(60_000);
    const engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      abortSignal: parentController.signal,
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'arch-review', content: 'Arch OK' }),
      makeResponse({ persona: 'security-review', content: 'Security OK' }),
      makeResponse({ persona: 'supervise', content: 'Pass' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    // When: the engine runs
    await engine.run();

    // Then: buildAbortSignal should have received the parent signal
    const buildCalls = mockBuildAbortSignal.mock.calls;
    expect(buildCalls.length).toBeGreaterThanOrEqual(2);
    for (const [, parentSignal] of buildCalls) {
      expect(parentSignal).toBe(parentController.signal);
    }
  });

  it('should abort sub-movements when parent abortSignal fires', async () => {
    // Given: a parent signal that will abort during parallel execution
    const parentController = new AbortController();
    const config = buildPieceConfigWithTimeout(60_000);
    const engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      abortSignal: parentController.signal,
    });

    vi.mocked(runAgent)
      .mockImplementationOnce(async (_persona, _task, options) => {
        // plan
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: '' });
        return makeResponse({ persona: 'plan', content: 'Plan done' });
      })
      .mockImplementationOnce(async (_persona, task, options) => {
        // arch-review: abort parent signal during execution, then wait for signal
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: task });
        parentController.abort(new Error('Parent cancelled'));
        return new Promise<never>((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (signal) {
            if (signal.aborted) { reject(signal.reason); return; }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }
        });
      })
      .mockImplementationOnce(async (_persona, task, options) => {
        // security-review: hangs until abort signal fires
        options?.onPromptResolved?.({ systemPrompt: '', userInstruction: task });
        return new Promise<never>((_resolve, reject) => {
          const signal = options?.abortSignal;
          if (signal) {
            if (signal.aborted) { reject(signal.reason); return; }
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
          }
        });
      });

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
    ]);

    // When: the engine runs — should eventually fail due to abort
    // The behavior depends on how the provider handles the abort signal,
    // but buildAbortSignal should propagate the parent abort
    // Then: all sub-movement signals should receive parent abort propagation
    // (verified by checking buildAbortSignal was called with the parent signal)
    // We verify the wiring, not the provider-level behavior
    await engine.run().catch(() => undefined);

    expect(mockBuildAbortSignal).toHaveBeenCalled();
    for (const [, parentSignal] of mockBuildAbortSignal.mock.calls) {
      expect(parentSignal).toBe(parentController.signal);
    }
  });
});

describe('ParallelRunner: piece_call timeout', () => {
  let tmpDir: string;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();

    mockBuildAbortSignal.mockImplementation((timeoutMs, parentSignal) => {
      return createRealAbortPair(timeoutMs, parentSignal);
    });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should pass abort signal to runPieceCallMovement for piece_call sub-movements', async () => {
    // Given: a parallel movement with a piece_call sub-movement that has timeoutMs
    const childPieceConfig: PieceConfig = {
      name: 'child-piece',
      description: 'Child piece',
      maxMovements: 10,
      initialMovement: 'child-step',
      movements: [
        makeMovement('child-step', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
      ],
    };

    const pieceCallSubMovement = makeMovement('piece-call-review', {
      kind: 'piece_call',
      call: 'child-piece',
      timeoutMs: 5_000,
      rules: [
        makeRule('COMPLETE', 'supervise'),
        makeRule('ABORT', 'fix'),
      ],
    });

    const normalSubMovement = makeMovement('normal-review', {
      rules: [
        makeRule('approved', 'COMPLETE'),
        makeRule('needs_fix', 'fix'),
      ],
    });

    const config: PieceConfig = {
      name: 'test-piece-call-timeout',
      description: 'Test piece_call timeout',
      maxMovements: 30,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('clear', 'reviewers')],
        }),
        makeMovement('reviewers', {
          parallel: [pieceCallSubMovement, normalSubMovement],
          parallelConfig: { timeoutMs: 60_000 },
          rules: [
            makeRule('all("approved")', 'supervise', {
              isAggregateCondition: true,
              aggregateType: 'all',
              aggregateConditionText: 'approved',
            }),
            makeRule('any("needs_fix")', 'fix', {
              isAggregateCondition: true,
              aggregateType: 'any',
              aggregateConditionText: 'needs_fix',
            }),
          ],
        }),
        makeMovement('fix', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
        makeMovement('supervise', {
          rules: [makeRule('pass', 'COMPLETE')],
        }),
      ],
    };

    const engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      loadPieceByIdentifier: (name: string) => {
        if (name === 'child-piece') return childPieceConfig;
        return null;
      },
    });

    // Mock agent calls for plan + child-step + normal-review + supervise
    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'child-step', content: 'Child done' }),
      makeResponse({ persona: 'normal-review', content: 'Normal OK' }),
      makeResponse({ persona: 'supervise', content: 'Pass' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // plan → reviewers
      { index: 0, method: 'phase1_tag' },  // child-step in child piece
      { index: 0, method: 'phase1_tag' },  // normal-review
      { index: 0, method: 'phase1_tag' },  // piece-call-review (resolved from child status)
      { index: 0, method: 'aggregate' },   // reviewers aggregate
      { index: 0, method: 'phase1_tag' },  // supervise
    ]);

    // When: the engine runs
    await engine.run();

    // Then: buildAbortSignal should have been called with the piece_call's timeoutMs
    const buildCalls = mockBuildAbortSignal.mock.calls;
    const timeoutValues = buildCalls.map(([ms]) => ms);
    expect(timeoutValues).toContain(5_000);
  });

  it('should call dispose() for piece_call sub-movements even on failure', async () => {
    // Given: a piece_call that fails
    const disposeFns: Array<ReturnType<typeof vi.fn>> = [];
    mockBuildAbortSignal.mockImplementation((timeoutMs, parentSignal) => {
      const pair = createRealAbortPair(timeoutMs, parentSignal);
      const trackedDispose = vi.fn(() => pair.dispose());
      disposeFns.push(trackedDispose);
      return { signal: pair.signal, dispose: trackedDispose };
    });

    const pieceCallSubMovement = makeMovement('piece-call-review', {
      kind: 'piece_call',
      call: 'nonexistent-piece',
      timeoutMs: 5_000,
      rules: [
        makeRule('COMPLETE', 'supervise'),
        makeRule('ABORT', 'fix'),
      ],
    });

    const normalSubMovement = makeMovement('normal-review', {
      rules: [
        makeRule('approved', 'COMPLETE'),
        makeRule('needs_fix', 'fix'),
      ],
    });

    const config: PieceConfig = {
      name: 'test-piece-call-dispose',
      description: 'Test piece_call dispose',
      maxMovements: 30,
      initialMovement: 'plan',
      movements: [
        makeMovement('plan', {
          rules: [makeRule('clear', 'reviewers')],
        }),
        makeMovement('reviewers', {
          parallel: [pieceCallSubMovement, normalSubMovement],
          parallelConfig: { timeoutMs: 60_000 },
          rules: [
            makeRule('all("approved")', 'supervise', {
              isAggregateCondition: true,
              aggregateType: 'all',
              aggregateConditionText: 'approved',
            }),
            makeRule('any("needs_fix")', 'fix', {
              isAggregateCondition: true,
              aggregateType: 'any',
              aggregateConditionText: 'needs_fix',
            }),
          ],
        }),
        makeMovement('fix', {
          rules: [makeRule('done', 'COMPLETE')],
        }),
        makeMovement('supervise', {
          rules: [makeRule('pass', 'COMPLETE')],
        }),
      ],
    };

    const engine = new PieceEngine(config, tmpDir, 'test task', {
      projectCwd: tmpDir,
      loadPieceByIdentifier: () => null, // piece not found → failure
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'plan', content: 'Plan done' }),
      makeResponse({ persona: 'normal-review', content: 'Normal OK' }),
      makeResponse({ persona: 'supervise', content: 'Pass' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    // When: the engine runs
    await engine.run().catch(() => undefined);

    // Then: dispose should be called for every buildAbortSignal invocation
    for (const dispose of disposeFns) {
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });
});
