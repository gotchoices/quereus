---
description: Partial-WHERE UNIQUE enforcement and CREATE UNIQUE INDEX duplicate validation. The WHERE clause is wired into both index population/maintenance and uniqueness checks; CREATE UNIQUE INDEX over data with pre-existing duplicates is rejected.
prereq:
files:
  packages/quereus/src/schema/table.ts
  packages/quereus/src/schema/manager.ts
  packages/quereus/src/vtab/memory/index.ts
  packages/quereus/src/vtab/memory/module.ts
  packages/quereus/src/vtab/memory/utils/predicate.ts
  packages/quereus/src/vtab/memory/layer/manager.ts
  packages/quereus/src/vtab/memory/layer/base.ts
  packages/quereus/src/vtab/memory/layer/transaction.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  packages/quereus/test/logic/102.1-unique-edge-cases.sqllogic
---

## Summary

`CREATE [UNIQUE] INDEX … WHERE <predicate>` now produces a true partial index in the memory vtab: only rows whose predicate is unambiguously TRUE participate, and partial UNIQUE constraints only enforce within that scope. Additionally, `CREATE UNIQUE INDEX` over data with pre-existing duplicates raises `UNIQUE constraint failed` instead of silently swallowing duplicates at population time.

## Behavior

| Path | Old | New |
|---|---|---|
| Populate new index | All rows added | Skip rows whose predicate ≠ TRUE (NULL counts as out-of-scope) |
| Maintain on UPDATE | Always rekey | Branches on the four predicate-transition cases (F→F skip, F→T add, T→F remove, T→T rekey if changed) |
| UNIQUE check | Always run | Skipped when predicate ≠ TRUE for the new row |
| UNIQUE check on UPDATE | Triggered only when constrained columns changed | Also triggered when any column referenced by a partial predicate changed |
| CREATE UNIQUE INDEX over duplicate data | Silently merged in BTree | Throws `UNIQUE constraint failed: <table> (<cols>)` and rolls back the schema change |
| Planner access path over partial index | Could pick a partial index whose predicate the query did not imply, silently dropping rows | Partial indexes are excluded from `gatherAvailableIndexes` and serve solely as uniqueness enforcers |

Three-valued logic: predicate evaluator returns `boolean | null`; only `true` counts as in-scope. AND/OR truth tables, comparisons returning NULL when either side is NULL, and `NOT NULL → NULL` are all preserved per SQL semantics.

## Code-level entry points

- Schema carriage: `IndexSchema.predicate` and `UniqueConstraintSchema.predicate` (`schema/table.ts:249,433`). `SchemaManager.buildIndexSchema` (`schema/manager.ts:1227`) and `addIndexToTableSchema` (`schema/manager.ts:1247`) propagate `stmt.where` onto both.
- Predicate compiler: `compilePredicate` in `vtab/memory/utils/predicate.ts`. Supports literals, column refs, `=` `==` `!=` `<>` `<` `<=` `>` `>=`, `AND`/`OR`/`NOT` (3VL), `IS`/`IS NOT`, `IS NULL`/`IS NOT NULL`, unary `+`/`-`. Unsupported forms throw at index-creation time. Returns `{ evaluate, referencedColumns }`.
- `MemoryIndex.rowMatchesPredicate` (`vtab/memory/index.ts:53`) — central in-scope predicate test consumed by every population, maintenance, and uniqueness path.
- Population & duplicate detection: `BaseLayer.populateNewIndex` (`vtab/memory/layer/base.ts:233`). For unique indexes, tracks seen non-NULL keys via `JSON.stringify` of the per-column array and throws `QuereusError(StatusCode.CONSTRAINT, …)` on the first duplicate. Multi-NULL is allowed (matches `checkSingleUniqueConstraint` semantics).
- Schema rollback on failure: `MemoryTableManager.createIndex` (`vtab/memory/layer/manager.ts:1255`) catches the error and restores `originalManagerSchema`. Because `addIndexToBase` only inserts into `secondaryIndexes` *after* `populateNewIndex` succeeds, no partial index state is left behind.
- Maintenance: `TransactionLayer.recordUpsert`/`recordDelete` (`vtab/memory/layer/transaction.ts:188,253`) implement the four predicate-transition cases on UPDATE and gate DELETE on the old row being in scope.
- UNIQUE enforcement: `MemoryTableManager.checkSingleUniqueConstraint` (`vtab/memory/layer/manager.ts:746`) early-returns when `index.predicate` is not satisfied. `uniqueColumnsChanged` (`:703`) was extended to detect transitions into scope by also checking `predicate.referencedColumns`. `checkUniqueByScanning` (`:832`) compiles the predicate ad-hoc for the scan fallback.
- Planner exclusion: `MemoryTableModule.gatherAvailableIndexes` (`vtab/memory/module.ts:517`) skips partial indexes for access-path planning; nothing else in the planner reaches into `tableSchema.indexes` to pick an index (verified by grep across `src/planner`).
- Auto-created UNIQUE indexes: `MemoryTableManager.ensureUniqueConstraintIndexes` (`vtab/memory/layer/manager.ts:80`) propagates `uc.predicate` onto the synthesized index.

