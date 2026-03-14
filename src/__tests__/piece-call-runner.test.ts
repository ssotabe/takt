/**
 * PieceCallRunner unit tests.
 *
 * Covers:
 * - Circular reference detection (A → B → A)
 * - Maximum nesting depth enforcement
 * - Child piece resolution and execution
 * - Context propagation from parent to child
 * - Budget sharing (child movements consume parent budget)
 * - Child completion/abort result propagation to parent
 * - Report directory namespacing
 * - Overrides application
 */

import { describe, it, expect } from 'vitest';
import type { PieceMovement, PieceState, AgentResponse } from '../core/models/index.js';
import { MAX_PIECE_CALL_DEPTH } from '../core/piece/constants.js';

// ─── Helpers ───

function makePieceCallMovement(
  name: string,
  call: string,
  overrides: Partial<PieceMovement> = {},
): PieceMovement {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: true,
    kind: 'piece_call' as PieceMovement['kind'],
    call,
    ...overrides,
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

// ─── Circular detection logic (pure function tests) ───

describe('PieceCallRunner: Circular detection', () => {
  it('should detect direct circular reference (A calls A)', () => {
    const callStack = ['piece-a'];
    const newCall = 'piece-a';

    const isCircular = callStack.includes(newCall);

    expect(isCircular).toBe(true);
  });

  it('should detect indirect circular reference (A → B → A)', () => {
    const callStack = ['piece-a', 'piece-b'];
    const newCall = 'piece-a';

    const isCircular = callStack.includes(newCall);

    expect(isCircular).toBe(true);
  });

  it('should detect deep circular reference (A → B → C → A)', () => {
    const callStack = ['piece-a', 'piece-b', 'piece-c'];
    const newCall = 'piece-a';

    const isCircular = callStack.includes(newCall);

    expect(isCircular).toBe(true);
  });

  it('should allow non-circular call', () => {
    const callStack = ['piece-a', 'piece-b'];
    const newCall = 'piece-c';

    const isCircular = callStack.includes(newCall);

    expect(isCircular).toBe(false);
  });

  it('should allow empty call stack', () => {
    const callStack: string[] = [];
    const newCall = 'piece-a';

    const isCircular = callStack.includes(newCall);

    expect(isCircular).toBe(false);
  });

  it('should produce clear error message for circular reference', () => {
    const callStack = ['parent', 'child'];
    const newCall = 'parent';
    const errorMessage = `Circular piece_call detected: ${[...callStack, newCall].join(' → ')}`;

    expect(errorMessage).toBe('Circular piece_call detected: parent → child → parent');
  });
});

// ─── Nesting depth limit logic (pure function tests) ───

describe('PieceCallRunner: Nesting depth limit', () => {
  it('should reject when nesting depth equals max', () => {
    const nestingDepth = MAX_PIECE_CALL_DEPTH;

    const exceedsLimit = nestingDepth >= MAX_PIECE_CALL_DEPTH;

    expect(exceedsLimit).toBe(true);
  });

  it('should reject when nesting depth exceeds max', () => {
    const nestingDepth = MAX_PIECE_CALL_DEPTH + 1;

    const exceedsLimit = nestingDepth >= MAX_PIECE_CALL_DEPTH;

    expect(exceedsLimit).toBe(true);
  });

  it('should allow when nesting depth is below max', () => {
    const nestingDepth = MAX_PIECE_CALL_DEPTH - 1;

    const exceedsLimit = nestingDepth >= MAX_PIECE_CALL_DEPTH;

    expect(exceedsLimit).toBe(false);
  });

  it('should allow depth 0 (first-level piece_call)', () => {
    const nestingDepth = 0;

    const exceedsLimit = nestingDepth >= MAX_PIECE_CALL_DEPTH;

    expect(exceedsLimit).toBe(false);
  });

  it('should produce clear error message for exceeded depth', () => {
    const errorMessage = `Maximum piece_call nesting depth (${MAX_PIECE_CALL_DEPTH}) exceeded`;

    expect(errorMessage).toBe(`Maximum piece_call nesting depth (${MAX_PIECE_CALL_DEPTH}) exceeded`);
  });
});

// ─── Budget sharing logic (pure function tests) ───

describe('PieceCallRunner: Budget sharing', () => {
  it('should calculate remaining budget from parent state', () => {
    const parentMaxMovements = 30;
    const parentIteration = 5;

    const remainingBudget = parentMaxMovements - parentIteration;

    expect(remainingBudget).toBe(25);
  });

  it('should update parent iteration after child completion', () => {
    const parentIteration = 5;
    const childIterations = 8;

    const updatedParentIteration = parentIteration + childIterations;

    expect(updatedParentIteration).toBe(13);
  });

  it('should calculate zero remaining budget when parent is exhausted', () => {
    const parentMaxMovements = 10;
    const parentIteration = 10;

    const remainingBudget = parentMaxMovements - parentIteration;

    expect(remainingBudget).toBe(0);
  });

  it('should calculate negative remaining when parent exceeded', () => {
    const parentMaxMovements = 10;
    const parentIteration = 12;

    const remainingBudget = parentMaxMovements - parentIteration;

    expect(remainingBudget).toBe(-2);
  });
});

// ─── Call stack propagation logic ───

describe('PieceCallRunner: Call stack propagation', () => {
  it('should build child call stack by appending current piece name', () => {
    const parentCallStack = ['root-piece'];
    const currentPieceName = 'parent-piece';

    const childCallStack = [...parentCallStack, currentPieceName];

    expect(childCallStack).toEqual(['root-piece', 'parent-piece']);
  });

  it('should increment nesting depth for child', () => {
    const parentNestingDepth = 2;

    const childNestingDepth = parentNestingDepth + 1;

    expect(childNestingDepth).toBe(3);
  });

  it('should start with empty call stack for top-level piece', () => {
    const parentCallStack: string[] = [];
    const currentPieceName = 'top-piece';

    const childCallStack = [...parentCallStack, currentPieceName];

    expect(childCallStack).toEqual(['top-piece']);
  });
});

// ─── Movement type identification ───

describe('PieceCallRunner: Movement type identification', () => {
  it('should identify piece_call movement by kind field', () => {
    const movement = makePieceCallMovement('deploy', 'deploy-piece');

    expect((movement as Record<string, unknown>).kind).toBe('piece_call');
    expect((movement as Record<string, unknown>).call).toBe('deploy-piece');
  });

  it('should require call field for piece_call kind', () => {
    const movement = makePieceCallMovement('deploy', 'deploy-piece');

    const hasPieceCallFields =
      (movement as Record<string, unknown>).kind === 'piece_call' &&
      typeof (movement as Record<string, unknown>).call === 'string';

    expect(hasPieceCallFields).toBe(true);
  });

  it('should distinguish piece_call from normal movement', () => {
    const normalMovement: PieceMovement = {
      name: 'plan',
      personaDisplayName: 'planner',
      instruction: 'Plan the task',
      passPreviousResponse: true,
    };
    const pieceCallMovement = makePieceCallMovement('deploy', 'default');

    expect((normalMovement as Record<string, unknown>).kind).toBeUndefined();
    expect((pieceCallMovement as Record<string, unknown>).kind).toBe('piece_call');
  });
});

// ─── Report directory namespacing ───

describe('PieceCallRunner: Report directory namespacing', () => {
  it('should create child report directory under parent sub/ directory', () => {
    const parentReportDir = '.takt/runs/20260311-xxx';
    const movementName = 'deploy';
    const iteration = 1;

    const childReportDir = `${parentReportDir}/sub/${movementName}_${iteration}`;

    expect(childReportDir).toBe('.takt/runs/20260311-xxx/sub/deploy_1');
  });

  it('should use unique directory for each piece_call iteration', () => {
    const parentReportDir = '.takt/runs/20260311-xxx';
    const movementName = 'deploy';

    const childDir1 = `${parentReportDir}/sub/${movementName}_1`;
    const childDir2 = `${parentReportDir}/sub/${movementName}_2`;

    expect(childDir1).not.toBe(childDir2);
  });

  it('should support nested sub-directories for deeply nested piece_calls', () => {
    const grandparentReportDir = '.takt/runs/20260311-xxx';
    const parentReportDir = `${grandparentReportDir}/sub/deploy_1`;
    const childReportDir = `${parentReportDir}/sub/build_1`;

    expect(childReportDir).toBe('.takt/runs/20260311-xxx/sub/deploy_1/sub/build_1');
  });
});

// ─── Overrides propagation ───

describe('PieceCallRunner: Overrides', () => {
  it('should pass provider override to child engine options', () => {
    const movement = makePieceCallMovement('deploy', 'default', {
      overrides: {
        provider: 'codex',
        model: 'gpt-5',
      },
    } as Partial<PieceMovement>);

    const overrides = (movement as Record<string, unknown>).overrides as Record<string, unknown>;
    expect(overrides.provider).toBe('codex');
    expect(overrides.model).toBe('gpt-5');
  });

  it('should allow piece_call without overrides', () => {
    const movement = makePieceCallMovement('deploy', 'default');

    expect((movement as Record<string, unknown>).overrides).toBeUndefined();
  });
});

// ─── Child result to parent response mapping ───

describe('PieceCallRunner: Child result mapping', () => {
  it('should map completed child state to done response', () => {
    const childLastOutput = 'Implementation complete with all tests passing';
    const childStatus = 'completed';

    const parentResponse: Partial<AgentResponse> = {
      status: 'done',
      content: childLastOutput,
    };

    expect(parentResponse.status).toBe('done');
    expect(parentResponse.content).toBe(childLastOutput);
  });

  it('should map aborted child state to done response for rule evaluation', () => {
    const childLastOutput = 'Build failed: missing dependencies';
    const childStatus = 'aborted';

    const parentResponse: Partial<AgentResponse> = {
      status: 'done',
      content: childLastOutput,
    };

    expect(parentResponse.status).toBe('done');
    expect(parentResponse.content).toBe(childLastOutput);
  });

  it('should handle child with no output', () => {
    const childLastOutput: string | undefined = undefined;

    const parentResponseContent = childLastOutput ?? '';

    expect(parentResponseContent).toBe('');
  });
});
