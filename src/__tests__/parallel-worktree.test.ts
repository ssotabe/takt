/**
 * Unit tests for parallel-worktree module (refactored version).
 *
 * Tests:
 * - createParallelWorktree: auto-commit, worktree dir creation, shared clone
 * - cleanupParallelWorktree: .takt/runs/ copy (responsibility-reduced version)
 *
 * Mocked: git operations, clone, fs operations
 * Not mocked: parallel-worktree logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Hoisted mocks ---

const { mockStageAndCommit, mockGetCurrentBranch, mockCreateSharedClone, mockExistsSync, mockCpSync, mockMkdirSync } =
  vi.hoisted(() => ({
    mockStageAndCommit: vi.fn(),
    mockGetCurrentBranch: vi.fn(),
    mockCreateSharedClone: vi.fn(),
    mockExistsSync: vi.fn(),
    mockCpSync: vi.fn(),
    mockMkdirSync: vi.fn(),
  }));

vi.mock('node:fs', () => ({
  existsSync: mockExistsSync,
  cpSync: mockCpSync,
  mkdirSync: mockMkdirSync,
}));

vi.mock('../infra/task/clone.js', () => ({
  createSharedClone: mockCreateSharedClone,
}));

vi.mock('../infra/task/git.js', () => ({
  stageAndCommit: mockStageAndCommit,
  getCurrentBranch: mockGetCurrentBranch,
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getErrorMessage: (e: unknown) => String(e),
}));

// --- Imports (after mocks) ---

import {
  createParallelWorktree,
  cleanupParallelWorktree,
} from '../core/workflow/engine/parallel-worktree.js';

describe('createParallelWorktree', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should auto-commit, get current branch, and create shared clone', () => {
    // Given
    mockGetCurrentBranch.mockReturnValue('main');
    mockCreateSharedClone.mockReturnValue({
      path: '/worktrees/20260418T0730-slot_1',
      branch: 'takt/slot_1',
    });

    // When
    const result = createParallelWorktree('/project', 'slot_1');

    // Then
    expect(mockStageAndCommit).toHaveBeenCalledWith(
      '/project',
      'takt: auto-commit before child worktree',
    );
    expect(mockGetCurrentBranch).toHaveBeenCalledWith('/project');
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.stringContaining('.takt/worktrees'),
      { recursive: true },
    );
    expect(mockCreateSharedClone).toHaveBeenCalledWith('/project', {
      taskSlug: 'slot_1',
      worktree: expect.stringContaining('slot_1'),
      baseBranch: 'main',
    });
    expect(result).toEqual({
      path: '/worktrees/20260418T0730-slot_1',
      branch: 'takt/slot_1',
    });
  });

  it('should continue when auto-commit fails (nothing to commit)', () => {
    // Given
    mockStageAndCommit.mockImplementation(() => {
      throw new Error('nothing to commit');
    });
    mockGetCurrentBranch.mockReturnValue('feature-branch');
    mockCreateSharedClone.mockReturnValue({ path: '/wt/slot_1', branch: 'b' });

    // When
    const result = createParallelWorktree('/project', 'slot_1');

    // Then: should not throw, should continue with clone creation
    expect(result).toEqual({ path: '/wt/slot_1', branch: 'b' });
    expect(mockCreateSharedClone).toHaveBeenCalled();
  });

  it('should use current branch as base for shared clone', () => {
    // Given
    mockGetCurrentBranch.mockReturnValue('feature/my-branch');
    mockCreateSharedClone.mockReturnValue({ path: '/wt', branch: 'b' });

    // When
    createParallelWorktree('/project', 'slot_2');

    // Then
    expect(mockCreateSharedClone).toHaveBeenCalledWith(
      '/project',
      expect.objectContaining({ baseBranch: 'feature/my-branch' }),
    );
  });
});

describe('cleanupParallelWorktree', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should copy child .takt/runs/ to parent when directory exists', async () => {
    // Given
    mockExistsSync.mockReturnValue(true);

    // When
    await cleanupParallelWorktree('/worktree/slot-1', '/project');

    // Then
    expect(mockCpSync).toHaveBeenCalledWith(
      '/worktree/slot-1/.takt/runs',
      '/project/.takt/runs',
      { recursive: true },
    );
  });

  it('should skip copy when child runs directory does not exist', async () => {
    // Given
    mockExistsSync.mockReturnValue(false);

    // When
    await cleanupParallelWorktree('/worktree/slot-1', '/project');

    // Then
    expect(mockCpSync).not.toHaveBeenCalled();
  });

  it('should not throw when copy fails (logs error instead)', async () => {
    // Given
    mockExistsSync.mockReturnValue(true);
    mockCpSync.mockImplementation(() => {
      throw new Error('EACCES: permission denied');
    });

    // When / Then: should not throw
    await expect(
      cleanupParallelWorktree('/worktree/slot-1', '/project'),
    ).resolves.toBeUndefined();
  });

  it('should not perform merge operations (responsibility reduced)', async () => {
    // Given: cleanupParallelWorktree takes only worktreePath and parentCwd
    // No shouldMerge, no slotInstruction parameters
    mockExistsSync.mockReturnValue(false);

    // When
    await cleanupParallelWorktree('/worktree/slot-1', '/project');

    // Then: only cpSync/existsSync should be involved, no git merge operations
    expect(mockStageAndCommit).not.toHaveBeenCalled();
  });
});
