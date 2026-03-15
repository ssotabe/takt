/**
 * Tests for decomposeTask() and requestMoreParts() error detail improvement.
 *
 * Requirement 3: Error messages should include status, error, and content fields
 * instead of falling back to just the status string literal "error".
 */

import { describe, it, expect, vi } from 'vitest';
import { decomposeTask, requestMoreParts } from '../agents/decompose-task-usecase.js';

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../infra/resources/schema-loader.js', () => ({
  loadDecompositionSchema: vi.fn().mockReturnValue({}),
  loadMorePartsSchema: vi.fn().mockReturnValue({}),
}));

import { runAgent } from '../agents/runner.js';

describe('decomposeTask error detail', () => {
  it('response.errorがある場合、エラーメッセージにerror=を含む', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'team-leader',
      status: 'error',
      content: '',
      timestamp: new Date(),
      error: 'Rate limit exceeded',
    });

    await expect(
      decomposeTask('test instruction', 3, { cwd: '/tmp' }),
    ).rejects.toThrow(/status=error.*error=Rate limit exceeded/);
  });

  it('response.errorがなくcontentが空の場合、status=errorを含む詳細メッセージを出力する', async () => {
    // This is the key case: error=undefined, content='', status='error'
    // Previously this would produce "Team leader failed: error" (just the status string)
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'team-leader',
      status: 'error',
      content: '',
      timestamp: new Date(),
    });

    await expect(
      decomposeTask('test instruction', 3, { cwd: '/tmp' }),
    ).rejects.toThrow(/status=error/);
  });

  it('response.contentがある場合、エラーメッセージにcontent=を含む', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'team-leader',
      status: 'error',
      content: 'Detailed error explanation',
      timestamp: new Date(),
    });

    await expect(
      decomposeTask('test instruction', 3, { cwd: '/tmp' }),
    ).rejects.toThrow(/content=Detailed error explanation/);
  });

  it('response.errorとcontentの両方がある場合、両方を含むメッセージを出力する', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'team-leader',
      status: 'error',
      content: 'Some partial output',
      timestamp: new Date(),
      error: 'SDK crashed',
    });

    const promise = decomposeTask('test instruction', 3, { cwd: '/tmp' });

    await expect(promise).rejects.toThrow(/status=error/);
    await expect(
      decomposeTask('test instruction', 3, { cwd: '/tmp' }),
    ).rejects.toThrow(/error=SDK crashed/);
  });

  it('statusがdoneの場合はエラーをスローしない', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'team-leader',
      status: 'done',
      content: '```json\n[{"id":"p1","title":"T","instruction":"Do"}]\n```',
      timestamp: new Date(),
    });

    const result = await decomposeTask('test instruction', 3, { cwd: '/tmp' });
    expect(result).toHaveLength(1);
  });
});

describe('requestMoreParts error detail', () => {
  it('response.errorがなくcontentが空の場合、status=を含む詳細メッセージを出力する', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'team-leader',
      status: 'error',
      content: '',
      timestamp: new Date(),
    });

    await expect(
      requestMoreParts('instruction', [], [], 3, { cwd: '/tmp' }),
    ).rejects.toThrow(/status=error/);
  });

  it('response.errorがある場合、エラーメッセージにerror=を含む', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'team-leader',
      status: 'error',
      content: '',
      timestamp: new Date(),
      error: 'Timeout',
    });

    await expect(
      requestMoreParts('instruction', [], [], 3, { cwd: '/tmp' }),
    ).rejects.toThrow(/error=Timeout/);
  });

  it('エラーメッセージのプレフィックスが "Team leader feedback failed:" である', async () => {
    vi.mocked(runAgent).mockResolvedValue({
      persona: 'team-leader',
      status: 'error',
      content: '',
      timestamp: new Date(),
    });

    await expect(
      requestMoreParts('instruction', [], [], 3, { cwd: '/tmp' }),
    ).rejects.toThrow(/^Team leader feedback failed:/);
  });
});
