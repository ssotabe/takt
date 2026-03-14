/**
 * Schema validation tests for piece_call movement type.
 *
 * Covers:
 * - kind/call field validation in PieceMovementRawSchema
 * - Mutual exclusivity with parallel/arpeggio/team_leader
 * - piece_call requires call field
 * - piece_call forbids persona/instruction/edit/parallel/arpeggio/team_leader
 * - Backward compatibility: call without kind inferred as piece_call
 * - PieceConfigRawSchema: subpiece field
 * - Overrides validation
 * - ParallelSubMovementRawSchema: kind/call/overrides
 */

import { describe, it, expect } from 'vitest';
import { PieceMovementRawSchema, PieceConfigRawSchema } from '../core/models/schemas.js';

// ─── Helpers ───

function makeRawMovement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-movement',
    ...overrides,
  };
}

function makeValidPieceCallMovement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'deploy-task',
    kind: 'piece_call',
    call: 'default',
    rules: [{ condition: 'completed', next: 'COMPLETE' }],
    ...overrides,
  };
}

function makeRawConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'test-piece',
    movements: [
      {
        name: 'step1',
        persona: 'coder',
        instruction: 'Do something',
        rules: [{ condition: 'done', next: 'COMPLETE' }],
      },
    ],
    ...overrides,
  };
}

// ─── kind field validation ───

