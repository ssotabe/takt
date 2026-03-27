Review the changes from a frontend development perspective.

**Review criteria:**
- Design fidelity (top priority when a design reference is provided)
- Component design (separation of concerns, granularity)
- State management (local vs. global decisions)
- Performance (re-renders, memoization)
- Accessibility (keyboard navigation, ARIA)
- Data fetching patterns
- Reachability wiring for user-facing features (routes, entry paths, launch conditions)
- TypeScript type safety

**Design fidelity check (when a design reference exists):**
1. Identify the design reference from the task order's referenced materials
2. Compare design elements (layout, wording, colors, spacing) against implementation element by element
3. For any discrepancy, check the decisions log to determine if it was intentional
4. Report unintentional discrepancies as blocking issues

**Note**: If this project does not include a frontend,
proceed as no issues found.


**Design decisions reference:**
Review {report:coder-decisions.md} to understand the recorded design decisions.
- Do not flag intentionally documented decisions as FP
- However, also evaluate whether the design decisions themselves are sound, and flag any problems

## Judgment Procedure

1. Review the change diff and detect issues based on the frontend development criteria above
   - Cross-check changes against REJECT criteria tables defined in knowledge
   - When new screens or user-facing features are added, verify that entry points and caller wiring were updated as well
2. For each detected issue, classify as blocking/non-blocking based on Policy's scope determination table and judgment rules
3. If there is even one blocking issue, judge as REJECT
