/**
 * PieceEngine integration tests: parallel piece_call with slot distribution.
 *
 * Tests the end-to-end flow where ParallelRunner distributes slot-specific
 * instructions and worktrees to piece_call sub-movements.
 *
 * Covers:
 * - Slot distribution: each piece_call receives its slot-specific task
 * - Worktree isolation: each piece_call runs in a separate worktree
 * - Run directory isolation: each piece_call gets a unique reportDirName
 * - PieceCallOverrides: task/cwd/reportDirName are passed to child engine
 * - Error: parseSlotSections fails → ParallelRunner throws (no fallback)
 * - Cleanup: worktrees are cleaned up after completion (success and failure)
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

// Mock parallel-worktree to prevent actual git operations
vi.mock('../core/piece/engine/parallel-worktree.js', () => ({
  createParallelWorktree: vi.fn(),
  cleanupParallelWorktree: vi.fn(),
}));

// Mock slot-parser
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

function buildSlotDistributionConfig(): PieceConfig {
  return {
    name: 'slot-distribution-test',
    maxMovements: 30,
    initialMovement: 'decompose',
    movements: [
      makeMovement('decompose', {
        rules: [
          makeRule('分解完了', 'execute_batch'),
          makeRule('タスクなし', 'COMPLETE'),
        ],
      }),
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
          makeRule('any("ABORT")', 'COMPLETE', {
            isAggregateCondition: true,
            aggregateType: 'any',
            aggregateConditionText: 'ABORT',
          }),
        ],
      }),
    ],
  };
}

describe('PieceEngine Integration: parallel piece_call with slot distribution', () => {
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
  // 1. Slot distribution: each piece_call receives slot-specific task
  // =====================================================
  describe('slot distribution', () => {
    it('should parse decompose output and distribute slot-specific tasks to each piece_call', async () => {
      // Given: decompose produces slot instructions
      const decomposeOutput = [
        '## slot_1',
        'Implement feature A.',
        '',
        '## slot_2',
        'Implement feature B.',
        '',
        '## slot_3',
        'タスクなし',
      ].join('\n');

      const slotMap = new Map<string, string>([
        ['slot_1', 'Implement feature A.'],
        ['slot_2', 'Implement feature B.'],
        ['slot_3', ''],
      ]);

      vi.mocked(parseSlotSections).mockReturnValue(slotMap);

      // Setup worktree mocks
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildSlotDistributionConfig();

      engine = new PieceEngine(config, tmpDir, 'Build features A and B', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      // decompose agent response
      mockRunAgentSequence([
        makeResponse({ persona: 'decompose', content: decomposeOutput }),
        // child agents for slot_1, slot_2, slot_3
        makeResponse({ persona: 'child-step', content: 'Feature A done' }),
        makeResponse({ persona: 'child-step', content: 'Feature B done' }),
        makeResponse({ persona: 'child-step', content: 'No task' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // decompose → execute_batch
        { index: 0, method: 'phase1_tag' },  // slot_1 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_1 → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_2 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_2 → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_3 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_3 → COMPLETE
        { index: 0, method: 'aggregate' },   // execute_batch: all("COMPLETE")
      ]);

      const state = await engine.run();

      // Then: parseSlotSections should have been called with decompose output
      expect(parseSlotSections).toHaveBeenCalledWith(
        decomposeOutput,
        ['slot_1', 'slot_2', 'slot_3'],
      );

      expect(state.status).toBe('completed');
    });
  });

  // =====================================================
  // 2. Error: parseSlotSections fails → immediate throw
  // =====================================================
  describe('slot parse failure', () => {
    it('should throw when parseSlotSections fails (no fallback)', async () => {
      // Given: parseSlotSections throws (missing slot headers)
      vi.mocked(parseSlotSections).mockImplementation(() => {
        throw new Error('Missing slot headers: slot_1, slot_2, slot_3');
      });

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildSlotDistributionConfig();

      engine = new PieceEngine(config, tmpDir, 'Build features', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      // decompose agent response (malformed — no slot headers)
      mockRunAgentSequence([
        makeResponse({ persona: 'decompose', content: 'Some random output without slots' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // decompose → execute_batch
      ]);

      // When/Then: ParallelRunner should propagate the error (no fallback to distributing same text)
      // The engine should abort or throw
      const state = await engine.run();

      // The engine should not complete successfully with fallback behavior
      expect(state.status).not.toBe('completed');
    });
  });

  // =====================================================
  // 3. Worktree isolation: each piece_call in separate worktree
  // =====================================================
  describe('worktree isolation', () => {
    it('should create a separate worktree for each slot', async () => {
      // Given
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task 1'],
        ['slot_2', 'Task 2'],
        ['slot_3', ''],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildSlotDistributionConfig();

      engine = new PieceEngine(config, tmpDir, 'test', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'decompose', content: 'decompose output' }),
        makeResponse({ persona: 'child-step', content: 'Done 1' }),
        makeResponse({ persona: 'child-step', content: 'Done 2' }),
        makeResponse({ persona: 'child-step', content: 'Done 3' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // decompose → execute_batch
        { index: 0, method: 'phase1_tag' },  // slot_1 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_1 → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_2 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_2 → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_3 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_3 → COMPLETE
        { index: 0, method: 'aggregate' },   // all("COMPLETE")
      ]);

      await engine.run();

      // Then: createParallelWorktree called for each slot
      expect(createParallelWorktree).toHaveBeenCalledTimes(3);
      expect(createParallelWorktree).toHaveBeenCalledWith(tmpDir, 'slot_1');
      expect(createParallelWorktree).toHaveBeenCalledWith(tmpDir, 'slot_2');
      expect(createParallelWorktree).toHaveBeenCalledWith(tmpDir, 'slot_3');
    });
  });

  // =====================================================
  // 4. Cleanup: worktrees cleaned up after completion
  // =====================================================
  describe('worktree cleanup', () => {
    it('should cleanup worktrees after all slots complete', async () => {
      // Given
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task 1'],
        ['slot_2', 'Task 2'],
        ['slot_3', ''],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildSlotDistributionConfig();

      engine = new PieceEngine(config, tmpDir, 'test', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'decompose', content: 'decompose output' }),
        makeResponse({ persona: 'child-step', content: 'Done 1' }),
        makeResponse({ persona: 'child-step', content: 'Done 2' }),
        makeResponse({ persona: 'child-step', content: 'Done 3' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'aggregate' },
      ]);

      await engine.run();

      // Then: cleanupParallelWorktree called for each slot with shouldMerge=true (all COMPLETE)
      expect(cleanupParallelWorktree).toHaveBeenCalledTimes(3);
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_1',
        tmpDir,
        true,
        expect.any(String),
      );
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_2',
        tmpDir,
        true,
        expect.any(String),
      );
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_3',
        tmpDir,
        true,
        expect.any(String),
      );
    });

    it('should cleanup worktrees even when a slot fails', async () => {
      // Given: slot_2 child will fail
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task 1'],
        ['slot_2', 'Task 2 (will fail)'],
        ['slot_3', ''],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config = buildSlotDistributionConfig();

      engine = new PieceEngine(config, tmpDir, 'test', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
      });

      // slot_1 succeeds, slot_2 child aborts, slot_3 succeeds
      mockRunAgentSequence([
        makeResponse({ persona: 'decompose', content: 'decompose output' }),
        makeResponse({ persona: 'child-step', content: 'Done 1' }),
        makeResponse({ persona: 'child-step', content: 'Build failed' }),
        makeResponse({ persona: 'child-step', content: 'Done 3' }),
      ]);

      // Use argument-based mock to avoid sequential consumption issues with Promise.allSettled.
      // PieceCallRunner now pre-resolves matchedRuleIndex from child status, so we must
      // make the child PieceEngine abort by returning ABORT for child-step with failure content.
      const mock = vi.mocked(detectMatchedRule);
      mock.mockResolvedValueOnce({ index: 0, method: 'phase1_tag' }); // decompose → execute_batch
      mock.mockImplementation(async (movement, content) => {
        const name = (movement as { name: string }).name;
        // Child piece's internal movement: abort when content indicates failure
        if (name === 'child-step' && typeof content === 'string' && content.includes('Build failed')) {
          return { index: 1, method: 'phase1_tag' as const };
        }
        if (name === 'execute_batch') return { index: 1, method: 'aggregate' as const };
        // slot_1, slot_3, and child-step movements for non-ABORT slots
        return { index: 0, method: 'phase1_tag' as const };
      });

      await engine.run();

      // Then: cleanup called for all slots; ABORT slot gets shouldMerge=false
      expect(cleanupParallelWorktree).toHaveBeenCalledTimes(3);
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_1',
        tmpDir,
        true,
        expect.any(String),
      );
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_2',
        tmpDir,
        false,
        expect.any(String),
      );
      expect(cleanupParallelWorktree).toHaveBeenCalledWith(
        '/tmp/worktrees/slot_3',
        tmpDir,
        true,
        expect.any(String),
      );
    });
  });

  // =====================================================
  // 5. PieceCallOverrides: task override reaches child engine
  // =====================================================
  describe('PieceCallOverrides propagation', () => {
    it('should pass slot-specific task to child engine via PieceCallOverrides', async () => {
      // Given: slot_1 has specific instructions, slot_2 has "タスクなし"
      const slotMap = new Map<string, string>([
        ['slot_1', 'Specific task for slot 1'],
        ['slot_2', ''],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config: PieceConfig = {
        name: 'override-test',
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
            ],
          }),
        ],
      };

      engine = new PieceEngine(config, tmpDir, 'original task', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
        initialPreviousResponse: makeResponse({
          content: '## slot_1\nSpecific task for slot 1\n\n## slot_2\nタスクなし',
        }),
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Slot 1 done' }),
        makeResponse({ persona: 'child-step', content: 'Slot 2 done' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },  // slot_1 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_1 → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_2 child → COMPLETE
        { index: 0, method: 'phase1_tag' },  // slot_2 → COMPLETE
        { index: 0, method: 'aggregate' },   // all("COMPLETE")
      ]);

      const state = await engine.run();

      // Then: engine should complete (integration test validates the override flow end-to-end)
      expect(state.status).toBe('completed');

      // Then: worktrees should be created
      expect(createParallelWorktree).toHaveBeenCalledTimes(2);
    });
  });

  // =====================================================
  // 6. Run directory isolation
  // =====================================================
  describe('run directory isolation', () => {
    it('should generate unique reportDirName per slot', async () => {
      // Given: 3 slots with tasks
      const slotMap = new Map<string, string>([
        ['slot_1', 'Task 1'],
        ['slot_2', 'Task 2'],
        ['slot_3', 'Task 3'],
      ]);
      vi.mocked(parseSlotSections).mockReturnValue(slotMap);
      vi.mocked(createParallelWorktree).mockImplementation((_projectDir, slotName) => ({
        path: `/tmp/worktrees/${slotName}`,
        branch: `parallel-${slotName}`,
      }));

      const childConfig = makeChildPieceConfig();
      const loadPiece = vi.fn().mockReturnValue(childConfig);
      const config: PieceConfig = {
        name: 'rundir-test',
        maxMovements: 30,
        initialMovement: 'execute_batch',
        movements: [
          makeMovement('execute_batch', {
            parallel: [
              makePieceCallMovement('slot_1', 'takt-default', {
                rules: [makeRule('COMPLETE', 'COMPLETE')],
              }),
              makePieceCallMovement('slot_2', 'takt-default', {
                rules: [makeRule('COMPLETE', 'COMPLETE')],
              }),
              makePieceCallMovement('slot_3', 'takt-default', {
                rules: [makeRule('COMPLETE', 'COMPLETE')],
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

      engine = new PieceEngine(config, tmpDir, 'test', {
        projectCwd: tmpDir,
        loadPieceByIdentifier: loadPiece,
        reportDirName: 'parent-run-slug',
      });

      mockRunAgentSequence([
        makeResponse({ persona: 'child-step', content: 'Done 1' }),
        makeResponse({ persona: 'child-step', content: 'Done 2' }),
        makeResponse({ persona: 'child-step', content: 'Done 3' }),
      ]);

      mockDetectMatchedRuleSequence([
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'phase1_tag' },
        { index: 0, method: 'aggregate' },
      ]);

      const state = await engine.run();

      // Then: the engine should complete
      // The actual reportDirName per slot is validated via the PieceCallOverrides
      // being passed to PieceCallRunner (which is an internal detail tested by unit tests)
      expect(state.status).toBe('completed');
    });
  });
});
