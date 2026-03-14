/**
 * Tests for resolveMatchFromResponse.
 *
 * Covers:
 * - Pre-resolved match passthrough (matchedRuleIndex + matchedRuleMethod)
 * - Missing matchedRuleMethod when matchedRuleIndex is set (Fail Fast)
 * - Fallback to detectMatchedRule when matchedRuleIndex is not set
 */

import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { PieceMovement, AgentResponse } from '../core/models/index.js';
import type { RuleEvaluatorContext } from '../core/piece/evaluation/RuleEvaluator.js';

vi.mock('../core/piece/evaluation/RuleEvaluator.js', () => ({
  RuleEvaluator: vi.fn().mockImplementation(() => ({
    evaluate: vi.fn().mockResolvedValue({ index: 2, method: 'ai_judge_fallback' }),
  })),
}));

const { resolveMatchFromResponse } = await import('../core/piece/evaluation/resolve-match.js');

function makeStep(name: string): PieceMovement {
  return {
    name,
    personaDisplayName: name,
    instruction: `Run ${name}`,
    passPreviousResponse: true,
    rules: [
      { condition: 'done', next: 'COMPLETE' },
      { condition: 'retry', next: 'fix' },
      { condition: 'abort', next: 'ABORT' },
    ],
  };
}

function makeResponse(overrides: Partial<AgentResponse> = {}): AgentResponse {
  return {
    persona: 'test',
    status: 'done',
    content: 'test content',
    timestamp: new Date(),
    ...overrides,
  };
}

function makeRuleCtx(): RuleEvaluatorContext {
  return {
    state: {
      pieceName: 'test',
      currentMovement: 'step1',
      iteration: 1,
      movementOutputs: new Map(),
      userInputs: [],
      personaSessions: new Map(),
      movementIterations: new Map(),
      status: 'running',
    },
    cwd: '/workspace',
    interactive: false,
    detectRuleIndex: vi.fn().mockReturnValue(-1),
    callAiJudge: vi.fn(),
  };
}

describe('resolveMatchFromResponse', () => {
  it('should return pre-resolved match when matchedRuleIndex and matchedRuleMethod are set', async () => {
    const step = makeStep('deploy');
    const response = makeResponse({ matchedRuleIndex: 0, matchedRuleMethod: 'auto_select' });

    const result = await resolveMatchFromResponse(step, response, makeRuleCtx());

    expect(result).toEqual({ index: 0, method: 'auto_select' });
  });

  it('should throw when matchedRuleIndex is set but matchedRuleMethod is missing', async () => {
    const step = makeStep('deploy');
    const response = makeResponse({ matchedRuleIndex: 1 });

    await expect(
      resolveMatchFromResponse(step, response, makeRuleCtx()),
    ).rejects.toThrow('matchedRuleIndex is set (1) but matchedRuleMethod is missing for "deploy"');
  });

  it('should fall back to detectMatchedRule when matchedRuleIndex is not set', async () => {
    const step = makeStep('deploy');
    const response = makeResponse();

    const result = await resolveMatchFromResponse(step, response, makeRuleCtx());

    expect(result).toEqual({ index: 2, method: 'ai_judge_fallback' });
  });
});

describe('dead-code prevention: PieceEngine imports', () => {
  it('should not import detectMatchedRule in PieceEngine (uses resolveMatchFromResponse instead)', () => {
    const enginePath = resolve(__dirname, '../core/piece/engine/PieceEngine.ts');
    const content = readFileSync(enginePath, 'utf-8');

    // PieceEngine should use resolveMatchFromResponse, not detectMatchedRule directly
    expect(content).not.toMatch(/import\s.*detectMatchedRule.*from/);
    expect(content).toMatch(/import\s.*resolveMatchFromResponse.*from/);
  });
});
