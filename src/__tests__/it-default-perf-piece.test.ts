/**
 * Integration tests for the default-perf piece.
 *
 * Tests loading, structure validation, facet resolution, roadmap integration,
 * and step transition patterns for the default-perf piece (default + perf_review movement).
 *
 * Mocked: UI, session, phase-runner, notifications, config, callAiJudge
 * Not mocked: PieceEngine, runAgent, detectMatchedRule, rule-evaluator
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setMockScenario, resetScenario } from '../infra/mock/index.js';
import { detectRuleIndex } from '../shared/utils/ruleIndex.js';
import { callAiJudge } from '../agents/ai-judge.js';

// --- Mocks ---

vi.mock('../agents/ai-judge.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../agents/ai-judge.js')>();
  return {
    ...original,
    callAiJudge: vi.fn().mockImplementation(async (content: string, conditions: { index: number; text: string }[]) => {
      for (let i = 0; i < conditions.length; i++) {
        if (content.includes(conditions[i]!.text)) {
          return i;
        }
      }
      return -1;
    }),
  };
});

vi.mock('../core/piece/phase-runner.js', () => ({
  needsStatusJudgmentPhase: vi.fn().mockReturnValue(false),
  runReportPhase: vi.fn().mockResolvedValue(undefined),
  runStatusJudgmentPhase: vi.fn().mockResolvedValue({ tag: '', ruleIndex: 0, method: 'auto_select' }),
}));

vi.mock('../shared/utils/index.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  generateReportDir: vi.fn().mockReturnValue('test-report-dir'),
  generateSessionId: vi.fn().mockReturnValue('test-session-id'),
}));

const languageState = vi.hoisted(() => ({ value: 'en' as 'en' | 'ja' }));

vi.mock('../infra/config/global/globalConfig.js', () => ({
  loadGlobalConfig: vi.fn().mockReturnValue({}),
  getLanguage: vi.fn().mockReturnValue('en'),
  getDisabledBuiltins: vi.fn().mockReturnValue([]),
  getBuiltinPiecesEnabled: vi.fn().mockReturnValue(true),
}));

vi.mock('../infra/config/project/projectConfig.js', () => ({
  loadProjectConfig: vi.fn().mockReturnValue({}),
}));

vi.mock('../infra/config/resolveConfigValue.js', () => ({
  resolveConfigValue: vi.fn((_cwd: string, key: string) => {
    if (key === 'language') return languageState.value;
    if (key === 'enableBuiltinPieces') return true;
    if (key === 'disabledBuiltins') return [];
    return undefined;
  }),
  resolveConfigValues: vi.fn((_cwd: string, keys: readonly string[]) => {
    const result: Record<string, unknown> = {};
    for (const key of keys) {
      if (key === 'language') result[key] = languageState.value;
      if (key === 'enableBuiltinPieces') result[key] = true;
      if (key === 'disabledBuiltins') result[key] = [];
    }
    return result;
  }),
}));

// --- Imports (after mocks) ---

import { PieceEngine } from '../core/piece/index.js';
import { loadPiece } from '../infra/config/index.js';
import { resolveFacetByName, type FacetResolutionContext } from '../infra/config/loaders/resource-resolver.js';
import type { PieceConfig } from '../core/models/index.js';

// --- Test helpers ---

function createTestDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'takt-it-dperf-'));
  mkdirSync(join(dir, '.takt', 'reports', 'test-report-dir'), { recursive: true });
  return dir;
}

function createEngine(config: PieceConfig, dir: string, task: string): PieceEngine {
  return new PieceEngine(config, dir, task, {
    projectCwd: dir,
    provider: 'mock',
    detectRuleIndex,
    callAiJudge,
  });
}

// =====================================================
// 1. Piece Loading & Structure Validation
// =====================================================

describe('default-perf piece: loading (EN)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    languageState.value = 'en';
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load default-perf as a builtin piece', () => {
    const config = loadPiece('default-perf', testDir);

    expect(config).not.toBeNull();
    expect(config!.name).toBe('default-perf');
    expect(config!.movements.length).toBeGreaterThan(0);
    expect(config!.initialMovement).toBe('plan');
    expect(config!.maxMovements).toBeGreaterThan(0);
  });

  it('should have perf_review movement between plan and write_tests', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const movementNames = config!.movements.map((m) => m.name);

    // perf_review must exist
    expect(movementNames).toContain('perf_review');

    // perf_review must be between plan and write_tests
    const planIndex = movementNames.indexOf('plan');
    const perfReviewIndex = movementNames.indexOf('perf_review');
    const writeTestsIndex = movementNames.indexOf('write_tests');
    expect(perfReviewIndex).toBeGreaterThan(planIndex);
    expect(perfReviewIndex).toBeLessThan(writeTestsIndex);
  });

  it('should configure perf_review as a read-only review movement', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const perfReview = config!.movements.find((m) => m.name === 'perf_review');
    expect(perfReview).toBeDefined();
    expect(perfReview!.edit).toBe(false);
  });

  it('should configure perf_review with performance-reviewer persona', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const perfReview = config!.movements.find((m) => m.name === 'perf_review');
    expect(perfReview).toBeDefined();
    expect(perfReview!.persona).toBe('performance-reviewer');
  });

  it('should configure perf_review with correct rules', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const perfReview = config!.movements.find((m) => m.name === 'perf_review');
    expect(perfReview).toBeDefined();
    expect(perfReview!.rules).toBeDefined();
    expect(perfReview!.rules!.length).toBe(2);

    // Rule: no issues → write_tests
    const noIssuesRule = perfReview!.rules!.find((r) => r.next === 'write_tests');
    expect(noIssuesRule).toBeDefined();
    expect(noIssuesRule!.condition).toBe('No performance issues found');

    // Rule: issues found → plan
    const issuesRule = perfReview!.rules!.find((r) => r.next === 'plan');
    expect(issuesRule).toBeDefined();
    expect(issuesRule!.condition).toBe('Performance issues found');
  });

  it('should configure perf_review with output_contracts for perf-review.md', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const perfReview = config!.movements.find((m) => m.name === 'perf_review');
    expect(perfReview).toBeDefined();
    expect(perfReview!.outputContracts).toBeDefined();
  });

  it('should route plan to perf_review instead of write_tests', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const plan = config!.movements.find((m) => m.name === 'plan');
    expect(plan).toBeDefined();

    // The "clear and implementable" rule should go to perf_review
    const clearRule = plan!.rules!.find((r) => r.condition === 'Requirements are clear and implementable');
    expect(clearRule).toBeDefined();
    expect(clearRule!.next).toBe('perf_review');
  });

  it('should have plan ⇄ perf_review loop monitor', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();
    expect(config!.loopMonitors).toBeDefined();

    const planPerfMonitor = config!.loopMonitors!.find(
      (m) => m.cycle.includes('plan') && m.cycle.includes('perf_review'),
    );
    expect(planPerfMonitor).toBeDefined();
    expect(planPerfMonitor!.threshold).toBe(3);
    expect(planPerfMonitor!.judge.rules.length).toBe(2);

    // Judge rule: healthy → plan
    const healthyRule = planPerfMonitor!.judge.rules.find((r) => r.next === 'plan');
    expect(healthyRule).toBeDefined();

    // Judge rule: unproductive → write_tests
    const unproductiveRule = planPerfMonitor!.judge.rules.find((r) => r.next === 'write_tests');
    expect(unproductiveRule).toBeDefined();
  });

  it('should preserve ai_review ⇄ ai_fix loop monitor from default', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const aiReviewFixMonitor = config!.loopMonitors!.find(
      (m) => m.cycle.includes('ai_review') && m.cycle.includes('ai_fix'),
    );
    expect(aiReviewFixMonitor).toBeDefined();
    expect(aiReviewFixMonitor!.threshold).toBe(3);
  });

  it('should have allowed_tools Read, Glob, Grep on perf_review', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const perfReview = config!.movements.find((m) => m.name === 'perf_review');
    expect(perfReview).toBeDefined();
    expect(perfReview!.providerOptions).toBeDefined();

    const claudeOptions = perfReview!.providerOptions!.claude as Record<string, unknown>;
    expect(claudeOptions).toBeDefined();

    const allowedTools = claudeOptions.allowedTools as string[];
    expect(allowedTools).toContain('Read');
    expect(allowedTools).toContain('Glob');
    expect(allowedTools).toContain('Grep');
    // Should NOT have edit tools
    expect(allowedTools).not.toContain('Edit');
    expect(allowedTools).not.toContain('Write');
    expect(allowedTools).not.toContain('Bash');
  });
});

describe('default-perf piece: loading (JA)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    languageState.value = 'ja';
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should load default-perf as a builtin piece in JA', () => {
    const config = loadPiece('default-perf', testDir);

    expect(config).not.toBeNull();
    expect(config!.name).toBe('default-perf');
  });

  it('should have perf_review movement with JA conditions', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const perfReview = config!.movements.find((m) => m.name === 'perf_review');
    expect(perfReview).toBeDefined();
    expect(perfReview!.rules).toBeDefined();
    expect(perfReview!.rules!.length).toBe(2);

    // JA conditions
    const noIssuesRule = perfReview!.rules!.find((r) => r.next === 'write_tests');
    expect(noIssuesRule).toBeDefined();
    expect(noIssuesRule!.condition).toBe('パフォーマンス上の問題なし');

    const issuesRule = perfReview!.rules!.find((r) => r.next === 'plan');
    expect(issuesRule).toBeDefined();
    expect(issuesRule!.condition).toBe('パフォーマンス上の問題あり');
  });

  it('should have plan ⇄ perf_review loop monitor with JA conditions', () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const planPerfMonitor = config!.loopMonitors!.find(
      (m) => m.cycle.includes('plan') && m.cycle.includes('perf_review'),
    );
    expect(planPerfMonitor).toBeDefined();

    // JA conditions on judge rules
    const healthyRule = planPerfMonitor!.judge.rules.find((r) => r.next === 'plan');
    expect(healthyRule).toBeDefined();

    const unproductiveRule = planPerfMonitor!.judge.rules.find((r) => r.next === 'write_tests');
    expect(unproductiveRule).toBeDefined();
  });

  it('should have identical movement names and next targets between EN and JA', () => {
    // Load JA
    const jaConfig = loadPiece('default-perf', testDir);
    expect(jaConfig).not.toBeNull();

    // Load EN
    languageState.value = 'en';
    const enConfig = loadPiece('default-perf', testDir);
    expect(enConfig).not.toBeNull();

    // Movement names must match exactly
    const jaMovementNames = jaConfig!.movements.map((m) => m.name);
    const enMovementNames = enConfig!.movements.map((m) => m.name);
    expect(jaMovementNames).toEqual(enMovementNames);

    // Rule next targets must match
    for (let i = 0; i < enConfig!.movements.length; i++) {
      const enMovement = enConfig!.movements[i]!;
      const jaMovement = jaConfig!.movements[i]!;

      if (enMovement.rules && jaMovement.rules) {
        const enNextTargets = enMovement.rules.map((r) => r.next);
        const jaNextTargets = jaMovement.rules.map((r) => r.next);
        expect(jaNextTargets).toEqual(enNextTargets);
      }
    }

    // Loop monitor cycles must match
    if (enConfig!.loopMonitors && jaConfig!.loopMonitors) {
      expect(jaConfig!.loopMonitors.length).toBe(enConfig!.loopMonitors.length);
      for (let i = 0; i < enConfig!.loopMonitors.length; i++) {
        expect(jaConfig!.loopMonitors[i]!.cycle).toEqual(enConfig!.loopMonitors[i]!.cycle);
        expect(jaConfig!.loopMonitors[i]!.threshold).toEqual(enConfig!.loopMonitors[i]!.threshold);
      }
    }
  });
});

// =====================================================
// 2. Facet Resolution
// =====================================================

describe('default-perf piece: facet resolution', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should resolve performance-reviewer persona from EN builtins', () => {
    const context: FacetResolutionContext = { projectDir: testDir, lang: 'en' };
    const content = resolveFacetByName('performance-reviewer', 'personas', context);
    expect(content).toBeDefined();
    expect(content!.length).toBeGreaterThan(0);
  });

  it('should resolve performance-reviewer persona from JA builtins', () => {
    const context: FacetResolutionContext = { projectDir: testDir, lang: 'ja' };
    const content = resolveFacetByName('performance-reviewer', 'personas', context);
    expect(content).toBeDefined();
    expect(content!.length).toBeGreaterThan(0);
  });

  it('should resolve review-performance instruction from EN builtins', () => {
    const context: FacetResolutionContext = { projectDir: testDir, lang: 'en' };
    const content = resolveFacetByName('review-performance', 'instructions', context);
    expect(content).toBeDefined();
    expect(content!.length).toBeGreaterThan(0);
  });

  it('should resolve review-performance instruction from JA builtins', () => {
    const context: FacetResolutionContext = { projectDir: testDir, lang: 'ja' };
    const content = resolveFacetByName('review-performance', 'instructions', context);
    expect(content).toBeDefined();
    expect(content!.length).toBeGreaterThan(0);
  });

  it('should resolve persona path to existing file when loading default-perf piece', () => {
    languageState.value = 'en';
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    const perfReview = config!.movements.find((m) => m.name === 'perf_review');
    expect(perfReview).toBeDefined();

    if (perfReview!.personaPath) {
      expect(existsSync(perfReview!.personaPath)).toBe(true);
    }
  });
});

// =====================================================
// 3. Roadmap Integration
// =====================================================

describe('default-perf piece: roadmap integration', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    languageState.value = 'en';
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should reference default-perf in roadmap execute_batch slot_1 (EN)', () => {
    languageState.value = 'en';
    const config = loadPiece('roadmap', testDir);
    expect(config).not.toBeNull();

    const executeBatch = config!.movements.find((m) => m.name === 'execute_batch');
    expect(executeBatch).toBeDefined();
    expect(executeBatch!.parallel).toBeDefined();

    const slot1 = executeBatch!.parallel!.find((s) => s.name === 'slot_1');
    expect(slot1).toBeDefined();
    expect(slot1!.call).toBe('default-perf');
  });

  it('should reference default-perf in roadmap execute_batch slot_2 (EN)', () => {
    languageState.value = 'en';
    const config = loadPiece('roadmap', testDir);
    expect(config).not.toBeNull();

    const executeBatch = config!.movements.find((m) => m.name === 'execute_batch');
    expect(executeBatch).toBeDefined();

    const slot2 = executeBatch!.parallel!.find((s) => s.name === 'slot_2');
    expect(slot2).toBeDefined();
    expect(slot2!.call).toBe('default-perf');
  });

  it('should reference default-perf in roadmap execute_batch (JA)', () => {
    languageState.value = 'ja';
    const config = loadPiece('roadmap', testDir);
    expect(config).not.toBeNull();

    const executeBatch = config!.movements.find((m) => m.name === 'execute_batch');
    expect(executeBatch).toBeDefined();

    const slot1 = executeBatch!.parallel!.find((s) => s.name === 'slot_1');
    expect(slot1).toBeDefined();
    expect(slot1!.call).toBe('default-perf');

    const slot2 = executeBatch!.parallel!.find((s) => s.name === 'slot_2');
    expect(slot2).toBeDefined();
    expect(slot2!.call).toBe('default-perf');
  });
});

// =====================================================
// 4. Piece Transition Patterns
// =====================================================

describe('default-perf piece: happy path (plan → perf_review → write_tests → implement → ai_review → reviewers → COMPLETE)', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    languageState.value = 'en';
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should complete when perf_review finds no issues', async () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'performance-reviewer', status: 'done', content: 'No performance issues found' },
      { persona: 'coder', status: 'done', content: 'Tests written successfully' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Test task');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    // plan(1) + perf_review(2) + write_tests(3) + implement(4) + ai_review(5) + reviewers(6)
    expect(state.iteration).toBe(6);
  });
});

describe('default-perf piece: perf_review rejects plan', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    languageState.value = 'en';
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should loop back to plan when perf_review finds performance issues', async () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      // First cycle: plan → perf_review (issues)
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'performance-reviewer', status: 'done', content: 'Performance issues found' },
      // Second cycle: plan (revised) → perf_review (no issues)
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'performance-reviewer', status: 'done', content: 'No performance issues found' },
      // Continue normal flow
      { persona: 'coder', status: 'done', content: 'Tests written successfully' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Task with perf issues');
    const state = await engine.run();

    expect(state.status).toBe('completed');
    // plan(1) + perf_review(2) + plan(3) + perf_review(4) + write_tests(5) + implement(6) + ai_review(7) + reviewers(8)
    expect(state.iteration).toBe(8);
  });
});

describe('default-perf piece: parallel reviewers fix loop', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    languageState.value = 'en';
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should route to fix when any("needs_fix") in parallel review step', async () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'performance-reviewer', status: 'done', content: 'No performance issues found' },
      { persona: 'coder', status: 'done', content: 'Tests written successfully' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      // Parallel reviewers: arch needs_fix, supervisor passes
      { persona: 'architecture-reviewer', status: 'done', content: 'needs_fix' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
      // Fix
      { persona: 'coder', status: 'done', content: 'Fix complete' },
      // Re-review: all approved
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Task needing fix');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

describe('default-perf piece: write_tests skip path', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    languageState.value = 'en';
    testDir = createTestDir();
  });

  afterEach(() => {
    resetScenario();
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should continue to implement when test target is not implemented yet', async () => {
    const config = loadPiece('default-perf', testDir);
    expect(config).not.toBeNull();

    setMockScenario([
      { persona: 'planner', status: 'done', content: 'Requirements are clear and implementable' },
      { persona: 'performance-reviewer', status: 'done', content: 'No performance issues found' },
      { persona: 'coder', status: 'done', content: 'Cannot proceed because the test target is not implemented yet, so skip test writing' },
      { persona: 'coder', status: 'done', content: 'Implementation complete' },
      { persona: 'ai-antipattern-reviewer', status: 'done', content: 'No AI-specific issues' },
      { persona: 'architecture-reviewer', status: 'done', content: 'approved' },
      { persona: 'supervisor', status: 'done', content: 'All checks passed' },
    ]);

    const engine = createEngine(config!, testDir, 'Task with skip test');
    const state = await engine.run();

    expect(state.status).toBe('completed');
  });
});

// =====================================================
// 5. Structure Consistency with default.yaml
// =====================================================

describe('default-perf piece: consistency with default piece', () => {
  let testDir: string;

  beforeEach(() => {
    vi.clearAllMocks();
    languageState.value = 'en';
    testDir = createTestDir();
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  it('should have all movements from default piece plus perf_review', () => {
    const defaultConfig = loadPiece('default', testDir);
    const perfConfig = loadPiece('default-perf', testDir);
    expect(defaultConfig).not.toBeNull();
    expect(perfConfig).not.toBeNull();

    const defaultMovementNames = defaultConfig!.movements.map((m) => m.name);
    const perfMovementNames = perfConfig!.movements.map((m) => m.name);

    // All default movements should exist in default-perf
    for (const name of defaultMovementNames) {
      expect(perfMovementNames).toContain(name);
    }

    // default-perf should additionally have perf_review
    expect(perfMovementNames).toContain('perf_review');
    expect(perfMovementNames.length).toBe(defaultMovementNames.length + 1);
  });

  it('should differ from default only in plan rules, perf_review addition, and loop_monitors', () => {
    const defaultConfig = loadPiece('default', testDir);
    const perfConfig = loadPiece('default-perf', testDir);
    expect(defaultConfig).not.toBeNull();
    expect(perfConfig).not.toBeNull();

    // Verify plan movement rules differ: default goes to write_tests, default-perf goes to perf_review
    const defaultPlan = defaultConfig!.movements.find((m) => m.name === 'plan');
    const perfPlan = perfConfig!.movements.find((m) => m.name === 'plan');

    const defaultClearRule = defaultPlan!.rules!.find((r) => r.condition === 'Requirements are clear and implementable');
    const perfClearRule = perfPlan!.rules!.find((r) => r.condition === 'Requirements are clear and implementable');

    expect(defaultClearRule!.next).toBe('write_tests');
    expect(perfClearRule!.next).toBe('perf_review');
  });

  it('should have more loop monitors than default (additional plan ⇄ perf_review)', () => {
    const defaultConfig = loadPiece('default', testDir);
    const perfConfig = loadPiece('default-perf', testDir);
    expect(defaultConfig).not.toBeNull();
    expect(perfConfig).not.toBeNull();

    const defaultMonitorCount = defaultConfig!.loopMonitors?.length ?? 0;
    const perfMonitorCount = perfConfig!.loopMonitors?.length ?? 0;

    expect(perfMonitorCount).toBe(defaultMonitorCount + 1);
  });
});
