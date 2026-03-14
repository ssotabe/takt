/**
 * Bridge between PieceEngine events and SessionLogger.
 *
 * Provides two functions:
 * - connectEngineToSessionLogger: wires 5 lifecycle events to SessionLogger methods
 * - createChildSessionLoggingSetup: factory for the setupChildSessionLogging callback
 */

import { join } from 'node:path';
import type { PieceMovement, AgentResponse, PieceState } from '../../../core/models/index.js';
import type { PhasePromptParts, JudgeStageEntry } from '../../../core/piece/types.js';
import { SessionLogger } from './sessionLogger.js';
import { createTraceReportWriter } from './traceReportWriter.js';
import { sanitizeTextForStorage } from './traceReportRedaction.js';
import { buildRunPaths } from '../../../core/piece/run/run-paths.js';
import { generateSessionId, initNdjsonLog } from '../../../infra/fs/index.js';
import { createLogger } from '../../../shared/utils/index.js';

/**
 * Register 5 event listeners that forward PieceEngine lifecycle events to SessionLogger.
 *
 * Tracks currentIteration internally so that phase:complete can call setIteration.
 * Does NOT register piece:complete or piece:abort — those are caller's responsibility.
 */
export function connectEngineToSessionLogger(
  engine: NodeJS.EventEmitter,
  sessionLogger: SessionLogger,
): void {
  let currentIteration = 0;

  engine.on('phase:start', (step: PieceMovement, phase: 1 | 2 | 3, phaseName: 'execute' | 'report' | 'judge', instruction: string, promptParts: PhasePromptParts, phaseExecutionId: string, iteration: number) => {
    sessionLogger.onPhaseStart(step, phase, phaseName, instruction, promptParts, phaseExecutionId, iteration);
  });

  engine.on('phase:complete', (step: PieceMovement, phase: 1 | 2 | 3, phaseName: 'execute' | 'report' | 'judge', content: string, phaseStatus: string, phaseError: string | undefined, phaseExecutionId: string, iteration: number) => {
    sessionLogger.setIteration(currentIteration);
    sessionLogger.onPhaseComplete(step, phase, phaseName, content, phaseStatus, phaseError, phaseExecutionId, iteration);
  });

  engine.on('phase:judge_stage', (step: PieceMovement, phase: 3, phaseName: 'judge', entry: JudgeStageEntry, phaseExecutionId: string, iteration: number) => {
    sessionLogger.onJudgeStage(step, phase, phaseName, entry, phaseExecutionId, iteration);
  });

  engine.on('movement:start', (step: PieceMovement, iteration: number, instruction: string) => {
    currentIteration = iteration;
    sessionLogger.onMovementStart(step, iteration, instruction);
  });

  engine.on('movement:complete', (step: PieceMovement, response: AgentResponse, instruction: string) => {
    sessionLogger.onMovementComplete(step, response, instruction);
  });
}

/**
 * Factory for the setupChildSessionLogging callback injected into PieceEngineOptions.
 *
 * The returned callback creates a SessionLogger for a child engine, wires up
 * all lifecycle events, and generates trace.md on piece:complete / piece:abort.
 */
export function createChildSessionLoggingSetup(
  options: { traceReportMode: 'full' | 'redacted' },
): (childEngine: NodeJS.EventEmitter, childCwd: string, task: string, reportDirName: string, pieceName: string) => void {
  const { traceReportMode } = options;
  const allowSensitiveData = traceReportMode === 'full';

  return (childEngine, childCwd, task, reportDirName, pieceName) => {
    const runPaths = buildRunPaths(childCwd, reportDirName);
    const sessionId = generateSessionId();
    const ndjsonLogPath = initNdjsonLog(
      sessionId,
      sanitizeTextForStorage(task, allowSensitiveData),
      pieceName,
      { logsDir: runPaths.logsAbs },
    );
    const sessionLogger = new SessionLogger(ndjsonLogPath, allowSensitiveData);

    connectEngineToSessionLogger(childEngine, sessionLogger);

    const log = createLogger('child-session');
    const writeTraceReportOnce = createTraceReportWriter({
      sessionLogger,
      ndjsonLogPath,
      tracePath: join(runPaths.runRootAbs, 'trace.md'),
      pieceName,
      task,
      runSlug: reportDirName,
      promptLogPath: undefined,
      mode: traceReportMode,
      logger: log,
    });

    childEngine.on('piece:complete', (state: PieceState) => {
      sessionLogger.onPieceComplete(state);
      writeTraceReportOnce({
        status: 'completed',
        iterations: state.iteration,
        endTime: new Date().toISOString(),
      });
    });

    childEngine.on('piece:abort', (state: PieceState, reason: string) => {
      sessionLogger.onPieceAbort(state, reason);
      writeTraceReportOnce({
        status: 'aborted',
        iterations: state.iteration,
        reason,
        endTime: new Date().toISOString(),
      });
    });
  };
}
