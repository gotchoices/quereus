description: Review — ALTER TABLE/COLUMN RENAME now rewrites dependent MV bodies in place (parallel to plain views): sourceTables/bodyHash/sql re-keyed, backing columns renamed on output-name shift, row-time maintenance re-registered, materialized_view_modified fired; pre-existing stale flags preserved and failures leave the MV stale.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # NEW: snapshotStaleMaterializedViews, propagate{Table,Column}RenameToMaterializedViews, applyMaterializedViewRewrite, renameShiftedBackingColumns, backingColumnDef, failMaterializedViewRenamePropagation; backingShapeMatches refactored over describeBackingShapeMismatch
  - packages/quereus/src/runtime/emit/alter-table.ts                 # pre-statement staleness snapshot in runRenameTable/runRenameColumn; propagate* made async; MV loop called inside the same-schema gate after the view loop
  - packages/quereus/src/core/database-materialized-views.ts         # NEW public MaterializedViewManager.markMaterializedViewStale (stale + releaseRowTime + emitBackingInvalidation)
  - packages/quereus/src/core/database.ts                            # thin markMaterializedViewStale wrapper
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic   # NEW behavioral suite (passes memory AND store mode; verified to FAIL at HEAD)
  - packages/quereus/test/mv-rename-propagation.spec.ts              # NEW catalog-level spec (derived fields, staleness discipline, failure path, MV-through-view)
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts            # NEW section: RENAME fires materialized_view_modified with round-trippable DDL
  - docs/materialized-views.md                                       # § Rename propagation ("MV ≡ faster view") under Schema-change staleness
----

# Implemented: MV body rewrite on source RENAME (parallel to plain views)

Human disposition (settled in fix stage): a source table/column rename rewrites a
dependent MV exactly as it rewrites a plain view — "MV ≡ faster view". This landed as
specified; the design's staleness discipline and failure path are implemented verbatim,
with the divergences and extensions noted below.

## What was built

