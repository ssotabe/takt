/**
 * Tests that ParallelRunner uses getCwd() (parent worktree) — not getProjectCwd() (main repo)
 * — as the base directory for child worktree creation and merge target.
 *
 * When `takt run` executes in a worktree, cwd !== projectCwd. Child worktrees must be
 * created from and merged into the parent's cwd (the worktree), not the project root (main).
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
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
  applyDefaultMocks,
  cleanupPieceEngine,
} from './engine-test-helpers.js';
import { parseSlotSections } from '../core/piece/engine/slot-parser.js';
import { createParallelWorktree, cleanupParallelWorktree } from '../core/piece/engine/parallel-worktree.js';

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

function buildParallelPieceCallConfig(): PieceConfig {
  return {
    name: 'parent-cwd-test',
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

/**
 * Create two separate temp directories to simulate cwd !== projectCwd.
 * Returns { parentWorktree, projectRoot } where parentWorktree simulates
 * the parent's worktree and projectRoot simulates the main repo.
 */
function createSeparateTmpDirs(): { parentWorktree: string; projectRoot: string } {
  const base = join(tmpdir(), `takt-parent-cwd-test-${randomUUID()}`);
  const parentWorktree = join(base, 'parent-worktree');
  const projectRoot = join(base, 'project-root');

  for (const dir of [parentWorktree, projectRoot]) {
    mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'reports'), { recursive: true });
    mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'knowledge'), { recursive: true });
    mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'policy'), { recursive: true });
    mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'context', 'previous_responses'), { recursive: true });
    mkdirSync(join(dir, '.takt', 'runs', 'test-report-dir', 'logs'), { recursive: true });
  }

  return { parentWorktree, projectRoot };
}

