/**
 * Resolves a rule match from a workflow_call response.
 *
 * Uses the pre-resolved matchedRuleIndex from WorkflowCallRunner when available,
 * otherwise falls back to RuleEvaluator for content-based evaluation.
 */

import type { WorkflowStep, AgentResponse } from '../../models/types.js';
import { RuleEvaluator, type RuleMatch, type RuleEvaluatorContext } from './RuleEvaluator.js';

export async function resolveMatchFromResponse(
  step: WorkflowStep,
  response: AgentResponse,
  ruleCtx: RuleEvaluatorContext,
): Promise<RuleMatch | undefined> {
  if (response.matchedRuleIndex != null) {
    if (!response.matchedRuleMethod) {
      throw new Error(
        `matchedRuleIndex is set (${response.matchedRuleIndex}) but matchedRuleMethod is missing for "${step.name}"`,
      );
    }
    return { index: response.matchedRuleIndex, method: response.matchedRuleMethod };
  }
  return new RuleEvaluator(step, ruleCtx).evaluate(response.content, '');
}