**Propagation helpers** (`materialized-view-helpers.ts`, kept out of the ALTER emitter
per the ticket's structure recommendation):

- `snapshotStaleMaterializedViews(db)` — lowercased `schema.name` keys of every stale
  MV; called in `runRenameTable`/`runRenameColumn` BEFORE the statement's first
  `notifyChange`, threaded into the propagation.
- `propagateTableRenameToMaterializedViews` — processes an MV when `renameTableInAst`
  changed its body **or** its `sourceTables` carries the old base (see Extensions);
  re-keys `sourceTables` old→new, re-keys the `covers.tableName` reverse link.
- `propagateColumnRenameToMaterializedViews` — processes only changed-AST MVs
  (`sourceTables` is table-keyed; unchanged-AST-but-stale MVs, e.g. `select *` bodies,
  deliberately stay on the stale→REFRESH path per the ticket).
- `applyMaterializedViewRewrite` (shared core) — shallow clone with new `bodyHash`
  (`computeBodyHash(astToString(selectAst))`) and `sql`
  (`generateMaterializedViewDDL(updated)`, reads the rewritten AST so DDL round-trips);
  `schema.addMaterializedView(updated)`. If the MV was NOT stale pre-statement:
  backing-column rename (column path only) → `db.registerMaterializedView(updated)`
  (re-plans against the renamed catalog, re-keys `rowTimeBySource`, recomputes
  `sourceScope`) → `stale = false`. `materialized_view_modified` fires in BOTH cases
  (stale MVs too — the rewritten DDL must re-persist so a post-reopen REFRESH resolves
  the new name; the store's `saveMaterializedViewDDL` listener was already wired).
- `renameShiftedBackingColumns` — re-derives the shape from the rewritten body,
  asserts a *pure name shift* via the new name-blind structural compare (anything
  beyond names → throw → failure path, no data rebuild), positionally renames shifted
  backing columns via `module.alterTable({type:'renameColumn'})` (data-preserving),
  updates the catalog, fires the backing `table_modified` — which deliberately
  cascades staleness to chained MVs referencing the old output name.
- Failure path: per-MV try/catch → `db.markMaterializedViewStale(live)` (new manager
  hook: stale flag + `releaseRowTime` + `emitBackingInvalidation`) → log and continue.

**Staleness discipline**: a stale flag that predates the statement is never cleared —
the body/sql/hash/sources are still rewritten (so a later REFRESH resolves the new
name; before this fix REFRESH errored `Table 't' not found`), but no re-registration,
no backing rename, flag stays. Statement-local staleness (the column-rename notify
marks every dependent MV stale) is restored after a successful rewrite.

## Divergences / judgment calls (reviewer attention here)

1. **Failure-path read does NOT always show the staleness diagnostic.** The ticket's
   design text said "the next read surfaces the staleness diagnostic instead of a
   frozen snapshot". The build-time stale guard (`building/select.ts`) only errors when
   the body *fails to plan*; after a successful rewrite + failed re-registration the
   body is valid, so a read serves the marked-stale (unmaintained) backing — the same
   semantic as every other stale-but-valid MV in the engine. The spec test asserts the
   honest behavior: `stale === true`, writes do not propagate, REFRESH fully recovers.
   Changing read semantics for stale-but-valid MVs was out of scope.
2. **LogicalType comparison switched from identity to case-insensitive NAME** in the
   (refactored) `backingShapeMatches`/`describeBackingShapeMismatch`. Required: in
   store mode the store module rebuilds its `TableSchema` with fresh `LogicalType`
   instances after an ALTER, so identity is spuriously false (`INTEGER → INTEGER`
   mismatch). Types resolve through the name-interned registry and round-trip through
   DDL by name, so name equality is the correct semantic. **Side effect**: refresh's
   data-only fast path can now be taken in store mode where the identity compare
   previously forced the drop+recreate branch. Both full suites pass; worth a look.
3. **Table rename also processes an unchanged-AST MV whose `sourceTables` carries the
   old base** — an MV reading the renamed table *through a plain view* (`mv as select
   … from v`, `v as select … from t`). Its AST never names `t`, but its row-time plan
   is keyed under `main.t`; without this extension the MV silently freezes after the
   rename (plan keyed to a dead base). Covered by a dedicated spec test.
4. **`materialized_view_modified` fires for still-stale MVs too** (the ticket listed
   the event under the previously-not-stale bullet only). Rationale: persistence of the
   rewritten DDL matters regardless of staleness. Cost: a cached plan holding a `view`
   dependency on a stale MV invalidates — harmless.
5. **`covers.tableName` reverse link re-keyed on table rename** (not in the ticket's
   TODO, but prevents a dangling convenience pointer; the authoritative forward pointer
   rides the renamed TableSchema object unchanged).

## Known gaps / not addressed

- A chained MV (`mv2` over `mv1`) whose AST is unchanged stays stale after a source
  column rename even when its body still validates (e.g. `select id from mv1`, not
  touching the renamed output) — pre-existing cascade behavior, per the ticket's
  "changed=false-but-stale stays on the stale→refresh path". A user must REFRESH it.
- MVs in OTHER schemas referencing the renamed table schema-qualified are not
  rewritten — exact parity with the plain-view loop's same-schema gate.
- `sourceScope` on a preserved-stale MV keeps the old base until REFRESH re-registers
  (a `Database.watch` on a stale MV across a rename projects to a dead base) —
  pre-existing class of stale-MV watch imprecision, untouched.
- `insertDefaults` expression rewrite on rename: owned by sibling ticket
  `view-insert-defaults-not-rewritten-on-source-rename` (should cover the MV field
  symmetrically — same `ViewInsertDefault` shape).

## Validation performed (floor, not ceiling)

- `packages/quereus`: `yarn test` 5574 passing; `yarn test:store` 5570 passing
  (store suite run because the shape-compare change affects refresh under store);
  `yarn lint` clean; `tsc --noEmit` clean. Root `yarn test` (all workspaces) green.
- New sqllogic `53.2-materialized-view-rename-propagation.sqllogic` verified to FAIL
  at HEAD with the src changes stashed (frozen MV after table rename), passes in both
  memory and store modes. Covers: table rename keeps MV live (writes propagate,
  REFRESH works); column rename exposes the NEW name (`select w` works, `select v`
  errors) and stays live; explicit-column and expression-alias bodies keep pinned
  names and stay live; MV-over-MV base-table rename cascades writes through the chain;
  MV-over-MV column rename flowing into mv1's exposed name leaves mv2 with the
  staleness diagnostic on read AND on refresh.
- `mv-rename-propagation.spec.ts`: sourceTables/bodyHash/sql re-key + single
  `materialized_view_modified` (no `_added`); backing column renamed in place with
  data preserved; MV-through-view re-key; pre-existing stale survives rename and
  REFRESH then succeeds against the rewritten body; injected
  `registerMaterializedView` failure → stale, frozen, REFRESH recovers.
- `view-mv-ddl-persistence.spec.ts` new section: rename events carry a schema whose
  regenerated DDL names the new source/column, re-parses, and equals the stored `sql`
  (no drift); unrelated MVs fire no event.

## Review suggestions

- Adversarial reading of the staleness snapshot/restore: any path where DML could
  observe a window between the rename notify and re-registration? (Design relies on
  no DML interleaving within one statement.)
- The name-based type compare (divergence 2) — check nothing relied on identity
  inequality to force backing rebuilds (e.g. a custom registered type mutated and
  re-registered under the same name).
- `renameShiftedBackingColumns` renames columns one at a time; a pathological swap
  (`a→b, b→a` in one statement) is impossible for a single-column RENAME, but confirm
  no multi-mismatch ordering hazard (two outputs both shifting names cannot collide:
  only one source column was renamed, names are distinct post-rewrite).
- Memory-module-only assumption: backing is always memory in v1 (`buildBackingTableSchema`),
  and `renameShiftedBackingColumns` routes through `requireVtabModule(backing)` +
  `alterTable` generically with an UNSUPPORTED throw — confirm acceptable for v2 modules.
