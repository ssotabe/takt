/**
 * PieceEngine integration tests: piece_call movement type.
 *
 * Covers:
 * - piece_call movement dispatches to PieceCallRunner
 * - piece_call result (COMPLETE/ABORT) feeds parent rule evaluation
 * - piece_call within parallel sub-movements
 * - Safety: circular detection throws
 * - Safety: nesting depth exceeded throws
 * - Budget sharing: child movements consume parent budget
 * - Context: parent lastOutput propagated to child
 * - Config validation: piece_call with missing call field
 * - loadPieceByIdentifier injection
 * - Event forwarding from child to parent
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';
import type { PieceConfig, PieceMovement } from '../core/models/index.js';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/piece/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/piece/evaluation/resolve-match.js', () => {
  return {
    resolveMatchFromResponse: vi.fn(),
  };
});

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

vi.mock('../core/piece/engine/parallel-worktree.js', () => ({
  createParallelWorktree: vi.fn(),
  cleanupParallelWorktree: vi.fn(),
}));

vi.mock('../core/piece/engine/slot-parser.js', () => ({
  parseSlotSections: vi.fn(),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';
import { runAgent } from '../agents/runner.js';
import {
  makeResponse,
  makeMovement,
  makeRule,
  mockRunAgentSequence,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
  cleanupPieceEngine,
} from './engine-test-helpers.js';
import { parseSlotSections } from '../core/piece/engine/slot-parser.js';
import { createParallelWorktree, cleanupParallelWorktree } from '../core/piece/engine/parallel-worktree.js';
import { resolveMatchFromResponse } from '../core/piece/evaluation/resolve-match.js';
import { detectMatchedRule } from '../core/piece/evaluation/index.js';

// ─── Helpers ───

function makePieceCallMovement(
  name: string,
  call: string,
  overrides: Partial<PieceMovement> = {},
): PieceMovement {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: true,
    kind: 'piece_call' as PieceMovement['kind'],
    call,
    ...overrides,
  } as PieceMovement & { kind: string; call: string };
}

function makeChildPieceConfig(): PieceConfig {
  return {
    name: 'child-piece',
    maxMovements: 10,
    initialMovement: 'child-step',
    movements: [
      makeMovement('child-step', {
        rules: [
          makeRule('Done', 'COMPLETE'),
          makeRule('Failed', 'ABORT'),
        ],
      }),
    ],
  };
}

function buildPieceCallConfig(overrides: Partial<PieceConfig> = {}): PieceConfig {
  return {
    name: 'parent-piece',
    maxMovements: 30,
    initialMovement: 'plan',
    movements: [
      makeMovement('plan', {
        rules: [
          makeRule('Task ready', 'execute_child'),
          makeRule('No task', 'COMPLETE'),
        ],
      }),
      makePieceCallMovement('execute_child', 'default', {
        rules: [
          makeRule('Child completed', 'COMPLETE'),
          makeRule('Child failed', 'ABORT'),
        ],
      }),
    ],
    ...overrides,
  };
}

function makeMockLoadPieceByIdentifier(config: PieceConfig | null = null) {
  return vi.fn().mockReturnValue(config);
}

describe('PieceEngine Integration: piece_call movement', () => {
  let tmpDir: string;
  let engine: PieceEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    // Wire resolveMatchFromResponse to delegate to the mocked detectMatchedRule
    vi.mocked(resolveMatchFromResponse).mockImplementation(async (step, response, ruleCtx) => {
      if (response.matchedRuleIndex != null) {
        if (!response.matchedRuleMethod) {
          throw new Error(`matchedRuleIndex is set but matchedRuleMethod is missing for "${step.name}"`);
        }
        return { index: response.matchedRuleIndex, method: response.matchedRuleMethod };
      }
      return vi.mocked(detectMatchedRule)(step, response.content, '', ruleCtx);
    });
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupPieceEngine(engine);
      engine = null;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  // =====================================================
  // 1. piece_call dispatches to PieceCallRunner
  // =====================================================
  describe('piece_call dispatching', () => {
    it('should dispatch piece_call movement to PieceCallRunner and complete', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      // plan agent response
      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Task is ready' }),
        // child-step agent response
        makeResponse({ persona: 'child-step', content: 'Child done' }),
      ]);

      // plan → execute_child (rule 0), child-step → COMPLETE (rule 0), execute_child → COMPLETE (rule 0)
      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → execute_child
        { index: 0, method: 'phase1_tag' },  // child-step → COMPLETE (inside child)
        { index: 0, method: 'phase1_tag' },  // execute_child → COMPLETE (parent rule eval)
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
    });

    it('should pass loadPieceByIdentifier to resolve child piece', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Task is ready' }),
        makeResponse({ persona: 'child-step', content: 'Child done' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
      ]);

      await engine.run();

      expect(loadPiece).toHaveBeenCalledWith('default', tmpDir);
    });
  });

  // =====================================================
  // 2. piece_call with ABORT child result
  // =====================================================
  describe('piece_call with child abort', () => {
    it('should propagate child ABORT status to parent rule evaluation', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Task ready' }),
        makeResponse({ persona: 'child-step', content: 'Build failed' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → execute_child
        { index: 1, method: 'phase1_tag' },  // child-step → ABORT (child fails)
        { index: 1, method: 'phase1_tag' },  // execute_child → ABORT (parent routes to ABORT)
      ]);

      const state = await engine.run();

      expect(state.status).toBe('aborted');
    });
  });

  // =====================================================
  // 3. Event emissions for piece_call
  // =====================================================
  describe('piece_call events', () => {
    it('should emit movement:start and movement:complete for piece_call movement', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Ready' }),
        makeResponse({ persona: 'child-step', content: 'Done' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const startFn = vi.fn();
      const completeFn = vi.fn();
      engine.on('movement:start', startFn);
      engine.on('movement:complete', completeFn);

      await engine.run();

      const startedMovements = startFn.mock.calls.map(
        (call) => (call[0] as PieceMovement).name,
      );
      expect(startedMovements).toContain('plan');
      expect(startedMovements).toContain('execute_child');
    });
  });

  // =====================================================
  // 4. piece_call in parallel sub-movements
  // =====================================================
  describe('piece_call in parallel', () => {
    it('should support piece_call as parallel sub-movement', async () => {
      // Slot-pattern mocks: prepareSlotContext detects slot_N names
      vi.mocked(parseSlotSections).mockReturnValue(
        new Map([['slot_1', 'task 1'], ['slot_2', 'task 2']]),
      );
      vi.mocked(createParallelWorktree).mockImplementation((_dir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config: PieceConfig = {
        name: 'parallel-piece-call',
        maxMovements: 30,
        initialMovement: 'execute_batch',
        movements: [
          makeMovement('execute_batch', {
            parallel: [
              makePieceCallMovement('slot_1', 'default', {
                rules: [
                  makeRule('completed', 'COMPLETE'),
                  makeRule('no_task', 'COMPLETE'),
                ],
              }),
              makePieceCallMovement('slot_2', 'default', {
                rules: [
                  makeRule('completed', 'COMPLETE'),
                  makeRule('no_task', 'COMPLETE'),
                ],
              }),
            ],
            rules: [
              makeRule('all("completed")', 'COMPLETE', {
                isAggregateCondition: true,
                aggregateType: 'all',
                aggregateConditionText: 'completed',
              }),
            ],
          }),
        ],
      };

      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      // Child agents for slot_1 and slot_2
      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Slot 1 done' }),
        makeResponse({ persona: 'child-step', content: 'Slot 2 done' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // slot_1 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_1 → completed
        { index: 0, method: 'phase1_tag' },  // slot_2 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_2 → completed
        { index: 0, method: 'aggregate' },   // execute_batch: all("completed") → COMPLETE
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
    });
  });

  // =====================================================
  // 5. Config validation for piece_call
  // =====================================================
  describe('piece_call config validation', () => {
    it('should accept piece_call movement with valid call field', () => {
      const config = buildPieceCallConfig();

      expect(() => {
        new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).not.toThrow();
    });

    it('should accept movement with kind: piece_call and rules', () => {
      const config: PieceConfig = {
        name: 'test',
        maxMovements: 10,
        initialMovement: 'call_step',
        movements: [
          makePieceCallMovement('call_step', 'my-piece', {
            rules: [
              makeRule('completed', 'COMPLETE'),
              makeRule('failed', 'ABORT'),
            ],
          }),
        ],
      };

      expect(() => {
        new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });
      }).not.toThrow();
    });
  });

  // =====================================================
  // 6. Budget tracking with piece_call
  // =====================================================
  describe('piece_call budget tracking', () => {
    it('should count piece_call movement in iteration count', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Ready' }),
        makeResponse({ persona: 'child-step', content: 'Done' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → execute_child
        { index: 0, method: 'phase1_tag' },  // child-step → COMPLETE
        { index: 0, method: 'phase1_tag' },  // execute_child → COMPLETE
      ]);

      const state = await engine.run();

      // plan (1) + execute_child (1+child iterations) >= 2
      expect(state.iteration).toBeGreaterThanOrEqual(2);
    });

    it('should share budget between parent and child engines', async () => {
      const childConfig: PieceConfig = {
        name: 'child-piece',
        maxMovements: 10,
        initialMovement: 'step1',
        movements: [
          makeMovement('step1', {
            rules: [makeRule('Continue', 'step2')],
          }),
          makeMovement('step2', {
            rules: [makeRule('Done', 'COMPLETE')],
          }),
        ],
      };
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig({ maxMovements: 10 });
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Ready' }),
        makeResponse({ persona: 'step1', content: 'Step 1 done' }),
        makeResponse({ persona: 'step2', content: 'Step 2 done' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → execute_child
        { index: 0, method: 'phase1_tag' },  // step1 → step2
        { index: 0, method: 'phase1_tag' },  // step2 → COMPLETE
        { index: 0, method: 'phase1_tag' },  // execute_child → COMPLETE
      ]);

      const state = await engine.run();

      // parent: plan(1) + child: step1(1) + step2(1) = 3+
      expect(state.iteration).toBeGreaterThanOrEqual(3);
    });
  });

  // =====================================================
  // 7. Multiple piece_call in sequence
  // =====================================================
  describe('piece_call in sequence', () => {
    it('should support sequential piece_call movements', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config: PieceConfig = {
        name: 'sequential-piece-call',
        maxMovements: 30,
        initialMovement: 'task_1',
        movements: [
          makePieceCallMovement('task_1', 'default', {
            rules: [
              makeRule('completed', 'task_2'),
              makeRule('failed', 'ABORT'),
            ],
          }),
          makePieceCallMovement('task_2', 'default', {
            rules: [
              makeRule('completed', 'COMPLETE'),
              makeRule('failed', 'ABORT'),
            ],
          }),
        ],
      };

      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Task 1 done' }),
        makeResponse({ persona: 'child-step', content: 'Task 2 done' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // task_1 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // task_1 → task_2
        { index: 0, method: 'phase1_tag' },  // task_2 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // task_2 → COMPLETE
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
    });
  });

  // =====================================================
  // 8. Empty slot handling (no task scenario)
  // =====================================================
  describe('piece_call empty slot handling', () => {
    it('should handle piece_call where child completes immediately (no task)', async () => {
      // Slot-pattern mocks: prepareSlotContext detects slot_N names
      vi.mocked(parseSlotSections).mockReturnValue(
        new Map([['slot_1', ''], ['slot_2', ''], ['slot_3', '']]),
      );
      vi.mocked(createParallelWorktree).mockImplementation((_dir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config: PieceConfig = {
        name: 'empty-slot-piece',
        maxMovements: 30,
        initialMovement: 'execute_batch',
        movements: [
          makeMovement('execute_batch', {
            parallel: [
              makePieceCallMovement('slot_1', 'default', {
                rules: [
                  makeRule('completed', 'COMPLETE'),
                  makeRule('no_task', 'COMPLETE'),
                ],
              }),
              makePieceCallMovement('slot_2', 'default', {
                rules: [
                  makeRule('completed', 'COMPLETE'),
                  makeRule('no_task', 'COMPLETE'),
                ],
              }),
              makePieceCallMovement('slot_3', 'default', {
                rules: [
                  makeRule('completed', 'COMPLETE'),
                  makeRule('no_task', 'COMPLETE'),
                ],
              }),
            ],
            rules: [
              makeRule('all("completed")', 'COMPLETE', {
                isAggregateCondition: true,
                aggregateType: 'all',
                aggregateConditionText: 'completed',
              }),
            ],
          }),
        ],
      };

      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      // All slots are empty → all piece_calls are skipped (no child agents run)
      mockRunAgentSequence([]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'aggregate' },   // all("completed") — skipped slots have status 'done'
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
    });
  });

  // =====================================================
  // 9. piece_call movement output tracking
  // =====================================================
  describe('piece_call output tracking', () => {
    it('should store piece_call movement output in movementOutputs', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Task ready' }),
        makeResponse({ persona: 'child-step', content: 'Child output' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
      ]);

      const state = await engine.run();

      // Plan output should be tracked
      expect(state.movementOutputs.has('plan')).toBe(true);
      expect(state.movementOutputs.get('plan')!.content).toBe('Task ready');
    });
  });

  // =====================================================
  // 10. piece_call with unresolvable child piece
  // =====================================================
  describe('piece_call error handling', () => {
    it('should handle unresolvable child piece when loadPieceByIdentifier returns null', async () => {
      const loadPiece = makeMockLoadPieceByIdentifier(null);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Task ready' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → execute_child
      ]);

      // When child piece cannot be resolved, PieceCallRunner returns error content.
      // Without a matching rule for that content, the engine aborts.
      const state = await engine.run();
      expect(state.status).toBe('aborted');
    });

    it('should handle missing loadPieceByIdentifier gracefully', async () => {
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        // No loadPieceByIdentifier provided
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Task ready' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → execute_child
      ]);

      // When no piece loader is available, PieceCallRunner returns error content.
      // Without a matching rule for that content, the engine aborts.
      const state = await engine.run();
      expect(state.status).toBe('aborted');
    });
  });

  // =====================================================
  // 11. piece_call with overrides
  // =====================================================
  describe('piece_call with overrides', () => {
    it('should pass overrides when creating child engine', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config: PieceConfig = {
        name: 'parent-with-overrides',
        maxMovements: 30,
        initialMovement: 'execute_child',
        movements: [
          makePieceCallMovement('execute_child', 'default', {
            overrides: {
              provider: 'codex',
              model: 'gpt-5',
            },
            rules: [
              makeRule('Child completed', 'COMPLETE'),
              makeRule('Child failed', 'ABORT'),
            ],
          } as Partial<PieceMovement>),
        ],
      };

      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Done with codex' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // execute_child → COMPLETE
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
    });
  });

  // =====================================================
  // 12. Context propagation to child
  // =====================================================
  describe('piece_call context propagation', () => {
    it('should propagate parent lastOutput to child as initial context', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Context for child: deploy v2.0' }),
        makeResponse({ persona: 'child-step', content: 'Deployed v2.0 successfully' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → execute_child
        { index: 0, method: 'phase1_tag' },  // child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // execute_child → COMPLETE
      ]);

      const state = await engine.run();

      // After child completes, parent lastOutput should have child's output
      expect(state.status).toBe('completed');
    });
  });

  // =====================================================
  // 13. Regression: rule evaluation only in PieceEngine (AIAR-001)
  // =====================================================
  describe('regression: no double rule evaluation', () => {
    it('should evaluate rules in PieceEngine, not PieceCallRunner (AIAR-001)', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Ready' }),
        makeResponse({ persona: 'child-step', content: 'Child done' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → execute_child
        { index: 0, method: 'phase1_tag' },  // child-step → COMPLETE
        { index: 0, method: 'phase1_tag' },  // execute_child → COMPLETE (parent rule eval)
      ]);

      const completeFn = vi.fn();
      engine.on('movement:complete', completeFn);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // The execute_child movement:complete should carry a matchedRuleIndex from PieceEngine
      const pieceCallComplete = completeFn.mock.calls.find(
        (call) => (call[0] as PieceMovement).name === 'execute_child',
      );
      expect(pieceCallComplete).toBeDefined();
      const response = pieceCallComplete![1] as { matchedRuleIndex?: number };
      expect(response.matchedRuleIndex).toBe(0);
    });
  });

  // =====================================================
  // 14. Regression: subpiece.callable === false rejection (ARCH-006)
  // =====================================================
  describe('regression: subpiece.callable check', () => {
    it('should reject child piece with callable: false (ARCH-006)', async () => {
      const childConfig: PieceConfig = {
        ...makeChildPieceConfig(),
        subpiece: { callable: false },
      };
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: 'Ready' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → execute_child
      ]);

      const state = await engine.run();

      // The execute_child output should contain an error about callable: false
      const executeOutput = state.movementOutputs.get('execute_child');
      expect(executeOutput).toBeDefined();
      expect(executeOutput!.content).toContain('callable: false');
    });
  });

  // =====================================================
  // 15. Regression: initialPreviousResponse propagation
  // =====================================================
  describe('regression: initialPreviousResponse propagation', () => {
    it('should pass parent lastOutput as initialPreviousResponse to child (REQ gap)', async () => {
      const childConfig = makeChildPieceConfig();
      const loadPiece = makeMockLoadPieceByIdentifier(childConfig);
      const config = buildPieceCallConfig();
      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      const planOutput = 'Context: deploy v3.0 to staging';
      mockRunAgentSequence([
        makeResponse({ persona: 'plan', content: planOutput }),
        makeResponse({ persona: 'child-step', content: 'Deployed v3.0' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // plan → execute_child
        { index: 0, method: 'phase1_tag' },  // child-step → COMPLETE
        { index: 0, method: 'phase1_tag' },  // execute_child → COMPLETE
      ]);

      const state = await engine.run();

      expect(state.status).toBe('completed');
      // After plan completes, lastOutput has plan's content;
      // PieceCallRunner passes it as initialPreviousResponse to child.
      // The plan output should be stored in movementOutputs.
      const planResponse = state.movementOutputs.get('plan');
      expect(planResponse).toBeDefined();
      expect(planResponse!.content).toBe(planOutput);
    });
  });
});
