/**
 * Unit tests for AggregateEvaluator empty slot exclusion (Feature 15)
 *
 * Tests that empty slots (sub-steps with no matched rule / matchedRuleIndex == null)
 * are excluded from aggregate condition evaluation for both all() and any().
 */

import { describe, it, expect } from 'vitest';
import { AggregateEvaluator } from '../core/workflow/evaluation/AggregateEvaluator.js';
import type { WorkflowStep, WorkflowState, AgentResponse } from '../core/models/types.js';

function makeState(outputs: Record<string, { matchedRuleIndex?: number }>): WorkflowState {
  const stepOutputs = new Map<string, AgentResponse>();
  for (const [name, data] of Object.entries(outputs)) {
    stepOutputs.set(name, {
      persona: name,
      status: 'done',
      content: '',
      timestamp: new Date(),
      matchedRuleIndex: data.matchedRuleIndex,
    });
  }
  return {
    workflowName: 'test',
    currentStep: 'parent',
    iteration: 1,
    stepOutputs,
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

function makeSubStep(name: string, conditions: string[]): WorkflowStep {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: false,
    rules: conditions.map((c) => ({ condition: c })),
  };
}

function makeParentStep(
  parallel: WorkflowStep[],
  rules: WorkflowStep['rules'],
): WorkflowStep {
  return {
    name: 'parent',
    personaDisplayName: 'parent',
    instruction: '',
    passPreviousResponse: false,
    parallel,
    rules,
  };
}

describe('AggregateEvaluator empty slot exclusion', () => {
  describe('all() with single condition and empty slots', () => {
    it('should match when all active slots match and one slot is empty', () => {
      // Given: 3 sub-steps, one is an empty slot (no matchedRuleIndex)
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);
      const sub3 = makeSubStep('review-c', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2, sub3], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
      ]);

      // sub1 and sub3 matched "approved", sub2 is an empty slot (matchedRuleIndex undefined)
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': {},
        'review-c': { matchedRuleIndex: 0 },
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: empty slot excluded, all active slots match → true
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should not match when an active slot does not match the condition', () => {
      // Given: 3 sub-steps, one empty, one approved, one rejected
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);
      const sub3 = makeSubStep('review-c', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2, sub3], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
      ]);

      // sub1: approved, sub2: empty slot, sub3: rejected
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': {},
        'review-c': { matchedRuleIndex: 1 },
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: sub3 is active and doesn't match → false
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should return -1 when all sub-steps are empty slots', () => {
      // Given: all sub-steps are empty slots
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
      ]);

      // Both empty slots
      const state = makeState({
        'review-a': {},
        'review-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: no active slots → false
      expect(evaluator.evaluate()).toBe(-1);
    });
  });

  describe('all() with multiple conditions (order-based) and empty slots', () => {
    it('should treat empty slots as true to preserve index alignment', () => {
      // Given: 3 sub-steps with order-based conditions, middle one is empty
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);
      const sub3 = makeSubStep('review-c', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2, sub3], [
        {
          condition: 'order-based all',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: ['approved', 'approved', 'rejected'],
          next: 'COMPLETE',
        },
      ]);

      // sub1: approved (idx 0), sub2: empty slot, sub3: rejected (idx 1)
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': {},
        'review-c': { matchedRuleIndex: 1 },
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: empty slot treated as true, sub1 matches [0]="approved", sub3 matches [2]="rejected"
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should return -1 when all sub-steps are empty in multi-condition mode', () => {
      // Given: all sub-steps are empty
      const sub1 = makeSubStep('review-a', ['approved']);
      const sub2 = makeSubStep('review-b', ['approved']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'order-based all',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: ['approved', 'approved'],
          next: 'COMPLETE',
        },
      ]);

      const state = makeState({
        'review-a': {},
        'review-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: no active slots → false
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should not match when active slot does not match its position condition', () => {
      // Given: 2 sub-steps, first is empty, second is active but wrong condition
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'order-based all',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: ['approved', 'approved'],
          next: 'COMPLETE',
        },
      ]);

      // sub1: empty, sub2: "rejected" (doesn't match expected "approved")
      const state = makeState({
        'review-a': {},
        'review-b': { matchedRuleIndex: 1 },
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: sub2 doesn't match → false
      expect(evaluator.evaluate()).toBe(-1);
    });
  });

  describe('any() with single condition and empty slots', () => {
    it('should match when at least one active slot matches the condition', () => {
      // Given: 3 sub-steps, one active matches, one active doesn't, one empty
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);
      const sub3 = makeSubStep('review-c', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2, sub3], [
        {
          condition: 'any rejected',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'rejected',
          next: 'fix',
        },
      ]);

      // sub1: approved, sub2: empty slot, sub3: rejected
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': {},
        'review-c': { matchedRuleIndex: 1 },
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: sub3 matches → true
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should return -1 when all sub-steps are empty slots', () => {
      // Given: all empty
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'any rejected',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'rejected',
          next: 'fix',
        },
      ]);

      const state = makeState({
        'review-a': {},
        'review-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: no active slots → false
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should not match when no active slot matches the condition', () => {
      // Given: one active slot (approved), one empty slot — looking for "rejected"
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'any rejected',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'rejected',
          next: 'fix',
        },
      ]);

      // sub1: approved, sub2: empty
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: sub1 is "approved", not "rejected" → false
      expect(evaluator.evaluate()).toBe(-1);
    });
  });

  describe('any() with multiple conditions and empty slots', () => {
    it('should match when at least one active slot matches any condition', () => {
      // Given: one active matches one of the conditions, one empty
      const sub1 = makeSubStep('review-a', ['approved', 'rejected', 'needs-work']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected', 'needs-work']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'any rejected or needs-work',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: ['rejected', 'needs-work'],
          next: 'fix',
        },
      ]);

      // sub1: needs-work (idx 2), sub2: empty
      const state = makeState({
        'review-a': { matchedRuleIndex: 2 },
        'review-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: sub1 matches "needs-work" → true
      expect(evaluator.evaluate()).toBe(0);
    });

    it('should not match when active slot does not match any condition', () => {
      // Given: one active slot that matches neither condition, one empty
      const sub1 = makeSubStep('review-a', ['approved', 'rejected', 'needs-work']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected', 'needs-work']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'any rejected or needs-work',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: ['rejected', 'needs-work'],
          next: 'fix',
        },
      ]);

      // sub1: approved (idx 0) — does not match "rejected" or "needs-work", sub2: empty
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: sub1 is "approved", not in ["rejected", "needs-work"] → false
      expect(evaluator.evaluate()).toBe(-1);
    });

    it('should return -1 when all sub-steps are empty slots (multi-condition)', () => {
      // Given: all empty
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'any rejected or approved',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: ['rejected', 'approved'],
          next: 'fix',
        },
      ]);

      const state = makeState({
        'review-a': {},
        'review-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: no active slots → false
      expect(evaluator.evaluate()).toBe(-1);
    });
  });

  describe('rule fallthrough with empty slots', () => {
    it('should fall through to next rule when all() fails due to empty slots', () => {
      // Given: two rules, first is all() which fails because only active slot doesn't match,
      //        second is any() which should match
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
        {
          condition: 'any rejected',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'rejected',
          next: 'fix',
        },
      ]);

      // sub1: rejected (active), sub2: empty slot
      const state = makeState({
        'review-a': { matchedRuleIndex: 1 },
        'review-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: all("approved") fails → any("rejected") matches → rule index 1
      expect(evaluator.evaluate()).toBe(1);
    });

    it('should match all() when only active slot matches, ignoring empty slots', () => {
      // Given: 2 sub-steps, one active matches, one empty
      const sub1 = makeSubStep('review-a', ['approved', 'rejected']);
      const sub2 = makeSubStep('review-b', ['approved', 'rejected']);

      const step = makeParentStep([sub1, sub2], [
        {
          condition: 'all approved',
          isAggregateCondition: true,
          aggregateType: 'all',
          aggregateConditionText: 'approved',
          next: 'COMPLETE',
        },
        {
          condition: 'any rejected',
          isAggregateCondition: true,
          aggregateType: 'any',
          aggregateConditionText: 'rejected',
          next: 'fix',
        },
      ]);

      // sub1: approved (active), sub2: empty slot
      const state = makeState({
        'review-a': { matchedRuleIndex: 0 },
        'review-b': {},
      });

      // When
      const evaluator = new AggregateEvaluator(step, state);

      // Then: all("approved") with only active slot matching → rule index 0
      expect(evaluator.evaluate()).toBe(0);
    });
  });
});
