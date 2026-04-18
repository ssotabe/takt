/**
 * Unit tests for slot-context module.
 *
 * Tests prepareSlotContext: detecting slot_N naming pattern among
 * workflow_call sub-steps, parsing per-slot instructions, creating
 * worktrees, and building WorkflowCallSlotOverrides.
 *
 * Mocked: slot-parser (parseSlotSections), parallel-worktree (createParallelWorktree)
 * Not mocked: prepareSlotContext logic
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { WorkflowStep, WorkflowState, AgentResponse } from '../core/models/types.js';

// --- Hoisted mocks ---

const { mockParseSlotSections, mockCreateParallelWorktree } = vi.hoisted(() => ({
  mockParseSlotSections: vi.fn(),
  mockCreateParallelWorktree: vi.fn(),
}));

vi.mock('../core/workflow/engine/slot-parser.js', () => ({
  parseSlotSections: mockParseSlotSections,
}));

vi.mock('../core/workflow/engine/parallel-worktree.js', () => ({
  createParallelWorktree: mockCreateParallelWorktree,
}));

vi.mock('../shared/utils/index.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

// --- Imports (after mocks) ---

import { prepareSlotContext } from '../core/workflow/engine/slot-context.js';

// --- Test helpers ---

function makeWorkflowCallStep(name: string): WorkflowStep {
  return {
    kind: 'workflow_call' as const,
    name,
    call: 'some-workflow',
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: false,
  };
}

function makeAgentStep(name: string): WorkflowStep {
  return {
    name,
    personaDisplayName: name,
    instruction: '',
    passPreviousResponse: false,
  };
}

function makeState(lastOutputContent: string): WorkflowState {
  return {
    workflowName: 'test',
    currentStep: 'parallel-step',
    iteration: 1,
    stepOutputs: new Map(),
    structuredOutputs: new Map(),
    systemContexts: new Map(),
    effectResults: new Map(),
    lastOutput: {
      persona: 'test',
      status: 'done',
      content: lastOutputContent,
      timestamp: new Date(),
    },
    userInputs: [],
    personaSessions: new Map(),
    stepIterations: new Map(),
    status: 'running',
  };
}

describe('prepareSlotContext', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  describe('slot pattern detection', () => {
    it('should return undefined when no sub-steps have slot_N naming', () => {
      // Given
      const subSteps = [makeWorkflowCallStep('review'), makeWorkflowCallStep('fix')];
      const state = makeState('some content');

      // When
      const result = prepareSlotContext(subSteps, state, 'parent', '/project');

      // Then
      expect(result).toBeUndefined();
      expect(mockParseSlotSections).not.toHaveBeenCalled();
    });

    it('should return undefined when only some workflow_call steps match slot_N', () => {
      // Given: mixed naming — slot_1 matches but "review" does not
      const subSteps = [
        makeWorkflowCallStep('slot_1'),
        makeWorkflowCallStep('review'),
      ];
      const state = makeState('content');

      // When
      const result = prepareSlotContext(subSteps, state, 'parent', '/project');

      // Then
      expect(result).toBeUndefined();
    });

    it('should return undefined when sub-steps are agent kind, not workflow_call', () => {
      // Given: agent steps with slot_N names are not workflow_call
      const subSteps = [makeAgentStep('slot_1'), makeAgentStep('slot_2')];
      const state = makeState('content');

      // When
      const result = prepareSlotContext(subSteps, state, 'parent', '/project');

      // Then
      expect(result).toBeUndefined();
    });
  });

  describe('slot context preparation', () => {
    it('should create overrides and worktrees for each non-empty slot', () => {
      // Given
      const subSteps = [
        makeWorkflowCallStep('slot_1'),
        makeWorkflowCallStep('slot_2'),
      ];
      const state = makeState('## slot_1\nTask A\n\n## slot_2\nTask B');

      mockParseSlotSections.mockReturnValue(
        new Map([
          ['slot_1', 'Task A'],
          ['slot_2', 'Task B'],
        ]),
      );
      mockCreateParallelWorktree
        .mockReturnValueOnce({ path: '/worktree/slot-1', branch: 'slot-1-branch' })
        .mockReturnValueOnce({ path: '/worktree/slot-2', branch: 'slot-2-branch' });

      // When
      const result = prepareSlotContext(subSteps, state, 'parent-slug', '/project');

      // Then
      expect(result).toBeDefined();
      expect(result!.overrides.size).toBe(2);
      expect(result!.worktrees.size).toBe(2);

      const override1 = result!.overrides.get('slot_1')!;
      expect(override1.cwd).toBe('/worktree/slot-1');
      expect(override1.reportDirName).toBe('parent-slug-slot-1');
      expect(override1.initialPreviousResponse.content).toBe('Task A');
      expect(override1.initialPreviousResponse.status).toBe('done');

      const override2 = result!.overrides.get('slot_2')!;
      expect(override2.cwd).toBe('/worktree/slot-2');
      expect(override2.reportDirName).toBe('parent-slug-slot-2');
    });

    it('should skip empty slots without creating worktrees', () => {
      // Given
      const subSteps = [
        makeWorkflowCallStep('slot_1'),
        makeWorkflowCallStep('slot_2'),
      ];
      const state = makeState('content');

      mockParseSlotSections.mockReturnValue(
        new Map([
          ['slot_1', 'Task A'],
          ['slot_2', ''],  // empty → タスクなし
        ]),
      );
      mockCreateParallelWorktree.mockReturnValue({
        path: '/worktree/slot-1',
        branch: 'slot-1-branch',
      });

      // When
      const result = prepareSlotContext(subSteps, state, 'parent', '/project');

      // Then
      expect(result).toBeDefined();
      expect(result!.overrides.size).toBe(1);
      expect(result!.overrides.has('slot_1')).toBe(true);
      expect(result!.overrides.has('slot_2')).toBe(false);
      expect(result!.worktrees.size).toBe(1);
      expect(mockCreateParallelWorktree).toHaveBeenCalledTimes(1);
    });

    it('should pass projectCwd and slotName to createParallelWorktree', () => {
      // Given
      const subSteps = [makeWorkflowCallStep('slot_1')];
      const state = makeState('content');

      mockParseSlotSections.mockReturnValue(new Map([['slot_1', 'Task']]));
      mockCreateParallelWorktree.mockReturnValue({
        path: '/worktree/slot-1',
        branch: 'branch',
      });

      // When
      prepareSlotContext(subSteps, state, 'parent', '/project/dir');

      // Then
      expect(mockCreateParallelWorktree).toHaveBeenCalledWith('/project/dir', 'slot_1');
    });

    it('should use lastOutput content from state for parsing', () => {
      // Given
      const subSteps = [makeWorkflowCallStep('slot_1')];
      const previousContent = '## slot_1\nParsed instructions';
      const state = makeState(previousContent);

      mockParseSlotSections.mockReturnValue(new Map([['slot_1', 'Parsed instructions']]));
      mockCreateParallelWorktree.mockReturnValue({
        path: '/wt',
        branch: 'b',
      });

      // When
      prepareSlotContext(subSteps, state, 'parent', '/project');

      // Then
      expect(mockParseSlotSections).toHaveBeenCalledWith(
        previousContent,
        ['slot_1'],
      );
    });

    it('should use empty string when lastOutput is undefined', () => {
      // Given
      const subSteps = [makeWorkflowCallStep('slot_1')];
      const state: WorkflowState = {
        workflowName: 'test',
        currentStep: 'step',
        iteration: 1,
        stepOutputs: new Map(),
        structuredOutputs: new Map(),
        systemContexts: new Map(),
        effectResults: new Map(),
        lastOutput: undefined,
        userInputs: [],
        personaSessions: new Map(),
        stepIterations: new Map(),
        status: 'running',
      };

      mockParseSlotSections.mockReturnValue(new Map([['slot_1', 'content']]));
      mockCreateParallelWorktree.mockReturnValue({ path: '/wt', branch: 'b' });

      // When
      prepareSlotContext(subSteps, state, 'parent', '/project');

      // Then
      expect(mockParseSlotSections).toHaveBeenCalledWith('', ['slot_1']);
    });
  });

  describe('reportDirName formatting', () => {
    it('should replace underscores with hyphens in slot name for reportDirName', () => {
      // Given
      const subSteps = [makeWorkflowCallStep('slot_1')];
      const state = makeState('content');

      mockParseSlotSections.mockReturnValue(new Map([['slot_1', 'Task']]));
      mockCreateParallelWorktree.mockReturnValue({ path: '/wt', branch: 'b' });

      // When
      const result = prepareSlotContext(subSteps, state, 'my-parent', '/project');

      // Then
      expect(result!.overrides.get('slot_1')!.reportDirName).toBe('my-parent-slot-1');
    });
  });
});
