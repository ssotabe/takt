/**
 * Tests for prepareSlotContext: empty slot skipping behavior.
 *
 * Covers:
 * - Empty slot (slotContent === '') is excluded from overrides Map
 * - Empty slot is excluded from worktrees Map
 * - Worktree is not created for empty slots
 * - Non-empty slots are still processed normally alongside empty slots
 * - All slots empty results in empty overrides/worktrees Maps (but SlotContext is returned)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PieceMovement, PieceState } from '../core/models/index.js';

const createParallelWorktreeMock = vi.fn().mockImplementation((_cwd: string, slotName: string) => ({
  path: `/tmp/worktree-${slotName}`,
  branch: `branch-${slotName}`,
}));

vi.mock('../core/piece/engine/parallel-worktree.js', () => ({
  createParallelWorktree: createParallelWorktreeMock,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
}));

const { prepareSlotContext } = await import('../core/piece/engine/slot-context.js');

function makeSlotMovement(name: string, call: string): PieceMovement {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: true,
    kind: 'piece_call' as PieceMovement['kind'],
    call,
  } as PieceMovement & { kind: string; call: string };
}

function makeState(overrides: Partial<PieceState> = {}): PieceState {
  return {
    pieceName: 'parent',
    currentMovement: 'parallel-step',
    iteration: 1,
    movementOutputs: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    movementIterations: new Map(),
    status: 'running',
    ...overrides,
  };
}

describe('prepareSlotContext: empty slot skipping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should exclude empty slot from overrides Map', () => {
    // Given: slot_1 has content, slot_2 is empty (タスクなし → '')
    const state = makeState({
      lastOutput: {
        persona: 'decomposer',
        status: 'done',
        content: '## slot_1\nTask A\n## slot_2\nタスクなし',
        timestamp: new Date(),
      },
    });
    const subMovements = [
      makeSlotMovement('slot_1', 'child-a'),
      makeSlotMovement('slot_2', 'child-b'),
    ];

    // When
    const result = prepareSlotContext(subMovements, state, 'parent-slug', '/workspace');

    // Then: only slot_1 should have overrides
    expect(result).toBeDefined();
    expect(result!.overrides.size).toBe(1);
    expect(result!.overrides.has('slot_1')).toBe(true);
    expect(result!.overrides.has('slot_2')).toBe(false);
  });

  it('should exclude empty slot from worktrees Map', () => {
    // Given: slot_1 has content, slot_2 is empty
    const state = makeState({
      lastOutput: {
        persona: 'decomposer',
        status: 'done',
        content: '## slot_1\nTask A\n## slot_2\nタスクなし',
        timestamp: new Date(),
      },
    });
    const subMovements = [
      makeSlotMovement('slot_1', 'child-a'),
      makeSlotMovement('slot_2', 'child-b'),
    ];

    // When
    const result = prepareSlotContext(subMovements, state, 'parent-slug', '/workspace');

    // Then: only slot_1 should have a worktree
    expect(result!.worktrees.size).toBe(1);
    expect(result!.worktrees.has('slot_1')).toBe(true);
    expect(result!.worktrees.has('slot_2')).toBe(false);
  });

  it('should not call createParallelWorktree for empty slots', () => {
    // Given: 3 slots, slot_2 and slot_3 are empty
    const state = makeState({
      lastOutput: {
        persona: 'decomposer',
        status: 'done',
        content: '## slot_1\nTask A\n## slot_2\nタスクなし\n## slot_3\nタスクなし',
        timestamp: new Date(),
      },
    });
    const subMovements = [
      makeSlotMovement('slot_1', 'child-a'),
      makeSlotMovement('slot_2', 'child-b'),
      makeSlotMovement('slot_3', 'child-c'),
    ];

    // When
    prepareSlotContext(subMovements, state, 'parent-slug', '/workspace');

    // Then: worktree created only for slot_1
    expect(createParallelWorktreeMock).toHaveBeenCalledTimes(1);
    expect(createParallelWorktreeMock).toHaveBeenCalledWith('/workspace', 'slot_1');
  });

  it('should still process non-empty slots correctly alongside empty slots', () => {
    // Given: slot_1 has content, slot_2 is empty, slot_3 has content
    const state = makeState({
      lastOutput: {
        persona: 'decomposer',
        status: 'done',
        content: '## slot_1\nTask A\n## slot_2\nタスクなし\n## slot_3\nTask C',
        timestamp: new Date(),
      },
    });
    const subMovements = [
      makeSlotMovement('slot_1', 'child-a'),
      makeSlotMovement('slot_2', 'child-b'),
      makeSlotMovement('slot_3', 'child-c'),
    ];

    // When
    const result = prepareSlotContext(subMovements, state, 'parent-slug', '/workspace');

    // Then: slot_1 and slot_3 have overrides with correct data
    expect(result!.overrides.size).toBe(2);
    expect(result!.overrides.get('slot_1')!.reportDirName).toBe('parent-slug-slot-1');
    expect(result!.overrides.get('slot_1')!.cwd).toBe('/tmp/worktree-slot_1');
    expect(result!.overrides.get('slot_3')!.reportDirName).toBe('parent-slug-slot-3');
    expect(result!.overrides.get('slot_3')!.cwd).toBe('/tmp/worktree-slot_3');

    // worktrees also only for non-empty
    expect(result!.worktrees.size).toBe(2);
    expect(result!.worktrees.has('slot_1')).toBe(true);
    expect(result!.worktrees.has('slot_3')).toBe(true);
  });

  it('should return SlotContext with empty Maps when all slots are empty', () => {
    // Given: all slots are empty
    const state = makeState({
      lastOutput: {
        persona: 'decomposer',
        status: 'done',
        content: '## slot_1\nタスクなし\n## slot_2\nタスクなし',
        timestamp: new Date(),
      },
    });
    const subMovements = [
      makeSlotMovement('slot_1', 'child-a'),
      makeSlotMovement('slot_2', 'child-b'),
    ];

    // When
    const result = prepareSlotContext(subMovements, state, 'parent-slug', '/workspace');

    // Then: SlotContext returned (slot pattern was detected) but Maps are empty
    expect(result).toBeDefined();
    expect(result!.overrides.size).toBe(0);
    expect(result!.worktrees.size).toBe(0);
    expect(createParallelWorktreeMock).not.toHaveBeenCalled();
  });
});
