description: Materialized-view engine substrate (phase 1, manual refresh) — parser/AST, dual-registered schema, MemoryTable-backed storage with atomic base-layer swap, query resolution to the backing table, read-only write boundary, and schema-change staleness. Reviewed and accepted with minor inline fixes; one major limitation filed to backlog.
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/schema.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/schema/change-events.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/building/schema-resolution.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/runtime/emit/drop-table.ts, packages/quereus/src/runtime/emit/drop-view.ts, packages/quereus/src/runtime/register.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-materialized-views.ts
----

> **⚠ Partly superseded (2026-05-29).** `materialized-view-rowtime-only-consolidation` (plan) makes materialized views **row-time only** and removes the `manual` full-refresh policy and refresh-policy knob described here. The underlying keyed-derived-relation substrate (backing table, PK inference, dual registration) survives; the refresh-policy framing does not.

Phase-1 materialized views as **keyed derived relations**: a stored relation
defined by a query body, primary-keyed, addressable like any virtual table, with
manual full-refresh. See the original implement handoff (commit
`ticket(implement): materialized-view-core`) for the architecture; this file
records the review disposition.

## Review findings

### What was checked

- **Parser / AST** — `CREATE/REFRESH/DROP MATERIALIZED VIEW` are dispatched
  (`parser.ts` `statement()` `case 'REFRESH'` line 349; `createStatement` MATERIALIZED
  branch 2271-2274; `dropStatement` `materializedView` 2650-2653) and built as
  contextual keywords (no new reserved words — confirmed `MATERIALIZED`/`REFRESH`
  are not in the reserved set). `ast-stringify` round-trips create/refresh/drop
  including the `drop materialized view` two-word form. The `using <mod>(...)`
  clause parses before `as` and is forward-compatible (`moduleName`/`moduleArgs`).
- **Schema layer** — Dual registration verified: backing `TableSchema` under the
  reserved `_mv_<name>` (`backingTableNameFor`) in `Schema.tables`; the
  `MaterializedViewSchema` in the new `Schema.materializedViews` map. Name
  disjointness is enforced *both directions* in `schema.ts` (`addTable`/`addView`
  reject MV-name clashes; `addMaterializedView` rejects table/view clashes).
  `catalog.ts` excludes backing tables from user-facing enumeration. New change
  events (`materialized_view_added`/`_refreshed`/`_removed`) are defined and fired.
