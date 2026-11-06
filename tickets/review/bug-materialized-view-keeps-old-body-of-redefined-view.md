description: A materialized view built on an ordinary view kept computing from that view's old definition after the view was dropped or redefined; dropping a view a materialized view reads now marks the materialized view stale, just as dropping one of its source tables does.
architecture: docs/mv-schema-change.md
files:
  - packages/quereus/src/schema/derivation.ts # TableDerivation.sourceViews (new, required)
  - packages/quereus/src/core/database.ts # getPlan now delegates to new _getPlanWithDependencies
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # BackingShape.sourceViews, collectSourceViews, buildTableDerivation, describeSourceDrift, adoptShapeSources, reshape + recompile + restore sites
  - packages/quereus/src/runtime/emit/materialized-view.ts # refresh fast path now records the re-planned sources
  - packages/quereus/src/core/database-materialized-views.ts # view_removed arm; listener's stale transition folded onto markMaterializedViewStale
  - packages/quereus/test/logic/53.5-materialized-view-over-view-redefine.sqllogic # regression
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts # two literal derivations gained sourceViews: []
  - docs/mv-schema-change.md, docs/materialized-views.md, docs/invariants.md
----

## What changed

A materialized view's derivation now records the plain views its body reads, as `TableDerivation.sourceViews` (lowercased `schema.view`, transitive). The planner inlines a view's body, so the optimized plan has no node for the view and `sourceTables` only ever named the base tables beneath it. The names come from the build's `view_read` dependencies: `deriveBackingShapeUnguarded` now plans through a new `Database._getPlanWithDependencies` (what `getPlan` used to do inline; `getPlan` now returns its `.plan`), and `collectSourceViews` reads the tracker.

The materialized-view manager's schema-change listener has a new `view_removed` arm: every maintained table whose `sourceViews` includes the dropped view is marked stale. No recompile is attempted (a recreated view of the same name can carry a different body; the backing rows came from the old one).

Supporting changes:

- **One stale transition.** The listener's inline stale sequence (set flag + log, release row-time plan, emit backing invalidation) was a copy of the existing public `MaterializedViewManager.markMaterializedViewStale`. The listener now calls that method for both the table arm and the view arm; it gained an optional `reason` used only in the log line (`'forced'` by default, so the rename-failure callers' logs read as before). Its comments now carry the explanation that used to sit in the listener.
- **Source agreement checks cover views.** `sameSourceTables` became `describeSourceDrift(derivation, shape)` (tables, then views; returns a log string or null), used by `tryRecompileMaterializedViewLive` (gate 2) and `restoreUnaffectedMaterializedViews`.
- **Refresh records the re-planned sources on both arms.** New exported `adoptShapeSources(derivation, shape)` sets `sourceTables` + `sourceViews` together. The reshape arm already assigned `sourceTables`; the **fast path** (shape unchanged, data-only rebuild) previously assigned neither. That mattered before this ticket only in theory; now it matters: after `drop view V1; create view V1 as <body over other tables/views>; refresh M`, the fast path would otherwise keep the old source sets, so `sourceScope`, the read-side rewrite's source match, and the next view-drop check would key off the old body.
- Create / adopt / import / attach all build the derivation through `buildTableDerivation`, which now copies `shape.sourceViews`. The store catalog import goes through the same path (verified by `yarn test:store` passing; not separately tested for a view-reading MV across reopen).

`view_added` / `view_modified` get no arm (as the ticket specified): views cannot be redefined in place, so redefinition always goes through the drop, and `view_modified` fires only for tag changes and the rename propagation's AST rewrite.

## Behaviour to validate

From `53.5-materialized-view-over-view-redefine.sqllogic` (`M` = `select S from V1`, `V1` = `select sum(N) as S from T`):

- `drop view V1; create view V1 as select sum(N) + 1 as S from T;` → `select S from M` gives the snapshot `10`; an insert into `T` does not propagate (still `10`).
- `refresh materialized view M` → `12`; a later insert propagates under the new body (`13`).
- `drop view V1` with nothing recreated → `select S from M` errors with the staleness diagnostic (`is stale`).

Checked by throwaway probes and not kept as tests (the ticket asked for a nested-view case only if the tracker didn't cover it, and it does):

- `M` over `V2` over `V1`, drop and recreate `V1` → `M` stale; refresh picks up the new `V1`.
- A view read only inside a `where … in (select … from VS)` subquery of the body → dropping `VS` stales `M`.
- A view redefined to read `M` itself (`drop view V1; create view V1 as select … from M`) can't create a cycle: once `M` is stale, the `create view` fails because planning `M`'s stale body needs `V1`. Before this fix `M` stayed live, so that `create view` would have succeeded and a refresh would have made `M` read itself.

I confirmed the regression fails without the fix by disabling the `view_removed` arm temporarily (then restoring it).

## Tests

- Added `test/logic/53.5-materialized-view-over-view-redefine.sqllogic`: the bug's reproduction (stale snapshot, no propagation, refresh recovers under the new body, drop-without-recreate errors). One file, one scenario.
- `test/view-mv-ddl-persistence.spec.ts`: two hand-built `TableDerivation` literals gained `sourceViews: []` (the field is required; type check only).

Runs: `yarn workspace @quereus/quereus test` (11101 passing, 26 pending), `yarn workspace @quereus/quereus lint` (clean), `yarn test:store` (11094 passing, 33 pending).

## Known gaps / for the reviewer

- **Lens redeploy has the same defect at a different site; filed, not fixed.** `lens-compiler.ts` replaces a logical schema's views with `Schema.removeView` / `addView` and fires no event, so an MV over a lens view keeps maintaining from the old lens body after `apply schema` redeploys the logical schema. Reproduced (sqllogic probe: the insert propagated through a column the redeployed logical table no longer has). Filed as `tickets/backlog/bug-lens-redeploy-keeps-materialized-view-on-old-lens-body.md`. The fix there touches the store catalog's view persistence, which listens to the same events, so it isn't a one-line add.
- `apply schema` that redeclares a plain view's body leaves dependent MVs stale until refreshed (no auto-refresh). The ticket chose this on purpose; it matches an apply that drops and recreates a source table. The doc now says so.
- `SchemaDependency` keys are `type:schema:name:version` split on `:`, so a schema or view name containing `:` would parse wrongly in `collectSourceViews`. This problem already existed in the tracker, and nothing in this change makes it worse.
- `restoreUnaffectedMaterializedViews` now also declines on a view-set disagreement. A rename statement can't drop a view, so I expect that arm never fires there. It is included because the check is shared, not because of a known case.
