import { randomUUID } from 'node:crypto';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentResponse, PermissionMode } from '../../core/models/index.js';
import { createLogger, getErrorMessage } from '../../shared/utils/index.js';
import {
  type ClaudePermissionExpression,
  taktPermissionModeToClaudeExpression,
} from '../claude/permission-mode-expression.js';
import {
  HEADLESS_ABORTED_MESSAGE,
  type ExecError,
  runHeadlessCli,
} from './headless-spawn.js';
import {
  aggregateResultFromStdout,
  extractSessionIdFromStdout,
} from './stream-json-lines.js';
import { buildClaudeHeadlessResponse, buildErrorResponse } from './result-response.js';
import { isRetryableError, waitForRetryDelay, HEADLESS_MAX_RETRIES } from './retry.js';
import type { ClaudeHeadlessCallOptions } from './types.js';

const log = createLogger('claude-headless');

function resolveCliPermissionMode(
  mode: PermissionMode | undefined,
  bypassPermissions: boolean | undefined,
): ClaudePermissionExpression {
  if (bypassPermissions) {
    return 'bypassPermissions';
  }
  if (mode !== undefined) {
    return taktPermissionModeToClaudeExpression(mode);
  }
  return 'default';
}

function resolveSessionArgs(options: ClaudeHeadlessCallOptions): { args: string[]; sessionId: string } {
  if (options.sessionId) {
    return {
      args: ['--resume', options.sessionId],
      sessionId: options.sessionId,
    };
  }

  const sessionId = randomUUID();
  return {
    args: ['--session-id', sessionId],
    sessionId,
  };
}

type PreparedSpawnResources = {
  mcpConfigArg?: string;
  cleanup: () => Promise<void>;
};

