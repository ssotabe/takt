/**
 * Unit tests for parallel-worktree module.
 *
 * Tests createParallelWorktree() and cleanupParallelWorktree() which manage
 * isolated git worktrees for parallel piece_call execution.
 *
 * Covers:
 * - createParallelWorktree: normal creation flow
 * - createParallelWorktree: branch naming with slot name
 * - cleanupParallelWorktree: .takt/runs/ copy + worktree deletion
 * - cleanupParallelWorktree: runs when child piece failed
 * - cleanupParallelWorktree: handles missing .takt/runs/ gracefully
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock CloneManager before importing the module under test
vi.mock('../infra/task/clone.js', () => ({
  CloneManager: vi.fn().mockImplementation(() => ({
    createSharedClone: vi.fn(),
    removeClone: vi.fn(),
  })),
  createSharedClone: vi.fn(),
  removeClone: vi.fn(),
}));

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<Record<string, unknown>>();
  return {
    ...original,
    existsSync: vi.fn(),
    cpSync: vi.fn(),
  };
});

import { createParallelWorktree, cleanupParallelWorktree } from '../core/piece/engine/parallel-worktree.js';
import { createSharedClone, removeClone } from '../infra/task/clone.js';
import { existsSync, cpSync } from 'node:fs';

describe('createParallelWorktree', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // =====================================================
  // 1. Normal creation flow
  // =====================================================
  describe('normal creation', () => {
    it('should create a shared clone for the slot', () => {
      // Given: a project directory and slot name
      const projectDir = '/workspace/project';
      const slotName = 'slot_1';
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/tmp/worktrees/slot_1-clone',
        branch: 'parent-branch-slot_1',
      });

      // When: creating a parallel worktree
      const result = createParallelWorktree(projectDir, slotName);

      // Then: should call createSharedClone with appropriate options
      expect(createSharedClone).toHaveBeenCalledWith(
        projectDir,
        expect.objectContaining({
          taskSlug: expect.stringContaining(slotName),
          worktree: true,
        }),
      );
      expect(result).toEqual({
        path: '/tmp/worktrees/slot_1-clone',
        branch: 'parent-branch-slot_1',
      });
    });

    it('should include slot name in the clone task slug', () => {
      // Given
      const projectDir = '/workspace/project';
      const slotName = 'slot_2';
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/tmp/worktrees/slot_2-clone',
        branch: 'branch-slot_2',
      });

      // When
      createParallelWorktree(projectDir, slotName);

      // Then: taskSlug should contain the slot name for identification
      const callArgs = vi.mocked(createSharedClone).mock.calls[0]!;
      const options = callArgs[1];
      expect(options.taskSlug).toContain('slot_2');
    });
  });
});

describe('cleanupParallelWorktree', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // =====================================================
  // 1. Normal cleanup: copy runs + remove worktree
  // =====================================================
  describe('normal cleanup', () => {
    it('should copy .takt/runs/ from worktree to parent and remove worktree', () => {
      // Given: worktree with .takt/runs/ directory
      const worktreePath = '/tmp/worktrees/slot_1-clone';
      const parentCwd = '/workspace/project';
      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p).includes('.takt/runs')) return true;
        return false;
      });

      // When: cleaning up the worktree (shouldMerge=false to test basic cleanup only)
      cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: should copy runs directory
      expect(cpSync).toHaveBeenCalledWith(
        expect.stringContaining(worktreePath),
        expect.stringContaining(parentCwd),
        expect.objectContaining({ recursive: true }),
      );

      // Then: should remove the worktree
      expect(removeClone).toHaveBeenCalledWith(worktreePath);
    });
  });

  // =====================================================
  // 2. Cleanup when child piece failed (still copies runs)
  // =====================================================
  describe('cleanup after failure', () => {
    it('should still copy runs and remove worktree when child piece failed', () => {
      // Given: worktree exists with runs (even after failure)
      const worktreePath = '/tmp/worktrees/slot_2-clone';
      const parentCwd = '/workspace/project';
      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p).includes('.takt/runs')) return true;
        return false;
      });

      // When: cleanup runs (called from finally block, shouldMerge=false)
      cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: runs are copied and worktree is removed
      expect(cpSync).toHaveBeenCalled();
      expect(removeClone).toHaveBeenCalledWith(worktreePath);
    });
  });

  // =====================================================
  // 3. Cleanup when .takt/runs/ does not exist
  // =====================================================
  describe('missing .takt/runs/', () => {
    it('should skip copy but still remove worktree when .takt/runs/ does not exist', () => {
      // Given: worktree without .takt/runs/
      const worktreePath = '/tmp/worktrees/slot_3-clone';
      const parentCwd = '/workspace/project';
      vi.mocked(existsSync).mockReturnValue(false);

      // When
      cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: cpSync should NOT be called (no runs to copy)
      expect(cpSync).not.toHaveBeenCalled();

      // Then: worktree should still be removed
      expect(removeClone).toHaveBeenCalledWith(worktreePath);
    });
  });

  // =====================================================
  // 4. Cleanup should always remove worktree even if copy fails
  // =====================================================
  describe('copy failure does not prevent worktree removal', () => {
    it('should remove worktree even when cpSync throws', () => {
      // Given: cpSync will throw an error
      const worktreePath = '/tmp/worktrees/slot_1-clone';
      const parentCwd = '/workspace/project';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(cpSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // When: cleanup runs (should not throw, shouldMerge=false)
      cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: worktree removal should still be attempted
      expect(removeClone).toHaveBeenCalledWith(worktreePath);
    });
  });
});
