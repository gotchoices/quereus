description: ALTER TABLE/COLUMN RENAME does not rewrite a dependent materialized view's body AND does not mark the MV stale, because the rename-propagation loops never walk getAllMaterializedViews() and the MV staleness listener matches the rename event by the NEW table name while the MV's sourceTables still holds the OLD name. Surfaced as the "secondary note" scope-check in `view-body-rewrite-fires-no-schema-event`.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                 # propagateTableRename / propagateColumnRename — walk getAllTables()+getAllViews() only, never MVs
  - packages/quereus/src/core/database-materialized-views.ts         # subscribeToSchemaChanges — marks MV stale when event key matches mv.sourceTables
  - packages/quereus/src/schema/view.ts                              # MaterializedViewSchema.sourceTables / selectAst / bodyHash
----

# Materialized views are neither rewritten nor reliably marked stale on a source RENAME

## The gap

`ALTER TABLE t RENAME TO t2` (and `RENAME COLUMN`) propagate the rename into dependent
**tables** (CHECK/FK) and **plain views** (body AST rewrite), but **not** into materialized
views — `propagateTableRename` / `propagateColumnRename` iterate `schema.getAllTables()` and
`schema.getAllViews()` and never touch `schema.getAllMaterializedViews()`. So an MV whose body
names a renamed source keeps its old `selectAst` (`select … from t`).

Worse, the MV's normal safety net — staleness — also misses a rename:
`MaterializedViewManager.subscribeToSchemaChanges` marks an MV stale when an incoming
`table_modified` / `table_removed` event's key `${schemaName}.${objectName}` is in
`mv.sourceTables`. A table rename fires `table_modified` with `objectName = newName` (`t2`),
but the MV's `sourceTables` still lists the **old** key (`main.t`). The keys don't match, so
the MV is **not even marked stale**.

## Observable consequence

After `alter table t rename to t2`, an MV `mv as select … from t`:

1. is not stale and still resolves `select … from mv` to its backing table → silently serves
   the **pre-rename snapshot** (no error, possibly wrong after later writes to `t2`);
2. on `REFRESH MATERIALIZED VIEW mv`, re-validates its body `select … from t` → `t` no longer
   exists → errors.

So a rename converts an MV from "live, maintained" to "frozen snapshot that explodes on
refresh," with no event and no staleness signal in between.

## Why this is filed separately

The parent ticket (`view-body-rewrite-fires-no-schema-event`, now the implement ticket
`view-body-rewrite-fires-view-modified`) is narrowly about firing a `view_modified` event when
a rename rewrites a **plain** view body — a one-line-per-loop event fix. This MV gap is a
distinct, larger design question:

- Should a source rename **rewrite** the MV body in place (parallel to the plain-view rewrite),
  then re-persist + re-register maintenance? Or
- Should it at minimum **mark the MV stale** (fix the staleness-listener name-matching so a
  rename is caught), deferring the body correction to REFRESH? Or
- Should rename of a table that has dependent MVs be **rejected** until the MV is dropped?

It spans body-rewrite, the staleness `sourceTables` keying, optionally re-registration of
row-time maintenance, and store re-persistence — too much for the plain-view event ticket, and
it needs a design pass to pick among the options above. Promote from backlog when ready to
design.

## Notes for the eventual design pass

- The staleness mismatch is the cheapest partial fix and is independently a correctness bug:
  even without body rewrite, an MV over a renamed source should at least go stale so a stale
  read/refresh surfaces a diagnostic rather than a frozen snapshot.
- If the body IS rewritten, `MaterializedViewSchema.sourceTables` and `bodyHash` must be
  recomputed, and the MV maintenance manager re-registered (the row-time plan references the
  old source name). Confirm interaction with `database-materialized-views.ts`
  `releaseRowTime` / `emitBackingInvalidation`.
- Decide whether a store-backed catalog re-persists the MV via `materialized_view_modified`
  (already wired to `saveMaterializedViewDDL` in `store-module.ts`) — same reuse argument as
  the plain-view `view_modified` decision.

## Disposition (2026-06-09, human decision)

**Full rewrite — parallel to plain views.** The design question above is settled: a source
table/column rename rewrites a dependent MV's body exactly as it rewrites a plain view's
(option 1), consistent with the "MV ≡ faster view" stance. The staleness-listener keying fix
is subsumed (rewrite updates `sourceTables`, so the keying becomes consistent), but verify a
rename that *fails* mid-propagation still leaves the MV stale rather than silently frozen.

Fix-stage scope: reproduce both observable consequences (frozen-snapshot read; REFRESH error),
then emit implement ticket(s) covering:

- `propagateTableRename` / `propagateColumnRename` walk `getAllMaterializedViews()` and rewrite
  `selectAst` like plain views;
- recompute `sourceTables` + `bodyHash`, re-register row-time maintenance (the cached plan
  references the old source name — see `releaseRowTime` / registration in
  `database-materialized-views.ts`);
- fire `materialized_view_modified` so a store-backed catalog re-persists
  (`saveMaterializedViewDDL` is already wired in `store-module.ts`);
- MV-over-MV: a renamed source under a chained MV cascades the rewrite/keying correctly;
- backing table itself is NOT renamed (`_mv_<name>` keys off the MV name, which is unchanged).
