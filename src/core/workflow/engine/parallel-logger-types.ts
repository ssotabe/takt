/**
 * Type definitions and factory for ParallelLogger configuration.
 */

import type { StreamCallback, WorkflowEngineOptions } from '../types.js';

/** Progress information for parallel logger */
export interface ParallelProgressInfo {
  /** Current iteration (1-indexed) */
  iteration: number;
  /** Maximum steps allowed */
  maxSteps: number;
}

export interface ParallelLoggerOptions {
  /** Sub-step names (used to calculate prefix width) */
  subStepNames: string[];
  /** Parent onStream callback to delegate non-prefixed events */
  parentOnStream?: StreamCallback;
  /** Override process.stdout.write for testing */
  writeFn?: (text: string) => void;
  /** Progress information for display */
  progressInfo?: ParallelProgressInfo;
  /** Task label for rich parallel prefix display */
  taskLabel?: string;
  /** Task color index for rich parallel prefix display */
  taskColorIndex?: number;
  /** Parent step name for rich parallel prefix display */
  parentStepName?: string;
  /** Parent step iteration count for rich parallel prefix display */
  stepIteration?: number;
  /** Flush interval for partial text buffers in milliseconds */
  flushIntervalMs?: number;
  /** Minimum buffered chars before timed flush is allowed */
  minTimedFlushChars?: number;
  /** Maximum wait time for timed flush even without boundary */
  maxTimedBufferMs?: number;
}

export function buildParallelLoggerOptions(
  engineOptions: WorkflowEngineOptions,
  stepName: string,
  stepIteration: number,
  subStepNames: string[],
  iteration: number,
  maxSteps: number,
): ParallelLoggerOptions {
  const options: ParallelLoggerOptions = {
    subStepNames,
    parentOnStream: engineOptions.onStream,
    progressInfo: { iteration, maxSteps },
  };

  if (engineOptions.taskPrefix != null && engineOptions.taskColorIndex != null) {
    return {
      ...options,
      taskLabel: engineOptions.taskPrefix,
      taskColorIndex: engineOptions.taskColorIndex,
      parentStepName: stepName,
      stepIteration,
    };
  }

  return options;
}
