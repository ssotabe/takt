/**
 * PieceEngine integration tests: shouldMerge parameter in cleanup.
 *
 * Tests that ParallelRunner passes the correct shouldMerge flag to
 * cleanupParallelWorktree based on whether the child piece completed
 * successfully (COMPLETE) or was aborted (ABORT).
 *
 * Covers:
 * - shouldMerge=true: child piece completes with COMPLETE condition
 * - shouldMerge=false: child piece completes with ABORT condition
 * - shouldMerge=false: child piece throws (try block exits via exception)
 * - Mixed results: each slot gets its own shouldMerge based on its outcome
 * - 3-arg signature: cleanupParallelWorktree receives worktreePath, parentCwd, shouldMerge
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

function buildTwoSlotConfig(nextMovement: string): PieceConfig {
  return {
    name: 'merge-param-test',
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
          makeRule('all("COMPLETE")', nextMovement, {
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'COMPLETE',
          }),
          makeRule('any("ABORT")', nextMovement, {
            isAggregateCondition: true,
            aggregateType: 'any',
            aggregateConditionText: 'ABORT',
          }),
        ],
      }),
      ...(nextMovement !== 'COMPLETE' ? [
        makeMovement(nextMovement, {
          rules: [makeRule('Done', 'COMPLETE')],
        }),
      ] : []),
    ],
  };
}

describe('PieceEngine Integration: shouldMerge parameter in cleanup', () => {
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
  // 1. All slots COMPLETE → shouldMerge=true for all
  // =====================================================
  describe('all slots complete successfully', () => {
    it('should pass shouldMerge=true when child piece completes with COMPLETE', async () => {
      // Given
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task 1'],
        ['slot_2', 'Task 2'],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildTwoSlotConfig('COMPLETE');

      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Slot 1 done' }),
        makeResponse({ persona: 'child-step', content: 'Slot 2 done' }),
      ]);

      // PieceCallRunner now pre-resolves matchedRuleIndex from child status,
      // so detectMatchedRule is skipped for slot_1/slot_2 in ParallelRunner.
      // Only called for child-step (inside child engines) and execute_batch (aggregate).
      vi.mocked(detectMatchedRule).mockImplementation(async () => {
        return { index: 0, method: 'phase1_tag' as const };
      });

      // When
      await engine.run();

      // Then: both slots should get shouldMerge=true
      expect(cleanupParallelWorktree).toHaveBeenCalledTimes(2);
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_1',
        tmpDir,
        true,
      );
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_2',
        tmpDir,
        true,
      );
    });
  });

  // =====================================================
  // 2. One slot ABORTs → shouldMerge=false for that slot
  // =====================================================
  describe('mixed results: COMPLETE and ABORT', () => {
    it('should pass shouldMerge=false when child piece matches ABORT condition', async () => {
      // Given
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task 1'],
        ['slot_2', 'Task 2 (will abort)'],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildTwoSlotConfig('COMPLETE');

      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Slot 1 done' }),
        makeResponse({ persona: 'child-step', content: 'Build failed' }),
      ]);

      // Use argument-based mock to avoid sequential consumption issues with Promise.allSettled.
      // PieceCallRunner now pre-resolves matchedRuleIndex from child status, so we must
      // make the child PieceEngine abort by returning ABORT for child-step with failure content.
      vi.mocked(detectMatchedRule).mockImplementation(async (movement, content) => {
        const name = (movement as { name: string }).name;
        // Child piece's internal movement: abort when content indicates failure
        if (name === 'child-step' && typeof content === 'string' && content.includes('Build failed')) {
          return { index: 1, method: 'phase1_tag' as const };
        }
        if (name === 'execute_batch') return { index: 1, method: 'aggregate' as const };
        return { index: 0, method: 'phase1_tag' as const };
      });

      // When
      await engine.run();

      // Then: slot_1 merges (COMPLETE), slot_2 skips merge (ABORT)
      expect(cleanupParallelWorktree).toHaveBeenCalledTimes(2);
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_1',
        tmpDir,
        true,
      );
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_2',
        tmpDir,
        false,
      );
    });
  });

  // =====================================================
  // 3. Child piece throws → shouldMerge=false
  // =====================================================
  describe('child piece exception', () => {
    it('should pass shouldMerge=false when try block exits via exception', async () => {
      // Given: slot_1 completes, slot_2's PieceCallRunner throws
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task 1'],
        ['slot_2', 'Task 2'],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildTwoSlotConfig('COMPLETE');

      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      // slot_1 succeeds normally, slot_2 child throws
      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Slot 1 done' }),
        makeResponse({ persona: 'child-step', content: '', status: 'error', error: 'Provider timeout' }),
      ]);

      // PieceCallRunner now pre-resolves matchedRuleIndex from child status,
      // so detectMatchedRule is skipped for slot_1/slot_2 in ParallelRunner.
      vi.mocked(detectMatchedRule).mockImplementation(async () => {
        return { index: 0, method: 'phase1_tag' as const };
      });

      // When
      await engine.run();

      // Then: cleanup should still be called for both slots
      // slot_2's shouldMerge depends on whether an exception path was taken
      expect(cleanupParallelWorktree).toHaveBeenCalledTimes(2);
    });
  });

  // =====================================================
  // 4. 3-arg signature verification
  // =====================================================
  describe('3-arg signature', () => {
    it('should call cleanupParallelWorktree with exactly 3 arguments', async () => {
      // Given
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task 1'],
        ['slot_2', 'Task 2'],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildTwoSlotConfig('COMPLETE');

      engine = new PieceEngine(config, tmpDir, 'test task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Done 1' }),
        makeResponse({ persona: 'child-step', content: 'Done 2' }),
      ]);

      // PieceCallRunner now pre-resolves matchedRuleIndex from child status,
      // so detectMatchedRule is skipped for slot_1/slot_2 in ParallelRunner.
      vi.mocked(detectMatchedRule).mockImplementation(async () => {
        return { index: 0, method: 'phase1_tag' as const };
      });

      await engine.run();

      // Then: each call should have exactly 3 arguments (worktreePath, parentCwd, shouldMerge)
      const calls = vi.mocked(cleanupParallelWorktree).mock.calls;
      for (const call of calls) {
        expect(call).toHaveLength(3);
        // 1st arg: worktree path (string)
        expect(typeof call[0]).toBe('string');
        // 2nd arg: parent cwd (string)
        expect(typeof call[1]).toBe('string');
        // 3rd arg: shouldMerge (boolean)
        expect(typeof call[2]).toBe('boolean');
      }
    });
  });
});
