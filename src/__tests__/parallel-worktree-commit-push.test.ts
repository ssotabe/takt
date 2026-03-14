/**
 * Unit tests for parallel-worktree merge behavior.
 *
 * Tests cleanupParallelWorktree() with the shouldMerge parameter,
 * verifying merge operations are performed via execFileSync mocks.
 *
 * Covers:
 * - cleanupParallelWorktree: merges before runs copy when shouldMerge=true
 * - cleanupParallelWorktree: skips merge when shouldMerge=false
 * - cleanupParallelWorktree: continues cleanup when merge fails
 * - cleanupParallelWorktree: executes merge → runs copy → clone removal in order
 * - cleanupParallelWorktree: trims whitespace from rev-parse output
 * - cleanupParallelWorktree: calls merge --abort on conflict before continuing
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock dependencies before importing the module under test
vi.mock('../infra/task/clone.js', () => ({
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

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
}));

import { cleanupParallelWorktree } from '../core/piece/engine/parallel-worktree.js';
import { removeClone } from '../infra/task/clone.js';
import { existsSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

describe('cleanupParallelWorktree with merge', () => {
  const worktreePath = '/tmp/worktrees/slot_1-clone';
  const parentCwd = '/workspace/project';

  beforeEach(() => {
    vi.resetAllMocks();
  });

  // =====================================================
  // 1. shouldMerge=true: merge before cleanup
  // =====================================================
  describe('shouldMerge=true', () => {
    it('should call mergeChildBranch before runs copy and clone removal', () => {
      // Given: merge succeeds, worktree has .takt/runs/
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const argsArr = args as string[];
        if (argsArr.includes('rev-parse') && !argsArr.includes('--abbrev-ref')) {
          return 'abc1234\n';
        }
        if (argsArr.includes('--abbrev-ref')) {
          return 'takt/slot_1\n';
        }
        return '';
      });
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: rev-parse HEAD should have been called
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', worktreePath, 'rev-parse', 'HEAD'],
        expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
      );

      // Then: rev-parse --abbrev-ref HEAD should have been called
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', worktreePath, 'rev-parse', '--abbrev-ref', 'HEAD'],
        expect.objectContaining({ encoding: 'utf-8', stdio: 'pipe' }),
      );

      // Then: fetch should have been called with trimmed branch name
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'fetch', worktreePath, 'takt/slot_1'],
        expect.objectContaining({ stdio: 'pipe' }),
      );

      // Then: merge should have been called
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'merge', '--no-edit', 'FETCH_HEAD'],
        expect.objectContaining({ stdio: 'pipe' }),
      );

      // Then: runs copy and clone removal also happened
      expect(cpSync).toHaveBeenCalled();
      expect(removeClone).toHaveBeenCalledWith(worktreePath);
    });

    it('should trim whitespace from rev-parse output', () => {
      // Given: rev-parse returns values with surrounding whitespace
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const argsArr = args as string[];
        if (argsArr.includes('--abbrev-ref')) {
          return '  feature-branch \n';
        }
        if (argsArr.includes('rev-parse')) {
          return 'deadbeef\n';
        }
        return '';
      });
      vi.mocked(existsSync).mockReturnValue(false);

      // When
      cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: fetch uses trimmed branch name
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'fetch', worktreePath, 'feature-branch'],
        expect.objectContaining({ stdio: 'pipe' }),
      );
    });
  });

  // =====================================================
  // 2. shouldMerge=false: skip merge
  // =====================================================
  describe('shouldMerge=false', () => {
    it('should skip merge and proceed directly to runs copy and clone removal', () => {
      // Given: worktree with .takt/runs/
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: no git operations (merge skipped)
      expect(execFileSync).not.toHaveBeenCalled();

      // Then: runs copy and clone removal still happen
      expect(cpSync).toHaveBeenCalled();
      expect(removeClone).toHaveBeenCalledWith(worktreePath);
    });
  });

  // =====================================================
  // 3. Merge failure: continue with cleanup + abort called
  // =====================================================
  describe('merge failure handling', () => {
    it('should call merge --abort and continue with cleanup when conflict occurs', () => {
      // Given: merge will fail (conflict)
      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const argsArr = args as string[];
        if (argsArr.includes('rev-parse') && !argsArr.includes('--abbrev-ref')) {
          return 'abc1234\n';
        }
        if (argsArr.includes('--abbrev-ref')) {
          return 'takt/slot_1\n';
        }
        if (argsArr.includes('merge') && argsArr.includes('FETCH_HEAD')) {
          throw new Error('CONFLICT (content): Merge conflict in file.ts');
        }
        return '';
      });
      vi.mocked(existsSync).mockReturnValue(true);

      // When: should not throw (merge error is caught internally)
      cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: merge --abort should have been called
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'merge', '--abort'],
        expect.objectContaining({ stdio: 'pipe' }),
      );

      // Then: runs copy still happened
      expect(cpSync).toHaveBeenCalled();

      // Then: clone removal still happened
      expect(removeClone).toHaveBeenCalledWith(worktreePath);
    });
  });

  // =====================================================
  // 4. Ordering: merge → runs copy → clone removal
  // =====================================================
  describe('execution ordering', () => {
    it('should execute merge before runs copy before clone removal', () => {
      // Given: track call order
      const callOrder: string[] = [];

      vi.mocked(execFileSync).mockImplementation((_cmd, args) => {
        const argsArr = args as string[];
        if (argsArr.includes('rev-parse') && !argsArr.includes('--abbrev-ref')) {
          return 'abc1234\n';
        }
        if (argsArr.includes('--abbrev-ref')) {
          return 'takt/slot_1\n';
        }
        if (argsArr.includes('fetch')) {
          callOrder.push('fetch');
        }
        if (argsArr.includes('merge') && argsArr.includes('FETCH_HEAD')) {
          callOrder.push('merge');
        }
        return '';
      });
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(cpSync).mockImplementation(() => {
        callOrder.push('cpSync');
      });
      vi.mocked(removeClone).mockImplementation(() => {
        callOrder.push('removeClone');
      });

      // When
      cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: merge (fetch + merge) → cpSync → removeClone
      expect(callOrder).toEqual(['fetch', 'merge', 'cpSync', 'removeClone']);
    });
  });
});
