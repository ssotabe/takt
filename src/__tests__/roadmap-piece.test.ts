/**
 * Tests for roadmap piece YAML validation and integration.
 *
 * Covers:
 * - Schema validation of roadmap.yaml structure (5 movements: decompose, review_decomposition, assign_slots, execute_batch, check_remaining)
 * - review_decomposition parallel movement with 3 reviewer sub-movements
 * - parallel movement with 2 piece_call sub-movements validates against PieceConfigRawSchema
 * - piece_call constraints respected (no persona/instruction/edit on piece_call slots)
 * - decompose → review_decomposition → assign_slots → execute_batch / decompose transition rules
 * - personas section map with 3 decomposition reviewer personas
 * - piece-categories.yaml includes roadmap in 「その他」 category
 * - Integration: roadmap piece loads via pieceLoader
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PieceConfigRawSchema, PieceMovementRawSchema, ParallelSubMovementRawSchema } from '../core/models/schemas.js';

// ─── Helpers ───

/**
 * Builds the raw YAML-equivalent object for the roadmap piece.
 * This mirrors the planned roadmap.yaml structure including review_decomposition.
 */
function makeRoadmapPieceRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'roadmap',
    description: 'ロードマップ実行ピース（タスク分解 → 2並列piece_call → バッチループ）',
    max_movements: 200,
    initial_movement: 'decompose',
    personas: {
      'decomposition-dependency-reviewer': '../facets/personas/decomposition-dependency-reviewer.md',
      'decomposition-granularity-reviewer': '../facets/personas/decomposition-granularity-reviewer.md',
      'decomposition-coverage-reviewer': '../facets/personas/decomposition-coverage-reviewer.md',
    },
    movements: [
      {
        name: 'decompose',
        persona: 'planner',
        edit: false,
        instruction: 'Decompose the roadmap into individual tasks.',
        output_contracts: {
          report: [
            { name: 'roadmap-tasks.md', format: 'plan' },
          ],
        },
        rules: [
          { condition: '分解完了', next: 'review_decomposition' },
          { condition: 'タスクなし', next: 'COMPLETE' },
          { condition: '要件不明', next: 'ABORT' },
        ],
      },
      {
        name: 'review_decomposition',
        parallel: [
          {
            name: 'dependency-review',
            persona: 'decomposition-dependency-reviewer',
            edit: false,
            instruction: 'Review task decomposition for dependency and execution order issues.',
            rules: [
              { condition: 'approved' },
              { condition: 'needs_fix' },
            ],
          },
          {
            name: 'granularity-review',
            persona: 'decomposition-granularity-reviewer',
            edit: false,
            instruction: 'Review task decomposition for granularity and scope issues.',
            rules: [
              { condition: 'approved' },
              { condition: 'needs_fix' },
            ],
          },
          {
            name: 'coverage-review',
            persona: 'decomposition-coverage-reviewer',
            edit: false,
            instruction: 'Review task decomposition for requirements coverage.',
            rules: [
              { condition: 'approved' },
              { condition: 'needs_fix' },
            ],
          },
        ],
        rules: [
          { condition: 'all("approved")', next: 'assign_slots' },
          { condition: 'any("needs_fix")', next: 'decompose' },
        ],
      },
      {
        name: 'assign_slots',
        persona: 'planner',
        edit: false,
        instruction: 'Assign next batch of tasks to slots.',
        output_contracts: {
          report: [
            { name: 'roadmap-tasks.md', format: 'plan' },
          ],
        },
        rules: [
          { condition: 'バッチ実行', next: 'execute_batch' },
          { condition: 'タスクなし', next: 'COMPLETE' },
        ],
      },
      {
        name: 'execute_batch',
        parallel: [
          {
            name: 'slot_1',
            kind: 'piece_call',
            call: 'takt-default',
            rules: [
              { condition: 'COMPLETE' },
              { condition: 'ABORT' },
            ],
          },
          {
            name: 'slot_2',
            kind: 'piece_call',
            call: 'takt-default',
            rules: [
              { condition: 'COMPLETE' },
              { condition: 'ABORT' },
            ],
          },
        ],
        rules: [
          { condition: 'all("COMPLETE")', next: 'check_remaining' },
          { condition: 'any("ABORT")', next: 'check_remaining' },
        ],
      },
      {
        name: 'check_remaining',
        persona: 'planner',
        edit: false,
        instruction: 'Check remaining tasks from {report:roadmap-tasks.md}.',
        rules: [
          { condition: '失敗スロットあり', next: 'assign_slots' },
          { condition: '残りタスクあり', next: 'assign_slots' },
          { condition: '全タスク完了', next: 'COMPLETE' },
          { condition: 'リトライ上限到達', next: 'COMPLETE' },
        ],
      },
    ],
    ...overrides,
  };
}

