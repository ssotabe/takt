/**
 * Unit tests for parallel sub-step normalizer extensions.
 *
 * Tests the normalization of:
 * - timeout_ms → timeoutMs mapping for parallel sub-steps
 * - parallel_config → parallelConfig mapping for parent steps
 * - workflow_call sub-steps in parallel blocks
 */

import { describe, expect, it } from 'vitest';
import type { AgentWorkflowStep, WorkflowCallStep } from '../core/models/index.js';
import { normalizeWorkflowConfig } from '../infra/config/loaders/workflowParser.js';

function createWorkflowWithParallel(
  parallelSubSteps: Record<string, unknown>[],
  stepOverrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    name: 'test-workflow',
    initial_step: 'parallel-step',
    max_steps: 3,
    steps: [
      {
        name: 'parallel-step',
        parallel: parallelSubSteps,
        rules: [
          { condition: 'done', next: 'COMPLETE' },
        ],
        ...stepOverrides,
      },
    ],
  };
}

describe('parallel sub-step timeout_ms normalization', () => {
  it('should normalize timeout_ms to timeoutMs on agent sub-step', () => {
    const workflow = normalizeWorkflowConfig(
      createWorkflowWithParallel([
        {
          name: 'review-a',
          persona: 'reviewer',
          instruction: 'Review A',
          timeout_ms: 30000,
        },
        {
          name: 'review-b',
          persona: 'reviewer',
          instruction: 'Review B',
        },
      ]),
      process.cwd(),
    );

    const parentStep = workflow.steps[0] as AgentWorkflowStep;
    expect(parentStep.parallel).toBeDefined();

    const subA = parentStep.parallel![0] as AgentWorkflowStep;
    expect(subA.timeoutMs).toBe(30000);

    const subB = parentStep.parallel![1] as AgentWorkflowStep;
    expect(subB.timeoutMs).toBeUndefined();
  });

  it('should normalize timeout_ms on workflow_call sub-step', () => {
    const workflow = normalizeWorkflowConfig(
      createWorkflowWithParallel([
        {
          name: 'slot_1',
          kind: 'workflow_call',
          call: 'shared/review',
          timeout_ms: 60000,
        },
      ]),
      process.cwd(),
    );

    const parentStep = workflow.steps[0] as AgentWorkflowStep;
    const subStep = parentStep.parallel![0] as WorkflowCallStep;
    expect(subStep.kind).toBe('workflow_call');
    expect(subStep.timeoutMs).toBe(60000);
  });
});

describe('parallel_config normalization', () => {
  it('should normalize parallel_config.timeout_ms to parallelConfig.timeoutMs', () => {
    const workflow = normalizeWorkflowConfig(
      createWorkflowWithParallel(
        [
          {
            name: 'review-a',
            persona: 'reviewer',
            instruction: 'Review A',
          },
        ],
        {
          parallel_config: {
            timeout_ms: 900000,
          },
        },
      ),
      process.cwd(),
    );

    const parentStep = workflow.steps[0] as AgentWorkflowStep;
    expect(parentStep.parallelConfig).toEqual({
      timeoutMs: 900000,
    });
  });

  it('should use default timeout_ms when parallel_config is empty', () => {
    const workflow = normalizeWorkflowConfig(
      createWorkflowWithParallel(
        [
          {
            name: 'review-a',
            persona: 'reviewer',
            instruction: 'Review A',
          },
        ],
        {
          parallel_config: {},
        },
      ),
      process.cwd(),
    );

    const parentStep = workflow.steps[0] as AgentWorkflowStep;
    expect(parentStep.parallelConfig).toEqual({
      timeoutMs: 1800000,
    });
  });

  it('should not set parallelConfig when parallel_config is absent', () => {
    const workflow = normalizeWorkflowConfig(
      createWorkflowWithParallel([
        {
          name: 'review-a',
          persona: 'reviewer',
          instruction: 'Review A',
        },
      ]),
      process.cwd(),
    );

    const parentStep = workflow.steps[0] as AgentWorkflowStep;
    expect(parentStep.parallelConfig).toBeUndefined();
  });
});

describe('workflow_call sub-step normalization in parallel', () => {
  it('should normalize workflow_call sub-step with overrides', () => {
    const workflow = normalizeWorkflowConfig(
      createWorkflowWithParallel([
        {
          name: 'delegate-sub',
          kind: 'workflow_call',
          call: 'shared/review-loop',
          overrides: {
            provider: 'codex',
            model: 'gpt-5-codex',
          },
        },
      ]),
      process.cwd(),
    );

    const parentStep = workflow.steps[0] as AgentWorkflowStep;
    const subStep = parentStep.parallel![0] as WorkflowCallStep;
    expect(subStep.kind).toBe('workflow_call');
    expect(subStep.call).toBe('shared/review-loop');
    expect(subStep.overrides).toMatchObject({
      provider: 'codex',
      model: 'gpt-5-codex',
    });
  });

  it('should normalize mixed agent and workflow_call sub-steps', () => {
    const workflow = normalizeWorkflowConfig(
      createWorkflowWithParallel([
        {
          name: 'review-sub',
          persona: 'reviewer',
          instruction: 'Review',
        },
        {
          name: 'delegate-sub',
          kind: 'workflow_call',
          call: 'shared/fix-loop',
        },
      ]),
      process.cwd(),
    );

    const parentStep = workflow.steps[0] as AgentWorkflowStep;
    expect(parentStep.parallel).toHaveLength(2);

    const agentSub = parentStep.parallel![0] as AgentWorkflowStep;
    expect(agentSub.kind).toBe('agent');
    expect(agentSub.name).toBe('review-sub');

    const callSub = parentStep.parallel![1] as WorkflowCallStep;
    expect(callSub.kind).toBe('workflow_call');
    expect(callSub.call).toBe('shared/fix-loop');
  });
});
