/**
 * Integration test for resume session propagation.
 *
 * Verifies the end-to-end flow: step execution stores sessionId in stepSessions,
 * then a subsequent step with `resume: <step-name>` retrieves that sessionId
 * and applies its own model to prevent model persistence.
 *
 * This test exercises the chain:
 *   StepExecutor (stores sessionId) → WorkflowState.stepSessions
 *   → OptionsBuilder (resolves sessionId from stepSessions for resume)
 *   → RunAgentOptions (sessionId + resolvedModel)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import type { WorkflowStep, WorkflowState } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

function createStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'test-step',
    personaDisplayName: 'tester',
    instruction: 'test',
    passPreviousResponse: false,
    ...overrides,
  };
}

function createState(): WorkflowState {
  return {
    workflowName: 'test',
    currentStep: 'implement',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    userInputs: [],
    personaSessions: new Map(),
    stepSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

describe('Resume session propagation (integration)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should propagate sessionId through stepSessions for resume chain', () => {
    // Given: implement step completed and stored its session
    const state = createState();
    state.stepSessions.set('implement', 'impl-session-001');
    state.stepSessions.set('advisor_implement', 'adv-session-002');

    const engineOptions: WorkflowEngineOptions = {
      projectCwd: '/project',
      provider: 'claude',
      model: 'sonnet',
    };

    const builder = new OptionsBuilder(
      engineOptions,
      () => '/project',
      () => '/project',
      (persona: string) => state.personaSessions.get(persona),
      (stepName: string) => state.stepSessions.get(stepName),
      () => '.takt/runs/test/reports',
      () => 'ja',
      () => [
        { name: 'implement' },
        { name: 'advisor_implement' },
        { name: 'implement_continue' },
      ],
      () => 'default-advisor',
      () => 'Advisor workflow',
    );

    // When: advisor_implement step resumes from implement
    const advisorStep = createStep({
      name: 'advisor_implement',
      resume: 'implement',
      model: 'opus',
      persona: 'advisor',
    });
    const advisorOptions = builder.buildAgentOptions(advisorStep);

    // Then: gets implement's session and uses opus model
    expect(advisorOptions.sessionId).toBe('impl-session-001');
    expect(advisorOptions.resolvedModel).toBe('opus');

    // When: implement_continue resumes from advisor_implement
    const continueStep = createStep({
      name: 'implement_continue',
      resume: 'advisor_implement',
      model: 'sonnet',
      persona: 'coder',
    });
    const continueOptions = builder.buildAgentOptions(continueStep);

    // Then: gets advisor's session and uses sonnet model (not opus)
    expect(continueOptions.sessionId).toBe('adv-session-002');
    expect(continueOptions.resolvedModel).toBe('sonnet');
  });

  it('should keep persona session path independent from resume path', () => {
    // Given: state has both persona sessions and step sessions
    const state = createState();
    state.personaSessions.set('coder', 'persona-coder-session');
    state.stepSessions.set('implement', 'step-impl-session');

    const engineOptions: WorkflowEngineOptions = {
      projectCwd: '/project',
      provider: 'claude',
    };

    const builder = new OptionsBuilder(
      engineOptions,
      () => '/project',
      () => '/project',
      (persona: string) => state.personaSessions.get(persona),
      (stepName: string) => state.stepSessions.get(stepName),
      () => '.takt/runs/test/reports',
      () => 'ja',
      () => [{ name: 'implement' }, { name: 'review' }],
      () => 'default',
      () => 'test',
    );

    // When: a normal step (no resume) uses persona session
    const normalStep = createStep({
      name: 'review',
      persona: 'coder',
    });
    const normalOptions = builder.buildAgentOptions(normalStep);

    // Then: uses persona session key
    expect(normalOptions.sessionId).toBe('persona-coder-session');

    // When: a resume step uses step session
    const resumeStep = createStep({
      name: 'advisor_implement',
      resume: 'implement',
      model: 'opus',
    });
    const resumeOptions = builder.buildAgentOptions(resumeStep);

    // Then: uses step session, not persona session
    expect(resumeOptions.sessionId).toBe('step-impl-session');
  });
});
