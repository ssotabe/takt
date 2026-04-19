import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { StreamDisplay } from '../shared/ui/StreamDisplay.js';

describe('StreamDisplay', () => {
  let consoleSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('retry event', () => {
    it('calls reset to clear buffers and logs a retry message', () => {
      const display = new StreamDisplay('test-agent', false);
      const handler = display.createHandler();

      // Populate text buffer via text event
      handler({ type: 'text', data: { text: 'partial output' } });

      // Send retry event — should reset buffers
      handler({
        type: 'retry',
        data: { attempt: 1, maxRetries: 2, strategy: 'resume' },
      });

      // After reset, sending new text should re-print the agent header
      handler({ type: 'text', data: { text: 'new output' } });

      // Verify retry message was logged
      const retryLog = consoleSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('Retrying'),
      );
      expect(retryLog).toBeDefined();

      // Verify the agent header is printed again (isFirstText was reset to true)
      const headerCalls = consoleSpy.mock.calls.filter(
        (call) => typeof call[0] === 'string' && call[0].includes('[test-agent]'),
      );
      // Should have 2 header prints: one before 'partial output', one after reset before 'new output'
      expect(headerCalls.length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('api_retry event', () => {
    it('flushes pending output and logs an API rate limit retry message', () => {
      const display = new StreamDisplay('test-agent', false);
      const handler = display.createHandler();

      // Send api_retry event
      handler({
        type: 'api_retry',
        data: { retryDelayMs: 5000, errorStatus: 429, attempt: 1, maxRetries: 5 },
      });

      // Verify API retry message was logged
      const apiRetryLog = consoleSpy.mock.calls.find(
        (call) => typeof call[0] === 'string' && call[0].includes('API rate limit retry'),
      );
      expect(apiRetryLog).toBeDefined();
    });
  });
});
