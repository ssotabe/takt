/**
 * Parallel worktree management for slot-based parallel execution.
 *
 * Creates and cleans up isolated git worktrees (via shared clone) for
 * each parallel workflow_call slot.
 */

import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createSharedClone } from '../../../infra/task/clone.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { stageAndCommit, getCurrentBranch } from '../../../infra/task/git.js';

const log = createLogger('parallel-worktree');

function generateTimestamp(): string {
  return new Date().toISOString().replace(/[-:.]/g, '').slice(0, 13);
}

export function createParallelWorktree(
  projectDir: string,
  slotName: string,
): { path: string; branch: string } {
  try {
    stageAndCommit(projectDir, 'takt: auto-commit before child worktree');
  } catch (err) {
    log.info('Auto-commit skipped before child worktree', { projectDir, error: getErrorMessage(err) });
  }

  const currentBranch = getCurrentBranch(projectDir);

  const worktreeBaseDir = join(projectDir, '.takt', 'worktrees');
  mkdirSync(worktreeBaseDir, { recursive: true });
  const clonePath = join(worktreeBaseDir, `${generateTimestamp()}-${slotName}`);

  return createSharedClone(projectDir, {
    taskSlug: slotName,
    worktree: clonePath,
    baseBranch: currentBranch,
  });
}

export async function cleanupParallelWorktree(
  worktreePath: string,
  parentCwd: string,
): Promise<void> {
  const childRunsDir = join(worktreePath, '.takt', 'runs');
  const parentRunsDir = join(parentCwd, '.takt', 'runs');
  try {
    if (existsSync(childRunsDir)) {
      cpSync(childRunsDir, parentRunsDir, { recursive: true });
    }
  } catch (err) {
    log.error('Failed to copy child runs to parent', { childRunsDir, parentRunsDir, error: getErrorMessage(err) });
  }
}
