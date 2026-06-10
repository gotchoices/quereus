<!-- resume-note -->
RESUME: A prior agent run on this ticket did not complete.
  Prior run: 2026-06-10T06:15:50.147Z (agent: claude)
  Log file: C:\projects\quereus\tickets\.logs\mv-body-not-rewritten-on-source-rename.implement.2026-06-10T06-15-50-147Z.log
Read the log to see what was done. Resume where it left off.
If the prior run hit a timeout or repeated error, be cautious not to rush into the same situation.
<!-- /resume-note -->
description: ALTER TABLE/COLUMN RENAME must rewrite a dependent materialized view's body in place (parallel to the plain-view rewrite), re-key sourceTables/bodyHash, re-register row-time maintenance, and fire materialized_view_modified — while never clearing a pre-existing stale flag and leaving the MV stale if the rewrite fails mid-way.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                 # propagateTableRenameInSchema / propagateColumnRenameInSchema — add the MV loop (mirrors the plain-view loop)
  - packages/quereus/src/core/database-materialized-views.ts         # subscribeToSchemaChanges, registerMaterializedView, releaseRowTime, emitBackingInvalidation (needs a public stale-marking hook for the failure path)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # deriveBackingShape, backingShapeMatches — re-derive shape for the backing-column rename; recommended home for the new propagation helper(s)
  - packages/quereus/src/schema/view.ts                              # MaterializedViewSchema fields rewritten: selectAst (in place), sql, bodyHash (computeBodyHash), sourceTables, stale
  - packages/quereus/src/schema/ddl-generator.ts                     # generateMaterializedViewDDL — regenerate mv.sql after rewrite
  - packages/quereus/src/schema/rename-rewriter.ts                   # renameTableInAst / renameColumnInAst — reused verbatim on mv.selectAst
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts            # persistence round-trip for the rewritten DDL
  - docs/materialized-views.md                                       # document rename propagation semantics
----

# Rewrite a dependent MV's body on source RENAME (parallel to plain views)

Human disposition (settled): a source table/column rename rewrites a dependent MV's body
exactly as it rewrites a plain view's — "MV ≡ faster view". No design choice remains; this
ticket is the implementation.

## Reproduced behavior at HEAD (fix-stage findings)

With `create table t (id integer primary key, v integer not null)`, one row, and
`create materialized view mv as select id, v from t`:

1. **`alter table t rename to t2`** — `mv.stale` stays `false`, `mv.sourceTables` stays
   `['main.t']`, body unchanged. The staleness listener
   (`database-materialized-views.ts` `subscribeToSchemaChanges`) misses because the
   `table_modified` event carries `objectName = newName` (`t2`) while `sourceTables`
   holds the old key (`main.t`). The row-time plan stays registered under the **old**
   base, so `insert into t2 …` does NOT propagate (`hasRowTimePlanFor('main.t2')` is
   false) — the MV silently serves the pre-rename snapshot. `refresh materialized view mv`
   then errors `Table 't' not found in schema path: main`.
2. **`alter table t rename column v to w`** — here the event key (table name unchanged)
   DOES match `sourceTables`, so the MV is marked stale and its plan released; but the
   body is never rewritten, so both read and refresh die with
   `materialized view 'mv' is stale; … (Column not found: v)` instead of staying live
   like a plain view does.
3. **MV-over-MV** (`mv2 as select … from mv1`) — `mv2.sourceTables` is `['main._mv_mv1']`
   (the backing, whose name keys off the MV name and is unchanged by a *source* rename),
   so only `mv1` needs the rewrite; `mv2`'s frozenness at HEAD is purely inherited from
   `mv1`'s.

Root cause: `propagateTableRenameInSchema` / `propagateColumnRenameInSchema`
(`alter-table.ts:1297` / `:1407`) walk `getAllTables()` + `getAllViews()` only.

## Design

Add an MV loop to both propagation functions, mirroring the plain-view loop (same
same-schema gate — `schema.name.toLowerCase() === renamedSchemaLower` — and the same
in-place AST mutation via `renameTableInAst` / `renameColumnInAst` on `mv.selectAst`).
Recommended structure: keep `alter-table.ts` thin and put the MV-specific rewrite in a
helper in `materialized-view-helpers.ts` (or a `MaterializedViewManager` method) so the
emitter does not import MV internals.

Per MV whose AST changed, inside a per-MV try/catch:

- **Recompute derived fields** on a shallow clone (mirrors the tag setters / plain-view
  loop): `sourceTables` — replace key `${schema}.${old}` → `${schema}.${new}` (table
  rename only; unchanged for column rename); `bodyHash = computeBodyHash(astToString(selectAst))`;
  `sql = generateMaterializedViewDDL(updated)` (the generator reads `selectAst`, so the
  rewritten body round-trips). `schema.addMaterializedView(updated)`.
