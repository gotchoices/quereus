description: The set-op membership-write static surfaces (`column_info` / `view_info`) report a membership-body view fully writable from the AST shape alone (a membership flag is present), without verifying each branch is actually writable. A branch that is a VALUES/DML operand, or whose leg has a `select *` or a computed projection, is rejected at *write* time (`analyzeSetOpView` / `branchColumnNames` / `rightBranchSelect`) — but the static surface still reports `is_updatable='YES'` / `is_insertable_into='YES'` / `is_deletable='YES'`. This is a static-vs-dynamic over-claim: a tooling consumer that trusts the catalog is told the view is writable when a write will reject.
files: packages/quereus/src/func/builtins/schema.ts, packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/test/property.spec.ts
----

## Problem

`deriveViewInfo` and `deriveColumnInfo` in `func/builtins/schema.ts` short-circuit on
`isSetOpMembershipBody(view.selectAst)` — a pure AST peek (does the compound carry ≥1
`exists … as <flag>` clause?) — and report the view/columns fully writable. They never
check that the two branches are themselves recursively writable.

The **dynamic** write path (`buildSetOpWrite` → `analyzeSetOpView`) *does* enforce branch
writability and rejects:
- a right operand that is not a `SELECT` (`rightBranchSelect`),
- a `select *` leg (`branchColumnNames`),
- a computed (non-plain-column) leg projection (`branchColumnNames`),
- a branch whose projected column count disagrees with the data-column count (`buildBranch`).

So today a view like

```sql
create view Uc as
  select id, x from A
  union exists left as inA, exists right as inB
  select id, x + 1 from B          -- computed right leg
```

reports every column `is_updatable = 'YES'` from `column_info('Uc')`, yet
`update Uc set x = 5 where id = 1` rejects with `unsupported-set-op` ("the right branch
projects a computed column"). The join-body static surface, by contrast, *does* gate
(`deriveColumnInfo`/`deriveViewInfo` carry a "non-decomposable join shape gate" that
reports the conservative all-`NO` row) — so the set-op surface is inconsistent with the
join surface it was modelled on.

This is conservative-direction-*wrong* (claims writable when not) but **not** a
data-correctness bug: the write itself rejects cleanly. It is a catalog-honesty gap.

## Desired behavior

Gate the set-op membership static surface on a lightweight branch-writability probe before
reporting `YES`, so `column_info` / `view_info` agree with what a write will actually do —
the same way the join path's shape gate does. The probe should mirror the dynamic
rejections in `analyzeSetOpView` (non-SELECT operand, `select *` leg, computed leg,
column-count mismatch) without doing the full capture/decomposition build. When a branch is
non-writable, report the conservative row (columns `is_updatable='NO'`; view all-`NO`),
matching the join body's behavior.

Add a `column_info` / `view_info` test over a computed-leg (and a `select *`-leg) set-op
view asserting the static surface now reports the non-writable shape, and that it still
reports writable for the all-plain-column fixture (regression for the existing
`Set-operation membership writes` cross-check test, which only exercises writable fixtures).

## Notes

- Surfaced during review of `set-op-membership-write` (see that complete ticket's Review
  findings). Deferred as backlog (minor honesty gap, no correctness impact); the inline
  review fix in that pass addressed a separate, higher-impact bug (bound parameters in the
  WHERE of a membership write).
- Keep the dependency one-directional: `schema.ts` already imports from `set-op.ts`, so a
  shared `isSetOpBranchWritable(view)` helper exported from `set-op.ts` is the natural home
  (it can reuse `leftBranchSelect` / `rightBranchSelect` / `branchColumnNames` without
  building a plan).
