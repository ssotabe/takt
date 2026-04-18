/**
 * Unit tests for resolve-match module.
 *
 * Tests resolveMatchFromResponse: using pre-resolved matchedRuleIndex
 * from WorkflowCallRunner when available, falling back to RuleEvaluator.
 *
 * Mocked: RuleEvaluator
 * Not mocked: resolveMatchFromResponse logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkflowStep, AgentResponse, RuleMatchMethod } from '../core/models/types.js';

// --- Hoisted mocks ---

const { mockEvaluate } = vi.hoisted(() => ({
  mockEvaluate: vi.fn(),
}));

vi.mock('../core/workflow/evaluation/RuleEvaluator.js', () => ({
  RuleEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: mockEvaluate,
  })),
}));

// --- Imports (after mocks) ---

import { resolveMatchFromResponse } from '../core/workflow/evaluation/resolve-match.js';
import type { RuleEvaluatorContext, RuleMatch } from '../core/workflow/evaluation/RuleEvaluator.js';

// --- Test helpers ---

function makeStep(name: string): WorkflowStep {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: false,
    rules: [
      { condition: 'approved', next: 'next' },
      { condition: 'needs_fix', next: 'fix' },
    ],
  };
}

function makeResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    persona: 'test',
    status: 'done',
    content: 'agent output',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeRuleCtx(): RuleEvaluatorContext {
  return {
    state: {
      workflowName: 'test',
      currentStep: 'test',
      iteration: 1,
      stepOutputs: new Map(),
      structuredOutputs: new Map(),
      systemContexts: new Map(),
      effectResults: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      stepIterations: new Map(),
      status: 'running',
    },
    cwd: '/tmp/test',
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    structuredCaller: { evaluateCondition: vi.fn() },
  };
}

describe('resolveMatchFromResponse', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('pre-resolved matchedRuleIndex', () => {
    it('should return pre-resolved match when matchedRuleIndex and matchedRuleMethod are set', async () => {
      // Given
      const step = makeStep('review');
      const response = makeResponse({
        matchedRuleIndex: 0,
        matchedRuleMethod: 'phase1_tag' as RuleMatchMethod,
      });
      const ctx = makeRuleCtx();

      // When
      const result = await resolveMatchFromResponse(step, response, ctx);

      // Then
      expect(result).toEqual({ index: 0, method: 'phase1_tag' });
      expect(mockEvaluate).not.toHaveBeenCalled();
    });

    it('should throw when matchedRuleIndex is set but matchedRuleMethod is missing', async () => {
      // Given
      const step = makeStep('review');
      const response = makeResponse({
        matchedRuleIndex: 1,
        matchedRuleMethod: undefined,
      });
      const ctx = makeRuleCtx();

      // When / Then
      await expect(resolveMatchFromResponse(step, response, ctx)).rejects.toThrow(
        'matchedRuleIndex is set (1) but matchedRuleMethod is missing for "review"',
      );
    });

    it('should handle matchedRuleIndex of 0 (falsy but valid)', async () => {
      // Given: index 0 is falsy in JS but should be treated as a valid match
      const step = makeStep('review');
      const response = makeResponse({
        matchedRuleIndex: 0,
        matchedRuleMethod: 'aggregate' as RuleMatchMethod,
      });
      const ctx = makeRuleCtx();

      // When
      const result = await resolveMatchFromResponse(step, response, ctx);

      // Then
      expect(result).toEqual({ index: 0, method: 'aggregate' });
    });
  });

  describe('RuleEvaluator fallback', () => {
    it('should delegate to RuleEvaluator when matchedRuleIndex is not set', async () => {
      // Given
      const step = makeStep('review');
      const response = makeResponse({ content: 'some output' });
      const ctx = makeRuleCtx();
      const expectedMatch: RuleMatch = { index: 1, method: 'ai_judge' };
      mockEvaluate.mockResolvedValue(expectedMatch);

      // When
      const result = await resolveMatchFromResponse(step, response, ctx);

      // Then
      expect(result).toEqual(expectedMatch);
      expect(mockEvaluate).toHaveBeenCalledWith('some output', '');
    });

    it('should return undefined when RuleEvaluator returns undefined', async () => {
      // Given
      const step = makeStep('no-rules');
      step.rules = undefined;
      const response = makeResponse();
      const ctx = makeRuleCtx();
      mockEvaluate.mockResolvedValue(undefined);

      // When
      const result = await resolveMatchFromResponse(step, response, ctx);

      // Then
      expect(result).toBeUndefined();
    });
  });
});
