/**
 * Tests for roadmap piece YAML validation and integration.
 *
 * Covers:
 * - Schema validation of roadmap.yaml structure (3 movements: decompose, execute_batch, check_remaining)
 * - parallel movement with 2 piece_call sub-movements validates against PieceConfigRawSchema
 * - piece_call constraints respected (no persona/instruction/edit on piece_call slots)
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
 * This mirrors the planned roadmap.yaml structure from the plan report.
 */
function makeRoadmapPieceRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'roadmap',
    description: 'ロードマップ実行ピース（タスク分解 → 2並列piece_call → バッチループ）',
    max_movements: 200,
    initial_movement: 'decompose',
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
          { condition: '分解完了', next: 'execute_batch' },
          { condition: 'タスクなし', next: 'COMPLETE' },
          { condition: '要件不明', next: 'ABORT' },
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
          { condition: '残りタスクあり', next: 'decompose' },
          { condition: '全タスク完了', next: 'COMPLETE' },
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

  it('should have exactly 3 movements', () => {
    const raw = makeRoadmapPieceRaw();

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.movements).toHaveLength(3);
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
        { condition: '分解完了', next: 'execute_batch' },
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
        { condition: '分解完了', next: 'execute_batch' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(decompose);

    expect(result.success).toBe(true);
  });

  it('should have 3 rules: 分解完了, タスクなし, 要件不明', () => {
    const decompose = {
      name: 'decompose',
      persona: 'planner',
      edit: false,
      instruction: 'Decompose the roadmap.',
      rules: [
        { condition: '分解完了', next: 'execute_batch' },
        { condition: 'タスクなし', next: 'COMPLETE' },
        { condition: '要件不明', next: 'ABORT' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(decompose);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules).toHaveLength(3);
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
  it('should accept check_remaining as an agent movement', () => {
    const checkRemaining = {
      name: 'check_remaining',
      persona: 'planner',
      edit: false,
      instruction: 'Check remaining tasks.',
      rules: [
        { condition: '残りタスクあり', next: 'decompose' },
        { condition: '全タスク完了', next: 'COMPLETE' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(checkRemaining);

    expect(result.success).toBe(true);
  });

  it('should have rule routing back to decompose for remaining tasks', () => {
    const checkRemaining = {
      name: 'check_remaining',
      persona: 'planner',
      edit: false,
      instruction: 'Check remaining tasks.',
      rules: [
        { condition: '残りタスクあり', next: 'decompose' },
        { condition: '全タスク完了', next: 'COMPLETE' },
      ],
    };

    const result = PieceMovementRawSchema.safeParse(checkRemaining);

    expect(result.success).toBe(true);
    if (result.success) {
      const loopBackRule = result.data.rules?.find(r => r.next === 'decompose');
      expect(loopBackRule).toBeDefined();
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

  it('should have exactly 3 movements: decompose, execute_batch, check_remaining', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const movementNames = config!.movements.map(m => m.name);
    expect(movementNames).toEqual(['decompose', 'execute_batch', 'check_remaining']);
  });

  it('should have decompose movement with edit: false', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const decompose = config!.movements.find(m => m.name === 'decompose');
    expect(decompose).toBeDefined();
    expect(decompose!.edit).toBe(false);
  });

  it('should have decompose instruction referencing only slot_1 and slot_2', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const decompose = config!.movements.find(m => m.name === 'decompose');
    expect(decompose).toBeDefined();
    expect(decompose!.instruction).toContain('slot_1');
    expect(decompose!.instruction).toContain('slot_2');
    expect(decompose!.instruction).not.toContain('slot_3');
  });

  it('should have decompose instruction mentioning 最大2件', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const decompose = config!.movements.find(m => m.name === 'decompose');
    expect(decompose).toBeDefined();
    expect(decompose!.instruction).toContain('最大2件');
    expect(decompose!.instruction).not.toContain('最大3件');
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

  it('should have check_remaining with rule routing back to decompose', () => {
    const config = loadPiece('roadmap', testDir);

    expect(config).not.toBeNull();
    const checkRemaining = config!.movements.find(m => m.name === 'check_remaining');
    expect(checkRemaining).toBeDefined();
    expect(checkRemaining!.rules).toBeDefined();

    const loopBackRule = checkRemaining!.rules!.find(r => r.next === 'decompose');
    expect(loopBackRule).toBeDefined();

    const completeRule = checkRemaining!.rules!.find(r => r.next === 'COMPLETE');
    expect(completeRule).toBeDefined();
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
