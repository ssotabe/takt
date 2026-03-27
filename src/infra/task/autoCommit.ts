/**
 * Auto-commit and push for clone tasks
 *
 * After a successful piece completion in a shared clone,
 * automatically stages all changes, creates a commit, and
 * pushes to origin so the branch is reflected in the main repo.
 * No co-author trailer is added.
 */

import { execFileSync } from 'node:child_process';
import { resolveConfigValue } from '../config/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import { stageAndCommit } from './git.js';

const log = createLogger('autoCommit');
const AUTO_COMMIT_PUSH_FAILURE_MESSAGE = 'Push to main repo failed after commit creation.';
const AUTO_COMMIT_FAILURE_MESSAGE = 'Auto-commit failed.';

export interface AutoCommitResult {
  /** Whether the commit was created successfully */
  success: boolean;
  /** The short commit hash (if committed) */
  commitHash?: string;
  /** Whether the local push back to the main repo failed after commit creation */
  localPushFailed?: boolean;
  /** Human-readable message */
  message: string;
}

/**
 * Handles auto-commit and push operations for clone tasks.
 */
export class AutoCommitter {
  commitAndPush(cloneCwd: string, taskName: string, projectDir: string): AutoCommitResult {
    log.info('Auto-commit starting', { cwd: cloneCwd, taskName });

    try {
      const commitMessage = `takt: ${taskName}`;
      const commitHash = stageAndCommit(cloneCwd, commitMessage, {
        allowGitHooks: resolveConfigValue(projectDir, 'allowGitHooks') ?? false,
        allowGitFilters: resolveConfigValue(projectDir, 'allowGitFilters') ?? false,
      });

      if (commitHash) {
        log.info('Auto-commit created', { commitHash, message: commitMessage });
      } else {
        log.info('No changes to commit');
      }

      try {
        execFileSync('git', ['push', projectDir, 'HEAD'], {
          cwd: cloneCwd,
          stdio: 'pipe',
        });
        log.info('Pushed to main repo', { projectDir });
      } catch (pushError) {
        void pushError;
        log.info('Push to main repo failed after commit creation', {
          projectDir,
          outcome: AUTO_COMMIT_PUSH_FAILURE_MESSAGE,
        });

        return {
          success: true,
          commitHash,
          localPushFailed: true,
          message: `Committed: ${commitHash} - ${commitMessage}`,
        };
      }

      if (!commitHash) {
        return { success: true, message: 'No changes to commit, pushed existing commits' };
      }

      return {
        success: true,
        commitHash,
        message: `Committed: ${commitHash} - ${commitMessage}`,
      };
    } catch (err) {
      const errorMessage = getErrorMessage(err);
      log.error('Auto-commit failed', { outcome: AUTO_COMMIT_FAILURE_MESSAGE });

      return {
        success: false,
        message: `Auto-commit failed: ${errorMessage}`,
      };
    }
  }
}

// ---- Module-level function ----

const defaultCommitter = new AutoCommitter();

export function autoCommitAndPush(cloneCwd: string, taskName: string, projectDir: string): AutoCommitResult {
  return defaultCommitter.commitAndPush(cloneCwd, taskName, projectDir);
}