async function prepareMcpConfig(options: ClaudeHeadlessCallOptions): Promise<PreparedSpawnResources> {
  if (!options.mcpServers || Object.keys(options.mcpServers).length === 0) {
    return { cleanup: async () => {} };
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'takt-claude-mcp-'));
  const configPath = join(tempDir, 'mcp-config.json');

  try {
    await chmod(tempDir, 0o700);
    await writeFile(configPath, JSON.stringify({ mcpServers: options.mcpServers }), {
      encoding: 'utf-8',
      mode: 0o600,
    });
    await chmod(configPath, 0o600);
  } catch (raw) {
    try {
      await rm(tempDir, { recursive: true, force: true });
    } catch (cleanupRaw) {
      log.error('Failed to clean up Claude MCP temp directory after prepare failure', {
        error: getErrorMessage(cleanupRaw),
        tempDir,
      });
    }
    throw raw;
  }

  return {
    mcpConfigArg: configPath,
    cleanup: async () => {
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}

function buildSettingsArg(options: ClaudeHeadlessCallOptions): string | undefined {
  const sandbox = options.sandbox;
  if (!sandbox) {
    return undefined;
  }

  const settingsSandbox = {
    ...(sandbox.allowUnsandboxedCommands !== undefined
      ? { allowUnsandboxedCommands: sandbox.allowUnsandboxedCommands }
      : {}),
    ...(sandbox.excludedCommands !== undefined
      ? { excludedCommands: sandbox.excludedCommands }
      : {}),
  };

  if (Object.keys(settingsSandbox).length === 0) {
    return undefined;
  }

  return JSON.stringify({ sandbox: settingsSandbox });
}

async function buildSpawnArgs(
  prompt: string,
  options: ClaudeHeadlessCallOptions,
): Promise<{ args: string[]; expectedSessionId: string; cleanup: () => Promise<void> }> {
  const session = resolveSessionArgs(options);
  const preparedResources = await prepareMcpConfig(options);
  const args: string[] = [
    '-p',
    '--verbose',
    '--output-format',
    'stream-json',
    '--include-partial-messages',
    '--permission-mode',
    resolveCliPermissionMode(options.permissionMode, options.bypassPermissions),
  ];

  if (options.model) {
    args.push('--model', options.model);
  }

  if (options.allowedTools && options.allowedTools.length > 0) {
    args.push('--allowed-tools', options.allowedTools.join(','));
  }

  if (options.effort) {
    args.push('--effort', options.effort);
  }

  if (options.systemPrompt?.trim()) {
    args.push('--system-prompt', options.systemPrompt.trim());
  }

  if (options.outputSchema) {
    args.push('--json-schema', JSON.stringify(options.outputSchema));
  }

  if (preparedResources.mcpConfigArg) {
    args.push('--mcp-config', preparedResources.mcpConfigArg);
  }

  const settings = buildSettingsArg(options);
  if (settings) {
    args.push('--settings', settings);
  }

  args.push(...session.args);
  args.push('--', prompt);
  return {
    args,
    expectedSessionId: session.sessionId,
    cleanup: preparedResources.cleanup,
  };
}

function classifyError(error: ExecError, options: ClaudeHeadlessCallOptions): string {
  if (options.abortSignal?.aborted || error.name === 'AbortError') {
    return HEADLESS_ABORTED_MESSAGE;
  }
  if (error.code === 'ENOENT') {
    return 'claude CLI not found. Install Claude Code and ensure `claude` is in PATH, or set claude_cli_path in config.';
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return getErrorMessage(error);
  }
  if (typeof error.code === 'number') {
    const detail = (error.stderr ?? error.stdout ?? '').trim() || getErrorMessage(error);
    return `Claude CLI failed (${error.code}): ${detail}`;
  }
  return getErrorMessage(error);
}

export async function callClaudeHeadless(
  agentName: string,
  prompt: string,
  options: ClaudeHeadlessCallOptions,
): Promise<AgentResponse> {
  let response: AgentResponse | undefined;
  let retryOptions = options;

  for (let attempt = 0; attempt <= HEADLESS_MAX_RETRIES; attempt++) {
    let prepared: Awaited<ReturnType<typeof buildSpawnArgs>>;
    try {
      prepared = await buildSpawnArgs(prompt, retryOptions);
    } catch (raw) {
      response = buildErrorResponse(agentName, getErrorMessage(raw as Error), options);
      break;
    }

    const { cleanup } = prepared;

    try {
      const { args, expectedSessionId } = prepared;
      const { stdout, stderr } = await runHeadlessCli(args, retryOptions);
      const parsed = aggregateResultFromStdout(stdout);
      const sessionId = extractSessionIdFromStdout(stdout) ?? expectedSessionId;
      response = buildClaudeHeadlessResponse({
        agentName,
        parsed,
        stdout,
        stderr,
        sessionId,
        outputSchema: options.outputSchema,
        onStream: options.onStream,
      });

      try {
        await cleanup();
      } catch (raw) {
        log.error('Failed to clean up Claude MCP config', {
          agentName,
          error: getErrorMessage(raw as Error),
        });
      }

      break;
    } catch (raw) {
      const error = raw as ExecError;

      try {
        await cleanup();
      } catch (cleanupRaw) {
        log.error('Failed to clean up Claude MCP config', {
          agentName,
          error: getErrorMessage(cleanupRaw as Error),
        });
      }

      if (!isRetryableError(error, options.abortSignal) || attempt >= HEADLESS_MAX_RETRIES) {
        response = buildErrorResponse(agentName, classifyError(error, options), options);
        break;
      }

      const extractedSessionId = extractSessionIdFromStdout(error.stdout ?? '');
      const strategy: 'resume' | 'new_session' = extractedSessionId ? 'resume' : 'new_session';
      retryOptions = extractedSessionId
        ? { ...options, sessionId: extractedSessionId }
        : { ...options, sessionId: undefined };

      if (options.onStream) {
        options.onStream({
          type: 'retry',
          data: { attempt: attempt + 1, maxRetries: HEADLESS_MAX_RETRIES, strategy },
        });
      }

      if (options.abortSignal?.aborted) {
        response = buildErrorResponse(agentName, classifyError(error, options), options);
        break;
      }

      try {
        await waitForRetryDelay(attempt + 1, options.abortSignal);
      } catch {
        response = buildErrorResponse(agentName, classifyError(error, options), options);
        break;
      }
    }
  }

  return response!;
}