function makeParallelPieceCallSlot(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'slot_1',
    kind: 'piece_call',
    call: 'takt-default',
    rules: [
      { condition: 'COMPLETE' },
      { condition: 'ABORT' },
    ],
    ...overrides,
  };
}

// ─── Schema validation: full roadmap piece config ───

describe('roadmap piece: PieceConfigRawSchema validation', () => {
  it('should accept the complete roadmap piece structure', () => {
    const raw = makeRoadmapPieceRaw();

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept roadmap piece with max_movements: 200', () => {
    const raw = makeRoadmapPieceRaw();

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.max_movements).toBe(200);
    }
  });

  it('should accept roadmap piece with initial_movement: decompose', () => {
    const raw = makeRoadmapPieceRaw();

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.initial_movement).toBe('decompose');
    }
  });

  it('should have exactly 5 movements', () => {
    const raw = makeRoadmapPieceRaw();

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.movements).toHaveLength(5);
    }
  });

  it('should accept roadmap piece with personas section map', () => {
    const raw = makeRoadmapPieceRaw();

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.personas).toBeDefined();
      expect(Object.keys(result.data.personas!)).toHaveLength(3);
      expect(result.data.personas!['decomposition-dependency-reviewer']).toBeDefined();
      expect(result.data.personas!['decomposition-granularity-reviewer']).toBeDefined();
      expect(result.data.personas!['decomposition-coverage-reviewer']).toBeDefined();
    }
  });
});

// ─── Schema validation: decompose movement ───

