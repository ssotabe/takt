/**
 * Tests for prepareSlotContext.
 *
 * Covers:
 * - Returns undefined when no slot_N pattern sub-movements
 * - Returns undefined when not all piece_call sub-movements match slot_N
 * - Creates overrides and worktrees for matching slot_N movements
 * - Generates correct reportDirName for each slot
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { PieceMovement, PieceState } from '../core/models/index.js';

vi.mock('../core/piece/engine/parallel-worktree.js', () => ({
  createParallelWorktree: vi.fn().mockImplementation((_cwd: string, slotName: string) => ({
    path: `/tmp/worktree-${slotName}`,
    branch: `branch-${slotName}`,
  })),
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

function makeNormalMovement(name: string): PieceMovement {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: true,
  };
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

describe('prepareSlotContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return undefined when no piece_call sub-movements match slot_N', () => {
    const subMovements = [makeNormalMovement('review'), makeNormalMovement('test')];
    const result = prepareSlotContext(subMovements, makeState(), 'parent-slug', '/workspace');
    expect(result).toBeUndefined();
  });

  it('should return undefined when not all piece_call sub-movements match slot_N', () => {
    const subMovements = [
      makeSlotMovement('slot_1', 'child-a'),
      makeSlotMovement('custom-slot', 'child-b'),
    ];
    const result = prepareSlotContext(subMovements, makeState(), 'parent-slug', '/workspace');
    expect(result).toBeUndefined();
  });

  it('should create overrides with correct reportDirName for each slot', () => {
    const state = makeState({
      lastOutput: {
        persona: 'decomposer',
        status: 'done',
        content: '## slot_1\nTask A\n## slot_2\nTask B',
        timestamp: new Date(),
      },
    });
    const subMovements = [
      makeSlotMovement('slot_1', 'child-a'),
      makeSlotMovement('slot_2', 'child-b'),
    ];

    const result = prepareSlotContext(subMovements, state, 'parent-slug', '/workspace');

    expect(result).toBeDefined();
    expect(result!.overrides.size).toBe(2);
    expect(result!.overrides.get('slot_1')!.reportDirName).toBe('parent-slug-slot-1');
    expect(result!.overrides.get('slot_2')!.reportDirName).toBe('parent-slug-slot-2');
  });

  it('should create worktrees for each slot', () => {
    const state = makeState({
      lastOutput: {
        persona: 'decomposer',
        status: 'done',
        content: '## slot_1\nTask A\n## slot_2\nTask B',
        timestamp: new Date(),
      },
    });
    const subMovements = [
      makeSlotMovement('slot_1', 'child-a'),
      makeSlotMovement('slot_2', 'child-b'),
    ];

    const result = prepareSlotContext(subMovements, state, 'parent-slug', '/workspace');

    expect(result!.worktrees.size).toBe(2);
    expect(result!.worktrees.get('slot_1')!.path).toBe('/tmp/worktree-slot_1');
    expect(result!.worktrees.get('slot_2')!.path).toBe('/tmp/worktree-slot_2');
  });

  it('should set cwd in overrides to worktree path', () => {
    const state = makeState({
      lastOutput: {
        persona: 'decomposer',
        status: 'done',
        content: '## slot_1\nTask A',
        timestamp: new Date(),
      },
    });
    const subMovements = [makeSlotMovement('slot_1', 'child-a')];

    const result = prepareSlotContext(subMovements, state, 'parent-slug', '/workspace');

    expect(result!.overrides.get('slot_1')!.cwd).toBe('/tmp/worktree-slot_1');
  });
});
