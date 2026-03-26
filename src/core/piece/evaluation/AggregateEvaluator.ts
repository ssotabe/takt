/**
 * Aggregate condition evaluator for parallel piece movements
 *
 * Evaluates all()/any() aggregate conditions against sub-movement results.
 */

import type { PieceMovement, PieceState } from '../../models/types.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('aggregate-evaluator');

/**
 * Evaluates aggregate conditions (all()/any()) for parallel parent movements.
 *
 * For each aggregate rule, checks the matched condition text of sub-movements:
 * - all("X"): true when ALL sub-movements have matched condition === X
 * - all("A", "B"): true when 1st sub-movement matches "A" AND 2nd sub-movement matches "B" (order-based)
 * - any("X"): true when at least ONE sub-movement has matched condition === X
 * - any("A", "B"): true when at least ONE sub-movement matches "A" OR "B"
 *
 * Edge cases per spec:
 * - Sub-movement with no matched rule (empty slot): excluded from evaluation for both all() and any()
 * - No active sub-movements (all empty or 0件): both → false
 * - Non-parallel movement: both → false
 * - all("A", "B") with wrong number of sub-movements: false (logged as error)
 */
export class AggregateEvaluator {
  constructor(
    private readonly step: PieceMovement,
    private readonly state: PieceState,
  ) {}

  /**
   * Evaluate aggregate conditions.
   * Returns the 0-based rule index in the movement's rules array, or -1 if no match.
   */
  evaluate(): number {
    if (!this.step.rules || !this.step.parallel || this.step.parallel.length === 0) return -1;

    // Helper: determine if a sub-movement is an active slot (not empty/skipped)
    const isActiveSlot = (sub: PieceMovement): boolean => {
      const output = this.state.movementOutputs.get(sub.name);
      return output != null && output.matchedRuleIndex != null;
    };

    for (let i = 0; i < this.step.rules.length; i++) {
      const rule = this.step.rules[i];
      if (!rule) continue;
      if (!rule.isAggregateCondition || !rule.aggregateType || !rule.aggregateConditionText) {
        continue;
      }

      const subMovements = this.step.parallel;
      const targetCondition = rule.aggregateConditionText;

      if (rule.aggregateType === 'all') {
        // Multiple conditions: order-based matching (1st sub-movement matches 1st condition, etc.)
        if (Array.isArray(targetCondition)) {
          if (targetCondition.length !== subMovements.length) {
            log.error('all() condition count mismatch', {
              movement: this.step.name,
              conditionCount: targetCondition.length,
              subMovementCount: subMovements.length,
            });
            continue;
          }
          // Guard: all slots empty → false
          if (!subMovements.some(isActiveSlot)) continue;
          const allMatch = subMovements.every((sub, idx) => {
            // Empty slot: skip (treat as true) to preserve index alignment
            if (!isActiveSlot(sub)) return true;
            const output = this.state.movementOutputs.get(sub.name);
            if (!output || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex!];
            const expectedCondition = targetCondition[idx];
            if (!expectedCondition) return false;
            return matchedRule?.condition === expectedCondition;
          });
          if (allMatch) {
            log.debug('Aggregate all() matched (multi-condition)', { movement: this.step.name, conditions: targetCondition, ruleIndex: i });
            return i;
          }
        } else {
          // Single condition: all active sub-movements must match the same condition
          const activeSubMovements = subMovements.filter(isActiveSlot);
          // Guard: no active slots → false
          if (activeSubMovements.length === 0) continue;
          const allMatch = activeSubMovements.every((sub) => {
            const output = this.state.movementOutputs.get(sub.name);
            if (!output || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex!];
            return matchedRule?.condition === targetCondition;
          });
          if (allMatch) {
            log.debug('Aggregate all() matched', { movement: this.step.name, condition: targetCondition, ruleIndex: i });
            return i;
          }
        }
      } else {
        // 'any'
        if (Array.isArray(targetCondition)) {
          // Multiple conditions: at least one active sub-movement matches at least one condition
          const activeSubMovements = subMovements.filter(isActiveSlot);
          // Guard: no active slots → false
          if (activeSubMovements.length === 0) continue;
          const anyMatch = activeSubMovements.some((sub) => {
            const output = this.state.movementOutputs.get(sub.name);
            if (!output || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex!];
            const condition = matchedRule?.condition;
            return condition != null && targetCondition.includes(condition);
          });
          if (anyMatch) {
            log.debug('Aggregate any() matched (multi-condition)', { movement: this.step.name, conditions: targetCondition, ruleIndex: i });
            return i;
          }
        } else {
          // Single condition: at least one active sub-movement matches the condition
          const activeSubMovements = subMovements.filter(isActiveSlot);
          // Guard: no active slots → false
          if (activeSubMovements.length === 0) continue;
          const anyMatch = activeSubMovements.some((sub) => {
            const output = this.state.movementOutputs.get(sub.name);
            if (!output || !sub.rules) return false;
            const matchedRule = sub.rules[output.matchedRuleIndex!];
            return matchedRule?.condition === targetCondition;
          });
          if (anyMatch) {
            log.debug('Aggregate any() matched', { movement: this.step.name, condition: targetCondition, ruleIndex: i });
            return i;
          }
        }
      }
    }

    return -1;
  }
}
