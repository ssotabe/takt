/**
 * Unit tests for workflowDoctorGraph resume validation.
 *
 * Tests that the resume field is validated:
 * - References to unknown steps produce errors
 * - Self-references produce errors
 * - Valid references produce no errors
 */

import { describe, expect, it } from 'vitest';
import { WorkflowConfigRawSchema } from '../core/models/index.js';
import { validateDoctorGraph } from '../infra/config/loaders/workflowDoctorGraph.js';
import type { WorkflowDiagnostic } from '../infra/config/loaders/workflowDoctorTypes.js';

function makeMinimalWorkflow(steps: Array<{ name: string; resume?: string; session?: string; rules?: Array<{ condition: string; next: string }> }>) {
  return {
    name: 'resume-test',
    max_steps: 10,
    initial_step: steps[0]!.name,
    steps: steps.map((s) => ({
      name: s.name,
      resume: s.resume,
      session: s.session,
      rules: s.rules ?? [{ condition: 'done', next: 'COMPLETE' }],
    })),
  };
}

describe('workflowDoctorGraph — resume validation', () => {
  it('should produce error when resume references an unknown step', () => {
    // Given: advisor_implement resumes "nonexistent" which doesn't exist
    const raw = WorkflowConfigRawSchema.parse(makeMinimalWorkflow([
      { name: 'implement', rules: [{ condition: 'done', next: 'advisor_implement' }] },
      { name: 'advisor_implement', resume: 'nonexistent', rules: [{ condition: 'done', next: 'COMPLETE' }] },
    ]));
    const diagnostics: WorkflowDiagnostic[] = [];

    // When
    validateDoctorGraph(raw, diagnostics);

    // Then
    const resumeErrors = diagnostics.filter((d) =>
      d.level === 'error' && d.message.includes('resume') && d.message.includes('nonexistent'),
    );
    expect(resumeErrors.length).toBeGreaterThanOrEqual(1);
  });

  it('should produce error when resume references itself', () => {
    // Given: step resumes itself
    const raw = WorkflowConfigRawSchema.parse(makeMinimalWorkflow([
      { name: 'implement', rules: [{ condition: 'done', next: 'advisor_implement' }] },
      { name: 'advisor_implement', resume: 'advisor_implement', rules: [{ condition: 'done', next: 'COMPLETE' }] },
    ]));
    const diagnostics: WorkflowDiagnostic[] = [];

    // When
    validateDoctorGraph(raw, diagnostics);

    // Then: self-reference should be an error
    const selfRefErrors = diagnostics.filter((d) =>
      d.level === 'error' && d.message.includes('resume') && d.message.includes('advisor_implement'),
    );
    expect(selfRefErrors.length).toBeGreaterThanOrEqual(1);
  });

  it('should produce no error when resume references a valid step', () => {
    // Given: advisor_implement correctly resumes "implement"
    const raw = WorkflowConfigRawSchema.parse(makeMinimalWorkflow([
      { name: 'implement', rules: [{ condition: 'advisor needed', next: 'advisor_implement' }] },
      { name: 'advisor_implement', resume: 'implement', rules: [{ condition: 'done', next: 'implement_continue' }] },
      { name: 'implement_continue', resume: 'advisor_implement', rules: [{ condition: 'done', next: 'COMPLETE' }] },
    ]));
    const diagnostics: WorkflowDiagnostic[] = [];

    // When
    validateDoctorGraph(raw, diagnostics);

    // Then: no resume-related errors
    const resumeErrors = diagnostics.filter((d) =>
      d.message.includes('resume'),
    );
    expect(resumeErrors).toEqual([]);
  });

  it('should produce error when resume is combined with session refresh', () => {
    // Given: step has both resume and session: 'refresh' which are mutually exclusive
    const raw = WorkflowConfigRawSchema.parse(makeMinimalWorkflow([
      { name: 'implement', rules: [{ condition: 'done', next: 'advisor_implement' }] },
      { name: 'advisor_implement', resume: 'implement', session: 'refresh', rules: [{ condition: 'done', next: 'COMPLETE' }] },
    ]));
    const diagnostics: WorkflowDiagnostic[] = [];

    // When
    validateDoctorGraph(raw, diagnostics);

    // Then
    const crossErrors = diagnostics.filter((d) =>
      d.level === 'error' && d.message.includes('resume') && d.message.includes('refresh'),
    );
    expect(crossErrors.length).toBeGreaterThanOrEqual(1);
  });

  it('should not produce resume errors when resume is not used', () => {
    // Given: a normal workflow without resume
    const raw = WorkflowConfigRawSchema.parse(makeMinimalWorkflow([
      { name: 'plan', rules: [{ condition: 'done', next: 'implement' }] },
      { name: 'implement', rules: [{ condition: 'done', next: 'COMPLETE' }] },
    ]));
    const diagnostics: WorkflowDiagnostic[] = [];

    // When
    validateDoctorGraph(raw, diagnostics);

    // Then: no errors at all
    expect(diagnostics).toEqual([]);
  });
});
