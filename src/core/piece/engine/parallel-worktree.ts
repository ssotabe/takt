/**
 * Parallel worktree management for slot-based parallel execution.
 *
 * Creates and cleans up isolated git worktrees (via shared clone) for
 * each parallel piece_call slot.
 */

import { existsSync, cpSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createSharedClone } from '../../../infra/task/clone.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';
import { stageAndCommit, getCurrentBranch } from '../../../infra/task/git.js';
import { getProvider, type ProviderType } from '../../../infra/providers/index.js';
import { resolveConfigValues, getLanguage } from '../../../infra/config/index.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { StreamDisplay } from '../../../shared/ui/index.js';

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

/** Auto-approve all tool invocations (agent runs in isolated worktree) */
async function autoApproveAll(request: { toolName: string; input: Record<string, unknown> }) {
  return { behavior: 'allow' as const, updatedInput: request.input };
}

function abortMerge(parentCwd: string): void {
  try {
    execFileSync('git', ['-C', parentCwd, 'merge', '--abort'], { stdio: 'pipe' });
  } catch (abortError) {
    log.error('merge --abort failed', { parentCwd, error: getErrorMessage(abortError) });
  }
}

async function attemptAiConflictResolution(parentCwd: string, slotInstruction?: string): Promise<boolean> {
  const lang = getLanguage();
  const originalInstruction = slotInstruction ?? '(no slot instruction available)';
  const systemPrompt = loadTemplate('sync_conflict_resolver_system_prompt', lang);
  const prompt = loadTemplate('sync_conflict_resolver_message', lang, { originalInstruction });

  const config = resolveConfigValues(parentCwd, ['provider', 'model']);
  if (!config.provider) {
    throw new Error('No provider configured');
  }
  const providerType = config.provider as ProviderType;
  const provider = getProvider(providerType);
  const agent = provider.setup({ name: 'conflict-resolver', systemPrompt });

  const response = await agent.call(prompt, {
    cwd: parentCwd,
    model: config.model,
    permissionMode: 'edit',
    onPermissionRequest: autoApproveAll,
    onStream: new StreamDisplay('conflict-resolver', false).createHandler(),
  });

  return response.status === 'done';
}

async function mergeChildBranch(childClonePath: string, parentCwd: string, slotInstruction?: string): Promise<void> {
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
      const resolved = await attemptAiConflictResolution(parentCwd, slotInstruction);
      if (resolved) {
        log.info('AI conflict resolution succeeded', { parentCwd });
        return;
      }
    } catch (aiError) {
      log.info('AI conflict resolution unavailable, falling back to abort', {
        parentCwd, error: getErrorMessage(aiError),
      });
    }
    abortMerge(parentCwd);
    throw mergeError;
  }
}

export async function cleanupParallelWorktree(
  worktreePath: string,
  parentCwd: string,
  shouldMerge: boolean,
  slotInstruction?: string,
): Promise<void> {
  if (shouldMerge) {
    try {
      const summary = slotInstruction
        ? slotInstruction.split('\n')[0]!.slice(0, 72)
        : 'auto-commit before merge';
      const hash = stageAndCommit(worktreePath, `takt: ${summary}`, {
        allowGitHooks: false,
        allowGitFilters: false,
      });
      if (hash) log.info('Auto-committed before merge', { worktreePath, hash });
    } catch (err) {
      log.info('Auto-commit skipped', { worktreePath, error: getErrorMessage(err) });
    }

    try {
      await mergeChildBranch(worktreePath, parentCwd, slotInstruction);
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
  }
}
