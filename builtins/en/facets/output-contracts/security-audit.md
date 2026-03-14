```markdown
# Security Audit Report

## Result: APPROVE / REJECT

## Severity: None / Low / Medium / High / Critical

## Audit Scope
| # | File | Audited | Risk Classification |
|---|------|---------|-------------------|
| 1 | `src/file.ts` | ✅ | High / Medium / Low |

## Detected Issues
| # | Severity | Category | Location | Issue | Remediation |
|---|----------|----------|----------|-------|-------------|
| 1 | Critical | injection | `src/file.ts:42` | {issue description} | {remediation} |

## Files with No Issues
- {list of files where no issues were detected}

## Recommendations (non-blocking)
- {security improvement suggestions}

## REJECT Criteria
- REJECT if one or more High or Critical issues exist
```

**Cognitive load reduction rules:**
- No issues → Audit scope table only (15 lines max)
- Low/Medium only → + issues table (30 lines max)
- High/Critical present → Full output
