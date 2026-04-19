/**
 * Unit tests for WorkflowState.stepSessions and StateManager integration.
 *
 * Tests that stepSessions (stepName → sessionId mapping) is properly
 * initialized in WorkflowState and can be used for resume-based session lookup.
 */

import { describe, it, expect } from 'vitest';
import {
  StateManager,
  createInitialState,
} from '../core/workflow/engine/state-manager.js';
import type { WorkflowConfig } from '../core/models/types.js';
import type { WorkflowEngineOptions } from '../core/workflow/types.js';

function makeConfig(overrides: Partial<WorkflowConfig> = {}): WorkflowConfig {
  return {
    name: 'test-workflow',
    steps: [],
    initialStep: 'start',
    maxSteps: 10,
    ...overrides,
  };
}

function makeOptions(overrides: Partial<WorkflowEngineOptions> = {}): WorkflowEngineOptions {
  return {
    projectCwd: '/tmp/project',
    ...overrides,
  };
}

describe('StateManager — stepSessions', () => {
  it('should initialize stepSessions as an empty Map', () => {
    const manager = new StateManager(makeConfig(), makeOptions());

    expect(manager.state.stepSessions).toBeInstanceOf(Map);
    expect(manager.state.stepSessions.size).toBe(0);
  });

  it('should store and retrieve session by step name', () => {
    const manager = new StateManager(makeConfig(), makeOptions());

    manager.state.stepSessions.set('implement', 'session-123');

    expect(manager.state.stepSessions.get('implement')).toBe('session-123');
  });

  it('should return undefined for unknown step name', () => {
    const manager = new StateManager(makeConfig(), makeOptions());

    expect(manager.state.stepSessions.get('nonexistent')).toBeUndefined();
  });

  it('should allow updating an existing step session', () => {
    const manager = new StateManager(makeConfig(), makeOptions());

    manager.state.stepSessions.set('implement', 'session-v1');
    manager.state.stepSessions.set('implement', 'session-v2');

    expect(manager.state.stepSessions.get('implement')).toBe('session-v2');
  });

  it('should track sessions for multiple steps independently', () => {
    const manager = new StateManager(makeConfig(), makeOptions());

    manager.state.stepSessions.set('plan', 'plan-session');
    manager.state.stepSessions.set('implement', 'implement-session');
    manager.state.stepSessions.set('advisor_implement', 'advisor-session');

    expect(manager.state.stepSessions.get('plan')).toBe('plan-session');
    expect(manager.state.stepSessions.get('implement')).toBe('implement-session');
    expect(manager.state.stepSessions.get('advisor_implement')).toBe('advisor-session');
  });
});

describe('createInitialState — stepSessions', () => {
  it('should include stepSessions as empty Map in initial state', () => {
    const state = createInitialState(makeConfig(), makeOptions());

    expect(state.stepSessions).toBeInstanceOf(Map);
    expect(state.stepSessions.size).toBe(0);
  });
});
