/**
 * Integration tests for roadmap piece retry loop with failed slots.
 *
 * Tests the planned changes to roadmap.yaml's check_remaining and decompose
 * movements for detecting failed slots and routing them through the retry loop.
 *
 * Covers:
 * - Schema: check_remaining accepts new retry-related rule conditions
 * - Schema: check_remaining rules include 失敗スロットあり → decompose
 * - Schema: check_remaining rules include リトライ上限到達 → COMPLETE
 * - Schema: decompose movement structure unchanged for retry compatibility
 * - Aggregate: any("ABORT") correctly routes to check_remaining
 * - Non-regression: all("COMPLETE") still routes to check_remaining
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { PieceConfigRawSchema, PieceMovementRawSchema } from '../core/models/schemas.js';

// --- Helpers ---

/**
 * Builds the updated roadmap piece raw config with retry-related rules.
 * This represents the expected state after implementation.
 */
function makeUpdatedRoadmapPieceRaw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
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
        instruction: 'Decompose the roadmap into individual tasks with retry support.',
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
        instruction: 'Check remaining tasks and detect failed slots for retry.',
        output_contracts: {
          report: [
            { name: 'roadmap-tasks.md', format: 'plan' },
          ],
        },
        rules: [
          { condition: '失敗スロットあり', next: 'decompose' },
          { condition: '残りタスクあり', next: 'decompose' },
          { condition: '全タスク完了', next: 'COMPLETE' },
          { condition: 'リトライ上限到達', next: 'COMPLETE' },
        ],
      },
    ],
    ...overrides,
  };
}

// --- Schema validation for updated check_remaining ---

describe('roadmap piece retry: check_remaining schema validation', () => {
  it('should accept check_remaining with 4 rules including retry conditions', () => {
    // Given: check_remaining with added retry rules
    const checkRemaining = {
      name: 'check_remaining',
      persona: 'planner',
      edit: false,
      instruction: 'Check remaining tasks and detect failed slots.',
      rules: [
        { condition: '失敗スロットあり', next: 'decompose' },
        { condition: '残りタスクあり', next: 'decompose' },
        { condition: '全タスク完了', next: 'COMPLETE' },
        { condition: 'リトライ上限到達', next: 'COMPLETE' },
      ],
    };

    // When
    const result = PieceMovementRawSchema.safeParse(checkRemaining);

    // Then
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.rules).toHaveLength(4);
    }
  });

  it('should route 失敗スロットあり to decompose for retry', () => {
    // Given: check_remaining with retry rule
    const checkRemaining = {
      name: 'check_remaining',
      persona: 'planner',
      edit: false,
      instruction: 'Check failed slots.',
      rules: [
        { condition: '失敗スロットあり', next: 'decompose' },
        { condition: '全タスク完了', next: 'COMPLETE' },
      ],
    };

    // When
    const result = PieceMovementRawSchema.safeParse(checkRemaining);

    // Then
    expect(result.success).toBe(true);
    if (result.success) {
      const retryRule = result.data.rules?.find(r => r.condition === '失敗スロットあり');
      expect(retryRule).toBeDefined();
      expect(retryRule!.next).toBe('decompose');
    }
  });

  it('should route リトライ上限到達 to COMPLETE', () => {
    // Given: check_remaining with retry limit rule
    const checkRemaining = {
      name: 'check_remaining',
      persona: 'planner',
      edit: false,
      instruction: 'Check retry limits.',
      rules: [
        { condition: 'リトライ上限到達', next: 'COMPLETE' },
      ],
    };

    // When
    const result = PieceMovementRawSchema.safeParse(checkRemaining);

    // Then
    expect(result.success).toBe(true);
    if (result.success) {
      const limitRule = result.data.rules?.find(r => r.condition === 'リトライ上限到達');
      expect(limitRule).toBeDefined();
      expect(limitRule!.next).toBe('COMPLETE');
    }
  });

  it('should accept check_remaining with output_contracts for roadmap-tasks.md', () => {
    // Given: check_remaining now writes to roadmap-tasks.md for retry tracking
    const checkRemaining = {
      name: 'check_remaining',
      persona: 'planner',
      edit: false,
      instruction: 'Check and update retry counts.',
      output_contracts: {
        report: [
          { name: 'roadmap-tasks.md', format: 'plan' },
        ],
      },
      rules: [
        { condition: '失敗スロットあり', next: 'decompose' },
        { condition: '全タスク完了', next: 'COMPLETE' },
      ],
    };

    // When
    const result = PieceMovementRawSchema.safeParse(checkRemaining);

    // Then
    expect(result.success).toBe(true);
  });
});

// --- Full piece config validation with retry rules ---

