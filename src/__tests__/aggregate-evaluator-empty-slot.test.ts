/**
 * Tests for AggregateEvaluator empty slot (skipped sub-movement) handling.
 *
 * When ParallelRunner skips a sub-movement ("No task"), it sets movementOutputs
 * with matchedRuleIndex = undefined. These empty slots should be excluded from
 * all()/any() evaluation.
 */

import { describe, it, expect } from 'vitest';
import { AggregateEvaluator } from '../core/piece/evaluation/AggregateEvaluator.js';
import type { PieceMovement, PieceState, AgentResponse } from '../core/models/types.js';

function makeState(outputs: Record<string, { matchedRuleIndex?: number }>): PieceState {
  const movementOutputs = new Map<string, AgentResponse>();
  for (const [name, data] of Object.entries(outputs)) {
    movementOutputs.set(name, {
      persona: name,
      status: 'done',
      content: '',
      timestamp: new Date(),
      matchedRuleIndex: data.matchedRuleIndex,
    });
  }
  return {
    pieceName: 'test',
    currentMovement: 'parent',
    iteration: 1,
    movementOutputs,
    userInputs: [],
    personaSessions: new Map(),
    movementIterations: new Map(),
    status: 'running',
  };
}

function makeSubMovement(name: string, conditions: string[]): PieceMovement {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: false,
    rules: conditions.map((c) => ({ condition: c })),
  };
}

function makeParentMovement(
  parallel: PieceMovement[],
  rules: PieceMovement['rules'],
): PieceMovement {
  return {
    name: 'parent',
    personaDisplayName: 'parent',
    instruction: '',
    passPreviousResponse: false,
    parallel,
    rules,
  };
}

