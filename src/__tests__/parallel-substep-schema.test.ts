/**
 * Unit tests for ParallelSubStepRawSchema extensions.
 *
 * Tests the addition of workflow_call support to parallel sub-steps:
 * - kind: 'workflow_call' with call field
 * - overrides (only for workflow_call)
 * - timeout_ms per sub-step
 * - parallel_config on parent step
 */

import { describe, expect, it } from 'vitest';
import { ParallelSubStepRawSchema, WorkflowStepRawSchema } from '../core/models/index.js';

function createAgentSubStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'review-sub',
    persona: 'reviewer',
    instruction: 'Review the code',
    ...overrides,
  };
}

function createWorkflowCallSubStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'delegate-sub',
    kind: 'workflow_call',
    call: 'shared/review-loop',
    ...overrides,
  };
}

function createParentStep(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'parallel-step',
    parallel: [createAgentSubStep()],
    rules: [
      { condition: 'done', next: 'COMPLETE' },
    ],
    ...overrides,
  };
}

describe('ParallelSubStepRawSchema workflow_call extensions', () => {
  describe('kind and call', () => {
    it('should accept workflow_call sub-step with call field', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createWorkflowCallSubStep(),
      );

      expect(result.success).toBe(true);
    });

    it('should reject workflow_call sub-step without call', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createWorkflowCallSubStep({ call: undefined }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes('call'))).toBe(true);
      }
    });

    it('should reject workflow_call sub-step with persona', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createWorkflowCallSubStep({ persona: 'coder' }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes('persona'))).toBe(true);
      }
    });

    it('should reject workflow_call sub-step with instruction', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createWorkflowCallSubStep({ instruction: 'Do something' }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes('instruction'))).toBe(true);
      }
    });

    it('should reject workflow_call sub-step with edit', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createWorkflowCallSubStep({ edit: true }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes('edit'))).toBe(true);
      }
    });

    it('should accept agent sub-step without kind (default)', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createAgentSubStep(),
      );

      expect(result.success).toBe(true);
    });

    it('should accept agent sub-step with explicit kind agent', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createAgentSubStep({ kind: 'agent' }),
      );

      expect(result.success).toBe(true);
    });
  });

  describe('overrides', () => {
    it('should accept overrides on workflow_call sub-step', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createWorkflowCallSubStep({
          overrides: {
            provider: 'codex',
            model: 'gpt-5-codex',
          },
        }),
      );

      expect(result.success).toBe(true);
    });

    it('should reject overrides on agent sub-step', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createAgentSubStep({ overrides: { provider: 'codex' } }),
      );

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.some((issue) => issue.path.includes('overrides'))).toBe(true);
      }
    });

    it('should reject empty overrides on workflow_call sub-step', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createWorkflowCallSubStep({ overrides: {} }),
      );

      expect(result.success).toBe(false);
    });

    it('should accept overrides with provider_options', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createWorkflowCallSubStep({
          overrides: {
            provider: 'codex',
            provider_options: {
              codex: { network_access: true },
            },
          },
        }),
      );

      expect(result.success).toBe(true);
    });
  });

  describe('timeout_ms', () => {
    it('should accept positive integer timeout_ms', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createAgentSubStep({ timeout_ms: 30000 }),
      );

      expect(result.success).toBe(true);
    });

    it('should accept timeout_ms on workflow_call sub-step', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createWorkflowCallSubStep({ timeout_ms: 60000 }),
      );

      expect(result.success).toBe(true);
    });

    it('should reject non-positive timeout_ms', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createAgentSubStep({ timeout_ms: 0 }),
      );

      expect(result.success).toBe(false);
    });

    it('should reject non-integer timeout_ms', () => {
      const result = ParallelSubStepRawSchema.safeParse(
        createAgentSubStep({ timeout_ms: 1000.5 }),
      );

      expect(result.success).toBe(false);
    });
  });
});

describe('parallel_config on parent step', () => {
  it('should accept parallel_config with timeout_ms', () => {
    const result = WorkflowStepRawSchema.safeParse(
      createParentStep({
        parallel_config: {
          timeout_ms: 1800000,
        },
      }),
    );

    expect(result.success).toBe(true);
  });

  it('should reject parallel_config without parallel', () => {
    const result = WorkflowStepRawSchema.safeParse({
      name: 'solo-step',
      persona: 'coder',
      instruction: 'Do work',
      parallel_config: {
        timeout_ms: 1800000,
      },
      rules: [
        { condition: 'done', next: 'COMPLETE' },
      ],
    });

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) =>
        issue.path.includes('parallel_config'),
      )).toBe(true);
    }
  });

  it('should accept parallel_config with empty timeout_ms (uses default)', () => {
    const result = WorkflowStepRawSchema.safeParse(
      createParentStep({
        parallel_config: {},
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      const data = result.data as Record<string, unknown>;
      const config = data.parallel_config as Record<string, unknown>;
      expect(config.timeout_ms).toBe(1800000);
    }
  });

  it('should accept parallel step with workflow_call sub-steps', () => {
    const result = WorkflowStepRawSchema.safeParse(
      createParentStep({
        parallel: [
          createWorkflowCallSubStep({ name: 'slot_1' }),
          createWorkflowCallSubStep({ name: 'slot_2', call: 'shared/fix-loop' }),
        ],
      }),
    );

    expect(result.success).toBe(true);
  });
});
