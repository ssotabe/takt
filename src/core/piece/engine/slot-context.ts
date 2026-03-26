/**
 * Prepares slot-specific overrides for parallel piece_call sub-movements.
 *
 * Detects slot_N naming pattern, parses per-slot instructions from
 * the previous response, creates worktrees, and builds PieceCallSlotOverrides.
 */

import type { PieceMovement, PieceState, AgentResponse } from '../../models/types.js';
import type { PieceCallSlotOverrides } from './PieceCallRunner.js';
import { parseSlotSections } from './slot-parser.js';
import { createParallelWorktree } from './parallel-worktree.js';
import { createLogger } from '../../../shared/utils/index.js';

const log = createLogger('slot-context');

export interface SlotContext {
  overrides: Map<string, PieceCallSlotOverrides>;
  worktrees: Map<string, { path: string; branch: string }>;
}

/**
 * Detect slot_N naming pattern among piece_call sub-movements and prepare
 * slot-specific overrides (parsed instructions, worktrees, reportDirNames).
 */
export function prepareSlotContext(
  subMovements: readonly PieceMovement[],
  state: PieceState,
  parentSlug: string,
  projectCwd: string,
): SlotContext | undefined {
  const SLOT_PATTERN = /^slot_\d+$/;
  const pieceCallSlots = subMovements.filter(
    (m) => m.kind === 'piece_call' && SLOT_PATTERN.test(m.name),
  );

  if (pieceCallSlots.length === 0) return undefined;
  const allPieceCalls = subMovements.filter((m) => m.kind === 'piece_call');
  if (pieceCallSlots.length !== allPieceCalls.length) return undefined;

  const slotNames = pieceCallSlots.map((m) => m.name);
  log.debug('Detected slot pattern', { slotNames });
  const previousContent = state.lastOutput?.content ?? '';

  const slotSections = parseSlotSections(previousContent, slotNames);

  const overrides = new Map<string, PieceCallSlotOverrides>();
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
