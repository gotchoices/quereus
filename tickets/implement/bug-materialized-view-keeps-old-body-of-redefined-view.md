description: A materialized view built on an ordinary view keeps computing from that view's old definition after the view is dropped or redefined; dropping a view a materialized view reads should mark the materialized view stale, just as dropping one of its source tables does.
architecture: docs/mv-schema-change.md
files:
  - packages/quereus/src/schema/derivation.ts # TableDerivation — add sourceViews next to sourceTables
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # BackingShape / deriveBackingShapeUnguarded (~157, uses db.getPlan, drops the dependency tracker), buildTableDerivation (~598), refresh reshape (~2852 assigns sourceTables), tryRecompileMaterializedViewLive (~2309)
  - packages/quereus/src/core/database-materialized-views.ts # subscribeToSchemaChanges (~128) — add a view_removed arm
  - packages/quereus/src/core/database.ts # _buildPlan (~2734) returns schemaDependencies; getPlan (~2533) discards them
  - packages/quereus/src/planner/building/select.ts # ~575 records a `view_read` dependency for every inlined view body (transitive — nested bodies share the tracker via storedBodyContext)
  - packages/quereus/src/runtime/emit/drop-view.ts # fires view_removed
  - packages/quereus/test/logic/53.4-materialized-view-structural-alter-restore.sqllogic # or a new 53.x file for the regression
  - docs/mv-schema-change.md
repro: verified
----

## Reproduction (verified on the memory module, plain DDL)

```sql
create table T (Id integer primary key, N integer);
insert into T values (1, 10);
create view V1 as select sum(N) as S from T;
create materialized view M as select S from V1;
drop view V1;
create view V1 as select sum(N) + 1 as S from T;
select S from M;            -- 10
insert into T values (2, 1);
select S from M;            -- 11: maintenance is still running the OLD body (new body gives 12)
```

After a further `drop view V1` and insert, `M` keeps maintaining (12) with the view it reads gone. `apply schema` reaches the same state: redeclaring `V1` with a new body plans only `DROP VIEW` + `CREATE VIEW`, which run through the same emitters.

## Cause

`TableDerivation.sourceTables` holds only base tables. `collectSourceTables` walks the optimized plan for `TableReferenceNode`s, and a view's body is inlined at build time, so `V1` never appears; `T` does. The listener in `MaterializedViewManager.subscribeToSchemaChanges` reacts to `table_removed` / `table_modified` (matched against `sourceTables`) and `materialized_view_removed`. `drop view` fires `view_removed`, which nothing on the maintenance side listens to, so the row-time plan compiled with V1's old body keeps running.

The planner already knows which views a body read: `building/select.ts` records a `view_read` dependency for every inlined view (nested view bodies included, because `storedBodyContext` spreads the parent context and shares its `schemaDependencies` tracker). `deriveBackingShapeUnguarded` calls `db.getPlan`, which throws that tracker away.

## Fix

Record the views the body reads, and treat dropping one as a source change that cannot be survived live: mark the materialized view stale.

