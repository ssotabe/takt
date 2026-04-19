import type { ExecError } from './headless-spawn.js';

export const HEADLESS_MAX_RETRIES = 2;
export const HEADLESS_RETRY_BASE_DELAY_MS = 1000;

export function isRetryableError(error: ExecError, abortSignal?: AbortSignal): boolean {
  if (abortSignal?.aborted || error.name === 'AbortError') {
    return false;
  }
  if (error.code === 'ENOENT') {
    return false;
  }
  if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
    return false;
  }
  return true;
}

export async function waitForRetryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  const delayMs = HEADLESS_RETRY_BASE_DELAY_MS * (2 ** Math.max(0, attempt - 1));
  await new Promise<void>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      resolve();
    }, delayMs);

    const onAbort = (): void => {
      clearTimeout(timeoutId);
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
      reject(new Error('Retry delay aborted'));
    };

    if (signal) {
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}