describe('AggregateEvaluator — empty slot handling', () => {
  describe('all() single condition with empty slots', () => {
    it('should match when active slots all satisfy condition and empty slots are excluded', () => {
      // Given: 2 sub-movements, slot-a completed with "COMPLETE", slot-b is empty (skipped)
      const slotA = makeSubMovement('slot-a', ['COMPLETE', 'FAILED']);
      const slotB = makeSubMovement('slot-b', ['COMPLETE', 'FAILED']);

      const step = makeParentMovement([slotA, slotB], [
        {
          condition: 'all complete',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'COMPLETE',
          next: 'done',
        },
      ]);

      // slot-a matched "COMPLETE" (index 0), slot-b has no matchedRuleIndex (empty slot)
      const state = makeState({
        'slot-a': { matchedRuleIndex: 0 },
        'slot-b': {},
      });

      // When: evaluating all("COMPLETE")
      const evaluator = new AggregateEvaluator(step, state);

      // Then: empty slot is excluded, only slot-a is evaluated → matches
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should not match when active slot does not satisfy condition despite empty slots being excluded', () => {
      // Given: 3 sub-movements, slot-a FAILED, slot-b empty, slot-c COMPLETE
      const slotA = makeSubMovement('slot-a', ['COMPLETE', 'FAILED']);
      const slotB = makeSubMovement('slot-b', ['COMPLETE', 'FAILED']);
      const slotC = makeSubMovement('slot-c', ['COMPLETE', 'FAILED']);

      const step = makeParentMovement([slotA, slotB, slotC], [
        {
          condition: 'all complete',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'COMPLETE',
          next: 'done',
        },
      ]);

      // slot-a matched "FAILED" (index 1), slot-b empty, slot-c matched "COMPLETE" (index 0)
      const state = makeState({
        'slot-a': { matchedRuleIndex: 1 },
        'slot-b': {},
        'slot-c': { matchedRuleIndex: 0 },
      });

      // When: evaluating all("COMPLETE")
      const evaluator = new AggregateEvaluator(step, state);

      // Then: slot-a is FAILED → all() is false
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should return -1 when all slots are empty', () => {
      // Given: 2 sub-movements, both are empty slots
      const slotA = makeSubMovement('slot-a', ['COMPLETE', 'FAILED']);
      const slotB = makeSubMovement('slot-b', ['COMPLETE', 'FAILED']);

      const step = makeParentMovement([slotA, slotB], [
        {
          condition: 'all complete',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'COMPLETE',
          next: 'done',
        },
      ]);

      // Both slots are empty (no matchedRuleIndex)
      const state = makeState({
        'slot-a': {},
        'slot-b': {},
      });

      // When: evaluating all("COMPLETE")
      const evaluator = new AggregateEvaluator(step, state);

      // Then: 0 active slots → false
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should match with multiple empty slots and one active slot satisfying condition', () => {
      // Given: 3 sub-movements, only slot-c is active with COMPLETE
      const slotA = makeSubMovement('slot-a', ['COMPLETE', 'FAILED']);
      const slotB = makeSubMovement('slot-b', ['COMPLETE', 'FAILED']);
      const slotC = makeSubMovement('slot-c', ['COMPLETE', 'FAILED']);

      const step = makeParentMovement([slotA, slotB, slotC], [
        {
          condition: 'all complete',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'COMPLETE',
          next: 'done',
        },
      ]);

      // slot-a and slot-b are empty, slot-c matched "COMPLETE" (index 0)
      const state = makeState({
        'slot-a': {},
        'slot-b': {},
        'slot-c': { matchedRuleIndex: 0 },
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: only slot-c evaluated, it matches → true
      expect(evaluator.evaluate()).toBe(0);
    });
  });

  describe('all() multi-condition (order-based) with empty slots', () => {
    it('should skip empty slots at specific positions in order-based matching', () => {
      // Given: 3 sub-movements with order-based conditions, slot-b is empty
      const slotA = makeSubMovement('slot-a', ['approved', 'rejected']);
      const slotB = makeSubMovement('slot-b', ['approved', 'rejected']);
      const slotC = makeSubMovement('slot-c', ['approved', 'rejected']);

      const step = makeParentMovement([slotA, slotB, slotC], [
        {
          condition: 'order-based all',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: ['approved', 'rejected', 'approved'],
          next: 'done',
        },
      ]);

      // slot-a matched "approved" (index 0), slot-b empty, slot-c matched "approved" (index 0)
      const state = makeState({
        'slot-a': { matchedRuleIndex: 0 },
        'slot-b': {},
        'slot-c': { matchedRuleIndex: 0 },
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: slot-b is empty → skipped (true), slot-a matches "approved", slot-c matches "approved" → all match
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should return -1 when all slots are empty in order-based matching', () => {
      // Given: 2 sub-movements, both empty
      const slotA = makeSubMovement('slot-a', ['approved', 'rejected']);
      const slotB = makeSubMovement('slot-b', ['approved', 'rejected']);

      const step = makeParentMovement([slotA, slotB], [
        {
          condition: 'order-based all',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: ['approved', 'rejected'],
          next: 'done',
        },
      ]);

      const state = makeState({
        'slot-a': {},
        'slot-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: all slots empty → false
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should not match when active slot does not match its positional condition', () => {
      // Given: 2 sub-movements, slot-a empty, slot-b active but does not match condition[1]
      const slotA = makeSubMovement('slot-a', ['approved', 'rejected']);
      const slotB = makeSubMovement('slot-b', ['approved', 'rejected']);

      const step = makeParentMovement([slotA, slotB], [
        {
          condition: 'order-based all',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: ['approved', 'rejected'],
          next: 'done',
        },
      ]);

      // slot-a empty, slot-b matched "approved" (index 0) but condition[1] expects "rejected"
      const state = makeState({
        'slot-a': {},
        'slot-b': { matchedRuleIndex: 0 },
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: slot-b matched "approved" but expected "rejected" → false
      expect(evaluator.evaluate()).toBe(-1);
    });
  });

  describe('any() single condition with empty slots', () => {
    it('should match when one active slot satisfies condition despite empty slots', () => {
      // Given: 2 sub-movements, slot-a matches, slot-b is empty
      const slotA = makeSubMovement('slot-a', ['needs_fix', 'approved']);
      const slotB = makeSubMovement('slot-b', ['needs_fix', 'approved']);

      const step = makeParentMovement([slotA, slotB], [
        {
          condition: 'any needs fix',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'needs_fix',
          next: 'fix',
        },
      ]);

      // slot-a matched "needs_fix" (index 0), slot-b is empty
      const state = makeState({
        'slot-a': { matchedRuleIndex: 0 },
        'slot-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: slot-a matches → true
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should return -1 when all slots are empty', () => {
      // Given: 2 sub-movements, both empty
      const slotA = makeSubMovement('slot-a', ['needs_fix', 'approved']);
      const slotB = makeSubMovement('slot-b', ['needs_fix', 'approved']);

      const step = makeParentMovement([slotA, slotB], [
        {
          condition: 'any needs fix',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'needs_fix',
          next: 'fix',
        },
      ]);

      const state = makeState({
        'slot-a': {},
        'slot-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: 0 active slots → false
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should return -1 when active slots do not match condition and empty slots are excluded', () => {
      // Given: 3 sub-movements, slot-a approved, slot-b empty, slot-c approved
      const slotA = makeSubMovement('slot-a', ['needs_fix', 'approved']);
      const slotB = makeSubMovement('slot-b', ['needs_fix', 'approved']);
      const slotC = makeSubMovement('slot-c', ['needs_fix', 'approved']);

      const step = makeParentMovement([slotA, slotB, slotC], [
        {
          condition: 'any needs fix',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'needs_fix',
          next: 'fix',
        },
      ]);

      // slot-a and slot-c matched "approved" (index 1), slot-b is empty
      const state = makeState({
        'slot-a': { matchedRuleIndex: 1 },
        'slot-b': {},
        'slot-c': { matchedRuleIndex: 1 },
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: no active slot matches "needs_fix" → false
      expect(evaluator.evaluate()).toBe(-1);
    });
  });

  describe('any() multi-condition with empty slots', () => {
    it('should match when one active slot matches one of the conditions despite empty slots', () => {
      // Given: 3 sub-movements, slot-a empty, slot-b matches one of the conditions
      const slotA = makeSubMovement('slot-a', ['approved', 'rejected', 'needs-work']);
      const slotB = makeSubMovement('slot-b', ['approved', 'rejected', 'needs-work']);
      const slotC = makeSubMovement('slot-c', ['approved', 'rejected', 'needs-work']);

      const step = makeParentMovement([slotA, slotB, slotC], [
        {
          condition: 'any rejected or needs-work',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: ['rejected', 'needs-work'],
          next: 'fix',
        },
      ]);

      // slot-a empty, slot-b matched "needs-work" (index 2), slot-c matched "approved" (index 0)
      const state = makeState({
        'slot-a': {},
        'slot-b': { matchedRuleIndex: 2 },
        'slot-c': { matchedRuleIndex: 0 },
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: slot-b matches "needs-work" → true
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should return -1 when all slots are empty for multi-condition any()', () => {
      // Given: 2 sub-movements, both empty
      const slotA = makeSubMovement('slot-a', ['approved', 'rejected']);
      const slotB = makeSubMovement('slot-b', ['approved', 'rejected']);

      const step = makeParentMovement([slotA, slotB], [
        {
          condition: 'any rejected or approved',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: ['rejected', 'approved'],
          next: 'fix',
        },
      ]);

      const state = makeState({
        'slot-a': {},
        'slot-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: 0 active slots → false
      expect(evaluator.evaluate()).toBe(-1);
    });
  });

  describe('rule priority with empty slots', () => {
    it('should fall through all() to any() when empty slot causes all() to exclude only active match', () => {
      // Given: 2 rules — all("COMPLETE") and any("FAILED"), with one empty and one failed slot
      const slotA = makeSubMovement('slot-a', ['COMPLETE', 'FAILED']);
      const slotB = makeSubMovement('slot-b', ['COMPLETE', 'FAILED']);

      const step = makeParentMovement([slotA, slotB], [
        {
          condition: 'all complete',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'COMPLETE',
          next: 'done',
        },
        {
          condition: 'any failed',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'FAILED',
          next: 'fix',
        },
      ]);

      // slot-a matched "FAILED" (index 1), slot-b is empty
      const state = makeState({
        'slot-a': { matchedRuleIndex: 1 },
        'slot-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: all("COMPLETE") fails (slot-a is FAILED), any("FAILED") matches → rule index 1
      expect(evaluator.evaluate()).toBe(1);
    });
  });
});
