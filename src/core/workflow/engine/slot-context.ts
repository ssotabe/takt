/**
 * Prepares slot-specific overrides for parallel workflow_call sub-steps.
 *
 * Detects slot_N naming pattern, parses per-slot instructions from
 * the previous response, creates worktrees, and builds WorkflowCallSlotOverrides.
 */

import type { WorkflowStep, WorkflowState, AgentResponse } from '../../models/types.js';
import { parseSlotSections } from './slot-parser.js';
import { createParallelWorktree } from './parallel-worktree.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('slot-context');

export interface WorkflowCallSlotOverrides {
  readonly initialPreviousResponse: AgentResponse;
  readonly reportDirName?: string;
  readonly cwd?: string;
}

export interface SlotContext {
  overrides: Map<string, WorkflowCallSlotOverrides>;
  worktrees: Map<string, { path: string; branch: string }>;
}

/**
 * Detect slot_N naming pattern among workflow_call sub-steps and prepare
 * slot-specific overrides (parsed instructions, worktrees, reportDirNames).
 */
export function prepareSlotContext(
  subSteps: readonly WorkflowStep[],
  state: WorkflowState,
  parentSlug: string,
  projectCwd: string,
): SlotContext | undefined {
  const SLOT_PATTERN = /^slot_\d+$/;
  const workflowCallSlots = subSteps.filter(
    (s) => s.kind === 'workflow_call' && SLOT_PATTERN.test(s.name),
  );

  if (workflowCallSlots.length === 0) return undefined;
  const allWorkflowCalls = subSteps.filter((s) => s.kind === 'workflow_call');
  if (workflowCallSlots.length !== allWorkflowCalls.length) return undefined;

  const slotNames = workflowCallSlots.map((s) => s.name);
  log.debug('Detected slot pattern', { slotNames });
  const previousContent = state.lastOutput?.content ?? '';

  const slotSections = parseSlotSections(previousContent, slotNames);

  const overrides = new Map<string, WorkflowCallSlotOverrides>();
  const worktrees = new Map<string, { path: string; branch: string }>();

  for (const slotName of slotNames) {
    const slotContent = slotSections.get(slotName)!;
    if (slotContent === '') {
      log.debug('Skipping empty slot', { slotName });
      continue;
    }
    const worktreeInfo = createParallelWorktree(projectCwd, slotName);
    worktrees.set(slotName, worktreeInfo);

    const slotResponse: AgentResponse = {
      persona: slotName,
      status: 'done',
      content: slotContent,
      timestamp: new Date(),
    };

    overrides.set(slotName, {
      initialPreviousResponse: slotResponse,
      reportDirName: `${parentSlug}-${slotName.replace(/_/g, '-')}`,
      cwd: worktreeInfo.path,
    });
  }

  log.debug('Prepared slot context', { slotCount: slotNames.length });
  return { overrides, worktrees };
}
