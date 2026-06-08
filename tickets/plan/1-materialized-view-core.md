description: Materialized views as keyed derived relations — DDL surface (`create materialized view`, `refresh materialized view`, `drop materialized view`), `MaterializedViewSchema`, MemoryTable-backed storage, query resolution to the backing table, manual refresh (phase 1), schema-change invalidation, lifecycle. Substrate beneath the lens layer and the prerequisite for incremental refresh and covering-structure enforcement.
files: packages/quereus/src/schema/view.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/catalog.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/planner/building/create-view.ts, packages/quereus/src/planner/nodes/create-view-node.ts, packages/quereus/src/runtime/emit/, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/core/database.ts, docs/architecture.md, docs/incremental-maintenance.md, docs/optimizer.md, docs/lens.md, docs/schema.md
----

## Scope

This ticket establishes the **substrate** for materialized views as "keyed derived relations" in Quereus terms — stored relations defined by a query, primary-keyed, addressable like any virtual table. Phase 1 is manual full-refresh; incremental refresh (phase 2) and covering-structure enforcement are siblings via `prereq:` and tracked separately.

This is the read-cache MV concern, framed deliberately narrow so the lens layer (`docs/lens.md`) and the covering ticket can build on top without churning the substrate.

## Design

Most of the framing already lives in `docs/lens.md` (§ Relationship to Materialized Views) and `docs/incremental-maintenance.md` (§ Plug-in pattern for future consumers). The new shape:

### Syntax

```sql
create materialized view mv_name as <select>;
refresh materialized view mv_name;
drop materialized view mv_name;
```

`<select>` is a `QueryExpr` (per `docs/sql.md#query-expressions`) — `select`, `values`, or compound. DML bodies remain rejected (same rationale as `create view`: a body that writes per read is incoherent).

`order by` is allowed in the body and is significant: it describes the clustered/ordered layout of the backing structure. A materialized view with `order by` is what `docs/lens.md` calls a "materialized index"; the covering-structure ticket (`covering-structure-unique-enforcement`) lights this up for UNIQUE enforcement.

Backing-module pluggability (`create materialized view ... using mod(...)`) is parsable-but-restricted-to-`mem()` in v1 — the AST carries the slot so the future module choice is additive, not breaking.

### `MaterializedViewSchema`

Sibling of `ViewSchema` (do **not** extend — different lifecycle, different invariants):

```ts
interface MaterializedViewSchema {
  name: string;
  schemaName: string;
  sql: string;              // original DDL text (round-trippable)
  selectAst: AST.QueryExpr; // body
  columns?: ReadonlyArray<string>;
  tags?: Readonly<Record<string, SqlValue>>;

  /** Backing-table identity. Same schemaName; conventional naming. */
  backingTableName: string;

  /** Inferred primary key of the view's relational output, from
   *  `keysOf` on the optimized body (`unified-key-inference-surface`).
   *  When `keysOf` returns no usable key, fallback is the all-columns key
   *  (Quereus default) — and this MV is incremental-ineligible until
   *  Phase 2 sharpens the surface. */
  primaryKey: ReadonlyArray<{ index: number; desc: boolean }>;

  /** Hash of the optimized body's structural shape. Used by the
   *  declarative-schema differ to detect "body changed → rebuild". */
  bodyHash: string;
}
```

The MV is also registered as a `TableSchema` with `isView: true`-style bridging so existing planner code that walks tables sees it, but the row source is the backing table (not the deferred body). This dual-registration is the existing trick `ViewSchema` already uses; we extend the predicate that picks "view body vs backing table" at resolution.

### Backing-table generation

On `create materialized view`:

1. Build + optimize the body.
2. Derive PK from `keysOf` on the optimized output (with the all-columns fallback noted above).
3. Create a backing `TableSchema` via the standard memory-vtab path (`vtab/memory/table.ts`), with PK from (2) and columns matching the body's output attributes.
4. Run the body and bulk-insert results into the backing table (initial materialization). Failures roll back the `create`.
5. Register the `MaterializedViewSchema` in `SchemaManager` alongside the backing table; emit `schema_change` for `materialized_view_added`.

### Query resolution

