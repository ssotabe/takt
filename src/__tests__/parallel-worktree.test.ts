/**
 * Unit tests for parallel-worktree module.
 *
 * Tests createParallelWorktree() and cleanupParallelWorktree() which manage
 * isolated git worktrees for parallel piece_call execution.
 *
 * Covers:
 * - createParallelWorktree: auto-commits parent changes before clone creation
 * - createParallelWorktree: passes parent's current branch as baseBranch
 * - createParallelWorktree: places clone under parent's .takt/worktrees/
 * - createParallelWorktree: creates .takt/worktrees/ directory via mkdirSync
 * - createParallelWorktree: continues when stageAndCommit fails
 * - cleanupParallelWorktree: .takt/runs/ copy without worktree deletion
 * - cleanupParallelWorktree: does not call removeClone
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
    mkdirSync: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

vi.mock('../infra/task/git.js', () => ({
  stageAndCommit: vi.fn(),
  getCurrentBranch: vi.fn(),
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: vi.fn(),
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: vi.fn(),
  getLanguage: vi.fn(),
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: vi.fn(),
}));

vi.mock('../shared/ui/index.js', () => ({
  StreamDisplay: vi.fn().mockImplementation(function () {
    return { createHandler: vi.fn().mockReturnValue(vi.fn()) };
  }),
}));

import { createParallelWorktree, cleanupParallelWorktree } from '../core/piece/engine/parallel-worktree.js';
import { createSharedClone, removeClone } from '../infra/task/clone.js';
import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stageAndCommit, getCurrentBranch } from '../infra/task/git.js';

describe('createParallelWorktree', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    // Default: getCurrentBranch returns parent branch name
    vi.mocked(getCurrentBranch).mockReturnValue('feature/parent-branch');
    // Default: stageAndCommit succeeds
    vi.mocked(stageAndCommit).mockReturnValue('abc1234');
  });

  // =====================================================
  // 1. Auto-commit parent changes before clone creation
  // =====================================================
  describe('auto-commit before clone', () => {
    it('should call stageAndCommit on parent before creating clone', () => {
      // Given: a project directory and slot name
      const projectDir = '/workspace/project';
      const slotName = 'slot_1';
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_1',
        branch: 'takt/20260101T0000-slot_1',
      });

      // When: creating a parallel worktree
      createParallelWorktree(projectDir, slotName);

      // Then: stageAndCommit should have been called with parent dir
      expect(stageAndCommit).toHaveBeenCalledWith(
        projectDir,
        'takt: auto-commit before child worktree',
      );
    });

    it('should continue clone creation when stageAndCommit fails', () => {
      // Given: stageAndCommit throws (no changes to commit)
      const projectDir = '/workspace/project';
      const slotName = 'slot_1';
      vi.mocked(stageAndCommit).mockImplementation(() => {
        throw new Error('nothing to commit');
      });
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_1',
        branch: 'takt/20260101T0000-slot_1',
      });

      // When: creating a parallel worktree (should not throw)
      const result = createParallelWorktree(projectDir, slotName);

      // Then: createSharedClone should still have been called
      expect(createSharedClone).toHaveBeenCalled();
      expect(result.path).toContain('slot_1');
    });

    it('should call stageAndCommit before createSharedClone', () => {
      // Given: track call order
      const callOrder: string[] = [];
      const projectDir = '/workspace/project';
      const slotName = 'slot_1';

      vi.mocked(stageAndCommit).mockImplementation(() => {
        callOrder.push('stageAndCommit');
        return 'abc1234';
      });
      vi.mocked(createSharedClone).mockImplementation(() => {
        callOrder.push('createSharedClone');
        return {
          path: '/workspace/project/.takt/worktrees/20260101T0000-slot_1',
          branch: 'takt/20260101T0000-slot_1',
        };
      });

      // When
      createParallelWorktree(projectDir, slotName);

      // Then: stageAndCommit is called before createSharedClone
      expect(callOrder).toEqual(['stageAndCommit', 'createSharedClone']);
    });
  });

  // =====================================================
  // 2. Pass parent's current branch as baseBranch
  // =====================================================
  describe('baseBranch from parent current branch', () => {
    it('should pass parent current branch as baseBranch to createSharedClone', () => {
      // Given: parent is on feature/parent-branch
      const projectDir = '/workspace/project';
      const slotName = 'slot_1';
      vi.mocked(getCurrentBranch).mockReturnValue('feature/parent-branch');
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_1',
        branch: 'takt/20260101T0000-slot_1',
      });

      // When
      createParallelWorktree(projectDir, slotName);

      // Then: createSharedClone receives baseBranch
      expect(createSharedClone).toHaveBeenCalledWith(
        projectDir,
        expect.objectContaining({
          baseBranch: 'feature/parent-branch',
        }),
      );
    });

    it('should call getCurrentBranch with parent projectDir', () => {
      // Given
      const projectDir = '/workspace/project';
      const slotName = 'slot_1';
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_1',
        branch: 'takt/20260101T0000-slot_1',
      });

      // When
      createParallelWorktree(projectDir, slotName);

      // Then: getCurrentBranch should be called with parent's cwd
      expect(getCurrentBranch).toHaveBeenCalledWith(projectDir);
    });

    it('should use getCurrentBranch return value directly as baseBranch', () => {
      // Given: getCurrentBranch returns already-trimmed branch name
      const projectDir = '/workspace/project';
      const slotName = 'slot_1';
      vi.mocked(getCurrentBranch).mockReturnValue('my-branch');
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_1',
        branch: 'takt/20260101T0000-slot_1',
      });

      // When
      createParallelWorktree(projectDir, slotName);

      // Then: baseBranch should match getCurrentBranch return value
      expect(createSharedClone).toHaveBeenCalledWith(
        projectDir,
        expect.objectContaining({
          baseBranch: 'my-branch',
        }),
      );
    });
  });

  // =====================================================
  // 3. Clone placement under .takt/worktrees/
  // =====================================================
  describe('clone placement under .takt/worktrees/', () => {
    it('should pass absolute path string as worktree option', () => {
      // Given
      const projectDir = '/workspace/project';
      const slotName = 'slot_1';
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_1',
        branch: 'takt/20260101T0000-slot_1',
      });

      // When
      createParallelWorktree(projectDir, slotName);

      // Then: worktree should be a string path (not boolean true)
      const callArgs = vi.mocked(createSharedClone).mock.calls[0]!;
      const options = callArgs[1];
      expect(typeof options.worktree).toBe('string');
      expect(options.worktree).toMatch(/\.takt\/worktrees\//);
      expect(options.worktree).toMatch(new RegExp(`${slotName}$`));
    });

    it('should create .takt/worktrees/ directory via mkdirSync', () => {
      // Given
      const projectDir = '/workspace/project';
      const slotName = 'slot_1';
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_1',
        branch: 'takt/20260101T0000-slot_1',
      });

      // When
      createParallelWorktree(projectDir, slotName);

      // Then: mkdirSync should be called for .takt/worktrees/
      expect(mkdirSync).toHaveBeenCalledWith(
        expect.stringContaining('.takt/worktrees'),
        expect.objectContaining({ recursive: true }),
      );
    });

    it('should include timestamp and slotName in clone path', () => {
      // Given
      const projectDir = '/workspace/project';
      const slotName = 'slot_2';
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_2',
        branch: 'takt/20260101T0000-slot_2',
      });

      // When
      createParallelWorktree(projectDir, slotName);

      // Then: worktree path should contain timestamp and slot name
      const callArgs = vi.mocked(createSharedClone).mock.calls[0]!;
      const worktreePath = callArgs[1].worktree as string;
      // Path format: {projectDir}/.takt/worktrees/{timestamp}-{slotName}
      expect(worktreePath).toMatch(/\.takt\/worktrees\/\d{8}T\d{4}-slot_2$/);
    });
  });

  // =====================================================
  // 4. taskSlug is still passed
  // =====================================================
  describe('taskSlug', () => {
    it('should include slot name in the clone task slug', () => {
      // Given
      const projectDir = '/workspace/project';
      const slotName = 'slot_2';
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_2',
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

  // =====================================================
  // 5. Return value passthrough
  // =====================================================
  describe('return value', () => {
    it('should return the result from createSharedClone', () => {
      // Given
      const projectDir = '/workspace/project';
      const slotName = 'slot_1';
      vi.mocked(createSharedClone).mockReturnValue({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_1',
        branch: 'takt/20260101T0000-slot_1',
      });

      // When
      const result = createParallelWorktree(projectDir, slotName);

      // Then
      expect(result).toEqual({
        path: '/workspace/project/.takt/worktrees/20260101T0000-slot_1',
        branch: 'takt/20260101T0000-slot_1',
      });
    });
  });
});

describe('cleanupParallelWorktree', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  // =====================================================
  // 1. Normal cleanup: copy runs, no worktree deletion
  // =====================================================
  describe('normal cleanup', () => {
    it('should copy .takt/runs/ from worktree to parent without removing worktree', async () => {
      // Given: worktree with .takt/runs/ directory
      const worktreePath = '/tmp/worktrees/slot_1-clone';
      const parentCwd = '/workspace/project';
      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p).includes('.takt/runs')) return true;
        return false;
      });

      // When: cleaning up the worktree (shouldMerge=false to test basic cleanup only)
      await cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: should copy runs directory
      expect(cpSync).toHaveBeenCalledWith(
        expect.stringContaining(worktreePath),
        expect.stringContaining(parentCwd),
        expect.objectContaining({ recursive: true }),
      );

      // Then: should NOT remove the worktree (parent cleanup handles it)
      expect(removeClone).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 2. Cleanup when child piece failed (still copies runs, no removal)
  // =====================================================
  describe('cleanup after failure', () => {
    it('should still copy runs without removing worktree when child piece failed', async () => {
      // Given: worktree exists with runs (even after failure)
      const worktreePath = '/tmp/worktrees/slot_2-clone';
      const parentCwd = '/workspace/project';
      vi.mocked(existsSync).mockImplementation((p) => {
        if (String(p).includes('.takt/runs')) return true;
        return false;
      });

      // When: cleanup runs (called from finally block, shouldMerge=false)
      await cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: runs are copied but worktree is NOT removed
      expect(cpSync).toHaveBeenCalled();
      expect(removeClone).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 3. Cleanup when .takt/runs/ does not exist
  // =====================================================
  describe('missing .takt/runs/', () => {
    it('should skip copy and not remove worktree when .takt/runs/ does not exist', async () => {
      // Given: worktree without .takt/runs/
      const worktreePath = '/tmp/worktrees/slot_3-clone';
      const parentCwd = '/workspace/project';
      vi.mocked(existsSync).mockReturnValue(false);

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: cpSync should NOT be called (no runs to copy)
      expect(cpSync).not.toHaveBeenCalled();

      // Then: worktree should NOT be removed
      expect(removeClone).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 4. Cleanup should not remove worktree even if copy fails
  // =====================================================
  describe('copy failure does not trigger worktree removal', () => {
    it('should not remove worktree when cpSync throws', async () => {
      // Given: cpSync will throw an error
      const worktreePath = '/tmp/worktrees/slot_1-clone';
      const parentCwd = '/workspace/project';
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(cpSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // When: cleanup runs (should not throw, shouldMerge=false)
      await cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: worktree removal should NOT be attempted
      expect(removeClone).not.toHaveBeenCalled();
    });
  });
});
