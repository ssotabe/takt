/**
 * Worktree synchronization: merge child branches and resolve conflicts.
 *
 * Extracted from parallel-worktree to separate merge responsibility
 * from worktree lifecycle management.
 */

import { execFileSync } from 'node:child_process';
import { getProvider, type ProviderType } from '../../../infra/providers/index.js';
import { resolveConfigValues, getLanguage } from '../../../infra/config/index.js';
import { loadTemplate } from '../../../shared/prompts/index.js';
import { StreamDisplay } from '../../../shared/ui/index.js';
import { createLogger, getErrorMessage } from '../../../shared/utils/index.js';

const log = createLogger('worktree-sync');

/** Auto-approve all tool invocations (agent runs in isolated worktree) */
async function autoApproveAll(request: { toolName: string; input: Record<string, unknown> }) {
  return { behavior: 'allow' as const, updatedInput: request.input };
}

export function abortMerge(parentCwd: string): void {
  try {
    execFileSync('git', ['-C', parentCwd, 'merge', '--abort'], { stdio: 'pipe' });
  } catch (abortError) {
    log.error('merge --abort failed', { parentCwd, error: getErrorMessage(abortError) });
  }
}

export async function attemptAiConflictResolution(parentCwd: string, slotInstruction?: string): Promise<boolean> {
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

export async function mergeChildBranch(childClonePath: string, parentCwd: string, slotInstruction?: string): Promise<void> {
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