describe('roadmap piece: decompose movement', () => {
  it('should accept decompose as an agent movement with persona and instruction', () => {
    const decompose = {
      name: 'decompose',
      persona: 'planner',
      edit: false,
      instruction: 'Decompose the roadmap into individual tasks.',
      rules: [
        { condition: '分解完了', next: 'review_decomposition' },
        { condition: 'タスクなし', next: 'COMPLETE' },
        { condition: '要件不明', next: 'ABORT' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(decompose);

    expect(result.success).toBe(true);
  });

  it('should accept decompose with output_contracts for roadmap-tasks.md', () => {
    const decompose = {
      name: 'decompose',
      persona: 'planner',
      edit: false,
      instruction: 'Decompose the roadmap.',
      output_contracts: {
        report: [
          { name: 'roadmap-tasks.md', format: 'plan' },
        ],
      },
      rules: [
        { condition: '分解完了', next: 'review_decomposition' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(decompose);

    expect(result.success).toBe(true);
  });

  it('should have 分解完了 rule transitioning to review_decomposition', () => {
    const decompose = {
      name: 'decompose',
      persona: 'planner',
      edit: false,
      instruction: 'Decompose the roadmap.',
      rules: [
        { condition: '分解完了', next: 'review_decomposition' },
        { condition: 'タスクなし', next: 'COMPLETE' },
        { condition: '要件不明', next: 'ABORT' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(decompose);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules).toHaveLength(3);
      const decomposeRule = result.data.rules?.find(r => r.condition === '分解完了');
      expect(decomposeRule).toBeDefined();
      expect(decomposeRule!.next).toBe('review_decomposition');
    }
  });
});

// ─── Schema validation: review_decomposition movement (parallel reviewers) ───

describe('roadmap piece: review_decomposition movement', () => {
  it('should accept review_decomposition with 3 parallel reviewer sub-movements', () => {
    const reviewDecomposition = {
      name: 'review_decomposition',
      parallel: [
        {
          name: 'dependency-review',
          persona: 'decomposition-dependency-reviewer',
          edit: false,
          instruction: 'Review dependencies.',
          rules: [
            { condition: 'approved' },
            { condition: 'needs_fix' },
          ],
        },
        {
          name: 'granularity-review',
          persona: 'decomposition-granularity-reviewer',
          edit: false,
          instruction: 'Review granularity.',
          rules: [
            { condition: 'approved' },
            { condition: 'needs_fix' },
          ],
        },
        {
          name: 'coverage-review',
          persona: 'decomposition-coverage-reviewer',
          edit: false,
          instruction: 'Review coverage.',
          rules: [
            { condition: 'approved' },
            { condition: 'needs_fix' },
          ],
        },
      ],
      rules: [
        { condition: 'all("approved")', next: 'assign_slots' },
        { condition: 'any("needs_fix")', next: 'decompose' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(reviewDecomposition);

    expect(result.success).toBe(true);
  });

  it('should have aggregate rule all("approved") routing to assign_slots', () => {
    const reviewDecomposition = {
      name: 'review_decomposition',
      parallel: [
        {
          name: 'dependency-review',
          persona: 'decomposition-dependency-reviewer',
          edit: false,
          instruction: 'Review.',
          rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
        },
      ],
      rules: [
        { condition: 'all("approved")', next: 'assign_slots' },
        { condition: 'any("needs_fix")', next: 'decompose' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(reviewDecomposition);

    expect(result.success).toBe(true);
    if (result.success) {
      const allApprovedRule = result.data.rules?.find(r => r.condition === 'all("approved")');
      expect(allApprovedRule).toBeDefined();
      expect(allApprovedRule!.next).toBe('assign_slots');
    }
  });

  it('should have aggregate rule any("needs_fix") routing back to decompose', () => {
    const reviewDecomposition = {
      name: 'review_decomposition',
      parallel: [
        {
          name: 'dependency-review',
          persona: 'decomposition-dependency-reviewer',
          edit: false,
          instruction: 'Review.',
          rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
        },
      ],
      rules: [
        { condition: 'all("approved")', next: 'assign_slots' },
        { condition: 'any("needs_fix")', next: 'decompose' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(reviewDecomposition);

    expect(result.success).toBe(true);
    if (result.success) {
      const needsFixRule = result.data.rules?.find(r => r.condition === 'any("needs_fix")');
      expect(needsFixRule).toBeDefined();
      expect(needsFixRule!.next).toBe('decompose');
    }
  });

  it('should have each reviewer sub-movement with edit: false', () => {
    const subMovements = [
      {
        name: 'dependency-review',
        persona: 'decomposition-dependency-reviewer',
        edit: false,
        instruction: 'Review dependencies.',
        rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
      },
      {
        name: 'granularity-review',
        persona: 'decomposition-granularity-reviewer',
        edit: false,
        instruction: 'Review granularity.',
        rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
      },
      {
        name: 'coverage-review',
        persona: 'decomposition-coverage-reviewer',
        edit: false,
        instruction: 'Review coverage.',
        rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
      },
    ];

    for (const sub of subMovements) {
      const result = ParallelSubMovementRawSchema.safeParse(sub);

      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.edit).toBe(false);
      }
    }
  });

  it('should have each reviewer sub-movement with a dedicated persona', () => {
    const subMovements = [
      {
        name: 'dependency-review',
        persona: 'decomposition-dependency-reviewer',
        edit: false,
        instruction: 'Review.',
        rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
      },
      {
        name: 'granularity-review',
        persona: 'decomposition-granularity-reviewer',
        edit: false,
        instruction: 'Review.',
        rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
      },
      {
        name: 'coverage-review',
        persona: 'decomposition-coverage-reviewer',
        edit: false,
        instruction: 'Review.',
        rules: [{ condition: 'approved' }, { condition: 'needs_fix' }],
      },
    ];

    const personas = subMovements.map(s => s.persona);
    const uniquePersonas = new Set(personas);
    expect(uniquePersonas.size).toBe(3);
  });

  it('should have each reviewer sub-movement with approved and needs_fix rules', () => {
    const sub = {
      name: 'dependency-review',
      persona: 'decomposition-dependency-reviewer',
      edit: false,
      instruction: 'Review.',
      rules: [
        { condition: 'approved' },
        { condition: 'needs_fix' },
      ],
    };

    const result = ParallelSubMovementRawSchema.safeParse(sub);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules).toHaveLength(2);
      const conditions = result.data.rules!.map(r => r.condition);
      expect(conditions).toContain('approved');
      expect(conditions).toContain('needs_fix');
    }
  });
});

// ─── Schema validation: execute_batch movement (parallel + piece_call) ───

describe('roadmap piece: execute_batch movement', () => {
  it('should accept execute_batch with 2 parallel piece_call sub-movements', () => {
    const executeBatch = {
      name: 'execute_batch',
      parallel: [
        makeParallelPieceCallSlot({ name: 'slot_1' }),
        makeParallelPieceCallSlot({ name: 'slot_2' }),
      ],
      rules: [
        { condition: 'all("COMPLETE")', next: 'check_remaining' },
        { condition: 'any("ABORT")', next: 'check_remaining' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(executeBatch);

    expect(result.success).toBe(true);
  });

  it('should accept piece_call sub-movements calling takt-default', () => {
    const slot = makeParallelPieceCallSlot({ call: 'takt-default' });

    const result = ParallelSubMovementRawSchema.safeParse(slot);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.call).toBe('takt-default');
    }
  });

  it('should accept aggregate rules all("COMPLETE") and any("ABORT")', () => {
    const executeBatch = {
      name: 'execute_batch',
      parallel: [
        makeParallelPieceCallSlot({ name: 'slot_1' }),
      ],
      rules: [
        { condition: 'all("COMPLETE")', next: 'check_remaining' },
        { condition: 'any("ABORT")', next: 'check_remaining' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(executeBatch);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules).toHaveLength(2);
    }
  });
});

// ─── Schema validation: piece_call constraints in parallel sub-movements ───

describe('roadmap piece: piece_call constraints in parallel slots', () => {
  it('should reject piece_call sub-movement with persona', () => {
    const slot = makeParallelPieceCallSlot({ persona: 'coder' });

    const result = ParallelSubMovementRawSchema.safeParse(slot);

    expect(result.success).toBe(false);
  });

  it('should reject piece_call sub-movement with instruction', () => {
    const slot = makeParallelPieceCallSlot({ instruction: 'Do something' });

    const result = ParallelSubMovementRawSchema.safeParse(slot);

    expect(result.success).toBe(false);
  });

  it('should reject piece_call sub-movement with edit', () => {
    const slot = makeParallelPieceCallSlot({ edit: true });

    const result = ParallelSubMovementRawSchema.safeParse(slot);

    expect(result.success).toBe(false);
  });

  it('should reject piece_call sub-movement without call field', () => {
    const slot = {
      name: 'slot_1',
      kind: 'piece_call',
      rules: [{ condition: 'COMPLETE' }],
    };

    const result = ParallelSubMovementRawSchema.safeParse(slot);

    expect(result.success).toBe(false);
  });

  it('should accept piece_call sub-movement with overrides', () => {
    const slot = makeParallelPieceCallSlot({
      overrides: {
        provider: 'claude',
        model: 'opus',
      },
    });

    const result = ParallelSubMovementRawSchema.safeParse(slot);

    expect(result.success).toBe(true);
  });

  it('should accept piece_call sub-movement with a different call target', () => {
    const slot = makeParallelPieceCallSlot({ call: 'default' });

    const result = ParallelSubMovementRawSchema.safeParse(slot);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.call).toBe('default');
    }
  });
});

// ─── Schema validation: check_remaining movement ───

describe('roadmap piece: check_remaining movement', () => {
  it('should accept check_remaining as an agent movement with 4 rules', () => {
    const checkRemaining = {
      name: 'check_remaining',
      persona: 'planner',
      edit: false,
      instruction: 'Check remaining tasks.',
      rules: [
        { condition: '失敗スロットあり', next: 'assign_slots' },
        { condition: '残りタスクあり', next: 'assign_slots' },
        { condition: '全タスク完了', next: 'COMPLETE' },
        { condition: 'リトライ上限到達', next: 'COMPLETE' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(checkRemaining);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules).toHaveLength(4);
    }
  });

  it('should have rules routing to assign_slots for failed slots and remaining tasks', () => {
    const checkRemaining = {
      name: 'check_remaining',
      persona: 'planner',
      edit: false,
      instruction: 'Check remaining tasks.',
      rules: [
        { condition: '失敗スロットあり', next: 'assign_slots' },
        { condition: '残りタスクあり', next: 'assign_slots' },
        { condition: '全タスク完了', next: 'COMPLETE' },
        { condition: 'リトライ上限到達', next: 'COMPLETE' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(checkRemaining);

    expect(result.success).toBe(true);
    if (result.success) {
      const assignSlotsRules = result.data.rules?.filter(r => r.next === 'assign_slots');
      expect(assignSlotsRules).toHaveLength(2);

      const completeRules = result.data.rules?.filter(r => r.next === 'COMPLETE');
      expect(completeRules).toHaveLength(2);
    }
  });
});

// ─── Schema validation: edge cases and invalid structures ───

describe('roadmap piece: invalid structure detection', () => {
  it('should reject roadmap piece without movements', () => {
    const raw = makeRoadmapPieceRaw({ movements: [] });

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should reject parallel movement that also has kind: piece_call at parent level', () => {
    const raw = makeRoadmapPieceRaw({
      movements: [
        {
          name: 'invalid',
          kind: 'piece_call',
          call: 'default',
          parallel: [
            makeParallelPieceCallSlot({ name: 'slot_1' }),
          ],
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should reject piece_call sub-movement with empty call string', () => {
    const slot = makeParallelPieceCallSlot({ call: '' });

    const result = ParallelSubMovementRawSchema.safeParse(slot);

    expect(result.success).toBe(false);
  });
});

// ─── Integration: builtin piece loading ───

const languageState = vi.hoisted(() => ({ value: 'ja' as 'en' | 'ja' }));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return languageState.value;
    if (key === 'enableBuiltinPieces') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolveConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
      if (key === 'enableBuiltinPieces') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
}));

import { loadPiece } from '../infra/config/index.js';
import { listBuiltinPieceNames } from '../infra/config/loaders/pieceResolver.js';

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-roadmap-'));
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

describe('roadmap piece: builtin loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    languageState.value = 'ja';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should be listed as a builtin piece', () => {
    const builtinNames = listBuiltinPieceNames(testDir, { includeDisabled: true });

    expect(builtinNames).toContain('roadmap');
  });

  it('should load roadmap piece via loadPiece', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    expect(config!.name).toBe('roadmap');
  });

  it('should have description mentioning 2並列piece_call', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    expect(config!.description).toContain('2並列piece_call');
  });

  it('should have initial_movement set to decompose', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    expect(config!.initialMovement).toBe('decompose');
  });

  it('should have max_movements of 200', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    expect(config!.maxMovements).toBe(200);
  });

  it('should have exactly 5 movements: decompose, review_decomposition, assign_slots, execute_batch, check_remaining', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const movementNames = config!.movements.map(m => m.name);
    expect(movementNames).toEqual(['decompose', 'review_decomposition', 'assign_slots', 'execute_batch', 'check_remaining']);
  });

  it('should have decompose movement with edit: false', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const decompose = config!.movements.find(m => m.name === 'decompose');
    expect(decompose).toBeDefined();
    expect(decompose!.edit).toBe(false);
  });

  it('should have assign_slots instruction referencing only slot_1 and slot_2', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const assignSlots = config!.movements.find(m => m.name === 'assign_slots');
    expect(assignSlots).toBeDefined();
    expect(assignSlots!.instruction).toContain('slot_1');
    expect(assignSlots!.instruction).toContain('slot_2');
    expect(assignSlots!.instruction).not.toContain('slot_3');
  });

  it('should have assign_slots instruction mentioning 最大2件', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const assignSlots = config!.movements.find(m => m.name === 'assign_slots');
    expect(assignSlots).toBeDefined();
    expect(assignSlots!.instruction).toContain('最大2件');
    expect(assignSlots!.instruction).not.toContain('最大3件');
  });

  it('should have execute_batch as a parallel movement with 2 piece_call sub-movements', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const executeBatch = config!.movements.find(m => m.name === 'execute_batch');
    expect(executeBatch).toBeDefined();
    expect(executeBatch!.parallel).toBeDefined();
    expect(executeBatch!.parallel).toHaveLength(2);

    for (const slot of executeBatch!.parallel!) {
      expect(slot.kind).toBe('piece_call');
      expect(slot.call).toBe('takt-default');
    }
  });

  it('should have execute_batch with aggregate rules', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const executeBatch = config!.movements.find(m => m.name === 'execute_batch');
    expect(executeBatch).toBeDefined();
    expect(executeBatch!.rules).toBeDefined();

    const allRule = executeBatch!.rules!.find(r => r.isAggregateCondition && r.aggregateType === 'all');
    expect(allRule).toBeDefined();

    const anyRule = executeBatch!.rules!.find(r => r.isAggregateCondition && r.aggregateType === 'any');
    expect(anyRule).toBeDefined();
  });

  it('should have check_remaining with rules routing to assign_slots and to COMPLETE', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const checkRemaining = config!.movements.find(m => m.name === 'check_remaining');
    expect(checkRemaining).toBeDefined();
    expect(checkRemaining!.rules).toBeDefined();

    const assignSlotsRules = checkRemaining!.rules!.filter(r => r.next === 'assign_slots');
    expect(assignSlotsRules.length).toBeGreaterThanOrEqual(2);

    const completeRules = checkRemaining!.rules!.filter(r => r.next === 'COMPLETE');
    expect(completeRules.length).toBeGreaterThanOrEqual(2);
  });

  it('should have decompose rule 分解完了 routing to review_decomposition', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const decompose = config!.movements.find(m => m.name === 'decompose');
    expect(decompose).toBeDefined();

    const decomposeCompleteRule = decompose!.rules!.find(r => r.condition === '分解完了');
    expect(decomposeCompleteRule).toBeDefined();
    expect(decomposeCompleteRule!.next).toBe('review_decomposition');
  });

  it('should have review_decomposition as a parallel movement with 3 reviewer sub-movements', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const reviewDecomp = config!.movements.find(m => m.name === 'review_decomposition');
    expect(reviewDecomp).toBeDefined();
    expect(reviewDecomp!.parallel).toBeDefined();
    expect(reviewDecomp!.parallel).toHaveLength(3);

    const subNames = reviewDecomp!.parallel!.map(s => s.name);
    expect(subNames).toContain('dependency-review');
    expect(subNames).toContain('granularity-review');
    expect(subNames).toContain('coverage-review');
  });

  it('should have review_decomposition sub-movements with edit: false', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const reviewDecomp = config!.movements.find(m => m.name === 'review_decomposition');
    expect(reviewDecomp).toBeDefined();

    for (const sub of reviewDecomp!.parallel!) {
      expect(sub.edit).toBe(false);
    }
  });

  it('should have review_decomposition sub-movements with dedicated personas', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const reviewDecomp = config!.movements.find(m => m.name === 'review_decomposition');
    expect(reviewDecomp).toBeDefined();

    // With personas section map, resolvePersona returns the map value (relative path) as personaSpec
    const expectedPersonas = [
      '../facets/personas/decomposition-dependency-reviewer.md',
      '../facets/personas/decomposition-granularity-reviewer.md',
      '../facets/personas/decomposition-coverage-reviewer.md',
    ];

    const actualPersonas = reviewDecomp!.parallel!.map(s => s.persona);
    for (const expected of expectedPersonas) {
      expect(actualPersonas).toContain(expected);
    }
  });

  it('should have review_decomposition with aggregate rules for approved and needs_fix', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const reviewDecomp = config!.movements.find(m => m.name === 'review_decomposition');
    expect(reviewDecomp).toBeDefined();
    expect(reviewDecomp!.rules).toBeDefined();

    const allApproved = reviewDecomp!.rules!.find(r => r.isAggregateCondition && r.aggregateType === 'all');
    expect(allApproved).toBeDefined();
    expect(allApproved!.next).toBe('assign_slots');

    const anyNeedsFix = reviewDecomp!.rules!.find(r => r.isAggregateCondition && r.aggregateType === 'any');
    expect(anyNeedsFix).toBeDefined();
    expect(anyNeedsFix!.next).toBe('decompose');
  });

  it('should have execute_batch parallel slots named slot_1 and slot_2 only', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const executeBatch = config!.movements.find(m => m.name === 'execute_batch');
    expect(executeBatch).toBeDefined();

    const slotNames = executeBatch!.parallel!.map(s => s.name);
    expect(slotNames).toEqual(['slot_1', 'slot_2']);
  });

  it('should have piece_call sub-movements without persona or edit, and with empty instruction', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const executeBatch = config!.movements.find(m => m.name === 'execute_batch');
    expect(executeBatch).toBeDefined();

    for (const slot of executeBatch!.parallel!) {
      expect(slot.persona).toBeUndefined();
      // pieceParser normalizes piece_call instruction to empty string (not undefined)
      expect(slot.instruction).toBe('');
      expect(slot.edit).toBeUndefined();
    }
  });
});

