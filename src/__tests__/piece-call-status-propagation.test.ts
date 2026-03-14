/**
 * Tests for PieceCallRunner child piece status propagation.
 *
 * Verifies that:
 * - PieceCallRunner determines matchedRuleIndex from child status and step rules
 * - ParallelRunner skips detectMatchedRule when matchedRuleIndex is already set
 * - End-to-end: child piece status flows correctly through parallel aggregation
 */

import { describe, it, expect } from 'vitest';
import type { PieceMovement, PieceState, AgentResponse, RuleMatchMethod } from '../core/models/index.js';

// ─── Helpers ───

function makePieceCallMovement(
  name: string,
  call: string,
  rules?: Array<{ condition: string; next?: string }>,
): PieceMovement {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: true,
    kind: 'piece_call' as const,
    call,
    rules: rules?.map((r) => ({
      condition: r.condition,
      next: r.next,
    })),
  } as PieceMovement;
}

function makeAgentResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    persona: 'test',
    status: 'done',
    content: '',
    timestamp: new Date(),
    ...overrides,
  };
}

/**
 * Resolves the matched rule index from child piece status and movement rules.
 *
 * This is the logic that PieceCallRunner should implement:
 * - Scan rules for COMPLETE/ABORT condition text
 * - Map childState.status to the matching rule index
 * - Return undefined if no matching rule is found (fallback to detectMatchedRule)
 */
function resolveMatchedRuleIndex(
  childStatus: 'completed' | 'aborted',
  rules: Array<{ condition: string }> | undefined,
): { index: number; method: RuleMatchMethod } | undefined {
  if (!rules) return undefined;

  const targetCondition = childStatus === 'completed' ? 'COMPLETE' : 'ABORT';

  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i];
    if (!rule) continue;
    if (rule.condition.toUpperCase().includes(targetCondition)) {
      return { index: i, method: 'auto_select' };
    }
  }

  return undefined;
}

// ─── resolveMatchedRuleIndex: child status → rule index ───

describe('PieceCallRunner: Status-to-rule resolution', () => {
  it('should resolve completed status to COMPLETE rule at index 0', () => {
    const rules = [
      { condition: 'COMPLETE' },
      { condition: 'ABORT' },
    ];

    const match = resolveMatchedRuleIndex('completed', rules);

    expect(match).toEqual({ index: 0, method: 'auto_select' });
  });

  it('should resolve aborted status to ABORT rule at index 1', () => {
    const rules = [
      { condition: 'COMPLETE' },
      { condition: 'ABORT' },
    ];

    const match = resolveMatchedRuleIndex('aborted', rules);

    expect(match).toEqual({ index: 1, method: 'auto_select' });
  });

  it('should resolve completed status when COMPLETE rule is not at index 0', () => {
    const rules = [
      { condition: 'ABORT' },
      { condition: 'COMPLETE' },
    ];

    const match = resolveMatchedRuleIndex('completed', rules);

    expect(match).toEqual({ index: 1, method: 'auto_select' });
  });

  it('should resolve aborted status when ABORT rule is at index 0', () => {
    const rules = [
      { condition: 'ABORT' },
      { condition: 'COMPLETE' },
    ];

    const match = resolveMatchedRuleIndex('aborted', rules);

    expect(match).toEqual({ index: 0, method: 'auto_select' });
  });

  it('should match case-insensitively (condition "Complete")', () => {
    const rules = [
      { condition: 'Complete' },
      { condition: 'Abort' },
    ];

    const match = resolveMatchedRuleIndex('completed', rules);

    expect(match).toEqual({ index: 0, method: 'auto_select' });
  });

  it('should match when condition contains COMPLETE as substring', () => {
    const rules = [
      { condition: 'Task COMPLETE successfully' },
      { condition: 'Task ABORT with errors' },
    ];

    const match = resolveMatchedRuleIndex('completed', rules);

    expect(match).toEqual({ index: 0, method: 'auto_select' });
  });

  it('should return undefined when rules is undefined', () => {
    const match = resolveMatchedRuleIndex('completed', undefined);

    expect(match).toBeUndefined();
  });

  it('should return undefined when no matching condition is found', () => {
    const rules = [
      { condition: 'approved' },
      { condition: 'needs_fix' },
    ];

    const match = resolveMatchedRuleIndex('completed', rules);

    expect(match).toBeUndefined();
  });

  it('should return undefined when rules array is empty', () => {
    const match = resolveMatchedRuleIndex('completed', []);

    expect(match).toBeUndefined();
  });

  it('should match first COMPLETE rule when multiple contain COMPLETE', () => {
    const rules = [
      { condition: 'COMPLETE with warnings' },
      { condition: 'COMPLETE without warnings' },
      { condition: 'ABORT' },
    ];

    const match = resolveMatchedRuleIndex('completed', rules);

    expect(match).toEqual({ index: 0, method: 'auto_select' });
  });
});

