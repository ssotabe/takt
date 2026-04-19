/**
 * Unit tests for commitBeforeMerge in worktree-sync (Feature D + H).
 *
 * Tests:
 * - buildCommitMessage with slotInstruction → first line, 72-char limit
 * - buildCommitMessage without slotInstruction → default message
 * - commitBeforeMerge calls stageAndCommit with correct options
 * - commitBeforeMerge swallows stageAndCommit errors (merge continues)
 * - mergeChildBranch calls commitBeforeMerge before fetch/merge
 *
 * Mocked: child_process, git (stageAndCommit), provider, config, template, StreamDisplay
 * Not mocked: worktree-sync commit logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Hoisted mocks ---

const {
  mockExecFileSync,
  mockStageAndCommit,
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
    mockStageAndCommit: vi.fn(),
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

vi.mock('../infra/task/git.js', () => ({
  stageAndCommit: mockStageAndCommit,
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

import { mergeChildBranch } from '../core/workflow/engine/worktree-sync.js';

function applySuccessfulMergeMocks(): void {
  mockExecFileSync
    .mockReturnValueOnce('abc123\n')        // rev-parse HEAD
    .mockReturnValueOnce('feature/slot\n')  // rev-parse --abbrev-ref HEAD
    .mockReturnValueOnce(undefined)         // fetch
    .mockReturnValueOnce(undefined);        // merge
}

describe('worktree-sync commitBeforeMerge (Feature D + H)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockStreamDisplayConstructor.mockImplementation(() => ({
      createHandler: mockStreamDisplayCreateHandler,
    }));
    mockStreamDisplayCreateHandler.mockReturnValue(vi.fn());
  });

  it('should call stageAndCommit before fetch/merge with slotInstruction as commit message', async () => {
    // Given
    const slotInstruction = 'Implement user authentication module';
    applySuccessfulMergeMocks();
    mockStageAndCommit.mockReturnValue('def456');

    // When
    await mergeChildBranch('/child/clone', '/parent', slotInstruction);

    // Then: stageAndCommit called with child clone path and message derived from slotInstruction
    expect(mockStageAndCommit).toHaveBeenCalledWith(
      '/child/clone',
      expect.stringContaining('Implement user authentication module'),
      expect.objectContaining({
        allowGitHooks: false,
        allowGitFilters: false,
      }),
    );
    // stageAndCommit must be called before git fetch
    const stageAndCommitCallOrder = mockStageAndCommit.mock.invocationCallOrder[0]!;
    const fetchCallOrder = mockExecFileSync.mock.invocationCallOrder[2]!; // 3rd call = fetch
    expect(stageAndCommitCallOrder).toBeLessThan(fetchCallOrder);
  });

  it('should truncate slotInstruction first line to 72 characters', async () => {
    // Given
    const longInstruction = 'A'.repeat(100) + '\nSecond line should be ignored';
    applySuccessfulMergeMocks();
    mockStageAndCommit.mockReturnValue('def456');

    // When
    await mergeChildBranch('/child', '/parent', longInstruction);

    // Then: commit message uses first line truncated to 72 chars
    const commitMessage = mockStageAndCommit.mock.calls[0]?.[1] as string;
    // The first line content should be at most 72 chars (excluding prefix)
    const contentPart = commitMessage.replace(/^takt:\s*/, '');
    expect(contentPart.length).toBeLessThanOrEqual(72);
  });

  it('should use only first line of multi-line slotInstruction', async () => {
    // Given
    const multiLineInstruction = 'First line of instruction\nSecond line\nThird line';
    applySuccessfulMergeMocks();
    mockStageAndCommit.mockReturnValue('def456');

    // When
    await mergeChildBranch('/child', '/parent', multiLineInstruction);

    // Then: only first line used
    const commitMessage = mockStageAndCommit.mock.calls[0]?.[1] as string;
    expect(commitMessage).toContain('First line of instruction');
    expect(commitMessage).not.toContain('Second line');
  });

  it('should use default commit message when slotInstruction is undefined', async () => {
    // Given
    applySuccessfulMergeMocks();
    mockStageAndCommit.mockReturnValue('def456');

    // When
    await mergeChildBranch('/child', '/parent');

    // Then: default message used
    const commitMessage = mockStageAndCommit.mock.calls[0]?.[1] as string;
    expect(commitMessage).toContain('auto-commit');
  });

  it('should use default commit message when slotInstruction is empty string', async () => {
    // Given
    applySuccessfulMergeMocks();
    mockStageAndCommit.mockReturnValue('def456');

    // When
    await mergeChildBranch('/child', '/parent', '');

    // Then: default message used
    const commitMessage = mockStageAndCommit.mock.calls[0]?.[1] as string;
    expect(commitMessage).toContain('auto-commit');
  });

  it('should continue merge when stageAndCommit fails', async () => {
    // Given
    mockStageAndCommit.mockImplementation(() => {
      throw new Error('nothing to commit');
    });
    applySuccessfulMergeMocks();

    // When
    await mergeChildBranch('/child', '/parent', 'some instruction');

    // Then: stageAndCommit was called (and threw), but merge still executed
    expect(mockStageAndCommit).toHaveBeenCalled();
    expect(mockExecFileSync).toHaveBeenCalledWith(
      'git',
      ['-C', '/parent', 'merge', '--no-edit', 'FETCH_HEAD'],
      expect.any(Object),
    );
  });

  it('should pass allowGitHooks: false and allowGitFilters: false to stageAndCommit', async () => {
    // Given
    applySuccessfulMergeMocks();
    mockStageAndCommit.mockReturnValue('abc');

    // When
    await mergeChildBranch('/child', '/parent', 'instruction');

    // Then
    expect(mockStageAndCommit).toHaveBeenCalledWith(
      '/child',
      expect.any(String),
      { allowGitHooks: false, allowGitFilters: false },
    );
  });
});