describe('ParallelRunner: child worktree base directory uses parent cwd (not projectCwd)', () => {
  let dirs: { parentWorktree: string; projectRoot: string };
  let engine: PieceEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    dirs = createSeparateTmpDirs();
  });

  afterEach(() => {
    if (engine) {
      cleanupPieceEngine(engine);
      engine = null;
    }
    const base = join(dirs.parentWorktree, '..');
    if (existsSync(base)) {
      rmSync(base, { recursive: true, force: true });
    }
  });

  it('should pass getCwd() (parent worktree) to createParallelWorktree, not getProjectCwd()', async () => {
    // Given: cwd (parentWorktree) ≠ projectCwd (projectRoot)
    const slotMap = new Map<string, string>([
      ['slot_1', 'Task 1'],
      ['slot_2', 'Task 2'],
    ]);
    vi.mocked(parseSlotSections).mockReturnValue(slotMap);
    vi.mocked(createParallelWorktree).mockImplementation((_baseDir, slotName) => ({
      path: `/tmp/child-worktrees/${slotName}`,
      branch: `parallel-${slotName}`,
    }));

    const childConfig = makeChildPieceConfig();
    const loadPiece = vi.fn().mockReturnValue(childConfig);
    const config = buildParallelPieceCallConfig();

    engine = new PieceEngine(config, dirs.parentWorktree, 'test task', {
      projectCwd: dirs.projectRoot,
      loadPieceByIdentifier: loadPiece,
      initialPreviousResponse: makeResponse({
        content: '## slot_1\nTask 1\n\n## slot_2\nTask 2',
      }),
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'child-step', content: 'Done 1' }),
      makeResponse({ persona: 'child-step', content: 'Done 2' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // slot_1 child → COMPLETE
      { index: 0, method: 'phase1_tag' },  // slot_1 → COMPLETE
      { index: 0, method: 'phase1_tag' },  // slot_2 child → COMPLETE
      { index: 0, method: 'phase1_tag' },  // slot_2 → COMPLETE
      { index: 0, method: 'aggregate' },   // all("COMPLETE")
    ]);

    // When
    await engine.run();

    // Then: createParallelWorktree must receive parentWorktree (getCwd), not projectRoot (getProjectCwd)
    expect(createParallelWorktree).toHaveBeenCalledTimes(2);
    expect(createParallelWorktree).toHaveBeenCalledWith(dirs.parentWorktree, 'slot_1');
    expect(createParallelWorktree).toHaveBeenCalledWith(dirs.parentWorktree, 'slot_2');

    // Verify it was NOT called with projectRoot
    for (const call of vi.mocked(createParallelWorktree).mock.calls) {
      expect(call[0]).not.toBe(dirs.projectRoot);
    }
  });

  it('should pass getCwd() (parent worktree) to cleanupParallelWorktree as merge target', async () => {
    // Given: cwd (parentWorktree) ≠ projectCwd (projectRoot)
    const slotMap = new Map<string, string>([
      ['slot_1', 'Task 1'],
      ['slot_2', 'Task 2'],
    ]);
    vi.mocked(parseSlotSections).mockReturnValue(slotMap);
    vi.mocked(createParallelWorktree).mockImplementation((_baseDir, slotName) => ({
      path: `/tmp/child-worktrees/${slotName}`,
      branch: `parallel-${slotName}`,
    }));

    const childConfig = makeChildPieceConfig();
    const loadPiece = vi.fn().mockReturnValue(childConfig);
    const config = buildParallelPieceCallConfig();

    engine = new PieceEngine(config, dirs.parentWorktree, 'test task', {
      projectCwd: dirs.projectRoot,
      loadPieceByIdentifier: loadPiece,
      initialPreviousResponse: makeResponse({
        content: '## slot_1\nTask 1\n\n## slot_2\nTask 2',
      }),
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'child-step', content: 'Done 1' }),
      makeResponse({ persona: 'child-step', content: 'Done 2' }),
    ]);

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // slot_1 child → COMPLETE
      { index: 0, method: 'phase1_tag' },  // slot_1 → COMPLETE
      { index: 0, method: 'phase1_tag' },  // slot_2 child → COMPLETE
      { index: 0, method: 'phase1_tag' },  // slot_2 → COMPLETE
      { index: 0, method: 'aggregate' },   // all("COMPLETE")
    ]);

    // When
    await engine.run();

    // Then: cleanupParallelWorktree must receive parentWorktree as second arg (merge target)
    expect(cleanupParallelWorktree).toHaveBeenCalledTimes(2);
    expect(cleanupParallelWorktree).toHaveBeenCalledWith(
      '/tmp/child-worktrees/slot_1',
      dirs.parentWorktree,
      true,
    );
    expect(cleanupParallelWorktree).toHaveBeenCalledWith(
      '/tmp/child-worktrees/slot_2',
      dirs.parentWorktree,
      true,
    );

    // Verify merge target is NOT projectRoot
    for (const call of vi.mocked(cleanupParallelWorktree).mock.calls) {
      expect(call[1]).not.toBe(dirs.projectRoot);
    }
  });

  it('should use getCwd() for cleanup even when a slot ABORTs (shouldMerge=false)', async () => {
    // Given: cwd ≠ projectCwd, slot_2 will ABORT
    const slotMap = new Map<string, string>([
      ['slot_1', 'Task 1'],
      ['slot_2', 'Task 2 (will fail)'],
    ]);
    vi.mocked(parseSlotSections).mockReturnValue(slotMap);
    vi.mocked(createParallelWorktree).mockImplementation((_baseDir, slotName) => ({
      path: `/tmp/child-worktrees/${slotName}`,
      branch: `parallel-${slotName}`,
    }));

    const childConfig = makeChildPieceConfig();
    const loadPiece = vi.fn().mockReturnValue(childConfig);
    const config = buildParallelPieceCallConfig();

    engine = new PieceEngine(config, dirs.parentWorktree, 'test task', {
      projectCwd: dirs.projectRoot,
      loadPieceByIdentifier: loadPiece,
      initialPreviousResponse: makeResponse({
        content: '## slot_1\nTask 1\n\n## slot_2\nTask 2 (will fail)',
      }),
    });

    mockRunAgentSequence([
      makeResponse({ persona: 'child-step', content: 'Done 1' }),
      makeResponse({ persona: 'child-step', content: 'Build failed' }),
    ]);

    const mock = vi.mocked(
      (await import('../core/piece/evaluation/index.js')).detectMatchedRule,
    );
    mock.mockImplementation(async (movement, content) => {
      const name = (movement as { name: string }).name;
      if (name === 'child-step' && typeof content === 'string' && content.includes('Build failed')) {
        return { index: 1, method: 'phase1_tag' as const };
      }
      if (name === 'execute_batch') return { index: 1, method: 'aggregate' as const };
      return { index: 0, method: 'phase1_tag' as const };
    });

    // When
    await engine.run();

    // Then: both cleanup calls use parentWorktree as merge target
    expect(cleanupParallelWorktree).toHaveBeenCalledTimes(2);

    // slot_1: shouldMerge=true, merge target = parentWorktree
    expect(cleanupParallelWorktree).toHaveBeenCalledWith(
      '/tmp/child-worktrees/slot_1',
      dirs.parentWorktree,
      true,
    );

    // slot_2: shouldMerge=false (ABORT), merge target still = parentWorktree
    expect(cleanupParallelWorktree).toHaveBeenCalledWith(
      '/tmp/child-worktrees/slot_2',
      dirs.parentWorktree,
      false,
    );

    // Verify neither call uses projectRoot
    for (const call of vi.mocked(cleanupParallelWorktree).mock.calls) {
      expect(call[1]).not.toBe(dirs.projectRoot);
    }
  });
});
