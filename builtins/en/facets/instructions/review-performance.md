**This is performance review iteration #{step_iteration}.**

On the first iteration, review comprehensively and report all performance issues.
From the 2nd iteration onward, prioritize verifying whether previously flagged items have been addressed in the revised plan.

Review the implementation plan in {report:plan.md} for performance and efficiency issues.
Do not review architecture (covered by arch-review) or AI-specific patterns (covered by ai_review).

**Performance checklist (representative antipatterns — supplement with your expert judgment):**

1. **Unnecessary full-data transformation** — Copying entire DB results, DataFrames, etc. into dicts/lists when the library API or query could process them directly
2. **Reimplementing library-provided operations** — Writing filter/aggregate/sort/join logic in loops instead of using vectorized operations, SQL aggregation, or built-in functions
3. **Poor algorithmic complexity** — O(n²)+ nested loops that could be improved with dict/set/index lookups
4. **N+1 problem** — Repeated DB queries or file I/O inside loops; should use batch fetching or JOINs
5. **Excessive data loading** — SELECT * or full-file reads when only specific columns/rows are needed
6. **Missing cache for repeated execution** — Expensive computations recalculated on every run of a repeatedly-executed script
7. **Unnecessary intermediate data structures** — Copying/transforming large data into another format in memory; holding multiple copies of the same data
8. **Inefficient string operations** — Repeated concatenation inside loops

These are representative examples. Use your professional judgment to identify additional performance concerns beyond this list.

**Previous finding tracking (required):**
- First, extract open findings from "Previous Response"
- Assign `finding_id` to each finding and classify current status as `new / persists / resolved`
- If status is `persists`, provide concrete unresolved evidence

## Judgment Procedure

1. Extract previous open findings and preliminarily classify as `new / persists / resolved`
2. Review {report:plan.md} and detect performance issues based on the checklist above
3. For each detected issue, classify as blocking (will cause measurable performance degradation) or non-blocking (minor, theoretical)
4. If there is even one blocking issue (`new` or `persists`), judge as REJECT