- `TableDerivation.sourceViews: ReadonlyArray<string>`: lowercased `schema.view` names, transitive, runtime-derived like `sourceTables` (re-derived at create / adopt / import / refresh, never serialized; check whether the store catalog path rebuilds the derivation through `buildTableDerivation`, as it does for `sourceTables`).
- `BackingShape.sourceViews`: in `deriveBackingShapeUnguarded`, plan through `db._buildPlan` + `db.optimizer.optimize` (what `getPlan` does internally) so the `schemaDependencies` tracker is available, and collect every `view_read` dependency as `${schemaName}.${objectName}`.toLowerCase(). Keep the parse error handling `getPlan` has. Alternatively give `getPlan` an internal variant that returns the dependencies too. Don't duplicate the parse/build.
- Thread `shape.sourceViews` wherever `shape.sourceTables` is assigned to a derivation: `buildTableDerivation`, the refresh reshape (~2852), and any other site that assigns `derivation.sourceTables` from a shape (grep `sourceTables = shape`).
- Listener: add a `view_removed` arm. For each maintained table whose `derivation.sourceViews` includes the removed view: if not already stale, set `stale = true` and log; then `releaseRowTime` and `emitBackingInvalidation`, in the same idempotent shape as the existing stale path. Pull that stale sequence into a small private helper the table arm and the view arm both call, rather than copying it. No recompile attempt: a recreated view with the same name can carry a different body, and the backing rows came from the old one.
- `view_added` and `view_modified` need no arm. A view can't be redefined in place (no `create or replace`, no view rename), so a redefinition is always drop then create, and the drop already marked the view stale. `view_modified` fires only for tag changes and for the rename propagation's semantics-preserving AST rewrite. Reacting to it would stale materialized views in the middle of a table rename, which the rename propagation already handles through `sourceTables`.
- `tryRecompileMaterializedViewLive`: if the re-planned `sourceViews` differs from the recorded set, fall back to stale, as it already does for `sourceTables` (`sameSourceTables`). Otherwise the recorded set can drift on a keep-live recompile.

Why mark stale instead of re-deriving the rows: the doc keeps DDL paths compile-only. The body-function-drift section rejects running a rebuild inside a DDL path, and dropping a source table already goes stale rather than rebuilding. Once stale, a reference with V1 gone fails with the staleness diagnostic (the body no longer plans), a reference after V1 is recreated serves the snapshot, the read-side rewrite declines, and `refresh materialized view M` re-derives the rows from the new body and re-registers maintenance.

`apply schema` needs no differ change. Its DROP VIEW goes through `emitDropView`, so the listener stales `M`, and `M` stays stale after the apply until refreshed, the same outcome as an `apply schema` that drops and recreates one of `M`'s source tables. Having the differ append a `refresh` for maintained tables over recreated views was considered and left out, because it would put a full recompute into `apply schema` for this one case and not for the table-recreate case.

## Expected behaviour (regression test)

Put one sqllogic block next to the other source-schema-change coverage (53.4 or a new `53.5-materialized-view-over-view-redefine.sqllogic`). It's a single test; it reproduces the bug:

- after `drop view V1; create view V1 as select sum(N) + 1 …`, `select S from M` → `[{"S":10}]` (the stale snapshot)
- `insert into T values (2, 1)`, then `select S from M` → still `[{"S":10}]` (nothing propagates)
- `refresh materialized view M`, then `select S from M` → `[{"S":12}]`, and a later insert propagates again under the new body (e.g. `insert into T values (3, 1)` → 13)
- `drop view V1`, then `select S from M` → error (the staleness diagnostic; match the existing expected-error wording used in 53.4 / 51 for a broken stale body)

Add one case for a view reached through another view (`M` over `V2`, `V2` over `V1`, drop `V1`) only if the tracker sharing turns out not to cover it. The design expects it to be covered.

## TODO

- Add `sourceViews` to `TableDerivation` and `BackingShape`; collect it from the build's `view_read` dependencies in `deriveBackingShapeUnguarded`.
- Thread it through `buildTableDerivation`, the refresh reshape, and every other shape→derivation assignment.
- Factor the existing stale transition in `subscribeToSchemaChanges` into a helper; add the `view_removed` arm using it.
- Add the `sourceViews` agreement check to `tryRecompileMaterializedViewLive`.
- Add the sqllogic regression above.
- Update `docs/mv-schema-change.md`: the listener paragraph (it names only `table_removed` / `table_modified`) should say that dropping a view the body reads (directly or through other views) marks the view stale, and why there is no recompile. Check the `derivation.ts` doc comments and MV-022 in `docs/invariants.md` for wording that says "source table" only.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`. Store mode (`yarn test:store`) is worth running once, since the store catalog rebuilds derivations on import.
