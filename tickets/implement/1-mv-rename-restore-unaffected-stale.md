----
description: After ALTER … RENAME, restore dependent MVs the rename provably did not affect — those marked stale by this statement whose unchanged body still derives the same backing shape — instead of leaving them silently stale with writes no longer propagating.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # restoration pass + shared restore tail; deriveBackingShape, describeBackingShapeMismatch, renameShiftedBackingColumns, applyMaterializedViewRewrite, snapshotStaleMaterializedViews, mvStaleKey
  - packages/quereus/src/runtime/emit/alter-table.ts                 # propagateTableRename / propagateColumnRename — call the restoration pass after the per-schema loops
  - packages/quereus/src/core/database-materialized-views.ts         # subscribeToSchemaChanges (context only — the listener stays as-is in this ticket)
  - packages/quereus/test/logic/53.2-materialized-view-rename-propagation.sqllogic
  - packages/quereus/docs/materialized-views.md
----

# Restore provably-unaffected MVs after a source rename

## Bug (reproduced on the live engine)

A rename statement marks **every** dependent MV stale via the schema-change
listener (`subscribeToSchemaChanges` marks any MV whose `sourceTables` contains a
`table_modified` table, and detaches its row-time plan). The rename propagation
(`propagate{Table,Column}RenameToMaterializedViews`) then restores only MVs whose
**AST changed** (or, for table rename, whose `sourceTables` carries the old base).
An MV the rename provably does not affect falls through the `continue` and is left
stale-but-valid: reads serve the now-unmaintained backing **silently**, and writes
to the source never appear until a manual REFRESH.

Three concrete flows, all verified failing today:

1. **Unreferenced column rename** — `alter table t rename column v to w` with
   `mv as select id, u from t`: the `table_modified(t)` notify in `runRenameColumn`
   marks `mv` stale; `renameColumnInAst` returns false (body never names `v`) →
   `continue` → stale forever. A subsequent `insert into t` is invisible in `mv`.

2. **Constraint-only rewrite of another source** — `alter table t rename to t2`
   where `u` has `tid references t (id)` and `mvu as select id, tid from u`: the
   table loop in `propagateTableRenameInSchema` rewrites `u`'s FK
   `referencedTable` and fires `table_modified(u)` → listener marks `mvu` stale;
   the MV loop skips it (AST unchanged, `sourceTables = ['main.u']` lacks
   `main.t`) → stale forever.