- **Query resolution** — `select.ts` resolves an MV reference to a
  `TableReferenceNode` against the backing table (the `else if (mvSchema)` branch,
  lines 442-478), not a body expansion. NOTE: I specifically verified line 443 at
  the byte level — it is a correct `//` comment; an earlier search rendering showed
  a stray `\`, which was a tooling artifact, not a source defect.
- **Write boundary** — `assertNotMaterializedView` is wired into all three DML
  builders (`insert.ts:378`, `update.ts:34`, `delete.ts:34`). `drop-table.ts` and
  `drop-view.ts` reject MV names and redirect to `DROP MATERIALIZED VIEW`; the MV
  drop emitter conversely redirects table/view names to `DROP TABLE`/`DROP VIEW`.
- **Storage / atomicity** — `MemoryTableManager.replaceBaseLayer` builds a fresh
  `BaseLayer`, guards duplicate PKs, swaps `baseLayer`/`_currentCommittedLayer`
  under the `SchemaChange` latch, and re-points connections. Create rolls back the
  backing table on any fill failure before registering the MV.
- **Staleness** — `MaterializedViewManager` subscribes to `table_removed` /
  `table_modified`, marks any MV whose `sourceTables` contains the changed table
  stale, and is wired into the `Database` ctor and `close()`/`dispose()`. Reference-
  time re-validation of a stale MV is in `select.ts`; refresh re-validation is in
  `revalidateBody`.
- **Build** — `yarn workspace @quereus/quereus build` independently re-run:
  **PASS (exit 0).**

### Findings — minor, fixed inline in this review pass

1. **`replaceBaseLayer` doc was wrong about reader blocking.** The comment claimed
   "concurrent readers block on the latch"; in fact readers don't block — they use
   start-of-call snapshot isolation, and only the swap is serialized under the
   latch. Corrected the comment (`vtab/memory/layer/manager.ts`).
2. **`bodyHash` doc in `schema/view.ts` was inaccurate.** It wrote the hash nesting
   inverted (`fnv1aHash(toBase64Url(...))`) and called the input the "optimized
   body's structural shape"; it is actually `toBase64Url(fnv1aHash(astToString(body)))`
   over the parsed (canonical) body SQL. Corrected.
3. **`computeBodyHash` doc in `materialized-view-helpers.ts`** said "optimized body's
   canonical SQL"; it hashes the parsed body SQL supplied by the caller, not the
   optimized plan. Corrected.

### Findings — minor, documented and accepted as v1 design (not changed)

4. **Physical PK seeds ordering columns ahead of the logical key.**
   `computeBackingPrimaryKey` leads the backing table's `primaryKeyDefinition` with
   the body's `order by` columns (then the logical `keysOf` key for uniqueness) so a
   btree scan reproduces the body order; `MaterializedViewSchema.primaryKey` keeps
   the logical identity. Deliberate divergence; Phase-2 incremental reconciles via a
   materialized index. Accepted.
5. **Body evaluated twice on create** — once via `db.getPlan` to derive shape, once
   via `prepare`/`_iterateRowsRaw` to collect rows. Correct but redundant; fine for
   rare DDL. Left as-is.
6. **Staleness diagnostic string duplicated** between the inline block in `select.ts`
   and `revalidateBody` in the helpers (`select.ts` re-validates inside the active
   planning context rather than calling `revalidateBody`, so they are not trivially
   collapsible). Minor DRY; left as-is.
7. **MV name resolution ignores the schema search path** — `select.ts` looks up the
   MV with `table.schema || getCurrentSchemaName()`, unlike tables which use the
   search path. An unqualified MV in a non-current schema won't resolve as an MV.
   Single-schema ('main') usage unaffected. Left as-is.
8. **`getSchemaItem` is not MV-aware** — introspection through it surfaces only
   tables/views. User-facing catalog correctly hides backing tables; full MV catalog
   emission is the sibling declarative-schema ticket. Left as-is.
9. **Backing-table `module.create` is immediate** (not catalog-transactional), the
   same as `CREATE TABLE`. Not a regression. Left as-is.

### Findings — major, filed as a new ticket

- **Bag body with duplicate rows fails create/refresh.** A body with no inferable
  key materializes on an all-columns PK; if it emits duplicate rows,
  `replaceBaseLayer` throws a raw `UNIQUE constraint failed: _mv_<name> PK.`
  and the statement fails. A common, intuitive definition (e.g.
  `create materialized view mv as select status from orders`) is therefore
  unusable, and a body that becomes duplicate-producing after source edits fails
  only at the next `refresh`. Not silent corruption (loud failure, keyed bodies
  work), so non-blocking — but the contract should be chosen rather than left as a
  raw constraint error. Filed `tickets/backlog/materialized-view-bag-body-duplicates.md`.

### Test status — all independently re-run and green

- **Build: PASS** (`yarn workspace @quereus/quereus build`, exit 0).
- **Lint: PASS** (`yarn workspace @quereus/quereus lint`, exit 0).
- **Full mocha suite: PASS** (`yarn workspace @quereus/quereus test`) —
  **3703 passing / 0 failing / 9 pending** (51s), matching the implementer handoff.
  (The session's tool channel batched long-command output with heavy latency, so
  these summaries arrived in a delayed flush — but they were directly observed,
  not corroborated.)
- **Coverage assessment** (from the enumerated added tests:
  `test/logic/51-materialized-views.sqllogic`, `test/parser.spec.ts`,
  `test/plan/materialized-view-plan.spec.ts`, `test/logic/change-scope.spec.ts`,
  `test/vtab/concurrent-scan.spec.ts`): happy path, order-by scan order, manual-
  refresh (no auto-update until refresh), read-only boundary (+ source still
  writable), drop cascade, error paths, PK fallback (distinct rows), schema-change
  staleness, and atomic-refresh concurrency are covered. Recommended additions
  (non-blocking, noted for a future pass): a bag body with duplicate rows (the
  filed limitation), a cross-schema unqualified MV reference, and `if not exists`
  when a same-named table/view already exists.

## Follow-on work (already tracked / out of scope of this ticket)

- Sibling `materialized-view-declarative-docs` (prereqs this): declarative-schema
  round-trip / catalog DDL emission of MVs, schema-differ `bodyHash` wiring,
  `docs/materialized-views.md`.
- Backlog: `materialized-view-bag-body-duplicates` (filed by this review),
  `materialized-view-concurrent-refresh`, `materialized-view-incremental-refresh`,
  backing-module pluggability beyond `mem()`, `materialized-view-writes-through-body`,
  lens-layer integration.
