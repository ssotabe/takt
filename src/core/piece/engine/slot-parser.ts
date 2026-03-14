/**
 * Parses decompose output into per-slot instruction sections.
 *
 * Only `## {slotName}` headers matching the provided slot names
 * are treated as section boundaries. Other `##` headers (e.g. `## Background`)
 * are included as part of the preceding slot's content.
 */

const NO_TASK_MARKER = 'タスクなし';

export function parseSlotSections(
  content: string,
  slotNames: string[],
): Map<string, string> {
  if (slotNames.length === 0) {
    throw new Error('slotNames must not be empty');
  }

  const slotPositions: { name: string; headerEnd: number }[] = [];
  const missingSlots: string[] = [];

  for (const name of slotNames) {
    const pattern = new RegExp(`^## ${escapeRegExp(name)}$`, 'm');
    const match = pattern.exec(content);
    if (!match) {
      missingSlots.push(name);
      continue;
    }
    slotPositions.push({
      name,
      headerEnd: match.index + match[0].length,
    });
  }

  if (missingSlots.length > 0) {
    throw new Error(
      `Missing slot headers: ${missingSlots.join(', ')}`,
    );
  }

  slotPositions.sort((a, b) => a.headerEnd - b.headerEnd);

  const result = new Map<string, string>();

  for (let i = 0; i < slotPositions.length; i++) {
    const current = slotPositions[i]!;
    const next = slotPositions[i + 1];

    const contentStart = current.headerEnd;

    const rawContent = next
      ? content.slice(contentStart, findLineStart(content, next.headerEnd))
      : content.slice(contentStart);

    const trimmed = rawContent.trim();
    result.set(current.name, trimmed === NO_TASK_MARKER ? '' : trimmed);
  }

  return result;
}

function findLineStart(text: string, posInLine: number): number {
  let pos = posInLine;
  while (pos > 0 && text[pos - 1] !== '\n') {
    pos--;
  }
  return pos;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