When a `<name>` resolves to a `MaterializedViewSchema`, the planner emits a `TableReferenceNode` to the **backing table**, not a body-expanded view. This is a one-line decision in name resolution (parallel to today's `isView` branch). Effects:

- Optimizer sees a `TableReferenceNode` with the backing-table's full physical-property surface (`computePhysical` already does this work) — keys, FDs, ordering, statistics — at zero extra cost.
- `getChangeScope()` reports the **backing table**, not the source tables. Reactive consumers watching an MV watch the backing table. This is the correct semantics: an MV is a stable relation whose change cadence is "when refresh fires," not "when sources change." (Phase 2 sharpens this for `on-commit-incremental` MVs to source-union; see `materialized-view-incremental-refresh`.)
- The MV body AST is still retained on the schema for declarative-schema emission and for the body-hash check.

### Mutation semantics: read-only at the user-write boundary (v1)

`insert into mv`, `update mv set ...`, and `delete from mv` are **rejected** in v1 with a clear diagnostic: *"materialized views are read-only; write to the source tables instead."*

Rationale: an MV is defined by its body, not by its cache. The orthogonal answer ("writes propagate through the body to the sources") requires the [view-updateability propagation pass](view-updateability-implementation), which is a separate, sizeable plan ticket — not yet shipped despite `docs/view-updateability.md` describing it. When `view-updateability-implementation` lands, writes against an MV name *will* route through that pass against the MV's `selectAst` (with the backing table then catching up via manual or incremental refresh), but adding that surface to this ticket would couple two large independent features.

So: v1 ships read-only MVs. The write-through path is a follow-up that gates on view-updateability landing; file as `materialized-view-writes-through-body` (backlog) when ready. The MV body AST is already retained on the schema, so enabling write-through later is purely a routing change with no schema-shape implication.

Source tables remain writable via the normal `insert into source_table` path; MV reads see the new state at the next refresh (manual phase 1) or at commit (`on-commit-incremental`, phase 2).

### Refresh execution

`refresh materialized view mv_name`:

1. Acquire an exclusive lock on the backing table (the existing `MemoryTable.SchemaChange` latch shape).
2. Run the body to completion into a buffer (or directly into a fresh `BaseLayer` for the memory case).
3. Swap the backing table's base layer atomically.
4. Emit a `schema_change` for `materialized_view_refreshed` so the assertion / watch invalidation paths catch it.

Concurrent reads during refresh are **not supported in v1** (no `concurrently` option). A reader will block on the latch — this is acceptable for the initial cut and consistent with how `ALTER TABLE` already behaves. `concurrently` is a separate backlog item (see "Out of scope").

### Schema-change invalidation

Mirror `AssertionEvaluator` (`packages/quereus/src/core/database-assertions.ts`):

- Subscribe to `SchemaChangeNotifier` events.
- On `table_removed` or `table_modified` for any source table of an MV: mark the MV stale. A subsequent reference (or the next `refresh`) re-validates the body against the new source schema; if validation fails, the MV's reference errors with a clear "MV `X` is stale; source `Y` changed in incompatible ways" message until dropped/recreated.
- On `materialized_view_*` events: invalidate any cached plans that reference the MV (mirrors how view-body changes already invalidate).

### Drop

`drop materialized view mv_name`:

1. Detach any `DeltaSubscription` for this MV (phase 2 consumer).
2. Drop the backing table.
3. Remove the `MaterializedViewSchema` from the catalog.
4. Emit `materialized_view_removed`.

### Declarative-schema integration

`declare schema { ... }` accepts `create materialized view`; the differ uses `bodyHash` to recognize body-change-rebuild and `selectAst` round-tripping to emit canonical DDL on schema export. Initial-materialization is rerun on body change (a separate transaction, deferred until apply time).

## Resolved Open Questions (from parent ticket)

- **Backing module choice.** MemoryTable in v1; AST carries a `using mod(...)` slot so future module pluggability is additive. Decision rationale: basis-layer concern; the standard row-store is the right default; non-trivial alternative modules need their own write/swap semantics worked out separately.
- **Concurrent refresh.** Deferred. v1 holds the table latch through `refresh`. Backlog item: `materialized-view-concurrent-refresh`.
- **Schema-change handling.** Mirror `AssertionEvaluator`: subscribe to `SchemaChangeNotifier`, mark stale on source-table modification, re-validate on next reference.

## Out of scope (file in backlog/ after this lands)

- **`refresh materialized view ... concurrently`** — needs an MVCC-aware swap that exploits the layer model but has its own correctness story (readers see old, writers see new during the swap window).
- **Materialized-view ON COMMIT REFRESH** (auto-refresh on source change) — Phase 2 sibling ticket (`materialized-view-incremental-refresh`).
- **Backing-module pluggability beyond `mem()`** — out of v1; AST is forward-compatible.
- **Lens-layer integration** — separately tracked under the lens plan tickets; this ticket lands the substrate the lens-prover-and-constraint-attachment ticket consumes.

## Implementation Surface

- `packages/quereus/src/parser/ast.ts` — `CreateMaterializedViewStmt`, `RefreshMaterializedViewStmt`, `DropMaterializedViewStmt`. The `Drop` AST can extend the existing `DropStmt` with a new `kind: 'materialized-view'` discriminator; the create AST shares structure with `CreateViewStmt` plus a backing-module slot.
- `packages/quereus/src/parser/parser.ts` — `create materialized view`, `refresh materialized view`, `drop materialized view`. Lowercase-reserved-word style per repo convention.
- `packages/quereus/src/schema/view.ts` — add `MaterializedViewSchema` sibling.
- `packages/quereus/src/schema/manager.ts` + `catalog.ts` — registration / lookup paths for `MaterializedViewSchema` alongside the existing view/table maps.
- `packages/quereus/src/planner/building/create-view.ts` (extend) or a sibling `create-materialized-view.ts` — build flow for create + refresh + drop. Body-arity validation reuses `planViewBody` from create-view.
- `packages/quereus/src/planner/nodes/create-view-node.ts` + sibling refresh/drop nodes.
- `packages/quereus/src/runtime/emit/` — emitters for the three new plan nodes; the refresh emitter is the load-bearing one (bulk re-execute body, swap base layer).
- `packages/quereus/src/vtab/memory/table.ts` (+ `layer/manager.ts`) — backing-table creation helper; the swap-base-layer primitive for refresh (likely already 90% there via the existing schema-change paths).
- `packages/quereus/src/core/database.ts` — wire the schema-change subscription that flags stale MVs.
- `packages/quereus/src/schema/ddl-generator.ts` — round-trip MV DDL for declarative-schema export.
- `packages/quereus/src/schema/schema-differ.ts` + `schema-hasher.ts` — diff/hash MV bodies via `bodyHash`.
- **New doc: `docs/materialized-views.md`** — graduate the design here (the parent ticket's framing + this ticket's API). Register in `docs/architecture.md`'s docs list. Cross-reference from `docs/optimizer.md`, `docs/schema.md`, `docs/incremental-maintenance.md`, `docs/lens.md` exactly the way `change-scope.md` and `incremental-maintenance.md` are referenced today.
- **Doc fix:** `docs/incremental-maintenance.md`, `docs/optimizer.md`, and `docs/lens.md` currently reference `tickets/backlog/known/updatable-views.md` as the planned-consumer ticket — that ticket no longer exists at that path. Update those references to point to `docs/materialized-views.md` (or this ticket's complete summary) once it lands.

## Key Tests (TDD seeds for implement stage)

- **DDL round-trip.** `create materialized view mv as select x, y from t` survives `schema -> DDL emit -> parse -> schema` with no shape change (rides the `declarative-equivalence` harness — `test/declarative-equivalence.spec.ts`).
- **Initial materialization correctness.** Insert into `t`; create MV; assert MV rows equal `select x, y from t`. With `order by`: assert MV scan order matches.
- **Source mutation does NOT update MV (phase 1).** Insert into `t` after MV creation; assert MV rows unchanged until `refresh materialized view`.
- **Read-only at user-write boundary.** `insert into mv values (...)`, `update mv set ...`, `delete from mv` all reject with the "materialized views are read-only" diagnostic. Source-table writes (`insert into t ...`) succeed normally and are reflected in the MV after refresh.
- **Refresh swaps base atomically.** A reader iterating the MV during a `refresh` from another connection blocks until the refresh completes, then sees the new state (no half-state visible). Add to `test/vtab/concurrent-scan.spec.ts` shape.
- **Query resolution.** A `select * from mv` plan contains a `TableReferenceNode` to the backing table, not an expanded body. Use the golden-plan harness.
- **`getChangeScope()` reports backing table.** Watching an MV watches the backing table; phase 2 sharpens to sources.
- **Schema-change invalidation.** Drop source table → MV reference errors with "stale" diagnostic. `alter table` on source that breaks body planning → same.
- **Drop cascades.** `drop materialized view mv` drops backing table and emits the schema-change event.
- **PK fallback.** An MV whose body yields no `keysOf`-derived key gets the all-columns PK; document this in the new doc.
- **`sqllogic` corpus.** A new file under `test/logic/` covering create/refresh/drop, the resolution-to-backing-table behavior, and error paths (refresh on missing MV, drop on missing MV, drop materialized view on a non-MV name).

## TODO (implement stage)

Phase A — parser & schema
- Add the three AST nodes; extend parser; add unit-level parse tests.
- Add `MaterializedViewSchema` and the catalog registration paths; bridge dual-registration as `TableSchema` for the resolution layer.
- Wire DDL round-trip in `ddl-generator.ts` and diff/hash in the schema-differ/hasher.

Phase B — runtime
- Build flow for `create materialized view`: optimize body, derive PK via `keysOf`, create backing table, execute body, bulk-insert.
- Refresh emitter: latch + rebuild + atomic swap.
- Drop emitter: detach subscriptions + drop backing + unregister.

Phase C — resolution & invalidation
- Name-resolution branch that picks the backing table for MV references.
- Schema-change subscription that marks MVs stale; staleness diagnostic at next reference.

Phase D — docs & tests
- New `docs/materialized-views.md` (substrate framing + API).
- Update cross-refs in `docs/architecture.md`, `docs/optimizer.md`, `docs/incremental-maintenance.md`, `docs/lens.md`, `docs/schema.md`.
- Sqllogic corpus + golden-plan + declarative-equivalence coverage per "Key Tests" above.
