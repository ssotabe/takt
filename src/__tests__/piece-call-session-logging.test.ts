/**
 * Integration tests for child piece session logging via PieceCallRunner.
 *
 * Verifies that the setupChildSessionLogging callback is:
 * - Called by PieceCallRunner when creating a child PieceEngine
 * - Passed the correct arguments (childEngine, childCwd, task, reportDirName, pieceName)
 * - Propagated to nested piece_calls via options spread
 * - Not called when the callback is not provided (optional)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EventEmitter } from 'node:events';
import type { PieceMovement, PieceState, PieceConfig } from '../core/models/index.js';
import type { PieceEngineOptions } from '../core/piece/types.js';
import type { PieceCallRunnerDeps, PieceCallSlotOverrides } from '../core/piece/engine/PieceCallRunner.js';

// ─── Mock PieceEngine ───

const mockRun = vi.fn();

class MockPieceEngine extends EventEmitter {
  constructor(
    public readonly config: PieceConfig,
    public readonly cwd: string,
    public readonly task: string,
    public readonly options: PieceEngineOptions,
  ) {
    super();
  }

  async run(): Promise<PieceState> {
    return mockRun(this);
  }
}

vi.mock('../core/piece/engine/PieceEngine.js', () => ({
  PieceEngine: MockPieceEngine,
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    warn: vi.fn(),
  }),
  generateReportDir: vi.fn().mockReturnValue('generated-report-dir'),
}));

import { PieceCallRunner } from '../core/piece/engine/PieceCallRunner.js';
import { generateReportDir } from '../shared/utils/index.js';

// ─── Helpers ───

function makeChildPieceConfig(): PieceConfig {
  return {
    name: 'child-piece',
    description: 'A child piece',
    maxMovements: 10,
    initialMovement: 'step1',
    movements: [
      {
        name: 'step1',
        personaDisplayName: 'step1',
        instruction: 'do step 1',
        passPreviousResponse: true,
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
  };
}

function makePieceCallMovement(name: string, call: string): PieceMovement {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: true,
    kind: 'piece_call' as PieceMovement['kind'],
    call,
  } as PieceMovement & { kind: string; call: string };
}

function makeState(overrides: Partial<PieceState> = {}): PieceState {
  return {
    pieceName: 'parent-piece',
    currentMovement: 'call-child',
    iteration: 0,
    movementOutputs: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    movementIterations: new Map(),
    status: 'running',
    ...overrides,
  };
}

function makeDeps(overrides: Partial<PieceCallRunnerDeps> = {}): PieceCallRunnerDeps {
  return {
    engineOptions: {
      projectCwd: '/workspace',
      loadPieceByIdentifier: vi.fn().mockReturnValue(makeChildPieceConfig()),
      ...overrides.engineOptions,
    } as PieceEngineOptions,
    getCwd: () => '/workspace',
    getProjectCwd: () => '/workspace',
    ...overrides,
  };
}

// ─── Tests ───

describe('PieceCallRunner: setupChildSessionLogging callback invocation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({
      pieceName: 'child-piece',
      currentMovement: 'step1',
      iteration: 2,
      movementOutputs: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      movementIterations: new Map(),
      status: 'completed',
      lastOutput: { persona: 'step1', status: 'done', content: 'child done', timestamp: new Date() },
    } satisfies PieceState);
  });

  it('should call setupChildSessionLogging with the child engine instance', async () => {
    // Given
    const setupChildSessionLogging = vi.fn();
    const deps = makeDeps({
      engineOptions: {
        projectCwd: '/workspace',
        loadPieceByIdentifier: vi.fn().mockReturnValue(makeChildPieceConfig()),
        setupChildSessionLogging,
      } as unknown as PieceEngineOptions,
    });
    const runner = new PieceCallRunner(deps);
    const step = makePieceCallMovement('deploy', 'child-piece');
    const state = makeState();

    // When
    await runner.runPieceCallMovement(step, state, 'deploy the app', 30);

    // Then
    expect(setupChildSessionLogging).toHaveBeenCalledOnce();
    const [childEngine] = setupChildSessionLogging.mock.calls[0];
    expect(childEngine).toBeInstanceOf(MockPieceEngine);
  });

  it('should pass childCwd from deps.getCwd when no slot overrides', async () => {
    // Given
    const setupChildSessionLogging = vi.fn();
    const deps = makeDeps({
      engineOptions: {
        projectCwd: '/workspace',
        loadPieceByIdentifier: vi.fn().mockReturnValue(makeChildPieceConfig()),
        setupChildSessionLogging,
      } as unknown as PieceEngineOptions,
      getCwd: () => '/workspace/main',
    });
    const runner = new PieceCallRunner(deps);
    const step = makePieceCallMovement('deploy', 'child-piece');
    const state = makeState();

    // When
    await runner.runPieceCallMovement(step, state, 'deploy the app', 30);

    // Then
    const [, childCwd] = setupChildSessionLogging.mock.calls[0];
    expect(childCwd).toBe('/workspace/main');
  });

  it('should pass childCwd from slotOverrides.cwd when provided', async () => {
    // Given
    const setupChildSessionLogging = vi.fn();
    const deps = makeDeps({
      engineOptions: {
        projectCwd: '/workspace',
        loadPieceByIdentifier: vi.fn().mockReturnValue(makeChildPieceConfig()),
        setupChildSessionLogging,
      } as unknown as PieceEngineOptions,
      getCwd: () => '/workspace/main',
    });
    const runner = new PieceCallRunner(deps);
    const step = makePieceCallMovement('deploy', 'child-piece');
    const state = makeState();
    const slotOverrides: PieceCallSlotOverrides = { cwd: '/workspace/worktree' };

    // When
    await runner.runPieceCallMovement(step, state, 'deploy the app', 30, slotOverrides);

    // Then
    const [, childCwd] = setupChildSessionLogging.mock.calls[0];
    expect(childCwd).toBe('/workspace/worktree');
  });

  it('should pass task, reportDirName, and pieceName to the callback', async () => {
    // Given
    const setupChildSessionLogging = vi.fn();
    const deps = makeDeps({
      engineOptions: {
        projectCwd: '/workspace',
        loadPieceByIdentifier: vi.fn().mockReturnValue(makeChildPieceConfig()),
        setupChildSessionLogging,
      } as unknown as PieceEngineOptions,
    });
    const runner = new PieceCallRunner(deps);
    const step = makePieceCallMovement('deploy', 'child-piece');
    const state = makeState();

    // When
    await runner.runPieceCallMovement(step, state, 'deploy the app', 30);

    // Then
    const [, , task, reportDirName, pieceName] = setupChildSessionLogging.mock.calls[0];
    expect(task).toBe('deploy the app');
    expect(typeof reportDirName).toBe('string');
    expect(pieceName).toBe('child-piece');
  });

  it('should use slotOverrides.reportDirName when provided', async () => {
    // Given
    const setupChildSessionLogging = vi.fn();
    const deps = makeDeps({
      engineOptions: {
        projectCwd: '/workspace',
        loadPieceByIdentifier: vi.fn().mockReturnValue(makeChildPieceConfig()),
        setupChildSessionLogging,
      } as unknown as PieceEngineOptions,
    });
    const runner = new PieceCallRunner(deps);
    const step = makePieceCallMovement('deploy', 'child-piece');
    const state = makeState();
    const slotOverrides: PieceCallSlotOverrides = { reportDirName: 'custom-report-dir' };

    // When
    await runner.runPieceCallMovement(step, state, 'deploy the app', 30, slotOverrides);

    // Then
    const [, , , reportDirName] = setupChildSessionLogging.mock.calls[0];
    expect(reportDirName).toBe('custom-report-dir');
  });

  it('should generate reportDirName when slotOverrides.reportDirName is not provided', async () => {
    // Given
    const setupChildSessionLogging = vi.fn();
    vi.mocked(generateReportDir).mockReturnValue('auto-generated-dir');
    const deps = makeDeps({
      engineOptions: {
        projectCwd: '/workspace',
        loadPieceByIdentifier: vi.fn().mockReturnValue(makeChildPieceConfig()),
        setupChildSessionLogging,
      } as unknown as PieceEngineOptions,
    });
    const runner = new PieceCallRunner(deps);
    const step = makePieceCallMovement('deploy', 'child-piece');
    const state = makeState();

    // When
    await runner.runPieceCallMovement(step, state, 'deploy the app', 30);

    // Then
    const [, , , reportDirName] = setupChildSessionLogging.mock.calls[0];
    expect(reportDirName).toBe('auto-generated-dir');
  });

  it('should not throw when setupChildSessionLogging is not provided', async () => {
    // Given — no setupChildSessionLogging in engineOptions
    const deps = makeDeps();
    const runner = new PieceCallRunner(deps);
    const step = makePieceCallMovement('deploy', 'child-piece');
    const state = makeState();

    // When/Then — should complete without error
    await expect(
      runner.runPieceCallMovement(step, state, 'deploy the app', 30),
    ).resolves.toBeDefined();
  });

  it('should call setupChildSessionLogging before the child engine runs', async () => {
    // Given
    const callOrder: string[] = [];
    const setupChildSessionLogging = vi.fn().mockImplementation(() => {
      callOrder.push('setup');
    });
    mockRun.mockImplementation(async () => {
      callOrder.push('run');
      return {
        pieceName: 'child-piece',
        currentMovement: 'step1',
        iteration: 1,
        movementOutputs: new Map(),
        userInputs: [],
        personaSessions: new Map(),
        movementIterations: new Map(),
        status: 'completed',
        lastOutput: { persona: 'step1', status: 'done', content: 'done', timestamp: new Date() },
      };
    });
    const deps = makeDeps({
      engineOptions: {
        projectCwd: '/workspace',
        loadPieceByIdentifier: vi.fn().mockReturnValue(makeChildPieceConfig()),
        setupChildSessionLogging,
      } as unknown as PieceEngineOptions,
    });
    const runner = new PieceCallRunner(deps);
    const step = makePieceCallMovement('deploy', 'child-piece');
    const state = makeState();

    // When
    await runner.runPieceCallMovement(step, state, 'deploy the app', 30);

    // Then
    expect(callOrder).toEqual(['setup', 'run']);
  });
});

describe('PieceCallRunner: setupChildSessionLogging propagation to nested piece_calls', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockRun.mockResolvedValue({
      pieceName: 'child-piece',
      currentMovement: 'step1',
      iteration: 1,
      movementOutputs: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      movementIterations: new Map(),
      status: 'completed',
      lastOutput: { persona: 'step1', status: 'done', content: 'done', timestamp: new Date() },
    } satisfies PieceState);
  });

  it('should propagate setupChildSessionLogging to child engine options via spread', async () => {
    // Given
    const setupChildSessionLogging = vi.fn();
    const deps = makeDeps({
      engineOptions: {
        projectCwd: '/workspace',
        loadPieceByIdentifier: vi.fn().mockReturnValue(makeChildPieceConfig()),
        setupChildSessionLogging,
      } as unknown as PieceEngineOptions,
    });
    const runner = new PieceCallRunner(deps);
    const step = makePieceCallMovement('deploy', 'child-piece');
    const state = makeState();

    // When
    await runner.runPieceCallMovement(step, state, 'deploy the app', 30);

    // Then — the child PieceEngine should have received the callback in its options
    const childEngine = setupChildSessionLogging.mock.calls[0][0] as MockPieceEngine;
    expect(childEngine.options.setupChildSessionLogging).toBe(setupChildSessionLogging);
  });
});
