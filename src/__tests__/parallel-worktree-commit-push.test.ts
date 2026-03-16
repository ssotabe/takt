/**
 * Unit tests for parallel-worktree merge behavior.
 *
 * Tests cleanupParallelWorktree() with the shouldMerge parameter,
 * verifying merge operations are performed via execFileSync mocks.
 *
 * Covers:
 * - cleanupParallelWorktree: auto-commits before merge when shouldMerge=true
 * - cleanupParallelWorktree: merges before runs copy when shouldMerge=true
 * - cleanupParallelWorktree: skips merge and auto-commit when shouldMerge=false
 * - cleanupParallelWorktree: continues cleanup when merge fails and AI resolution fails
 * - cleanupParallelWorktree: AI resolves merge conflict successfully
 * - cleanupParallelWorktree: executes stageAndCommit → merge → runs copy (no clone removal)
 * - cleanupParallelWorktree: trims whitespace from rev-parse output
 * - cleanupParallelWorktree: calls merge --abort only after AI resolution fails
 * - cleanupParallelWorktree: continues cleanup when stageAndCommit fails
 * - cleanupParallelWorktree: passes slotInstruction to AI conflict resolver template
 * - cleanupParallelWorktree: does not call removeClone (parent cleanup handles it)
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

import { cleanupParallelWorktree } from '../core/piece/engine/parallel-worktree.js';
import { removeClone } from '../infra/task/clone.js';
import { existsSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stageAndCommit } from '../infra/task/git.js';
import { getProvider } from '../infra/providers/index.js';
import { resolveConfigValues, getLanguage } from '../infra/config/index.js';
import { loadTemplate } from '../shared/prompts/index.js';
import { StreamDisplay } from '../shared/ui/index.js';

/** Helper: set up execFileSync to simulate a successful merge flow */
function mockSuccessfulMergeFlow(): void {
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
}

/** Helper: set up execFileSync to simulate merge conflict */
function mockMergeConflict(): void {
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
}

/** Helper: set up AI provider mocks for conflict resolution */
function mockAiConflictResolver(status: 'done' | 'error'): ReturnType<typeof vi.fn> {
  const callMock = vi.fn().mockResolvedValue({ status, content: 'resolved' });
  const setupMock = vi.fn().mockReturnValue({ call: callMock });
  vi.mocked(getProvider).mockReturnValue({ setup: setupMock } as never);
  vi.mocked(resolveConfigValues).mockReturnValue({ provider: 'claude', model: 'sonnet' });
  vi.mocked(getLanguage).mockReturnValue('en');
  vi.mocked(loadTemplate).mockReturnValue('template content');
  return callMock;
}