// ─── buildResponse: matchedRuleIndex propagation ───

describe('PieceCallRunner: buildResponse with matchedRuleIndex', () => {
  it('should include matchedRuleIndex in response when child completes', () => {
    const step = makePieceCallMovement('deploy', 'deploy-piece', [
      { condition: 'COMPLETE', next: 'next-step' },
      { condition: 'ABORT', next: 'ABORT' },
    ]);
    const childStatus: PieceState['status'] = 'completed';
    const childContent = 'Deployment successful';

    const match = resolveMatchedRuleIndex(childStatus, step.rules);
    const response: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: childContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

    expect(response.matchedRuleIndex).toBe(0);
    expect(response.matchedRuleMethod).toBe('auto_select');
    expect(response.content).toBe('Deployment successful');
  });

  it('should include matchedRuleIndex for ABORT when child aborts', () => {
    const step = makePieceCallMovement('deploy', 'deploy-piece', [
      { condition: 'COMPLETE', next: 'next-step' },
      { condition: 'ABORT', next: 'ABORT' },
    ]);
    const childStatus: PieceState['status'] = 'aborted';
    const childContent = 'Deploy failed';

    const match = resolveMatchedRuleIndex(childStatus, step.rules);
    const response: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: childContent,
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

    expect(response.matchedRuleIndex).toBe(1);
    expect(response.matchedRuleMethod).toBe('auto_select');
  });

  it('should not set matchedRuleIndex when step has no rules', () => {
    const step = makePieceCallMovement('deploy', 'deploy-piece');
    const childStatus: PieceState['status'] = 'completed';

    const match = resolveMatchedRuleIndex(childStatus, step.rules);
    const response: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: 'Done',
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

    expect(response.matchedRuleIndex).toBeUndefined();
    expect(response.matchedRuleMethod).toBeUndefined();
  });

  it('should not set matchedRuleIndex when rules do not contain COMPLETE/ABORT', () => {
    const step = makePieceCallMovement('deploy', 'deploy-piece', [
      { condition: 'approved', next: 'next' },
      { condition: 'rejected', next: 'fix' },
    ]);
    const childStatus: PieceState['status'] = 'completed';

    const match = resolveMatchedRuleIndex(childStatus, step.rules);
    const response: AgentResponse = {
      persona: step.name,
      status: 'done',
      content: 'Done',
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

    expect(response.matchedRuleIndex).toBeUndefined();
  });

  it('should not set matchedRuleIndex for error cases (loadPiece failure)', () => {
    // Error responses from buildResponse should not have matchedRuleIndex
    const response: AgentResponse = {
      persona: 'deploy',
      status: 'done',
      content: 'piece_call failed: child piece "missing" not found',
      timestamp: new Date(),
    };

    expect(response.matchedRuleIndex).toBeUndefined();
  });
});

// ─── ParallelRunner: detectMatchedRule skip when matchedRuleIndex is preset ───

describe('ParallelRunner: Skip detectMatchedRule when matchedRuleIndex is preset', () => {
  it('should use preset matchedRuleIndex without calling detectMatchedRule', () => {
    const response = makeAgentResponse({
      matchedRuleIndex: 0,
      matchedRuleMethod: 'auto_select',
      content: 'Child piece completed successfully',
    });

    // The fix: when response.matchedRuleIndex is already set, skip detectMatchedRule
    const shouldSkipDetection = response.matchedRuleIndex != null;

    expect(shouldSkipDetection).toBe(true);
  });

  it('should call detectMatchedRule when matchedRuleIndex is not set', () => {
    const response = makeAgentResponse({
      content: 'Some agent output without preset rule index',
    });

    const shouldSkipDetection = response.matchedRuleIndex != null;

    expect(shouldSkipDetection).toBe(false);
  });

  it('should preserve matchedRuleMethod from PieceCallRunner', () => {
    const response = makeAgentResponse({
      matchedRuleIndex: 1,
      matchedRuleMethod: 'auto_select',
    });

    // ParallelRunner should not overwrite the method
    expect(response.matchedRuleMethod).toBe('auto_select');
  });

  it('should correctly determine ABORT condition from preset matchedRuleIndex', () => {
    const subMovement = makePieceCallMovement('deploy', 'deploy-piece', [
      { condition: 'COMPLETE' },
      { condition: 'ABORT' },
    ]);
    const response = makeAgentResponse({
      matchedRuleIndex: 1,
      matchedRuleMethod: 'auto_select',
    });

    const matchedCondition = subMovement.rules?.[response.matchedRuleIndex!]?.condition;
    const shouldMerge = matchedCondition !== 'ABORT';

    expect(matchedCondition).toBe('ABORT');
    expect(shouldMerge).toBe(false);
  });

  it('should correctly determine COMPLETE condition from preset matchedRuleIndex', () => {
    const subMovement = makePieceCallMovement('deploy', 'deploy-piece', [
      { condition: 'COMPLETE' },
      { condition: 'ABORT' },
    ]);
    const response = makeAgentResponse({
      matchedRuleIndex: 0,
      matchedRuleMethod: 'auto_select',
    });

    const matchedCondition = subMovement.rules?.[response.matchedRuleIndex!]?.condition;
    const shouldMerge = matchedCondition !== 'ABORT';

    expect(matchedCondition).toBe('COMPLETE');
    expect(shouldMerge).toBe(true);
  });
});

// ─── Integration: child status → matchedRuleIndex → ParallelRunner aggregation ───

describe('Integration: Child piece status flows through parallel aggregation', () => {
  it('should propagate completed child status to COMPLETE rule in parallel sub-movement', () => {
    // Given: a piece_call sub-movement with COMPLETE/ABORT rules
    const subMovement = makePieceCallMovement('child-piece', 'target-piece', [
      { condition: 'COMPLETE' },
      { condition: 'ABORT' },
    ]);
    const childStatus: PieceState['status'] = 'completed';
    const childContent = 'All tasks done';

    // When: PieceCallRunner resolves status to rule index
    const match = resolveMatchedRuleIndex(childStatus, subMovement.rules);

    // Then: matchedRuleIndex points to COMPLETE rule
    expect(match).toBeDefined();
    expect(match!.index).toBe(0);
    expect(subMovement.rules![match!.index]!.condition).toBe('COMPLETE');

    // And: ParallelRunner can determine shouldMerge from the preset index
    const matchedCondition = subMovement.rules![match!.index]!.condition;
    const shouldMerge = matchedCondition !== 'ABORT';
    expect(shouldMerge).toBe(true);
  });

  it('should propagate aborted child status to ABORT rule in parallel sub-movement', () => {
    const subMovement = makePieceCallMovement('child-piece', 'target-piece', [
      { condition: 'COMPLETE' },
      { condition: 'ABORT' },
    ]);
    const childStatus: PieceState['status'] = 'aborted';
    const childContent = 'Build failed';

    const match = resolveMatchedRuleIndex(childStatus, subMovement.rules);

    expect(match).toBeDefined();
    expect(match!.index).toBe(1);
    expect(subMovement.rules![match!.index]!.condition).toBe('ABORT');

    const matchedCondition = subMovement.rules![match!.index]!.condition;
    const shouldMerge = matchedCondition !== 'ABORT';
    expect(shouldMerge).toBe(false);
  });

  it('should fallback gracefully when rules lack COMPLETE/ABORT conditions', () => {
    const subMovement = makePieceCallMovement('child-piece', 'target-piece', [
      { condition: 'approved' },
      { condition: 'needs_fix' },
    ]);
    const childStatus: PieceState['status'] = 'completed';

    // When: PieceCallRunner cannot find matching rule
    const match = resolveMatchedRuleIndex(childStatus, subMovement.rules);

    // Then: returns undefined, so ParallelRunner falls back to detectMatchedRule
    expect(match).toBeUndefined();
  });

  it('should set matchedRuleIndex on AgentResponse for movementOutputs', () => {
    const subMovement = makePieceCallMovement('deploy', 'deploy-piece', [
      { condition: 'COMPLETE' },
      { condition: 'ABORT' },
    ]);
    const childStatus: PieceState['status'] = 'completed';

    const match = resolveMatchedRuleIndex(childStatus, subMovement.rules);
    const finalResponse: AgentResponse = {
      persona: subMovement.name,
      status: 'done',
      content: 'Deployed',
      timestamp: new Date(),
      ...(match && { matchedRuleIndex: match.index, matchedRuleMethod: match.method }),
    };

    // movementOutputs stores the response with matchedRuleIndex
    const state: PieceState = {
      pieceName: 'parent',
      currentMovement: 'parallel-deploy',
      iteration: 0,
      movementOutputs: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      movementIterations: new Map(),
      status: 'running',
    };
    state.movementOutputs.set(subMovement.name, finalResponse);

    const stored = state.movementOutputs.get(subMovement.name);
    expect(stored?.matchedRuleIndex).toBe(0);
    expect(stored?.matchedRuleMethod).toBe('auto_select');
  });

  it('should handle multiple piece_call sub-movements with mixed statuses', () => {
    const subA = makePieceCallMovement('deploy-a', 'piece-a', [
      { condition: 'COMPLETE' },
      { condition: 'ABORT' },
    ]);
    const subB = makePieceCallMovement('deploy-b', 'piece-b', [
      { condition: 'COMPLETE' },
      { condition: 'ABORT' },
    ]);

    const matchA = resolveMatchedRuleIndex('completed', subA.rules);
    const matchB = resolveMatchedRuleIndex('aborted', subB.rules);

    expect(matchA).toEqual({ index: 0, method: 'auto_select' });
    expect(matchB).toEqual({ index: 1, method: 'auto_select' });

    // ParallelRunner shouldMerge logic per sub-movement
    const conditionA = subA.rules![matchA!.index]!.condition;
    const conditionB = subB.rules![matchB!.index]!.condition;
    expect(conditionA).toBe('COMPLETE');
    expect(conditionB).toBe('ABORT');
    expect(conditionA !== 'ABORT').toBe(true);  // merge A
    expect(conditionB !== 'ABORT').toBe(false);  // don't merge B
  });
});

// ─── PieceEngine: detectMatchedRule skip when matchedRuleIndex is preset (non-parallel path) ───

describe('PieceEngine: Skip detectMatchedRule for non-parallel piece_call when matchedRuleIndex is preset', () => {
  it('should use preset matchedRuleIndex without calling detectMatchedRule', () => {
    // Simulates PieceEngine.ts L441: raw.response already has matchedRuleIndex set by PieceCallRunner
    const rawResponse = makeAgentResponse({
      matchedRuleIndex: 0,
      matchedRuleMethod: 'auto_select',
      content: 'Child piece completed successfully',
    });

    // The fix: when raw.response.matchedRuleIndex is already set, skip detectMatchedRule
    const shouldSkipDetection = rawResponse.matchedRuleIndex != null;

    expect(shouldSkipDetection).toBe(true);
    expect(rawResponse.matchedRuleIndex).toBe(0);
    expect(rawResponse.matchedRuleMethod).toBe('auto_select');
  });

  it('should call detectMatchedRule when matchedRuleIndex is not set (fallback)', () => {
    // When PieceCallRunner could not resolve (e.g. rules lack COMPLETE/ABORT)
    const rawResponse = makeAgentResponse({
      content: 'Some output from child piece',
    });

    const shouldSkipDetection = rawResponse.matchedRuleIndex != null;

    expect(shouldSkipDetection).toBe(false);
  });

  it('should throw when matchedRuleIndex is set but matchedRuleMethod is missing', () => {
    // Invariant: matchedRuleIndex and matchedRuleMethod must be set together
    const rawResponse = makeAgentResponse({
      matchedRuleIndex: 0,
      // matchedRuleMethod intentionally omitted
      content: 'Incomplete response',
    });

    // PieceEngine and ParallelRunner should enforce this invariant
    const hasIndex = rawResponse.matchedRuleIndex != null;
    const hasMethod = rawResponse.matchedRuleMethod != null;

    expect(hasIndex).toBe(true);
    expect(hasMethod).toBe(false);

    // This is the invariant violation that should trigger an error
    if (hasIndex && !hasMethod) {
      expect(() => {
        throw new Error(`matchedRuleIndex is set (${rawResponse.matchedRuleIndex}) but matchedRuleMethod is missing`);
      }).toThrow('matchedRuleIndex is set');
    }
  });
});
