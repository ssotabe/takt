/**
 * Parallel worktree management for slot-based parallel execution.
 *
 * Creates and cleans up isolated git worktrees (via shared clone) for
 * each parallel piece_call slot.
 */

import { existsSync, cpSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSharedClone, removeClone } from '../../../infra/task/clone.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('parallel-worktree');

export function createParallelWorktree(
  projectDir: string,
  slotName: string,
): { path: string; branch: string } {
  return createSharedClone(projectDir, { taskSlug: slotName, worktree: true });
}

function mergeChildBranch(childClonePath: string, parentCwd: string): void {
  const headHash = execFileSync('git', ['-C', childClonePath, 'rev-parse', 'HEAD'], {
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

  const branch = execFileSync('git', ['-C', childClonePath, 'rev-parse', '--abbrev-ref', 'HEAD'], {
    encoding: 'utf-8',
    stdio: 'pipe',
  }).trim();

  log.debug('Merging child branch into parent', { childClonePath, branch, headHash });

  execFileSync('git', ['-C', parentCwd, 'fetch', childClonePath, branch], { stdio: 'pipe' });

  try {
    execFileSync('git', ['-C', parentCwd, 'merge', '--no-edit', 'FETCH_HEAD'], { stdio: 'pipe' });
  } catch (mergeError) {
    try {
      execFileSync('git', ['-C', parentCwd, 'merge', '--abort'], { stdio: 'pipe' });
    } catch {
      // abort failure is secondary; the original merge error is more important
    }
    throw mergeError;
  }
}

export function cleanupParallelWorktree(
  worktreePath: string,
  parentCwd: string,
  shouldMerge: boolean,
): void {
  if (shouldMerge) {
    try {
      mergeChildBranch(worktreePath, parentCwd);
    } catch (err) {
      log.error('Failed to merge child branch into parent', { worktreePath, parentCwd, error: String(err) });
    }
  }

  const childRunsDir = join(worktreePath, '.takt', 'runs');
  const parentRunsDir = join(parentCwd, '.takt', 'runs');
  try {
    if (existsSync(childRunsDir)) {
      cpSync(childRunsDir, parentRunsDir, { recursive: true });
    }
  } catch (err) {
    log.error('Failed to copy child runs to parent', { childRunsDir, parentRunsDir, error: String(err) });
  } finally {
    removeClone(worktreePath);
  }
}
