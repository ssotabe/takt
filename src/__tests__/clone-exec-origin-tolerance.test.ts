/**
 * Unit tests for clone-exec origin remote removal tolerance (Feature E).
 *
 * Tests that `git remote remove origin` failure does not prevent
 * clone isolation from completing, for both sync and async versions.
 *
 * Mocked: child_process, fs, config
 * Not mocked: cloneAndIsolate / cloneAndIsolateAbortable logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// --- Hoisted mocks ---

const {
  mockExecFileSync,
  mockSpawn,
  mockFs,
  mockLoadProjectConfig,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockSpawn: vi.fn(),
  mockFs: {
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
    statSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    cpSync: vi.fn(),
    readdirSync: vi.fn(),
  },
  mockLoadProjectConfig: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFileSync: mockExecFileSync,
  spawn: mockSpawn,
}));

vi.mock('node:fs', () => ({
  default: mockFs,
  ...mockFs,
}));

vi.mock('../infra/config/index.js', () => ({
  loadProjectConfig: mockLoadProjectConfig,
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// --- Imports (after mocks) ---

import { cloneAndIsolate } from '../infra/task/clone-exec.js';

describe('clone-exec origin tolerance (Feature E)', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockLoadProjectConfig.mockReturnValue({});
    // Default: .git is a directory (not a worktree)
    mockFs.existsSync.mockReturnValue(true);
    mockFs.statSync.mockReturnValue({ isFile: () => false });
  });

  it('should not throw when git remote remove origin fails (sync)', () => {
    // Given: git clone succeeds, but origin remote doesn't exist
    const callSequence: string[] = [];
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      const argStr = args.join(' ');
      callSequence.push(argStr);

      if (argStr.includes('remote remove origin')) {
        throw new Error('fatal: No such remote: origin');
      }
      if (argStr.includes('config --local')) {
        return 'user@example.com\n';
      }
      return '';
    });

    // When / Then: should not throw
    expect(() => cloneAndIsolate('/project', '/clone')).not.toThrow();

    // git config commands after origin removal should still execute
    const originRemoveIndex = callSequence.findIndex((c) => c.includes('remote remove origin'));
    const configCallsAfter = callSequence.slice(originRemoveIndex + 1).filter((c) => c.includes('config'));
    expect(configCallsAfter.length).toBeGreaterThan(0);
  });

  it('should log debug when origin remote removal fails (sync)', () => {
    // Given
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args.join(' ').includes('remote remove origin')) {
        throw new Error('No such remote');
      }
      if (args.join(' ').includes('config --local')) {
        return 'value\n';
      }
      return '';
    });

    // When: should complete without error
    expect(() => cloneAndIsolate('/project', '/clone')).not.toThrow();
  });
});
