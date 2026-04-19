import { describe, it, expect } from 'vitest';
import { tryExtractApiRetryFromStreamJsonLine } from '../infra/claude-headless/stream-json-lines.js';

describe('tryExtractApiRetryFromStreamJsonLine', () => {
  it('extracts api_retry data from a valid system api_retry event', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      data: {
        retryDelayMs: 5000,
        errorStatus: 429,
        attempt: 1,
        maxRetries: 5,
      },
    });

    const result = tryExtractApiRetryFromStreamJsonLine(line);

    expect(result).toEqual({
      retryDelayMs: 5000,
      errorStatus: 429,
      attempt: 1,
      maxRetries: 5,
    });
  });

  it('returns undefined for a system event with a different subtype', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'other',
    });

    expect(tryExtractApiRetryFromStreamJsonLine(line)).toBeUndefined();
  });

  it('returns undefined for a non-system event type', () => {
    const line = JSON.stringify({
      type: 'text',
      text: 'hello',
    });

    expect(tryExtractApiRetryFromStreamJsonLine(line)).toBeUndefined();
  });

  it('returns undefined for an empty string', () => {
    expect(tryExtractApiRetryFromStreamJsonLine('')).toBeUndefined();
  });

  it('returns undefined for invalid JSON', () => {
    expect(tryExtractApiRetryFromStreamJsonLine('not json {')).toBeUndefined();
  });

  it('returns undefined when data field is missing', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
    });

    expect(tryExtractApiRetryFromStreamJsonLine(line)).toBeUndefined();
  });

  it('returns undefined when data is not an object', () => {
    const line = JSON.stringify({
      type: 'system',
      subtype: 'api_retry',
      data: 'not-an-object',
    });

    expect(tryExtractApiRetryFromStreamJsonLine(line)).toBeUndefined();
  });

  it('returns undefined for a system event without subtype', () => {
    const line = JSON.stringify({
      type: 'system',
      session_id: 'abc-123',
    });

    expect(tryExtractApiRetryFromStreamJsonLine(line)).toBeUndefined();
  });
});