describe('PieceMovementRawSchema: kind field', () => {
  it('should accept kind: agent', () => {
    const raw = makeRawMovement({
      kind: 'agent',
      persona: 'coder',
      instruction: 'Do something',
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept kind: piece_call with call field', () => {
    const raw = makeValidPieceCallMovement();

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept omitted kind (defaults to agent behavior)', () => {
    const raw = makeRawMovement({
      persona: 'coder',
      instruction: 'Do something',
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should reject invalid kind value', () => {
    const raw = makeRawMovement({
      kind: 'invalid_kind',
      call: 'default',
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });
});

// ─── piece_call requires call field ───

describe('PieceMovementRawSchema: piece_call + call validation', () => {
  it('should reject piece_call without call field', () => {
    const raw = makeRawMovement({
      kind: 'piece_call',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should reject piece_call with empty call string', () => {
    const raw = makeRawMovement({
      kind: 'piece_call',
      call: '',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should accept piece_call with valid call string', () => {
    const raw = makeValidPieceCallMovement({ call: 'my-custom-piece' });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept piece_call with namespaced call identifier', () => {
    const raw = makeValidPieceCallMovement({ call: 'takt/coding' });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });
});

// ─── piece_call mutual exclusivity with other movement types ───

describe('PieceMovementRawSchema: piece_call mutual exclusivity', () => {
  it('should reject piece_call with parallel', () => {
    const raw = makeValidPieceCallMovement({
      parallel: [
        { name: 'sub1', instruction: 'Do' },
      ],
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should reject piece_call with arpeggio', () => {
    const raw = makeValidPieceCallMovement({
      arpeggio: {
        source: 'csv',
        source_path: './data.csv',
        template: './template.txt',
      },
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should reject piece_call with team_leader', () => {
    const raw = makeValidPieceCallMovement({
      team_leader: { max_parts: 3 },
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });
});

// ─── piece_call forbids agent-specific fields ───

describe('PieceMovementRawSchema: piece_call forbidden fields', () => {
  it('should reject piece_call with persona', () => {
    const raw = makeValidPieceCallMovement({ persona: 'coder' });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should reject piece_call with instruction', () => {
    const raw = makeValidPieceCallMovement({ instruction: 'Do something' });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should reject piece_call with edit', () => {
    const raw = makeValidPieceCallMovement({ edit: true });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });

  it('should reject piece_call with instruction_template', () => {
    const raw = makeValidPieceCallMovement({ instruction_template: 'template.md' });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });
});

// ─── Backward compatibility: call without kind ───

describe('PieceMovementRawSchema: backward compatibility', () => {
  it('should accept call field without explicit kind (inferred as piece_call)', () => {
    const raw = makeRawMovement({
      call: 'default',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should reject call without kind when persona is also set', () => {
    const raw = makeRawMovement({
      call: 'default',
      persona: 'coder',
      rules: [{ condition: 'done', next: 'COMPLETE' }],
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });
});

// ─── call field on non-piece_call movement ───

describe('PieceMovementRawSchema: call field restrictions', () => {
  it('should reject call field on kind: agent', () => {
    const raw = makeRawMovement({
      kind: 'agent',
      call: 'default',
      persona: 'coder',
      instruction: 'Do something',
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });
});

// ─── PieceConfigRawSchema: subpiece field ───

describe('PieceConfigRawSchema: subpiece field', () => {
  it('should accept config with subpiece.callable: true', () => {
    const raw = makeRawConfig({
      subpiece: { callable: true },
    });

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept config with subpiece.callable: false', () => {
    const raw = makeRawConfig({
      subpiece: { callable: false },
    });

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept config without subpiece field', () => {
    const raw = makeRawConfig();

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should reject subpiece without callable field', () => {
    const raw = makeRawConfig({
      subpiece: {},
    });

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });
});

// ─── piece_call with overrides ───

describe('PieceMovementRawSchema: piece_call overrides', () => {
  it('should accept piece_call with provider override', () => {
    const raw = makeValidPieceCallMovement({
      overrides: {
        provider: 'claude',
        model: 'opus',
      },
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept piece_call with provider_options override', () => {
    const raw = makeValidPieceCallMovement({
      overrides: {
        provider_options: {
          codex: { network_access: true },
        },
      },
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept piece_call with model-only override', () => {
    const raw = makeValidPieceCallMovement({
      overrides: {
        model: 'sonnet',
      },
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept piece_call without overrides', () => {
    const raw = makeValidPieceCallMovement();

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should reject overrides on non-piece_call movement', () => {
    const raw = makeRawMovement({
      kind: 'agent',
      persona: 'coder',
      instruction: 'Do something',
      overrides: { provider: 'claude' },
    });

    const result = PieceMovementRawSchema.safeParse(raw);

    expect(result.success).toBe(false);
  });
});

// ─── piece_call in PieceConfigRawSchema movements array ───

describe('PieceConfigRawSchema: piece_call movements', () => {
  it('should accept config with piece_call movement', () => {
    const raw = makeRawConfig({
      movements: [
        {
          name: 'plan',
          persona: 'planner',
          instruction: 'Plan the task',
          rules: [{ condition: 'ready', next: 'execute' }],
        },
        {
          name: 'execute',
          kind: 'piece_call',
          call: 'default',
          rules: [
            { condition: 'completed', next: 'COMPLETE' },
            { condition: 'failed', next: 'ABORT' },
          ],
        },
      ],
      initial_movement: 'plan',
    });

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept config with multiple piece_call movements', () => {
    const raw = makeRawConfig({
      movements: [
        {
          name: 'task_1',
          kind: 'piece_call',
          call: 'default',
          rules: [
            { condition: 'completed', next: 'task_2' },
            { condition: 'failed', next: 'ABORT' },
          ],
        },
        {
          name: 'task_2',
          kind: 'piece_call',
          call: 'default',
          rules: [
            { condition: 'completed', next: 'COMPLETE' },
            { condition: 'failed', next: 'ABORT' },
          ],
        },
      ],
      initial_movement: 'task_1',
    });

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });

  it('should accept config with piece_call in parallel sub-movement', () => {
    const raw = makeRawConfig({
      movements: [
        {
          name: 'execute_batch',
          parallel: [
            {
              name: 'slot_1',
              kind: 'piece_call',
              call: 'default',
              rules: [
                { condition: 'completed' },
                { condition: 'no_task' },
              ],
            },
            {
              name: 'slot_2',
              kind: 'piece_call',
              call: 'default',
              rules: [
                { condition: 'completed' },
                { condition: 'no_task' },
              ],
            },
          ],
          rules: [{ condition: 'all completed', next: 'COMPLETE' }],
        },
      ],
    });

    const result = PieceConfigRawSchema.safeParse(raw);

    expect(result.success).toBe(true);
  });
});