// ─── Integration: piece-categories.yaml ───

import type { PieceCategoryNode } from '../infra/config/loaders/pieceCategories.js';

describe('roadmap piece: category registration', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    languageState.value = 'ja';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should include roadmap in builtin categories', async () => {
    const { loadDefaultCategories } = await import('../infra/config/loaders/pieceCategories.js');

    const categoryConfig = loadDefaultCategories(testDir);

    expect(categoryConfig).not.toBeNull();
    const allPieces = collectPiecesFromNodes(categoryConfig!.pieceCategories);
    expect(allPieces).toContain('roadmap');
  });

  it('should include roadmap in EN builtin categories', async () => {
    languageState.value = 'en';
    const { loadDefaultCategories } = await import('../infra/config/loaders/pieceCategories.js');

    const categoryConfig = loadDefaultCategories(testDir);

    expect(categoryConfig).not.toBeNull();
    const allPieces = collectPiecesFromNodes(categoryConfig!.pieceCategories);
    expect(allPieces).toContain('roadmap');
  });
});

// ─── Integration: EN builtin piece loading ───

describe('roadmap piece: EN builtin loading', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    languageState.value = 'en';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load EN roadmap piece via loadPiece', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    expect(config!.name).toBe('roadmap');
  });

  it('should have exactly 5 movements in EN version', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const movementNames = config!.movements.map(m => m.name);
    expect(movementNames).toEqual(['decompose', 'review_decomposition', 'assign_slots', 'execute_batch', 'check_remaining']);
  });

  it('should have review_decomposition as a parallel movement with 3 reviewer sub-movements in EN version', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const reviewDecomp = config!.movements.find(m => m.name === 'review_decomposition');
    expect(reviewDecomp).toBeDefined();
    expect(reviewDecomp!.parallel).toBeDefined();
    expect(reviewDecomp!.parallel).toHaveLength(3);

    const subNames = reviewDecomp!.parallel!.map(s => s.name);
    expect(subNames).toContain('dependency-review');
    expect(subNames).toContain('granularity-review');
    expect(subNames).toContain('coverage-review');
  });

  it('should have EN decompose rule transitioning to review_decomposition', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const decompose = config!.movements.find(m => m.name === 'decompose');
    expect(decompose).toBeDefined();

    const decomposeCompleteRule = decompose!.rules!.find(r => r.condition === 'Decomposition complete');
    expect(decomposeCompleteRule).toBeDefined();
    expect(decomposeCompleteRule!.next).toBe('review_decomposition');
  });

  it('should have EN check_remaining with English condition strings', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const checkRemaining = config!.movements.find(m => m.name === 'check_remaining');
    expect(checkRemaining).toBeDefined();
    expect(checkRemaining!.rules).toBeDefined();

    const conditions = checkRemaining!.rules!.map(r => r.condition);
    expect(conditions).toContain('Failed slots exist');
    expect(conditions).toContain('Remaining tasks exist');
    expect(conditions).toContain('All tasks complete');
    expect(conditions).toContain('Retry limit reached');
  });

  it('should have EN review_decomposition sub-movements with dedicated personas', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const reviewDecomp = config!.movements.find(m => m.name === 'review_decomposition');
    expect(reviewDecomp).toBeDefined();

    const expectedPersonas = [
      '../facets/personas/decomposition-dependency-reviewer.md',
      '../facets/personas/decomposition-granularity-reviewer.md',
      '../facets/personas/decomposition-coverage-reviewer.md',
    ];

    const actualPersonas = reviewDecomp!.parallel!.map(s => s.persona);
    for (const expected of expectedPersonas) {
      expect(actualPersonas).toContain(expected);
    }
  });

  it('should have EN review_decomposition with aggregate rules', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const reviewDecomp = config!.movements.find(m => m.name === 'review_decomposition');
    expect(reviewDecomp).toBeDefined();
    expect(reviewDecomp!.rules).toBeDefined();

    const allApproved = reviewDecomp!.rules!.find(r => r.isAggregateCondition && r.aggregateType === 'all');
    expect(allApproved).toBeDefined();
    expect(allApproved!.next).toBe('assign_slots');

    const anyNeedsFix = reviewDecomp!.rules!.find(r => r.isAggregateCondition && r.aggregateType === 'any');
    expect(anyNeedsFix).toBeDefined();
    expect(anyNeedsFix!.next).toBe('decompose');
  });
});

/**
 * Recursively collects all piece names from a PieceCategoryNode tree.
 */
function collectPiecesFromNodes(nodes: PieceCategoryNode[]): string[] {
  const pieces: string[] = [];
  for (const node of nodes) {
    pieces.push(...node.pieces);
    if (node.children.length > 0) {
      pieces.push(...collectPiecesFromNodes(node.children));
    }
  }
  return pieces;
}