3. **`select *` body, column rename** — exposure follows the rename (a pure
   name shift in the body's output), but the AST is unchanged → skipped → the MV
   serves the backing with the **old** column name, silently stale.

Both stalenesses are **statement-local**: they are set *after* the `preStaleMvs`
snapshot the rename emitters already take (`snapshotStaleMaterializedViews` runs
before the statement's first notify in both `runRenameTable` and
`runRenameColumn`). So the existing snapshot discipline cleanly distinguishes them
from a pre-existing stale flag, which must never be cleared (the backing may be
behind; only REFRESH may clear it).

## Fix design

Add a **restoration pass** that runs once at the end of `propagateTableRename` and
`propagateColumnRename` (after all per-schema loops, so all rewrites, backing
column renames, and cascade events have already fired). For every MV in **every
schema** (the listener marks cross-schema dependents too — the table loop walks all
schemas) where `mv.stale && !preStale.has(mvStaleKey(mv))`:

1. Re-derive the backing shape from the (possibly already-rewritten, possibly
   unchanged) body against the renamed catalog: `deriveBackingShape(db,
   astToString(mv.selectAst), mv.columns)`.
2. If `describeBackingShapeMismatch(liveBacking, shape)` reports a **structural**
   mismatch → leave stale (REFRESH's shape-mismatch rebuild owns that).
3. Otherwise the rename was a no-op or a pure name shift on this MV:
   `renameShiftedBackingColumns` carries any shifted output names onto the live
   backing (it no-ops when names already match, fires the backing
   `table_modified` itself when it renames — which correctly cascades staleness
   to chained MVs referencing the old output name), then
   `db.registerMaterializedView(mv)` re-registers row-time maintenance, then
   `mv.stale = false`. Register BEFORE clearing stale, mirroring
   `applyMaterializedViewRewrite`.
4. Any per-MV throw (body no longer plans, module lacks `alterTable`,
   registration fails) → catch, log, leave stale, continue with the rest —
   best-effort like the rest of the propagation.

Notes / invariants:

- **Do NOT fire `materialized_view_modified`** from the restoration pass: the MV
  record (AST, hash, sql, sourceTables) is unchanged for these MVs; `stale` is
  runtime state, not persisted. (`renameShiftedBackingColumns` fires its own
  backing `table_modified` when it actually renames.)
- The pass naturally re-restores an MV that `applyMaterializedViewRewrite`
  restored earlier in the statement but a later cascade event re-staled — and
  naturally leaves stale a chained MV whose body references a renamed-away output
  name (shape derivation throws). Test §6 of the existing sqllogic
  (`n2` stays stale) must remain green.
- MVs already restored by the changed-AST path have `stale === false` and are
  excluded by the filter — no double work.
- Cost: one `getAllMaterializedViews` walk per rename statement; body re-planning
  only for MVs marked stale by this statement. Unaffected statements pay ~nothing.
- Consider extracting the shared tail (`renameShiftedBackingColumns` →
  `registerMaterializedView` → `stale = false`) from
  `applyMaterializedViewRewrite` into a small helper both paths call, so the
  restore discipline cannot drift. Resolve the owning `Schema` per MV via
  `db.schemaManager.getSchemaOrFail(mv.schemaName)` (renameShiftedBackingColumns
  needs it).

This intentionally upgrades the previously-settled "`select *` stays stale on
column rename" behavior to live-with-name-shift — consistent with the
bare-passthrough body-rewrite semantics already shipped (53.2 §2). The
constraint-only `table_modified` listener refinement (avoiding the spurious
stale-mark entirely, also outside renames) is deliberately **not** in this ticket
— see backlog `mv-staleness-constraint-only-table-modified` for the design and its
soundness caveats.

## Reproductions (must become live after the fix)

```sql
-- 1: unreferenced column rename
create table t (id integer primary key, v integer not null, u integer not null);
insert into t values (1, 10, 100);
create materialized view mv as select id, u from t;
alter table t rename column v to w;
insert into t values (2, 20, 200);
select id, u from mv order by id;            -- expect BOTH rows; today: only row 1
refresh materialized view mv;                -- must keep working

-- 2: constraint-only rewrite of another source
create table t (id integer primary key);
create table u (id integer primary key, tid integer references t (id));
create materialized view mvu as select id, tid from u;
alter table t rename to t2;
insert into t2 values (1);
insert into u values (2, 1);
select id from mvu;                          -- expect [{id:2}]; today: []

-- 3: select * pure name shift
create table t (id integer primary key, v integer not null);
insert into t values (1, 10);
create materialized view mvs as select * from t;
alter table t rename column v to w;
select id, w from mvs;                       -- expect new name exposed + live
insert into t values (2, 20);
select id, w from mvs order by id;           -- expect both rows
```

## TODO

- Add the restoration helper (e.g. `restoreUnaffectedMaterializedViews(db, preStale)`) to `materialized-view-helpers.ts`; extract the shared restore tail from `applyMaterializedViewRewrite` so both paths use one code path.
- Call it at the end of `propagateTableRename` and `propagateColumnRename` in `alter-table.ts` (after the per-schema loops).
- Extend `test/logic/53.2-materialized-view-rename-propagation.sqllogic` with the three reproductions above (live writes + refresh after restore); verify existing §1–§9 stay green, especially §6 (`n2` stays stale).
- Update `docs/materialized-views.md` (rename-propagation / staleness section) to document the restored-when-provably-unaffected semantics and the `select *` name-shift upgrade.
- `yarn build`, `yarn test`, and `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
