---
description: Review GROUP BY column-coverage validation in select-aggregates.ts. SELECT lists that reference non-aggregate columns not covered by GROUP BY now raise the canonical error instead of silently using implementation-defined values.
prereq:
files: packages/quereus/src/planner/building/select-aggregates.ts, packages/quereus/test/logic/07-aggregates.sqllogic, packages/quereus/test/logic/03-expressions.sqllogic
---

# Review: aggregate / GROUP BY coverage validation

## What landed

`validateAggregateProjections` in `packages/quereus/src/planner/building/select-aggregates.ts` is now called *after* `groupByExpressions` is built (so it has them) and accepts the GROUP BY expression list. Two coverage checks for the `hasGroupBy` branch:

1. **Attribute-id match** — any `ColumnReferenceNode` in the SELECT projection must have its `attributeId` in the set of attribute ids of GROUP BY expressions that are themselves column references.
2. **Subtree fingerprint match** — any subtree whose `expressionToString` AST fingerprint matches one of the GROUP BY expression fingerprints is treated as covered (handles `SELECT id+1, count(*) ... GROUP BY id+1`).

The walker `findUngroupedColumnRef` short-circuits on:
- aggregate function subtrees (`CapabilityDetectors.isAggregateFunction`) — inner column refs are aggregated and need no coverage,
- relational subtrees (`isRelationalNode`) — correlated subqueries resolve their own scope,
- subtrees whose AST fingerprint matches a GROUP BY expression.

On first uncovered column reference it throws `QuereusError('Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY', StatusCode.ERROR)` — the same wording the no-GROUP-BY branch already used and that the corpus matcher checks for.

## Test corpus changes

- `07-aggregates.sqllogic:74` — assertion `SELECT grp, count(*), val FROM agg_t GROUP BY grp;` now genuinely fires the asserted error (was previously tautological per the `sqllogic-error-directive-ordering` caveat in the source ticket).
- `03-expressions.sqllogic:124,127` — two queries used `GROUP BY id` (PK) with non-grouped column refs in SELECT/HAVING expressions. These relied on PK-based functional-dependency coverage, which the source ticket explicitly puts *out of scope*. They were rewritten to `GROUP BY id, a, b` to be SQL-92 compliant; the test intent (HAVING with a complex expression) is preserved. Comment in the file points at the missing FD analysis.

## Verification cases

Should now succeed:
- `SELECT grp, count(*) FROM t GROUP BY grp` — `grp` covered by attrId.
- `SELECT grp, count(*), 0 AS k FROM t GROUP BY grp` — literal has no column refs.
- `SELECT grp, coalesce(max(val), 0) FROM t GROUP BY grp` — wrapped aggregate is in `aggregates` not `projections`.
- `SELECT id+1, count(*) FROM t GROUP BY id+1` — fingerprint match on the whole `id+1` subtree.
- `SELECT grp+1, count(*) FROM t GROUP BY grp` — recurses into `grp`, attrId-covered.
- `SELECT * FROM t WHERE ...` (no GROUP BY) — unchanged.
- `SELECT max(val)+1 FROM t` — wrapped aggregate path, no projections to validate.

Should now fail with the canonical error:
- `SELECT grp, count(*), val FROM t GROUP BY grp` — `val.attributeId` not in GROUP BY set.
- `SELECT * FROM t GROUP BY grp` — star expansion creates ColumnReferenceNodes; non-grp ones fail.
- `SELECT id, count(*), a FROM t GROUP BY id` — `a` not covered (no PK-FD).

## Out of scope (documented in source ticket)

- HAVING-clause column-coverage validation. Add only when a corpus case asserts it.
- Functional-dependency / unique-key coverage (would let `GROUP BY pk` cover all columns). The lift point is `constraint-extractor.ts:1027-1058` (`demoteForAggregate`'s key-coverage logic).

## Review checklist

- [ ] `validateAggregateProjections` placement after `groupByExpressions` build is correct (depends on stable attrIds; nothing else mutates them between build and use).
- [ ] `findUngroupedColumnRef` correctly handles correlated subqueries — outer-scope column refs inside a scalar subquery should not be checked here (they're behind the `isRelationalNode` skip). Consider whether a correlated subquery referencing an outer non-grouped column should error here or be left to the subquery's own validation. Current behavior: not checked here. If this is wrong, the walker needs to recurse into scalar subquery's correlated outer refs.
- [ ] Confirm fingerprint approach via `expressionToString` matches GROUP BY and SELECT consistently. Both build from the same `selectContext.scope`, so AST nodes (and their stringifications) for the same parsed expression should be identical.
- [ ] No regression in `aggregate-strategy.spec.ts`, `aggregate-physical-selection.spec.ts`, `hash-aggregate.spec.ts`.
- [ ] `yarn workspace @quereus/quereus test` passes (verified: 2453 passing, 2 pending).
- [ ] `yarn test` (all workspaces) passes (verified).
- [ ] `yarn workspace @quereus/quereus lint` reports 0 errors on changed files (verified: 0 new warnings on `select-aggregates.ts`).
