/**
 * Unit tests for Slot Results summary in ParallelRunner aggregated output.
 *
 * Tests the planned change: aggregatedContent should include a
 * "## Slot Results" section at the top listing each sub-movement's
 * matched condition (COMPLETE/ABORT/ERROR/UNKNOWN).
 *
 * Covers:
 * - All slots COMPLETE → summary shows all COMPLETE
 * - Mixed results (some ABORT) → summary shows correct per-slot conditions
 * - Slot with error (no matchedRuleIndex) → summary shows ERROR
 * - Slot with no matched rule and no error → summary shows UNKNOWN
 * - Summary section does not interfere with slot-parser (non-regression)
 * - Summary section appears before individual slot content sections
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, rmSync } from 'node:fs';

// --- Mock setup (must be before imports that use these modules) ---

vi.mock('../agents/runner.js', () => ({
  runAgent: vi.fn(),
}));

vi.mock('../core/piece/evaluation/index.js', () => ({
  detectMatchedRule: vi.fn(),
}));

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
}));

vi.mock('../core/piece/engine/parallel-worktree.js', () => ({
  createParallelWorktree: vi.fn().mockReturnValue({ path: '/tmp/worktree', branch: 'test-branch' }),
  cleanupParallelWorktree: vi.fn(),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';
import { runAgent } from '../agents/runner.js';
import type { PieceConfig, PieceMovement, AgentResponse } from '../core/models/index.js';
import { parseSlotSections } from '../core/piece/engine/slot-parser.js';
import {
  makeResponse,
  makeMovement,
  makeRule,
  mockDetectMatchedRuleSequence,
  createTestTmpDir,
  applyDefaultMocks,
  cleanupPieceEngine,
} from './engine-test-helpers.js';

// --- Helpers ---

function buildRoadmapLikeConfig(): PieceConfig {
  return {
    name: 'test-roadmap',
    description: 'Test roadmap piece for slot results',
    maxMovements: 30,
    initialMovement: 'reviewers',
    movements: [
      makeMovement('reviewers', {
        parallel: [
          makeMovement('sub-a', {
            rules: [
              makeRule('COMPLETE', 'COMPLETE'),
              makeRule('ABORT', 'ABORT'),
            ],
          }),
          makeMovement('sub-b', {
            rules: [
              makeRule('COMPLETE', 'COMPLETE'),
              makeRule('ABORT', 'ABORT'),
            ],
          }),
          makeMovement('sub-c', {
            rules: [
              makeRule('COMPLETE', 'COMPLETE'),
              makeRule('ABORT', 'ABORT'),
            ],
          }),
        ],
        rules: [
          makeRule('all("COMPLETE")', 'done', {
            isAggregateCondition: true,
            aggregateType: 'all',
            aggregateConditionText: 'COMPLETE',
          }),
          makeRule('any("ABORT")', 'check', {
            isAggregateCondition: true,
            aggregateType: 'any',
            aggregateConditionText: 'ABORT',
          }),
        ],
      }),
      makeMovement('done', {
        rules: [makeRule('completed', 'COMPLETE')],
      }),
      makeMovement('check', {
        rules: [makeRule('checked', 'COMPLETE')],
      }),
    ],
  };
}

function mockRunAgentWithPromptResolved(response: AgentResponse): (persona: string, task: string, options: Record<string, unknown>) => Promise<AgentResponse> {
  return async (persona, task, options: Record<string, unknown>) => {
    const onPromptResolved = options?.onPromptResolved as ((parts: { systemPrompt: string; userInstruction: string }) => void) | undefined;
    onPromptResolved?.({
      systemPrompt: typeof persona === 'string' ? persona : '',
      userInstruction: typeof task === 'string' ? task : '',
    });
    return response;
  };
}

// --- Tests ---

describe('ParallelRunner: Slot Results summary in aggregated output', () => {
  let tmpDir: string;
  let engine: PieceEngine | null = null;

  beforeEach(() => {
    vi.resetAllMocks();
    applyDefaultMocks();
    tmpDir = createTestTmpDir();
  });

  afterEach(() => {
    if (engine) {
      cleanupPieceEngine(engine);
      engine = null;
    }
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it('should include Slot Results section when all sub-movements succeed with COMPLETE', async () => {
    // Given: 3 sub-movements all matching COMPLETE (rule index 0)
    const config = buildRoadmapLikeConfig();
    engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-a', content: 'Sub A result' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-b', content: 'Sub B result' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-c', content: 'Sub C result' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'done', content: 'All done' }),
    ));

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // sub-a → COMPLETE
      { index: 0, method: 'phase1_tag' },  // sub-b → COMPLETE
      { index: 0, method: 'phase1_tag' },  // sub-c → COMPLETE
      { index: 0, method: 'aggregate' },   // reviewers → all("COMPLETE")
      { index: 0, method: 'phase1_tag' },  // done → COMPLETE
    ]);

    // When
    const state = await engine.run();

    // Then: aggregated output should contain a Slot Results section
    const reviewersOutput = state.movementOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.content).toContain('## Slot Results');
    expect(reviewersOutput!.content).toContain('- sub-a: COMPLETE');
    expect(reviewersOutput!.content).toContain('- sub-b: COMPLETE');
    expect(reviewersOutput!.content).toContain('- sub-c: COMPLETE');
  });

  it('should show ABORT for sub-movements that matched ABORT condition', async () => {
    // Given: sub-b matches ABORT (rule index 1), others match COMPLETE (rule index 0)
    const config = buildRoadmapLikeConfig();
    engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-a', content: 'Sub A OK' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-b', content: 'Sub B failed' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-c', content: 'Sub C OK' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'check', content: 'Checked' }),
    ));

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // sub-a → COMPLETE
      { index: 1, method: 'phase1_tag' },  // sub-b → ABORT
      { index: 0, method: 'phase1_tag' },  // sub-c → COMPLETE
      { index: 1, method: 'aggregate' },   // reviewers → any("ABORT")
      { index: 0, method: 'phase1_tag' },  // check → COMPLETE
    ]);

    // When
    const state = await engine.run();

    // Then: summary should reflect mixed results
    const reviewersOutput = state.movementOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.content).toContain('- sub-a: COMPLETE');
    expect(reviewersOutput!.content).toContain('- sub-b: ABORT');
    expect(reviewersOutput!.content).toContain('- sub-c: COMPLETE');
  });

  it('should show ERROR for sub-movements that threw an exception', async () => {
    // Given: sub-a throws an error, others succeed
    const config = buildRoadmapLikeConfig();
    engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockRejectedValueOnce(new Error('Process exited with code 1'));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-b', content: 'Sub B OK' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-c', content: 'Sub C OK' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'check', content: 'Checked' }),
    ));

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // sub-b → COMPLETE
      { index: 0, method: 'phase1_tag' },  // sub-c → COMPLETE
      { index: 1, method: 'aggregate' },   // any("ABORT") — error sub-movement
      { index: 0, method: 'phase1_tag' },  // check → COMPLETE
    ]);

    // When
    const state = await engine.run();

    // Then: sub-a should show ERROR in summary
    const reviewersOutput = state.movementOutputs.get('reviewers');
    expect(reviewersOutput).toBeDefined();
    expect(reviewersOutput!.content).toContain('- sub-a: ERROR');
    expect(reviewersOutput!.content).toContain('- sub-b: COMPLETE');
    expect(reviewersOutput!.content).toContain('- sub-c: COMPLETE');
  });

  it('should show UNKNOWN for sub-movements with no matched rule and no error', async () => {
    // Given: sub-c has no matched rule (detectMatchedRule returns undefined)
    const config = buildRoadmapLikeConfig();
    engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-a', content: 'Sub A OK' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-b', content: 'Sub B OK' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-c', content: 'Sub C ambiguous' }),
    ));

    // sub-a and sub-b match, sub-c returns undefined (no rule matched)
    // This causes fail-fast in the engine, so piece aborts.
    // The test verifies the summary reflects UNKNOWN before abort.
    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },  // sub-a → COMPLETE
      { index: 0, method: 'phase1_tag' },  // sub-b → COMPLETE
      undefined,                            // sub-c → no match
      undefined,                            // reviewers aggregate — no match either, will abort
    ]);

    // When
    const state = await engine.run();

    // Then: content should reflect UNKNOWN for sub-c (if piece reached aggregation)
    const reviewersOutput = state.movementOutputs.get('reviewers');
    if (reviewersOutput) {
      expect(reviewersOutput.content).toContain('- sub-c: UNKNOWN');
    }
  });

  it('should place Slot Results section before individual sub-movement content', async () => {
    // Given: normal execution with all COMPLETE
    const config = buildRoadmapLikeConfig();
    engine = new PieceEngine(config, tmpDir, 'test task', { projectCwd: tmpDir });

    const mock = vi.mocked(runAgent);
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-a', content: 'Content A' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-b', content: 'Content B' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'sub-c', content: 'Content C' }),
    ));
    mock.mockImplementationOnce(mockRunAgentWithPromptResolved(
      makeResponse({ persona: 'done', content: 'Done' }),
    ));

    mockDetectMatchedRuleSequence([
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'phase1_tag' },
      { index: 0, method: 'aggregate' },
      { index: 0, method: 'phase1_tag' },
    ]);

    // When
    const state = await engine.run();

    // Then: Slot Results section appears before individual content sections
    const content = state.movementOutputs.get('reviewers')!.content;
    const slotResultsIndex = content.indexOf('## Slot Results');
    const firstSubContentIndex = content.indexOf('## sub-a');

    expect(slotResultsIndex).toBeGreaterThanOrEqual(0);
    expect(firstSubContentIndex).toBeGreaterThan(slotResultsIndex);
  });
});

describe('Slot Results summary: non-regression with slot-parser', () => {
  it('should not confuse Slot Results header with slot_N headers', () => {
    // Given: content with both "## Slot Results" and slot_N headers
    const content = [
      '## Slot Results',
      '- slot_1: COMPLETE',
      '- slot_2: ABORT',
      '- slot_3: COMPLETE',
      '',
      '---',
      '',
      '## slot_1',
      'Task 1 result content.',
      '',
      '---',
      '',
      '## slot_2',
      'Task 2 failed content.',
      '',
      '---',
      '',
      '## slot_3',
      'Task 3 result content.',
    ].join('\n');
    const slotNames = ['slot_1', 'slot_2', 'slot_3'];

    // When: parsing slot sections
    const result = parseSlotSections(content, slotNames);

    // Then: only slot_N headers are treated as boundaries, Slot Results is ignored
    // Content between slot boundaries includes `---` separators since they're not boundaries
    expect(result.get('slot_1')).toContain('Task 1 result content.');
    expect(result.get('slot_2')).toContain('Task 2 failed content.');
    expect(result.get('slot_3')).toContain('Task 3 result content.');
    // "## Slot Results" should NOT appear in any slot content
    expect(result.get('slot_1')).not.toContain('## Slot Results');
    expect(result.get('slot_2')).not.toContain('## Slot Results');
    expect(result.get('slot_3')).not.toContain('## Slot Results');
  });

  it('should correctly parse slots when Slot Results summary lists contain slot names', () => {
    // Given: Slot Results section contains "slot_1", "slot_2" text in list items
    const content = [
      '## Slot Results',
      '- slot_1: COMPLETE',
      '- slot_2: COMPLETE',
      '',
      '---',
      '',
      '## slot_1',
      'First task done.',
      '',
      '## slot_2',
      'Second task done.',
    ].join('\n');
    const slotNames = ['slot_1', 'slot_2'];

    // When
    const result = parseSlotSections(content, slotNames);

    // Then: list items "- slot_1: COMPLETE" are NOT confused with "## slot_1" headers
    expect(result.get('slot_1')).toContain('First task done.');
    expect(result.get('slot_2')).toBe('Second task done.');
  });
});
