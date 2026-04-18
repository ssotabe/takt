/**
 * Unit tests for worktree-sync module.
 *
 * Tests:
 * - mergeChildBranch: fetch + merge from child clone, AI conflict resolution fallback
 * - attemptAiConflictResolution: provider setup, agent call, success/failure
 * - abortMerge: git merge --abort
 *
 * Mocked: child_process, provider, config, template, StreamDisplay
 * Not mocked: worktree-sync logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Hoisted mocks ---

const {
  mockExecFileSync,
  mockGetProvider,
  mockResolveConfigValues,
  mockGetLanguage,
  mockLoadTemplate,
  mockStreamDisplayConstructor,
  mockStreamDisplayCreateHandler,
  mockAgentCall,
} = vi.hoisted(() => {
  const createHandler = vi.fn();
  return {
    mockExecFileSync: vi.fn(),
    mockGetProvider: vi.fn(),
    mockResolveConfigValues: vi.fn(),
    mockGetLanguage: vi.fn(),
    mockLoadTemplate: vi.fn(),
    mockStreamDisplayConstructor: vi.fn(() => ({ createHandler })),
    mockStreamDisplayCreateHandler: createHandler,
    mockAgentCall: vi.fn(),
  };
});

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
}));

vi.mock('../infra/providers/index.js', () => ({
  getProvider: mockGetProvider,
}));

vi.mock('../infra/config/index.js', () => ({
  resolveConfigValues: mockResolveConfigValues,
  getLanguage: mockGetLanguage,
}));

vi.mock('../shared/prompts/index.js', () => ({
  loadTemplate: mockLoadTemplate,
}));

vi.mock('../shared/ui/index.js', () => ({
  StreamDisplay: mockStreamDisplayConstructor,
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
  getErrorMessage: (e: unknown) => String(e),
}));

// --- Imports (after mocks) ---

import {
  mergeChildBranch,
  attemptAiConflictResolution,
  abortMerge,
} from '../core/workflow/engine/worktree-sync.js';

describe('mergeChildBranch', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockStreamDisplayConstructor.mockImplementation(() => ({
      createHandler: mockStreamDisplayCreateHandler,
    }));
    mockStreamDisplayCreateHandler.mockReturnValue(vi.fn());
  });

  it('should fetch and merge child branch into parent successfully', async () => {
    // Given
    mockExecFileSync
      .mockReturnValueOnce('abc123\n')  // rev-parse HEAD
      .mockReturnValueOnce('feature/slot-1\n')  // rev-parse --abbrev-ref HEAD
      .mockReturnValueOnce(undefined)  // fetch
      .mockReturnValueOnce(undefined);  // merge

    // When
    await mergeChildBranch('/child/clone', '/parent');

    // Then
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/child/clone', 'rev-parse', 'HEAD'],
      expect.objectContaining({ encoding: 'utf-8' }),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/parent', 'fetch', '/child/clone', 'feature/slot-1'],
      expect.any(Object),
    );
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/parent', 'merge', '--no-edit', 'FETCH_HEAD'],
      expect.any(Object),
    );
  });

  it('should attempt AI conflict resolution when merge fails', async () => {
    // Given
    const mergeError = new Error('merge conflict');
    mockExecFileSync
      .mockReturnValueOnce('abc123\n')  // rev-parse HEAD
      .mockReturnValueOnce('slot-branch\n')  // rev-parse --abbrev-ref HEAD
      .mockReturnValueOnce(undefined)  // fetch
      .mockImplementationOnce(() => { throw mergeError; })  // merge fails
      .mockReturnValueOnce(undefined);  // merge --abort (if AI fails)

    mockResolveConfigValues.mockReturnValue({ provider: 'claude', model: 'sonnet' });
    mockGetLanguage.mockReturnValue('en');
    mockLoadTemplate.mockReturnValue('template content');
    const mockSetup = vi.fn().mockReturnValue({ call: mockAgentCall });
    mockGetProvider.mockReturnValue({ setup: mockSetup });
    mockAgentCall.mockResolvedValue({ status: 'done' });

    // When
    await mergeChildBranch('/child', '/parent', 'resolve conflicts');

    // Then: AI resolution attempted
    expect(mockGetProvider).toHaveBeenCalledWith('claude');
    expect(mockAgentCall).toHaveBeenCalled();
  });

  it('should abort merge and rethrow when AI conflict resolution fails', async () => {
    // Given
    const mergeError = new Error('merge conflict');
    mockExecFileSync
      .mockReturnValueOnce('abc123\n')
      .mockReturnValueOnce('slot-branch\n')
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => { throw mergeError; })  // merge fails
      .mockReturnValueOnce(undefined);  // merge --abort

    mockResolveConfigValues.mockReturnValue({ provider: 'claude', model: 'sonnet' });
    mockGetLanguage.mockReturnValue('en');
    mockLoadTemplate.mockReturnValue('template');
    mockGetProvider.mockReturnValue({
      setup: vi.fn().mockReturnValue({ call: mockAgentCall }),
    });
    mockAgentCall.mockResolvedValue({ status: 'blocked' });

    // When / Then
    await expect(mergeChildBranch('/child', '/parent')).rejects.toThrow('merge conflict');
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/parent', 'merge', '--abort'],
      expect.any(Object),
    );
  });

  it('should abort merge when AI resolution throws', async () => {
    // Given
    const mergeError = new Error('merge conflict');
    mockExecFileSync
      .mockReturnValueOnce('abc123\n')
      .mockReturnValueOnce('slot-branch\n')
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => { throw mergeError; })  // merge fails
      .mockReturnValueOnce(undefined);  // merge --abort

    mockResolveConfigValues.mockReturnValue({ provider: 'claude', model: 'sonnet' });
    mockGetLanguage.mockReturnValue('en');
    mockLoadTemplate.mockReturnValue('template');
    mockGetProvider.mockReturnValue({
      setup: vi.fn().mockReturnValue({
        call: vi.fn().mockRejectedValue(new Error('API error')),
      }),
    });

    // When / Then
    await expect(mergeChildBranch('/child', '/parent')).rejects.toThrow('merge conflict');
  });
});

describe('attemptAiConflictResolution', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockStreamDisplayConstructor.mockImplementation(() => ({
      createHandler: mockStreamDisplayCreateHandler,
    }));
    mockStreamDisplayCreateHandler.mockReturnValue(vi.fn());
  });

  it('should return true when AI agent resolves conflicts', async () => {
    // Given
    mockGetLanguage.mockReturnValue('en');
    mockLoadTemplate.mockReturnValue('system prompt');
    mockResolveConfigValues.mockReturnValue({ provider: 'claude', model: 'sonnet' });
    mockGetProvider.mockReturnValue({
      setup: vi.fn().mockReturnValue({ call: mockAgentCall }),
    });
    mockAgentCall.mockResolvedValue({ status: 'done' });

    // When
    const result = await attemptAiConflictResolution('/parent', 'fix the conflict');

    // Then
    expect(result).toBe(true);
    expect(mockAgentCall).toHaveBeenCalledWith(
      'system prompt',
      expect.objectContaining({
        cwd: '/parent',
        model: 'sonnet',
        permissionMode: 'edit',
        onPermissionRequest: expect.any(Function),
        onStream: expect.any(Function),
      }),
    );
  });

  it('should return false when AI agent fails to resolve', async () => {
    // Given
    mockGetLanguage.mockReturnValue('ja');
    mockLoadTemplate.mockReturnValue('prompt');
    mockResolveConfigValues.mockReturnValue({ provider: 'claude', model: 'opus' });
    mockGetProvider.mockReturnValue({
      setup: vi.fn().mockReturnValue({ call: mockAgentCall }),
    });
    mockAgentCall.mockResolvedValue({ status: 'blocked' });

    // When
    const result = await attemptAiConflictResolution('/parent');

    // Then
    expect(result).toBe(false);
  });

  it('should throw when no provider is configured', async () => {
    // Given
    mockGetLanguage.mockReturnValue('en');
    mockLoadTemplate.mockReturnValue('prompt');
    mockResolveConfigValues.mockReturnValue({ provider: undefined });

    // When / Then
    await expect(attemptAiConflictResolution('/parent')).rejects.toThrow(
      'No provider configured',
    );
  });

  it('should pass slot instruction to template loader', async () => {
    // Given
    const slotInstruction = 'Implement feature X';
    mockGetLanguage.mockReturnValue('en');
    mockLoadTemplate.mockReturnValue('template');
    mockResolveConfigValues.mockReturnValue({ provider: 'claude', model: 'sonnet' });
    mockGetProvider.mockReturnValue({
      setup: vi.fn().mockReturnValue({ call: mockAgentCall }),
    });
    mockAgentCall.mockResolvedValue({ status: 'done' });

    // When
    await attemptAiConflictResolution('/parent', slotInstruction);

    // Then
    expect(mockLoadTemplate).toHaveBeenCalledWith(
      'sync_conflict_resolver_message',
      'en',
      { originalInstruction: slotInstruction },
    );
  });

  it('should use fallback instruction when slotInstruction is undefined', async () => {
    // Given
    mockGetLanguage.mockReturnValue('en');
    mockLoadTemplate.mockReturnValue('template');
    mockResolveConfigValues.mockReturnValue({ provider: 'claude', model: 'sonnet' });
    mockGetProvider.mockReturnValue({
      setup: vi.fn().mockReturnValue({ call: mockAgentCall }),
    });
    mockAgentCall.mockResolvedValue({ status: 'done' });

    // When
    await attemptAiConflictResolution('/parent');

    // Then
    expect(mockLoadTemplate).toHaveBeenCalledWith(
      'sync_conflict_resolver_message',
      'en',
      { originalInstruction: '(no slot instruction available)' },
    );
  });
});

describe('abortMerge', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should execute git merge --abort', () => {
    // Given
    mockExecFileSync.mockReturnValue(undefined);

    // When
    abortMerge('/parent');

    // Then
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/parent', 'merge', '--abort'],
      { stdio: 'pipe' },
    );
  });

  it('should not throw when git merge --abort fails', () => {
    // Given
    mockExecFileSync.mockImplementation(() => {
      throw new Error('no merge in progress');
    });

    // When / Then: should not throw
    expect(() => abortMerge('/parent')).not.toThrow();
  });
});
