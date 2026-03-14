/**
 * Tests for engineSessionBridge module.
 *
 * Covers:
 * - connectEngineToSessionLogger: 5 event types forwarded to SessionLogger
 * - connectEngineToSessionLogger: currentIteration tracking across events
 * - createChildSessionLoggingSetup: SessionLogger creation and event wiring
 * - createChildSessionLoggingSetup: trace report on piece:complete
 * - createChildSessionLoggingSetup: trace report on piece:abort
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { PieceMovement, PieceState } from '../core/models/index.js';
import type { PhasePromptParts, JudgeStageEntry } from '../core/piece/types.js';

// ─── Mocks ───

const mockAppendNdjsonLine = vi.fn();
const mockInitNdjsonLog = vi.fn().mockReturnValue('/tmp/test-logs/session.jsonl');
const mockGenerateSessionId = vi.fn().mockReturnValue('test-session-id');

vi.mock('../infra/fs/index.js', () => ({
  appendNdjsonLine: (...args: unknown[]) => mockAppendNdjsonLine(...args),
  initNdjsonLog: (...args: unknown[]) => mockInitNdjsonLog(...args),
  generateSessionId: () => mockGenerateSessionId(),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  isDebugEnabled: vi.fn().mockReturnValue(false),
  writePromptLog: vi.fn(),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

vi.mock('../infra/config/index.js', () => ({
  writeFileAtomic: vi.fn(),
}));

vi.mock('../features/tasks/execute/traceReportRedaction.js', () => ({
  sanitizeTextForStorage: (text: string) => text,
}));

vi.mock('../features/tasks/execute/traceReport.js', () => ({
  assertTraceParams: vi.fn(),
  renderTraceReportFromLogs: vi.fn().mockReturnValue('# Trace Report'),
  renderTraceReportFromRecords: vi.fn().mockReturnValue('# Trace Report'),
}));

// Lazy import after mocks
const { connectEngineToSessionLogger, createChildSessionLoggingSetup } = await import(
  '../features/tasks/execute/engineSessionBridge.js'
);
const { SessionLogger } = await import('../features/tasks/execute/sessionLogger.js');

// ─── Helpers ───

function makeStep(name: string): PieceMovement {
  return {
    name,
    personaDisplayName: name,
    instruction: `Run ${name}`,
    passPreviousResponse: true,
  };
}

function makePromptParts(): PhasePromptParts {
  return {
    systemPrompt: 'system prompt',
    userInstruction: 'user instruction',
  };
}

function makePieceState(overrides: Partial<PieceState> = {}): PieceState {
  return {
    pieceName: 'test-piece',
    currentMovement: 'step1',
    iteration: 3,
    movementOutputs: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    movementIterations: new Map(),
    status: 'completed',
    ...overrides,
  };
}

// ─── connectEngineToSessionLogger ───

describe('connectEngineToSessionLogger', () => {
  let engine: EventEmitter;
  let sessionLogger: InstanceType<typeof SessionLogger>;

  beforeEach(() => {
    vi.clearAllMocks();
    engine = new EventEmitter();
    sessionLogger = new SessionLogger('/tmp/test.jsonl', false);
  });

  it('should forward phase:start events to sessionLogger.onPhaseStart', () => {
    // Given
    connectEngineToSessionLogger(engine, sessionLogger);
    const step = makeStep('plan');
    const promptParts = makePromptParts();
    const onPhaseStartSpy = vi.spyOn(sessionLogger, 'onPhaseStart');

    // When
    engine.emit('phase:start', step, 1, 'execute', 'instruction text', promptParts, 'exec-id-1', 1);

    // Then
    expect(onPhaseStartSpy).toHaveBeenCalledOnce();
    expect(onPhaseStartSpy).toHaveBeenCalledWith(step, 1, 'execute', 'instruction text', promptParts, 'exec-id-1', 1);
  });

  it('should forward phase:complete events to sessionLogger.onPhaseComplete', () => {
    // Given
    connectEngineToSessionLogger(engine, sessionLogger);
    const step = makeStep('implement');
    const onPhaseCompleteSpy = vi.spyOn(sessionLogger, 'onPhaseComplete');

    // Emit phase:start first so the execution ID is tracked
    engine.emit('phase:start', step, 1, 'execute', 'instruction', makePromptParts(), 'exec-id-1', 1);

    // When
    engine.emit('phase:complete', step, 1, 'execute', 'response content', 'done', undefined, 'exec-id-1', 1);

    // Then
    expect(onPhaseCompleteSpy).toHaveBeenCalledOnce();
    expect(onPhaseCompleteSpy).toHaveBeenCalledWith(step, 1, 'execute', 'response content', 'done', undefined, 'exec-id-1', 1);
  });

  it('should call setIteration on phase:complete with iteration from last movement:start', () => {
    // Given
    connectEngineToSessionLogger(engine, sessionLogger);
    const step = makeStep('implement');
    const setIterationSpy = vi.spyOn(sessionLogger, 'setIteration');

    // When — movement:start sets iteration to 5
    engine.emit('movement:start', step, 5, 'instruction', { provider: undefined, model: undefined });
    engine.emit('phase:start', step, 1, 'execute', 'instruction', makePromptParts(), 'exec-id-1', 5);
    engine.emit('phase:complete', step, 1, 'execute', 'content', 'done', undefined, 'exec-id-1', 5);

    // Then
    expect(setIterationSpy).toHaveBeenCalledWith(5);
  });

  it('should forward phase:judge_stage events to sessionLogger.onJudgeStage', () => {
    // Given
    connectEngineToSessionLogger(engine, sessionLogger);
    const step = makeStep('review');
    const onJudgeStageSpy = vi.spyOn(sessionLogger, 'onJudgeStage');
    const entry: JudgeStageEntry = {
      stage: 1,
      method: 'structured_output',
      status: 'done',
      instruction: 'judge instruction',
      response: 'judge response',
    };

    // When
    engine.emit('phase:judge_stage', step, 3, 'judge', entry, 'exec-id-1', 1);

    // Then
    expect(onJudgeStageSpy).toHaveBeenCalledOnce();
    expect(onJudgeStageSpy).toHaveBeenCalledWith(step, 3, 'judge', entry, 'exec-id-1', 1);
  });

  it('should forward movement:start events to sessionLogger.onMovementStart', () => {
    // Given
    connectEngineToSessionLogger(engine, sessionLogger);
    const step = makeStep('plan');
    const onMovementStartSpy = vi.spyOn(sessionLogger, 'onMovementStart');

    // When
    engine.emit('movement:start', step, 1, 'movement instruction', { provider: 'claude', model: 'sonnet' });

    // Then
    expect(onMovementStartSpy).toHaveBeenCalledOnce();
    expect(onMovementStartSpy).toHaveBeenCalledWith(step, 1, 'movement instruction');
  });

  it('should forward movement:complete events to sessionLogger.onMovementComplete', () => {
    // Given
    connectEngineToSessionLogger(engine, sessionLogger);
    const step = makeStep('implement');
    const onMovementCompleteSpy = vi.spyOn(sessionLogger, 'onMovementComplete');
    const response = {
      persona: 'coder',
      status: 'done' as const,
      content: 'implementation done',
      timestamp: new Date(),
    };

    // When
    engine.emit('movement:complete', step, response, 'instruction');

    // Then
    expect(onMovementCompleteSpy).toHaveBeenCalledOnce();
    expect(onMovementCompleteSpy).toHaveBeenCalledWith(step, response, 'instruction');
  });

  it('should track iteration across multiple movement:start events', () => {
    // Given
    connectEngineToSessionLogger(engine, sessionLogger);
    const step1 = makeStep('plan');
    const step2 = makeStep('implement');
    const setIterationSpy = vi.spyOn(sessionLogger, 'setIteration');

    // When — two movements with different iterations
    engine.emit('movement:start', step1, 1, 'inst1', { provider: undefined, model: undefined });
    engine.emit('phase:start', step1, 1, 'execute', 'inst', makePromptParts(), 'eid-1', 1);
    engine.emit('phase:complete', step1, 1, 'execute', 'r1', 'done', undefined, 'eid-1', 1);

    engine.emit('movement:start', step2, 2, 'inst2', { provider: undefined, model: undefined });
    engine.emit('phase:start', step2, 1, 'execute', 'inst', makePromptParts(), 'eid-2', 2);
    engine.emit('phase:complete', step2, 1, 'execute', 'r2', 'done', undefined, 'eid-2', 2);

    // Then — setIteration called with iteration from each movement:start
    expect(setIterationSpy).toHaveBeenCalledTimes(2);
    expect(setIterationSpy).toHaveBeenNthCalledWith(1, 1);
    expect(setIterationSpy).toHaveBeenNthCalledWith(2, 2);
  });

  it('should not register listeners for piece:complete or piece:abort', () => {
    // Given
    connectEngineToSessionLogger(engine, sessionLogger);

    // Then — these events are handled separately (by pieceExecution.ts or createChildSessionLoggingSetup)
    expect(engine.listenerCount('piece:complete')).toBe(0);
    expect(engine.listenerCount('piece:abort')).toBe(0);
  });

  it('should register exactly 5 event listeners', () => {
    // Given/When
    connectEngineToSessionLogger(engine, sessionLogger);

    // Then
    expect(engine.listenerCount('phase:start')).toBe(1);
    expect(engine.listenerCount('phase:complete')).toBe(1);
    expect(engine.listenerCount('phase:judge_stage')).toBe(1);
    expect(engine.listenerCount('movement:start')).toBe(1);
    expect(engine.listenerCount('movement:complete')).toBe(1);
  });
});

// ─── createChildSessionLoggingSetup ───

describe('createChildSessionLoggingSetup', () => {
  let childEngine: EventEmitter;

  beforeEach(() => {
    vi.clearAllMocks();
    childEngine = new EventEmitter();
  });

  it('should return a function', () => {
    // When
    const setup = createChildSessionLoggingSetup({ traceReportMode: 'redacted' });

    // Then
    expect(typeof setup).toBe('function');
  });

  it('should register 5 movement/phase listeners plus piece:complete and piece:abort on the child engine', () => {
    // Given
    const setup = createChildSessionLoggingSetup({ traceReportMode: 'redacted' });

    // When
    setup(childEngine, '/tmp/child-cwd', 'test task', 'child-report-dir', 'child-piece');

    // Then — 5 from connectEngineToSessionLogger + piece:complete + piece:abort
    expect(childEngine.listenerCount('phase:start')).toBe(1);
    expect(childEngine.listenerCount('phase:complete')).toBe(1);
    expect(childEngine.listenerCount('phase:judge_stage')).toBe(1);
    expect(childEngine.listenerCount('movement:start')).toBe(1);
    expect(childEngine.listenerCount('movement:complete')).toBe(1);
    expect(childEngine.listenerCount('piece:complete')).toBe(1);
    expect(childEngine.listenerCount('piece:abort')).toBe(1);
  });

  it('should initialize NDJSON log via initNdjsonLog', () => {
    // Given
    const setup = createChildSessionLoggingSetup({ traceReportMode: 'redacted' });

    // When
    setup(childEngine, '/tmp/child-cwd', 'test task', 'child-report-dir', 'child-piece');

    // Then
    expect(mockGenerateSessionId).toHaveBeenCalledOnce();
    expect(mockInitNdjsonLog).toHaveBeenCalledOnce();
    expect(mockInitNdjsonLog).toHaveBeenCalledWith(
      'test-session-id',
      'test task',
      'child-piece',
      expect.objectContaining({ logsDir: expect.stringContaining('logs') }),
    );
  });

  it('should call sessionLogger.onPieceComplete and write trace report on piece:complete', () => {
    // Given
    const setup = createChildSessionLoggingSetup({ traceReportMode: 'redacted' });
    setup(childEngine, '/tmp/child-cwd', 'test task', 'child-report-dir', 'child-piece');
    const state = makePieceState({ status: 'completed', iteration: 5 });

    // When
    childEngine.emit('piece:complete', state);

    // Then — NDJSON records should include a piece_complete record
    const pieceCompleteRecords = mockAppendNdjsonLine.mock.calls.filter(
      (call: [string, { type: string }]) => call[1].type === 'piece_complete',
    );
    expect(pieceCompleteRecords.length).toBe(1);
    expect(pieceCompleteRecords[0][1]).toMatchObject({
      type: 'piece_complete',
      iterations: 5,
    });
  });

  it('should call sessionLogger.onPieceAbort and write trace report on piece:abort', () => {
    // Given
    const setup = createChildSessionLoggingSetup({ traceReportMode: 'redacted' });
    setup(childEngine, '/tmp/child-cwd', 'test task', 'child-report-dir', 'child-piece');
    const state = makePieceState({ status: 'aborted', iteration: 3 });

    // When
    childEngine.emit('piece:abort', state, 'max_iterations_exceeded');

    // Then — NDJSON records should include a piece_abort record
    const pieceAbortRecords = mockAppendNdjsonLine.mock.calls.filter(
      (call: [string, { type: string }]) => call[1].type === 'piece_abort',
    );
    expect(pieceAbortRecords.length).toBe(1);
    expect(pieceAbortRecords[0][1]).toMatchObject({
      type: 'piece_abort',
      iterations: 3,
      reason: 'max_iterations_exceeded',
    });
  });

  it('should use child runPaths derived from childCwd and reportDirName', () => {
    // Given
    const setup = createChildSessionLoggingSetup({ traceReportMode: 'redacted' });

    // When
    setup(childEngine, '/workspace/child', 'task', 'child-run-slug', 'child-piece');

    // Then — initNdjsonLog should be called with logsDir under child's .takt/runs path
    expect(mockInitNdjsonLog).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String),
      { logsDir: expect.stringContaining('/workspace/child/.takt/runs/child-run-slug/logs') },
    );
  });

  it('should forward movement events to child SessionLogger during piece execution', () => {
    // Given
    const setup = createChildSessionLoggingSetup({ traceReportMode: 'redacted' });
    setup(childEngine, '/tmp/child-cwd', 'test task', 'child-report-dir', 'child-piece');
    const step = makeStep('child-step');

    // When — simulate a movement lifecycle
    childEngine.emit('movement:start', step, 1, 'child instruction', { provider: 'claude', model: 'sonnet' });
    childEngine.emit('phase:start', step, 1, 'execute', 'phase instruction', makePromptParts(), 'peid-1', 1);
    childEngine.emit('phase:complete', step, 1, 'execute', 'phase response', 'done', undefined, 'peid-1', 1);
    childEngine.emit('movement:complete', step, {
      persona: 'child-step',
      status: 'done',
      content: 'movement done',
      timestamp: new Date(),
    }, 'child instruction');

    // Then — NDJSON records should include step_start, phase_start, phase_complete, step_complete
    const recordTypes = mockAppendNdjsonLine.mock.calls.map(
      (call: [string, { type: string }]) => call[1].type,
    );
    expect(recordTypes).toContain('step_start');
    expect(recordTypes).toContain('phase_start');
    expect(recordTypes).toContain('phase_complete');
    expect(recordTypes).toContain('step_complete');
  });

  it('should use redacted mode when traceReportMode is redacted', () => {
    // Given
    const setup = createChildSessionLoggingSetup({ traceReportMode: 'redacted' });

    // When — the setup function creates a SessionLogger with allowSensitiveData=false
    setup(childEngine, '/tmp/child-cwd', 'test task', 'child-report-dir', 'child-piece');

    // Then — verify the SessionLogger was created (indirect verification via NDJSON init)
    expect(mockInitNdjsonLog).toHaveBeenCalledOnce();
  });

  it('should use full mode when traceReportMode is full', () => {
    // Given
    const setup = createChildSessionLoggingSetup({ traceReportMode: 'full' });

    // When
    setup(childEngine, '/tmp/child-cwd', 'test task', 'child-report-dir', 'child-piece');

    // Then — verify the SessionLogger was created
    expect(mockInitNdjsonLog).toHaveBeenCalledOnce();
  });
});