- **Column rename only — backing-column rename.** The backing table's column names derive
  from the body's output names at create (`deriveBackingShape`). A bare passthrough
  projection of the renamed column shifts the MV's exposed name (plain-view parity:
  `select id, v from t` exposes `w` after `rename column v to w`). Re-derive the shape
  from the rewritten body (`deriveBackingShape(db, bodySql, mv.columns)`) and positionally
  compare names to the live backing; for each mismatch issue a data-preserving
  `module.alterTable({type:'renameColumn'})` on the backing (always a memory table in v1;
  `MemoryTableModule.alterTable` supports it), update the catalog, and fire
  `table_modified` for the backing. Explicit-column MVs (`mv(a,b)`) and
  expression-aliased outputs need no backing change (names pinned). Anything beyond a
  pure name shift (types/PK/count) should not happen for a rename — treat it as a
  failure (leave stale) rather than rebuilding data.
  Note this backing `table_modified` deliberately cascades: a chained MV whose body
  references the **old output name** (`mv2 as select v from mv1`) is marked stale by the
  existing listener and its later re-registration attempt fails → the failure path below
  leaves it stale with a diagnostic — parity with a broken plain-view chain, and strictly
  better than silent freezing. Do NOT attempt transitive output-name rewriting through
  view/MV chains (plain views don't either).
- **Staleness discipline (the critical subtlety).** `stale` means the row-time plan was
  released and the backing data may already be BEHIND (writes during staleness are not
  maintained); only REFRESH can safely clear it. So:
  - Snapshot which MVs were already stale BEFORE the rename statement's first
    `notifyChange` (in `runRenameTable` / `runRenameColumn`, before the notify at
    `alter-table.ts:166` / `:236`) and thread the snapshot into the propagation. The
    column-rename listener marks dependent MVs stale during that notify; the snapshot is
    how the loop distinguishes "stale from this very rename" (safe to clear — no DML can
    interleave within the statement) from "stale from an earlier un-refreshed change"
    (must stay stale).
  - **Previously-not-stale MV**: rewrite → re-register row-time maintenance
    (`db.registerMaterializedView(updated)` — re-plans the body against the
    already-renamed catalog, re-keys `rowTimeBySource` to the new base, recomputes
    `sourceScope`) → restore `stale = false` → fire `materialized_view_modified`
    (store-backed catalogs re-persist via the already-wired `saveMaterializedViewDDL`;
    cached write-through plans holding a `view` dependency invalidate).
  - **Previously-stale MV**: rewrite the AST/sql/bodyHash/sourceTables (so a later
    REFRESH resolves the new name — today it can't) but do NOT re-register and do NOT
    clear `stale`; skip the backing-column rename (refresh's shape-mismatch rebuild
    handles names).
- **Failure path** (rewrite, shape re-derivation, backing rename, or re-registration
  throws): force `mv.stale = true`, release the row-time plan
  (`db.unregisterMaterializedView`), and invalidate cached backing reads so the next
  read re-hits the build-time stale guard — `emitBackingInvalidation` is currently
  private on `MaterializedViewManager`; expose a small public hook (e.g.
  `markMaterializedViewStale(mv)` doing stale+release+invalidate). Log and continue with
  the remaining MVs (propagation is best-effort, per the existing comment); the next read
  surfaces the staleness diagnostic instead of a frozen snapshot.

No change to `subscribeToSchemaChanges` keying is needed: the rename event itself is
handled by the propagation loop, and after the rewrite `sourceTables` carries the new
key, so all future events match consistently. `bodyHash` recompute keeps the
declarative-schema differ from seeing a phantom "body changed → rebuild".

Out of scope: rewriting `insertDefaults` expressions on rename — the sibling fix ticket
`view-insert-defaults-not-rewritten-on-source-rename` owns that for views and should
cover the MV field symmetrically (same `ViewInsertDefault` shape, read identically).

## TODO

Phase 1 — table rename
- Snapshot pre-statement MV staleness in `runRenameTable` and thread it into `propagateTableRename`.
- Add the MV loop to `propagateTableRenameInSchema`: `renameTableInAst` on `mv.selectAst`; on change rewrite `sourceTables` key, `bodyHash`, `sql`; re-register + restore non-stale / preserve stale per the discipline above; fire `materialized_view_modified`.
- Expose the manager stale-marking hook (stale + releaseRowTime + emitBackingInvalidation) and wire the per-MV failure path to it.

Phase 2 — column rename
- Same loop in `propagateColumnRenameInSchema` with `renameColumnInAst`; clear the listener-set staleness only for MVs not stale in the snapshot.
- Backing-column rename: re-derive shape from the rewritten body, positionally rename mismatched backing columns via the module, update catalog, fire the backing `table_modified`; verify the chained-MV staleness cascade lands as described.
- Leave the changed=false-but-stale case (e.g. a `select *` body, where no AST ref names the column) on the existing stale→refresh path.

Phase 3 — tests + docs
- sqllogic (extend `41.3-alter-rename-propagation.sqllogic` or a new `53.x` MV file):
  - table rename: MV stays live — subsequent writes to the renamed source propagate, read and `refresh` both succeed; `sourceTables`/DDL reflect the new name.
  - column rename: MV stays live and exposes the NEW column name (`select w from mv` works, `v` errors); writes maintain; refresh succeeds.
  - explicit-column MV and expression-alias body: output names unchanged, still live.
  - MV-over-MV, base table rename: both stay live; writes cascade through the chain.
  - MV-over-MV, source column rename flowing into mv1's exposed name: mv2 goes stale with the staleness diagnostic on read (not silently frozen).
- spec tests:
  - failure-path: patch `db.registerMaterializedView` to throw once, run the rename, assert `stale === true` and read yields the staleness diagnostic (the disposition's "fails mid-propagation" verification).
  - already-stale-before-rename: make an MV stale (e.g. drop+recreate a source column without refresh), rename the source table, assert it STAYS stale but a subsequent `refresh` now succeeds against the rewritten body.
  - persistence: in `view-mv-ddl-persistence.spec.ts`, assert `generateMaterializedViewDDL` after a rename round-trips the new source name (the `materialized_view_modified` → `saveMaterializedViewDDL` path).
- Update `docs/materialized-views.md` with the rename-propagation semantics (rewrite-in-place, staleness discipline, chained-MV column-rename behavior).
- Run `yarn test` (and lint); `yarn test:store` only if the store ALTER path is touched beyond the already-wired event.
