/**
 * Unit tests for OptionsBuilder resume session resolution.
 *
 * Tests that `step.resume` correctly resolves sessionId from the referenced
 * step's session, and that the step's own model is always applied to prevent
 * model persistence from the resumed session.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { OptionsBuilder } from '../core/workflow/engine/OptionsBuilder.js';
import type { WorkflowStep } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

function createStep(overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    name: 'advisor_implement',
    personaDisplayName: 'advisor',
    instruction: 'advise',
    passPreviousResponse: false,
    ...overrides,
  };
}

function createBuilder(
  step: WorkflowStep,
  engineOverrides: Partial<WorkflowEngineOptions> = {},
  deps: {
    getSessionId?: (persona: string) => string | undefined;
    getStepSessionId?: (stepName: string) => string | undefined;
    getCwd?: () => string;
    getProjectCwd?: () => string;
  } = {},
): OptionsBuilder {
  const engineOptions: WorkflowEngineOptions = {
    projectCwd: '/project',
    provider: 'claude',
    providerProfiles: {
      claude: {
        defaultPermissionMode: 'edit',
      },
    },
    ...engineOverrides,
  };

  return new OptionsBuilder(
    engineOptions,
    deps.getCwd ?? (() => '/project'),
    deps.getProjectCwd ?? (() => '/project'),
    deps.getSessionId ?? (() => undefined),
    deps.getStepSessionId ?? (() => undefined),
    () => '.takt/runs/sample/reports',
    () => 'ja',
    () => [{ name: step.name }],
    () => 'default',
    () => 'test workflow',
  );
}

describe('OptionsBuilder.buildAgentOptions — resume', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use step session from referenced step when resume is set', () => {
    // Given: a step that resumes from "implement" which has session "session-abc"
    const step = createStep({
      name: 'advisor_implement',
      resume: 'implement',
      model: 'opus',
    });
    const builder = createBuilder(step, { provider: 'claude' }, {
      getStepSessionId: (stepName: string) =>
        stepName === 'implement' ? 'session-abc' : undefined,
    });

    // When
    const options = builder.buildAgentOptions(step);

    // Then: sessionId comes from the referenced step
    expect(options.sessionId).toBe('session-abc');
  });

  it('should apply the step own model when resuming to prevent model persistence', () => {
    // Given: advisor step resumes implement (which used sonnet), advisor uses opus
    const step = createStep({
      name: 'advisor_implement',
      resume: 'implement',
      model: 'opus',
    });
    const builder = createBuilder(step, {
      provider: 'claude',
      model: 'sonnet',
    }, {
      getStepSessionId: (stepName: string) =>
        stepName === 'implement' ? 'session-abc' : undefined,
    });

    // When
    const options = builder.buildAgentOptions(step);

    // Then: model is the step's own model, not the engine's
    expect(options.resolvedModel).toBe('opus');
  });

  it('should start a new session when referenced step has no session yet', () => {
    // Given: resume references a step that hasn't run yet
    const step = createStep({
      name: 'advisor_implement',
      resume: 'implement',
      model: 'opus',
    });
    const builder = createBuilder(step, { provider: 'claude' }, {
      getStepSessionId: () => undefined,
    });

    // When
    const options = builder.buildAgentOptions(step);

    // Then: no sessionId, starts fresh
    expect(options.sessionId).toBeUndefined();
  });

  it('should prioritize resume over session refresh setting', () => {
    // Given: step has both resume and session: 'refresh'
    const step = createStep({
      name: 'advisor_implement',
      resume: 'implement',
      session: 'refresh',
      model: 'opus',
    });
    const builder = createBuilder(step, { provider: 'claude' }, {
      getStepSessionId: (stepName: string) =>
        stepName === 'implement' ? 'session-from-implement' : undefined,
    });

    // When
    const options = builder.buildAgentOptions(step);

    // Then: resume takes priority, session is resumed not refreshed
    expect(options.sessionId).toBe('session-from-implement');
  });

  it('should skip resume when in worktree execution (cwd !== projectCwd)', () => {
    // Given: running in a worktree with different cwd
    const step = createStep({
      name: 'advisor_implement',
      resume: 'implement',
      model: 'opus',
    });
    const builder = createBuilder(step, { provider: 'claude' }, {
      getCwd: () => '/worktree/clone',
      getProjectCwd: () => '/project',
      getStepSessionId: (stepName: string) =>
        stepName === 'implement' ? 'session-abc' : undefined,
    });

    // When
    const options = builder.buildAgentOptions(step);

    // Then: sessionId should be undefined because worktree skips resume
    expect(options.sessionId).toBeUndefined();
  });

  it('should use persona-based session when resume is not set', () => {
    // Given: a regular step without resume
    const step = createStep({
      name: 'implement',
      persona: 'coder',
    });
    const builder = createBuilder(step, { provider: 'claude' }, {
      getSessionId: (persona: string) =>
        persona === 'coder' ? 'persona-session-xyz' : undefined,
      getStepSessionId: () => {
        throw new Error('getStepSessionId should not be called');
      },
    });

    // When
    const options = builder.buildAgentOptions(step);

    // Then: uses persona-based session, not step-based
    expect(options.sessionId).toBe('persona-session-xyz');
  });

  it('should apply step model for implement_continue resuming from advisor', () => {
    // Given: implement_continue resumes from advisor (opus), returns to sonnet
    const step = createStep({
      name: 'implement_continue',
      resume: 'advisor_implement',
      model: 'sonnet',
      persona: 'coder',
    });
    const builder = createBuilder(step, {
      provider: 'claude',
      model: 'opus',
    }, {
      getStepSessionId: (stepName: string) =>
        stepName === 'advisor_implement' ? 'advisor-session-123' : undefined,
    });

    // When
    const options = builder.buildAgentOptions(step);

    // Then: model is sonnet (step's own), not opus (engine/advisor's)
    expect(options.sessionId).toBe('advisor-session-123');
    expect(options.resolvedModel).toBe('sonnet');
  });
});