describe('roadmap piece retry: full PieceConfigRawSchema validation', () => {
  it('should accept the complete updated roadmap piece with retry rules', () => {
    // Given: complete roadmap piece with retry-related check_remaining rules
    const raw = makeUpdatedRoadmapPieceRaw();

    // When
    const result = PieceConfigRawSchema.safeParse(raw);

    // Then
    expect(result.success).toBe(true);
  });

  it('should preserve execute_batch aggregate rules unchanged', () => {
    // Given: updated roadmap piece
    const raw = makeUpdatedRoadmapPieceRaw();

    // When
    const result = PieceConfigRawSchema.safeParse(raw);

    // Then: execute_batch rules are the same as before
    expect(result.success).toBe(true);
    if (result.success) {
      const executeBatch = result.data.movements.find(
        (m: Record<string, unknown>) => m.name === 'execute_batch',
      );
      expect(executeBatch).toBeDefined();
      expect(executeBatch!.rules).toHaveLength(2);
    }
  });

  it('should preserve decompose movement rules unchanged', () => {
    // Given: updated roadmap piece
    const raw = makeUpdatedRoadmapPieceRaw();

    // When
    const result = PieceConfigRawSchema.safeParse(raw);

    // Then: decompose still has the same 3 rules
    expect(result.success).toBe(true);
    if (result.success) {
      const decompose = result.data.movements.find(
        (m: Record<string, unknown>) => m.name === 'decompose',
      );
      expect(decompose).toBeDefined();
      expect(decompose!.rules).toHaveLength(3);
    }
  });
});

// --- Rule ordering: 失敗スロットあり should come before 残りタスクあり ---

describe('roadmap piece retry: rule ordering in check_remaining', () => {
  it('should evaluate 失敗スロットあり before 残りタスクあり', () => {
    // Given: rules in the expected order
    const raw = makeUpdatedRoadmapPieceRaw();
    const result = PieceConfigRawSchema.safeParse(raw);
    expect(result.success).toBe(true);

    if (result.success) {
      const checkRemaining = result.data.movements.find(
        (m: Record<string, unknown>) => m.name === 'check_remaining',
      );
      expect(checkRemaining).toBeDefined();

      // Then: 失敗スロットあり rule index should be less than 残りタスクあり
      const failedSlotRuleIndex = checkRemaining!.rules!.findIndex(
        r => r.condition === '失敗スロットあり',
      );
      const remainingTaskRuleIndex = checkRemaining!.rules!.findIndex(
        r => r.condition === '残りタスクあり',
      );
      expect(failedSlotRuleIndex).toBeLessThan(remainingTaskRuleIndex);
    }
  });
});

// --- Integration: loading updated roadmap piece from builtin ---

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

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-retry-'));
  mkdirSync(join(dir, '.takt'), { recursive: true });
  return dir;
}

describe('roadmap piece retry: builtin loading validation', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
    languageState.value = 'ja';
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load roadmap piece with check_remaining having retry rules', () => {
    // Given: builtin roadmap piece
    const config = loadPiece('roadmap', testDir);

    // When/Then: check_remaining should have retry-related rules
    expect(config).not.toBeNull();
    const checkRemaining = config!.movements.find(m => m.name === 'check_remaining');
    expect(checkRemaining).toBeDefined();

    const failedSlotRule = checkRemaining!.rules?.find(r => r.condition === '失敗スロットあり');
    expect(failedSlotRule).toBeDefined();
    expect(failedSlotRule!.next).toBe('decompose');

    const retryLimitRule = checkRemaining!.rules?.find(r => r.condition === 'リトライ上限到達');
    expect(retryLimitRule).toBeDefined();
    expect(retryLimitRule!.next).toBe('COMPLETE');
  });

  it('should load roadmap piece with check_remaining having output_contracts', () => {
    // Given: builtin roadmap piece
    const config = loadPiece('roadmap', testDir);

    // When/Then: check_remaining should have output_contracts for retry tracking
    expect(config).not.toBeNull();
    const checkRemaining = config!.movements.find(m => m.name === 'check_remaining');
    expect(checkRemaining).toBeDefined();
    expect(checkRemaining!.outputContracts).toBeDefined();
    expect(checkRemaining!.outputContracts!.length).toBeGreaterThan(0);
    expect(checkRemaining!.outputContracts![0]!.name).toBe('roadmap-tasks.md');
  });

  it('should keep execute_batch parallel structure with 2 slots unchanged', () => {
    // Given: builtin roadmap piece
    const config = loadPiece('roadmap', testDir);

    // When/Then: execute_batch should still have 2 piece_call slots
    expect(config).not.toBeNull();
    const executeBatch = config!.movements.find(m => m.name === 'execute_batch');
    expect(executeBatch).toBeDefined();
    expect(executeBatch!.parallel).toHaveLength(2);

    for (const slot of executeBatch!.parallel!) {
      expect(slot.kind).toBe('piece_call');
      expect(slot.rules).toHaveLength(2);
      expect(slot.rules![0]!.condition).toBe('COMPLETE');
      expect(slot.rules![1]!.condition).toBe('ABORT');
    }
  });

  it('should maintain decompose → execute_batch → check_remaining loop', () => {
    // Given: builtin roadmap piece
    const config = loadPiece('roadmap', testDir);

    // When/Then: basic loop structure is preserved
    expect(config).not.toBeNull();

    const decompose = config!.movements.find(m => m.name === 'decompose');
    const executeBatchRule = decompose!.rules?.find(r => r.next === 'execute_batch');
    expect(executeBatchRule).toBeDefined();

    const executeBatch = config!.movements.find(m => m.name === 'execute_batch');
    const checkRemainingRule = executeBatch!.rules?.find(r => r.next === 'check_remaining');
    expect(checkRemainingRule).toBeDefined();

    const checkRemaining = config!.movements.find(m => m.name === 'check_remaining');
    const decomposeRule = checkRemaining!.rules?.find(r => r.next === 'decompose');
    expect(decomposeRule).toBeDefined();
  });
});
