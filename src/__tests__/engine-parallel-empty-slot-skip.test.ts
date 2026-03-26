/**
 * PieceEngine integration tests: empty slot piece_call skipping.
 *
 * Tests the end-to-end flow where ParallelRunner skips piece_call
 * sub-movements when slotContext exists but slotOverrides is undefined
 * (indicating an empty slot with no assigned task).
 *
 * Covers:
 * - Empty slot piece_call is skipped (no child engine created)
 * - Skipped slot returns status 'done' with empty content
 * - Skipped slot is included in aggregated results
 * - No worktree cleanup for skipped slots (no worktree was created)
 * - Mixed scenario: non-empty slots execute, empty slots are skipped
 * - All slots empty: all piece_calls skipped, piece completes
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
import { runAgent } from '../agents/runner.js';

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

function buildTwoSlotConfig(): PieceConfig {
  return {
    name: 'empty-slot-skip-test',
    maxMovements: 30,
    initialMovement: 'execute_batch',
    movements: [
      makeMovement('execute_batch', {
        parallel: [
          makePieceCallMovement('slot_1', 'takt-default', {
            rules: [
              makeRule('COMPLETE', 'COMPLETE'),
              makeRule('ABORT', 'ABORT'),
            ],
          }),
          makePieceCallMovement('slot_2', 'takt-default', {
            rules: [
              makeRule('COMPLETE', 'COMPLETE'),
              makeRule('ABORT', 'ABORT'),
            ],
          }),
        ],
        rules: [
          makeRule('all("COMPLETE")', 'COMPLETE', {
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'COMPLETE',
          }),
          makeRule('any("ABORT")', 'ABORT', {
            isAggregateCondition: true,
            aggregateType: 'any',
            aggregateConditionText: 'ABORT',
          }),
        ],
      }),
    ],
  };
}

function buildThreeSlotConfig(): PieceConfig {
  return {
    name: 'empty-slot-skip-test',
    maxMovements: 30,
    initialMovement: 'execute_batch',
    movements: [
      makeMovement('execute_batch', {
        parallel: [
          makePieceCallMovement('slot_1', 'takt-default', {
            rules: [
              makeRule('COMPLETE', 'COMPLETE'),
              makeRule('ABORT', 'ABORT'),
            ],
          }),
          makePieceCallMovement('slot_2', 'takt-default', {
            rules: [
              makeRule('COMPLETE', 'COMPLETE'),
              makeRule('ABORT', 'ABORT'),
            ],
          }),
          makePieceCallMovement('slot_3', 'takt-default', {
            rules: [
              makeRule('COMPLETE', 'COMPLETE'),
              makeRule('ABORT', 'ABORT'),
            ],
          }),
        ],
        rules: [
          makeRule('all("COMPLETE")', 'COMPLETE', {
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'COMPLETE',
          }),
          makeRule('any("ABORT")', 'ABORT', {
            isAggregateCondition: true,
            aggregateType: 'any',
            aggregateConditionText: 'ABORT',
          }),
        ],
      }),
    ],
  };
}

describe('PieceEngine Integration: empty slot piece_call skipping', () => {
  let tmpDir: string;
  let engine: PieceEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
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
  // 1. Empty slot is skipped, non-empty slot executes
  // =====================================================
  describe('mixed empty and non-empty slots', () => {
    it('should skip empty slot and execute non-empty slot', async () => {
      // Given: slot_1 has task, slot_2 is empty (no overrides generated by slot-context)
      const slotMap = new Map<string, string>([
        ['slot_1', 'Implement feature A'],
        ['slot_2', ''],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);

      // Only slot_1 gets a worktree (slot-context skips empty slots)
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildTwoSlotConfig();

      engine = new PieceEngine(config, tmpDir, 'Build feature A', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
        initialPreviousResponse: makeResponse({
          content: '## slot_1\nImplement feature A\n\n## slot_2\nタスクなし',
        }),
      });

      // Only slot_1's child agent runs
      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Feature A done' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // slot_1 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_1 → COMPLETE
        { index: 0, method: 'aggregate' },   // execute_batch: all("COMPLETE")
      ]);

      // When
      const state = await engine.run();

      // Then: piece completes successfully
      expect(state.status).toBe('completed');

      // Then: worktree created only for slot_1
      expect(createParallelWorktree).toHaveBeenCalledTimes(1);
      expect(createParallelWorktree).toHaveBeenCalledWith(tmpDir, 'slot_1');

      // Then: child agent called only once (for slot_1)
      expect(runAgent).toHaveBeenCalledTimes(1);
    });
  });

  // =====================================================
  // 2. Skipped slot has empty content in aggregated results
  // =====================================================
  describe('skipped slot in aggregated results', () => {
    it('should include skipped slot with empty content in movementOutputs', async () => {
      // Given: slot_1 has task, slot_2 is empty
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task A'],
        ['slot_2', ''],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildTwoSlotConfig();

      engine = new PieceEngine(config, tmpDir, 'test', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
        initialPreviousResponse: makeResponse({
          content: '## slot_1\nTask A\n\n## slot_2\nタスクなし',
        }),
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Done A' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'aggregate' },
      ]);

      // When
      const state = await engine.run();

      // Then: slot_2's movementOutput exists with empty content
      const slot2Output = state.movementOutputs.get('slot_2');
      expect(slot2Output).toBeDefined();
      expect(slot2Output!.status).toBe('done');
      expect(slot2Output!.content).toBe('');
    });
  });

  // =====================================================
  // 3. No worktree cleanup for skipped slots
  // =====================================================
  describe('no worktree cleanup for skipped slots', () => {
    it('should not call cleanupParallelWorktree for skipped empty slots', async () => {
      // Given: slot_1 has task, slot_2 is empty
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task A'],
        ['slot_2', ''],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildTwoSlotConfig();

      engine = new PieceEngine(config, tmpDir, 'test', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
        initialPreviousResponse: makeResponse({
          content: '## slot_1\nTask A\n\n## slot_2\nタスクなし',
        }),
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Done A' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'aggregate' },
      ]);

      // When
      await engine.run();

      // Then: cleanup only for slot_1 (slot_2 had no worktree)
      expect(cleanupParallelWorktree).toHaveBeenCalledTimes(1);
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_1',
        tmpDir,
        true,
        expect.any(String),
      );
    });
  });

  // =====================================================
  // 4. Three slots: one empty in the middle
  // =====================================================
  describe('three slots with middle slot empty', () => {
    it('should skip only the empty middle slot', async () => {
      // Given: slot_1 and slot_3 have tasks, slot_2 is empty
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task A'],
        ['slot_2', ''],
        ['slot_3', 'Task C'],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildThreeSlotConfig();

      engine = new PieceEngine(config, tmpDir, 'test', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
        initialPreviousResponse: makeResponse({
          content: '## slot_1\nTask A\n\n## slot_2\nタスクなし\n\n## slot_3\nTask C',
        }),
      });

      // Two child agents run (slot_1 and slot_3)
      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Done A' }),
        makeResponse({ persona: 'child-step', content: 'Done C' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // slot_1 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_1 → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_3 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_3 → COMPLETE
        { index: 0, method: 'aggregate' },   // all("COMPLETE")
      ]);

      // When
      const state = await engine.run();

      // Then: piece completes
      expect(state.status).toBe('completed');

      // Then: worktrees created for slot_1 and slot_3 only
      expect(createParallelWorktree).toHaveBeenCalledTimes(2);
      expect(createParallelWorktree).toHaveBeenCalledWith(tmpDir, 'slot_1');
      expect(createParallelWorktree).toHaveBeenCalledWith(tmpDir, 'slot_3');

      // Then: child agent called twice (slot_1 and slot_3)
      expect(runAgent).toHaveBeenCalledTimes(2);

      // Then: cleanup for slot_1 and slot_3 only
      expect(cleanupParallelWorktree).toHaveBeenCalledTimes(2);
    });
  });

  // =====================================================
  // 5. All slots empty: all piece_calls skipped
  // =====================================================
  describe('all slots empty', () => {
    it('should skip all piece_calls when all slots are empty', async () => {
      // Given: both slots are empty
      const slotMap = new Map<string, string>([
        ['slot_1', ''],
        ['slot_2', ''],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildTwoSlotConfig();

      engine = new PieceEngine(config, tmpDir, 'test', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
        initialPreviousResponse: makeResponse({
          content: '## slot_1\nタスクなし\n\n## slot_2\nタスクなし',
        }),
      });

      // No child agents should run
      mockRunAgentSequence([]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'aggregate' },   // execute_batch: all("COMPLETE") — both skipped with 'done'
      ]);

      // When
      const state = await engine.run();

      // Then: piece completes
      expect(state.status).toBe('completed');

      // Then: no worktrees created
      expect(createParallelWorktree).not.toHaveBeenCalled();

      // Then: no child agents called
      expect(runAgent).not.toHaveBeenCalled();

      // Then: no worktree cleanup
      expect(cleanupParallelWorktree).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 6. Non-slot piece_call (no slot pattern) still executes normally
  // =====================================================
  describe('non-slot piece_call without slot pattern', () => {
    it('should not skip piece_call when slotContext is undefined', async () => {
      // Given: piece_call movements without slot_N naming (no slot pattern detected)
      const config: PieceConfig = {
        name: 'non-slot-test',
        maxMovements: 30,
        initialMovement: 'execute_batch',
        movements: [
          makeMovement('execute_batch', {
            parallel: [
              makePieceCallMovement('task-a', 'takt-default', {
                rules: [
                  makeRule('COMPLETE', 'COMPLETE'),
                  makeRule('ABORT', 'ABORT'),
                ],
              }),
              makePieceCallMovement('task-b', 'takt-default', {
                rules: [
                  makeRule('COMPLETE', 'COMPLETE'),
                  makeRule('ABORT', 'ABORT'),
                ],
              }),
            ],
            rules: [
              makeRule('all("COMPLETE")', 'COMPLETE', {
                isAggregateCondition: true,
                aggregateType: 'all',
                aggregateConditionText: 'COMPLETE',
              }),
            ],
          }),
        ],
      };

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);

      engine = new PieceEngine(config, tmpDir, 'test', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      // Both child agents run (no slot pattern → no skipping)
      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Done A' }),
        makeResponse({ persona: 'child-step', content: 'Done B' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // task-a child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // task-a → COMPLETE
        { index: 0, method: 'phase1_tag' },  // task-b child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // task-b → COMPLETE
        { index: 0, method: 'aggregate' },   // all("COMPLETE")
      ]);

      // When
      const state = await engine.run();

      // Then: piece completes with both piece_calls executed
      expect(state.status).toBe('completed');
      expect(runAgent).toHaveBeenCalledTimes(2);
    });
  });
});
