description: `adjustPlanForOrdering` now short-circuits ORDER BY ordering claims when a multi-value `IN` filter targets an ordering column, mirroring the existing `OR_RANGE` guard. The multi-seek emitter visits IN values in IN-list (declaration) order, which is not monotonic on the seek column unless the IN list is itself sorted — so the index cannot satisfy ORDER BY without an explicit SORT.
files:
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/test/optimizer/desc-index-ordering.spec.ts
----

## Summary

Bug: for `SELECT n FROM t WHERE n IN (40, 10, 30) ORDER BY n` against an indexed column `n`, `MemoryTableModule.adjustPlanForOrdering` consulted `indexSatisfiesOrdering` and claimed the index satisfied the ORDER BY. The planner therefore omitted the SORT, but the runtime multi-seek (`packages/quereus/src/planner/rules/access/rule-select-access-path.ts:289-396`) visits IN values in IN-list order, so the engine returned `[40, 10, 30]`.

Fix (Option 1 / conservative): `packages/quereus/src/vtab/memory/module.ts:449-464` adds a guard immediately after the existing `OR_RANGE` short-circuit. If any handled filter is a multi-value `IN` whose column is in the required ordering, return the plan unchanged so the planner inserts an explicit SORT. Same shape as the OR_RANGE precedent (`request.filters.some((f, i) => plan.handledFilters[i] && ...)`). `collectEqualityBoundColumns` was deliberately left alone — it still treats only `=` and single-value `IN` as ordering-neutral, so the two layers stay independent and complementary.

Option 2 (sort the IN values at plan time when statically known to recover the no-SORT case for literal IN lists) is **not** implemented here; left as a follow-on enhancement.

## Files

- `packages/quereus/src/vtab/memory/module.ts:449-464` — new guard inside `adjustPlanForOrdering`.
- `packages/quereus/test/optimizer/desc-index-ordering.spec.ts:55-86` — two new regression cases (single-column IN, composite prefix-equality + IN suffix).

## Validation

- `yarn workspace @quereus/quereus test --grep "DESC index"` — 5/5 passing.
- Optimizer suite (`--grep "secondary-index|index|optimizer"`) — 113/113 passing, including `composite index IN multi-seek` (4 cases).
- Full quereus test suite — 995 passing. The one failure (`Predicate normalizer / double negation`) is a pre-existing baseline failure on `main`, unrelated to this ticket.
- `yarn workspace @quereus/quereus lint` — exit 0.

## Usage / regression coverage

```sql
-- Before: returned [40, 10, 30] (IN-list order, no SORT inserted)
-- After:  returns  [10, 30, 40] (SORT enforces ORDER BY)
CREATE TABLE t (id INTEGER PRIMARY KEY, n INTEGER) USING memory;
CREATE INDEX ix ON t(n);
INSERT INTO t VALUES (1, 10), (2, 20), (3, 30), (4, 40), (5, 50);
SELECT n FROM t WHERE n IN (40, 10, 30) ORDER BY n;

-- Composite prefix-equality + IN suffix also fixed
CREATE TABLE e (id INTEGER PRIMARY KEY, category TEXT, year INTEGER) USING memory;
CREATE INDEX ix_e ON e(category, year);
SELECT year FROM e WHERE category='a' AND year IN (2025, 2024, 2026) ORDER BY year;
```

Composite-index nuance: when both `a` and `b` are multi-IN and `ORDER BY b`, the guard fires on `b`. `ORDER BY a` fires on `a`. `ORDER BY c` (third index column) does not fire the new guard, but `indexSatisfiesOrdering` already fails because `a` is not equality-bound, so no incorrect ordering claim is made.

The non-null assertion `request.requiredOrdering!` is safe — `adjustPlanForOrdering` is only called from `findBestAccessPlan` (`module.ts:199`) under `if (request.requiredOrdering && request.requiredOrdering.length > 0)`.