## Tests

Re-enabled fixtures exercise the new behavior:

- `test/logic/10.5.1-partial-indexes.sqllogic`
  - § 1 — basic non-unique partial index; rows outside WHERE remain queryable via full scan
  - § 2 — partial UNIQUE accepts `('inactive','A')` while rejecting a second `('active','A')`; transitioning a row to `archived` frees the code for reuse
  - § 3 — `IS NULL`/`IS NOT NULL` predicates
  - § 4 — compound `AND`/`>` predicates
  - § 5 — UPDATE moving rows in/out of scope keeps the index correct
- `test/logic/102.1-unique-edge-cases.sqllogic`
  - § 3 — `CREATE UNIQUE INDEX` over duplicate data raises `UNIQUE constraint failed`; after dedup, the index creates and subsequently rejects new duplicates; multi-NULL is allowed in composite UNIQUE indexes
  - § 4 — column-not-found errors at DDL

## Validation

- `yarn build` — clean.
- `yarn lint` — clean.
- Both partial-index fixtures (`10.5.1-partial-indexes.sqllogic`, `102.1-unique-edge-cases.sqllogic`) pass when run individually under the test runner.
- Full `node test-runner.mjs` at HEAD reports 2518 passing, 6 unrelated failures in `Extended constraint pushdown` and `Predicate normalizer` rules — these are pre-existing regressions introduced by later tickets in the chain (the partial-index implement commit `9b6cd46e` showed 2523 passing / 0 failing). Out of scope here.
- `yarn test:store` not run; store-mode partial-index coverage is out of scope per the ticket.

## Out of scope (follow-up)

- Predicate-implication checking would let the planner reuse a partial index when the query's WHERE implies the predicate. Not done here; partial indexes are conservatively excluded from access-path planning.
- `quereus-store` plugin builds its own indexes and does not currently consume `IndexSchema.predicate`. Without the predicate plumbing it would silently behave like a full index over the partial-index columns. Document and revisit when the store path needs partial-index support.
- Schema-change-mid-transaction limitation: `db.exec` of a multi-statement DDL+DML batch wraps the whole batch in a single implicit transaction. INSERTed rows live in an uncommitted `TransactionLayer` whose `tableSchemaAtCreation` is fixed at construction time and does not pick up schemas added by a later CREATE INDEX in the same batch. `BaseLayer.populateNewIndex` only sees rows in the base layer, so the duplicate scan would miss in-flight rows. Worked around in `102.1` § 3-4 with `-- run` markers; the underlying interaction is out of scope for this ticket.

## Cleanup

- Removed leftover `packages/quereus/repro.mjs` left over from the implement-stage debug session.
