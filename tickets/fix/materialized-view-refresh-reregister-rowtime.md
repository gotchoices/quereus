description: `refresh materialized view` rebuilds the backing snapshot and clears the `stale` flag, but does NOT re-register the row-time (write-through) maintenance plan. After a source schema change marks an MV stale (which detaches its row-time plan), a `refresh` leaves the MV in a clean-but-unmaintained state: reads return the correct rebuilt snapshot, but subsequent source writes are silently NOT propagated to the backing. Only drop+recreate fully restores row-time maintenance.
files: packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic
----

## Symptom

Discovered while writing row-time MV test coverage (`materialized-view-rowtime-test-coverage`). Reproduces against the memory module:

```sql
create table al (id integer primary key, x integer);
insert into al values (1, 10);
create materialized view al_ix as select id, x from al;

alter table al add column extra text null;   -- compatible source change → MV marked stale,
                                             -- row-time plan released (intended)
insert into al (id, x) values (2, 20);       -- not maintained while stale (intended)
select id, x from al_ix order by id;         -- [{id:1,x:10}]  (stale snapshot, intended)

refresh materialized view al_ix;             -- rebuilds backing + clears stale
select id, x from al_ix order by id;         -- [{id:1,x:10},{id:2,x:20}]  (correct snapshot)

insert into al (id, x) values (3, 30);       -- BUG: silently NOT maintained
select id, x from al_ix order by id;         -- [{id:1,x:10},{id:2,x:20}]  (id=3 missing!)
```

By contrast, `drop materialized view al_ix; create materialized view al_ix …;`
re-registers the plan and maintenance resumes (id=3 appears). The
test-coverage ticket asserts the working drop+recreate path in §16 of
`53-materialized-views-rowtime.sqllogic` and documents this gap there.

## Root cause (research)

`emitRefreshMaterializedView` (`src/runtime/emit/materialized-view.ts`) does:

```
if (mv.stale) revalidateBody(...);
await rebuildBacking(db, mv);
mv.stale = false;
notifyChange({ type: 'materialized_view_refreshed', ... });
```

The row-time plan lives in `MaterializedViewManager.rowTime` /
`rowTimeBySource`, populated only by `registerMaterializedView`
(`database-materialized-views.ts`). The schema-change listener calls
`releaseRowTime` when a source is modified/removed. `rebuildBacking` does
NOT re-register, and nothing listens to `materialized_view_refreshed` to
re-register, so after a refresh the plan stays detached. The
`subscribeToSchemaChanges` docstring even claims the MV "reads stale until
refreshed or recreated, which re-registers it" — refresh does not honor that.

## Expected behavior

A successful `refresh materialized view` should leave the MV fully row-time
maintained again: after rebuilding the backing and clearing `stale`, it should
re-register the row-time plan (e.g. call `db.registerMaterializedView(mv)` /
`materializedViewManager.registerMaterializedView(mv)`), or the refresh handler
should be wired so re-registration happens. Subsequent source writes must then
be reflected in the MV.

## Validation / use cases

- The reproduction above must end with `[{id:1,x:10},{id:2,x:20},{id:3,x:30}]`.
- Refresh of an MV that was NOT stale (no prior source schema change) must keep
  it maintained too (regression guard — registration must be idempotent and not
  duplicate `rowTimeBySource` entries).
- Compound-PK and partial (`where`) MVs must resume maintenance after refresh.
- Confirm under both memory and the store module path.
- When the fix lands, update §16 of `53-materialized-views-rowtime.sqllogic`:
  add a `refresh materialized view` branch asserting post-refresh writes ARE
  maintained, and drop the "KNOWN GAP" note referencing this ticket.
