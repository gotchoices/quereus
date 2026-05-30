description: `refresh materialized view` rebuilds the backing snapshot and clears the `stale` flag but does NOT re-register the row-time (write-through) maintenance plan that a prior source-schema change detached. After `alter source → refresh`, the MV reads the correct rebuilt snapshot, yet subsequent source writes are silently NOT propagated to the backing. Re-register the row-time plan at the end of a successful refresh so maintenance resumes. Root-caused, fix verified, reproduction in hand.
files: packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic
----

## Summary

`emitRefreshMaterializedView` (`src/runtime/emit/materialized-view.ts:115-144`) rebuilds the
backing table and clears `mv.stale`, but never re-registers the MV's row-time write-through
maintenance plan. When a *compatible* source schema change earlier marked the MV stale, the
schema-change listener in `MaterializedViewManager.subscribeToSchemaChanges`
(`src/core/database-materialized-views.ts:245`) already called `releaseRowTime`, detaching the
plan. The rebuild only fixes the snapshot; the plan stays detached, so reads return the correct
rebuilt set but subsequent source writes are silently not maintained. Only `drop + recreate`
(which re-registers) currently restores maintenance.

The fix is to call `db.registerMaterializedView(mv)` after `mv.stale = false` and before the
`materialized_view_refreshed` notification. Registration is idempotent — `registerMaterializedView`
(`database-materialized-views.ts:260`) calls `this.releaseRowTime(key)` before rebuilding the plan
and indexing it under `rowTimeBySource`, so re-registering a never-stale MV is a harmless no-op
re-attach with no duplicate `rowTimeBySource` entries. `db.registerMaterializedView` is the existing
public passthrough (`src/core/database.ts:1729`).

## Reproduction (confirmed failing on HEAD; passing with the fix)

```sql
create table al (id integer primary key, x integer);
insert into al values (1, 10);
create materialized view al_ix as select id, x from al;

alter table al add column extra text null;   -- compatible change → MV stale, plan detached
insert into al (id, x) values (2, 20);        -- not maintained while stale (intended)
select id, x from al_ix order by id;          -- [{id:1,x:10}]  (stale snapshot)

refresh materialized view al_ix;              -- rebuilds backing + clears stale
select id, x from al_ix order by id;          -- [{id:1,x:10},{id:2,x:20}]  (correct snapshot)

insert into al (id, x) values (3, 30);        -- BUG on HEAD: NOT maintained
select id, x from al_ix order by id;          -- HEAD: [{id:1,x:10},{id:2,x:20}]  (id=3 missing)
                                              -- FIXED: [{id:1,x:10},{id:2,x:20},{id:3,x:30}]
```

Verified directly: with the one-line fix applied, a temporary repro logic file passed and the
full `53-materialized-views-rowtime.sqllogic` suite still passed (no regression).

## Exact fix

In `emitRefreshMaterializedView`, after `mv.stale = false;` and before the
`getChangeNotifier().notifyChange({ type: 'materialized_view_refreshed', ... })` call, insert:

```ts
// Re-register row-time write-through maintenance. A source schema change that
// marked this MV stale also detached its row-time plan; the rebuild above only
// fixes the snapshot, so without re-registering, subsequent source writes would
// silently not propagate. Registration is idempotent (it releases any existing
// plan first), so a refresh of a never-stale MV is a harmless no-op re-attach.
db.registerMaterializedView(mv);
```

Notes for the implementer:
- `revalidateBody` already runs first for a stale MV and throws the staleness diagnostic on an
  incompatible source change, so `registerMaterializedView` (which re-runs the eligibility gate via
  `buildMaintenancePlan`) only ever fires on a body that still plans. If a compatible-but-now-
  ineligible body ever reaches it, `registerMaterializedView` throws `UNSUPPORTED` — acceptable
  (the refresh fails loudly rather than silently leaving an unmaintained MV); do not swallow it.
- No ordering change needed: `db` and `sm` are already in scope in `run`.

## Test updates — `test/logic/53-materialized-views-rowtime.sqllogic` §16

§16 (lines ~540-573) currently documents this as a KNOWN GAP and only asserts the working
`drop + recreate` path. Update it to:

- Drop the `KNOWN GAP (see materialized-view-refresh-reregister-rowtime): ...` note from the §16
  header comment (lines ~547-549).
- Add a `refresh materialized view` branch (alongside, or instead of, the existing drop+recreate
  branch) asserting post-refresh writes ARE maintained. Concretely, exercise the reproduction
  above: after `alter ... add column` marks `al_ix` stale and the post-alter insert is unmaintained,
  `refresh materialized view al_ix` must both (a) rebuild the snapshot to include the missed row and
  (b) resume maintenance so a *subsequent* insert appears. Keep the existing drop+recreate coverage
  as a separate sub-case or fold it in — both paths must end fully maintained.

Suggested additional coverage to satisfy the ticket's validation list (add as small extra branches,
memory module is the default test path):
- A refresh of a NOT-stale MV that then keeps maintaining writes (idempotent-registration regression
  guard — confirms no duplicate `rowTimeBySource` entry breaks maintenance).
- A compound-PK MV and a partial (`where`) MV: mark stale via a compatible source alter, refresh,
  then assert a subsequent source write is reflected.

## Validation

- `yarn test` (memory; the default) — full suite green, including the updated §16.
- Optionally `yarn test:store` for the `53` file to confirm the store source path
  (`yarn test:store` re-runs the logic suite against LevelDB). The fix touches only MV registration,
  which is module-agnostic, but the ticket explicitly asks to confirm both paths.

## TODO

- Apply the one-line `db.registerMaterializedView(mv)` fix in `emitRefreshMaterializedView`
  (`src/runtime/emit/materialized-view.ts`) with the explanatory comment above.
- Update §16 of `test/logic/53-materialized-views-rowtime.sqllogic`: add the post-refresh
  maintenance assertions and remove the KNOWN GAP note.
- Add the regression-guard branches (not-stale refresh stays maintained; compound-PK and partial MV
  resume after refresh).
- Run `yarn test` and confirm green; lint `packages/quereus`.
- Hand off to review with an honest note on whether `yarn test:store` was run.