describe('cleanupParallelWorktree with merge', () => {
  const worktreePath = '/tmp/worktrees/slot_1-clone';
  const parentCwd = '/workspace/project';

  beforeEach(() => {
    vi.resetAllMocks();
    // Re-setup StreamDisplay mock after resetAllMocks clears vi.mock factory implementations
    vi.mocked(StreamDisplay).mockImplementation(function () {
      return { createHandler: vi.fn().mockReturnValue(vi.fn()) };
    } as never);
    // Default: stageAndCommit succeeds with a commit hash
    vi.mocked(stageAndCommit).mockReturnValue('abc1234');
  });

  // =====================================================
  // 1. auto-commit before merge
  // =====================================================
  describe('auto-commit before merge', () => {
    it('should call stageAndCommit before mergeChildBranch when shouldMerge=true', async () => {
      // Given: merge succeeds, worktree has .takt/runs/
      mockSuccessfulMergeFlow();
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: stageAndCommit should have been called with worktree path
      expect(stageAndCommit).toHaveBeenCalledWith(
        worktreePath,
        'takt: auto-commit before merge',
        { allowGitHooks: false, allowGitFilters: false },
      );
    });

    it('should continue with merge when stageAndCommit returns undefined (no changes)', async () => {
      // Given: no changes to commit
      vi.mocked(stageAndCommit).mockReturnValue(undefined);
      mockSuccessfulMergeFlow();
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: merge should still proceed
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'merge', '--no-edit', 'FETCH_HEAD'],
        expect.objectContaining({ stdio: 'pipe' }),
      );
    });

    it('should continue with merge when stageAndCommit throws', async () => {
      // Given: stageAndCommit fails
      vi.mocked(stageAndCommit).mockImplementation(() => {
        throw new Error('git add failed');
      });
      mockSuccessfulMergeFlow();
      vi.mocked(existsSync).mockReturnValue(true);

      // When: should not throw
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: merge should still be attempted
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'fetch', worktreePath, 'takt/slot_1'],
        expect.objectContaining({ stdio: 'pipe' }),
      );
    });

    it('should not call stageAndCommit when shouldMerge=false', async () => {
      // Given
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then
      expect(stageAndCommit).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 2. shouldMerge=true: merge before cleanup
  // =====================================================
  describe('shouldMerge=true', () => {
    it('should call mergeChildBranch before runs copy', async () => {
      // Given: merge succeeds, worktree has .takt/runs/
      mockSuccessfulMergeFlow();
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

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

      // Then: runs copy happened, but removeClone was NOT called
      expect(cpSync).toHaveBeenCalled();
      expect(removeClone).not.toHaveBeenCalled();
    });

    it('should trim whitespace from rev-parse output', async () => {
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
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: fetch uses trimmed branch name
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'fetch', worktreePath, 'feature-branch'],
        expect.objectContaining({ stdio: 'pipe' }),
      );
    });
  });

  // =====================================================
  // 3. shouldMerge=false: skip merge
  // =====================================================
  describe('shouldMerge=false', () => {
    it('should skip merge and proceed directly to runs copy without clone removal', async () => {
      // Given: worktree with .takt/runs/
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: no git operations (merge skipped)
      expect(execFileSync).not.toHaveBeenCalled();

      // Then: runs copy happens, but removeClone is NOT called
      expect(cpSync).toHaveBeenCalled();
      expect(removeClone).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 4. AI conflict resolution on merge failure
  // =====================================================
  describe('AI conflict resolution', () => {
    it('should attempt AI resolution when merge conflict occurs', async () => {
      // Given: merge will conflict, AI resolves successfully
      mockMergeConflict();
      const callMock = mockAiConflictResolver('done');
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: AI agent should have been called
      expect(callMock).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          cwd: parentCwd,
          permissionMode: 'edit',
        }),
      );

      // Then: merge --abort should NOT have been called (AI resolved)
      expect(execFileSync).not.toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'merge', '--abort'],
        expect.anything(),
      );
    });

    it('should call merge --abort when AI resolution fails', async () => {
      // Given: merge conflicts, AI resolution fails
      mockMergeConflict();
      const callMock = mockAiConflictResolver('error');
      vi.mocked(existsSync).mockReturnValue(true);

      // When: should not throw (error is caught in cleanupParallelWorktree)
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: AI agent should have been called (not skipped due to mock issue)
      expect(callMock).toHaveBeenCalled();

      // Then: merge --abort should have been called
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'merge', '--abort'],
        expect.objectContaining({ stdio: 'pipe' }),
      );
    });

    it('should fall back to merge --abort when AI provider is not configured', async () => {
      // Given: merge conflicts, no provider configured
      mockMergeConflict();
      vi.mocked(resolveConfigValues).mockReturnValue({ provider: undefined, model: undefined });
      vi.mocked(existsSync).mockReturnValue(true);

      // When: should not throw
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: merge --abort should have been called
      expect(execFileSync).toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'merge', '--abort'],
        expect.objectContaining({ stdio: 'pipe' }),
      );

      // Then: cleanup should still complete (no removeClone)
      expect(removeClone).not.toHaveBeenCalled();
    });

    it('should pass slotInstruction as originalInstruction to template', async () => {
      // Given: merge conflicts, AI resolves, slotInstruction provided
      mockMergeConflict();
      mockAiConflictResolver('done');
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, true, 'Implement feature X');

      // Then: loadTemplate for message should have been called with originalInstruction
      expect(loadTemplate).toHaveBeenCalledWith(
        'sync_conflict_resolver_message',
        expect.any(String),
        expect.objectContaining({ originalInstruction: 'Implement feature X' }),
      );
    });

    it('should still complete cleanup after successful AI resolution', async () => {
      // Given: merge conflicts but AI resolves
      mockMergeConflict();
      const callMock = mockAiConflictResolver('done');
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: AI agent should have been called (confirms success path, not catch path)
      expect(callMock).toHaveBeenCalled();

      // Then: merge --abort should NOT have been called (AI resolved successfully)
      expect(execFileSync).not.toHaveBeenCalledWith(
        'git',
        ['-C', parentCwd, 'merge', '--abort'],
        expect.anything(),
      );

      // Then: runs copy happened, but removeClone was NOT called
      expect(cpSync).toHaveBeenCalled();
      expect(removeClone).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 5. Ordering: stageAndCommit → merge → runs copy (no clone removal)
  // =====================================================
  describe('execution ordering', () => {
    it('should execute stageAndCommit → merge → runs copy without clone removal', async () => {
      // Given: track call order
      const callOrder: string[] = [];

      vi.mocked(stageAndCommit).mockImplementation(() => {
        callOrder.push('stageAndCommit');
        return 'abc1234';
      });

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
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: stageAndCommit → fetch → merge → cpSync (no removeClone)
      expect(callOrder).toEqual(['stageAndCommit', 'fetch', 'merge', 'cpSync']);
    });
  });

  // =====================================================
  // 6. slotInstruction parameter
  // =====================================================
  describe('slotInstruction parameter', () => {
    it('should accept optional slotInstruction as fourth argument', async () => {
      // Given: merge succeeds
      mockSuccessfulMergeFlow();
      vi.mocked(existsSync).mockReturnValue(false);

      // When: calling with slotInstruction
      await cleanupParallelWorktree(worktreePath, parentCwd, true, 'slot task description');

      // Then: should complete without error (no removeClone call)
      expect(removeClone).not.toHaveBeenCalled();
    });

    it('should work without slotInstruction (undefined)', async () => {
      // Given: merge succeeds
      mockSuccessfulMergeFlow();
      vi.mocked(existsSync).mockReturnValue(false);

      // When: calling without slotInstruction
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: should complete without error (no removeClone call)
      expect(removeClone).not.toHaveBeenCalled();
    });
  });

  // =====================================================
  // 7. removeClone is never called
  // =====================================================
  describe('removeClone not called', () => {
    it('should not call removeClone in any cleanup scenario', async () => {
      // Given: merge succeeds, runs exist
      mockSuccessfulMergeFlow();
      vi.mocked(existsSync).mockReturnValue(true);

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, true);

      // Then: removeClone should never be called
      expect(removeClone).not.toHaveBeenCalled();
    });

    it('should not call removeClone even when cpSync fails', async () => {
      // Given: cpSync throws
      vi.mocked(existsSync).mockReturnValue(true);
      vi.mocked(cpSync).mockImplementation(() => {
        throw new Error('Permission denied');
      });

      // When
      await cleanupParallelWorktree(worktreePath, parentCwd, false);

      // Then: removeClone should never be called
      expect(removeClone).not.toHaveBeenCalled();
    });
  });
});
