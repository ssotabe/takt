/**
 * pieceParser normalization tests for piece_call movement type.
 *
 * Covers:
 * - normalizeStepFromRaw: kind/call/overrides normalization
 * - Backward compatibility: call without kind → kind = 'piece_call'
 * - piece_call instruction defaults to empty string
 * - overrides provider/model/provider_options normalization
 * - normalizePieceConfig: subpiece field pass-through
 * - parallel sub-movement kind/call normalization
 */

import { describe, it, expect } from 'vitest';
import { normalizePieceConfig } from '../infra/config/loaders/pieceParser.js';
import type { PieceMovement } from '../core/models/index.js';

// ─── Helpers ───

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

function makePieceCallRawMovement(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'call-step',
    kind: 'piece_call',
    call: 'default',
    rules: [
      { condition: 'completed', next: 'COMPLETE' },
      { condition: 'failed', next: 'ABORT' },
    ],
    ...overrides,
  };
}

// ─── kind/call normalization ───

describe('pieceParser: piece_call kind/call normalization', () => {
  it('should normalize kind: piece_call and call field to PieceMovement', () => {
    const raw = makeRawConfig({
      movements: [
        makePieceCallRawMovement(),
      ],
    });

    const config = normalizePieceConfig(raw, process.cwd());
    const movement = config.movements[0]!;

    expect((movement as Record<string, unknown>).kind).toBe('piece_call');
    expect((movement as Record<string, unknown>).call).toBe('default');
  });

  it('should infer kind as piece_call when call is present without kind', () => {
    const raw = makeRawConfig({
      movements: [
        {
          name: 'implicit-call',
          call: 'default',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });

    const config = normalizePieceConfig(raw, process.cwd());
    const movement = config.movements[0]!;

    expect((movement as Record<string, unknown>).kind).toBe('piece_call');
    expect((movement as Record<string, unknown>).call).toBe('default');
  });

  it('should preserve kind: agent for normal movements', () => {
    const raw = makeRawConfig({
      movements: [
        {
          name: 'normal-step',
          kind: 'agent',
          persona: 'coder',
          instruction: 'Do something',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });

    const config = normalizePieceConfig(raw, process.cwd());
    const movement = config.movements[0]!;

    expect((movement as Record<string, unknown>).kind).toBe('agent');
    expect((movement as Record<string, unknown>).call).toBeUndefined();
  });

  it('should leave kind undefined for movements without kind or call', () => {
    const raw = makeRawConfig({
      movements: [
        {
          name: 'regular-step',
          persona: 'coder',
          instruction: 'Do something',
          rules: [{ condition: 'done', next: 'COMPLETE' }],
        },
      ],
    });

    const config = normalizePieceConfig(raw, process.cwd());
    const movement = config.movements[0]!;

    expect((movement as Record<string, unknown>).kind).toBeUndefined();
    expect((movement as Record<string, unknown>).call).toBeUndefined();
  });
});

// ─── piece_call instruction default ───

describe('pieceParser: piece_call instruction handling', () => {
  it('should set empty instruction for piece_call movement', () => {
    const raw = makeRawConfig({
      movements: [
        makePieceCallRawMovement(),
      ],
    });

    const config = normalizePieceConfig(raw, process.cwd());
    const movement = config.movements[0]!;

    // piece_call doesn't execute its own agent, so instruction should be empty
    expect(movement.instruction).toBe('');
  });
});

// ─── overrides normalization ───

describe('pieceParser: piece_call overrides normalization', () => {
  it('should normalize overrides with provider and model', () => {
    const raw = makeRawConfig({
      movements: [
        makePieceCallRawMovement({
          overrides: {
            provider: 'codex',
            model: 'gpt-5',
          },
        }),
      ],
    });

    const config = normalizePieceConfig(raw, process.cwd());
    const movement = config.movements[0]!;
    const overrides = (movement as Record<string, unknown>).overrides as Record<string, unknown>;

    expect(overrides).toBeDefined();
    expect(overrides.provider).toBe('codex');
    expect(overrides.model).toBe('gpt-5');
  });

  it('should normalize overrides with provider_options', () => {
    const raw = makeRawConfig({
      movements: [
        makePieceCallRawMovement({
          overrides: {
            provider_options: {
              codex: { network_access: true },
            },
          },
        }),
      ],
    });

    const config = normalizePieceConfig(raw, process.cwd());
    const movement = config.movements[0]!;
    const overrides = (movement as Record<string, unknown>).overrides as Record<string, unknown>;

    expect(overrides).toBeDefined();
  });

  it('should leave overrides undefined when not specified', () => {
    const raw = makeRawConfig({
      movements: [
        makePieceCallRawMovement(),
      ],
    });

    const config = normalizePieceConfig(raw, process.cwd());
    const movement = config.movements[0]!;

    expect((movement as Record<string, unknown>).overrides).toBeUndefined();
  });
});

// ─── subpiece normalization ───

describe('pieceParser: subpiece normalization', () => {
  it('should pass through subpiece.callable: true in PieceConfig', () => {
    const raw = makeRawConfig({
      subpiece: { callable: true },
    });

    const config = normalizePieceConfig(raw, process.cwd());

    expect((config as Record<string, unknown>).subpiece).toEqual({ callable: true });
  });

  it('should pass through subpiece.callable: false in PieceConfig', () => {
    const raw = makeRawConfig({
      subpiece: { callable: false },
    });

    const config = normalizePieceConfig(raw, process.cwd());

    expect((config as Record<string, unknown>).subpiece).toEqual({ callable: false });
  });

  it('should leave subpiece undefined when not specified', () => {
    const raw = makeRawConfig();

    const config = normalizePieceConfig(raw, process.cwd());

    expect((config as Record<string, unknown>).subpiece).toBeUndefined();
  });
});

// ─── parallel sub-movement piece_call normalization ───

describe('pieceParser: parallel sub-movement piece_call normalization', () => {
  it('should normalize piece_call kind/call in parallel sub-movements', () => {
    const raw = makeRawConfig({
      movements: [
        {
          name: 'batch',
          parallel: [
            {
              name: 'slot_1',
              kind: 'piece_call',
              call: 'default',
              rules: [{ condition: 'done' }],
            },
            {
              name: 'slot_2',
              kind: 'piece_call',
              call: 'default',
              rules: [{ condition: 'done' }],
            },
          ],
          rules: [{ condition: 'all done', next: 'COMPLETE' }],
        },
      ],
    });

    const config = normalizePieceConfig(raw, process.cwd());
    const batchMovement = config.movements[0]!;
    const slot1 = batchMovement.parallel![0]!;
    const slot2 = batchMovement.parallel![1]!;

    expect((slot1 as Record<string, unknown>).kind).toBe('piece_call');
    expect((slot1 as Record<string, unknown>).call).toBe('default');
    expect((slot2 as Record<string, unknown>).kind).toBe('piece_call');
    expect((slot2 as Record<string, unknown>).call).toBe('default');
  });

  it('should infer piece_call kind from call in parallel sub-movements', () => {
    const raw = makeRawConfig({
      movements: [
        {
          name: 'batch',
          parallel: [
            {
              name: 'slot_1',
              call: 'default',
              rules: [{ condition: 'done' }],
            },
          ],
          rules: [{ condition: 'all done', next: 'COMPLETE' }],
        },
      ],
    });

    const config = normalizePieceConfig(raw, process.cwd());
    const batchMovement = config.movements[0]!;
    const slot1 = batchMovement.parallel![0]!;

    expect((slot1 as Record<string, unknown>).kind).toBe('piece_call');
    expect((slot1 as Record<string, unknown>).call).toBe('default');
  });
});
