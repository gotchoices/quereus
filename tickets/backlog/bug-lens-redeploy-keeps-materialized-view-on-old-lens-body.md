description: Re-applying a logical schema replaces its views silently, so a materialized view that reads one of them keeps computing from the old view definition instead of being marked stale.
architecture: docs/mv-schema-change.md
files:
  - packages/quereus/src/schema/lens-compiler.ts # ~245 clear-and-rebuild of lens views: removeView / addView with no change event
  - packages/quereus/src/core/database-materialized-views.ts # subscribeToSchemaChanges — view_removed arm stales MVs off derivation.sourceViews
  - packages/quereus/src/runtime/emit/drop-view.ts # the one path that fires view_removed today
  - packages/quereus/src/core/statement.ts # ~388 cached-plan invalidation listens for view events
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Materialized views over logical-schema views may be rare, and the obvious fix (firing view events from the lens deploy) also reaches the store catalog's view persistence, which must not start persisting lens views as plain views.
----

## Reproduction (verified on the memory module, sqllogic)

```sql
declare schema ybasis { table t { id integer primary key, name text } }
apply schema ybasis;
insert into ybasis.t values (1, 'alpha');
declare logical schema appx { table t { id integer primary key, name text } }
declare lens for appx over ybasis { }
apply schema appx;
create materialized view main.mm as select id, name from appx.t;
-- redeploy the logical table without `name`
declare logical schema appx { table t { id integer primary key } }
apply schema appx;
insert into ybasis.t values (2, 'beta');
select id, name from main.mm order by id;   -- 2 rows: maintenance still runs the old lens body
```

Expected: `mm` is stale after the second `apply schema appx` (its body `select id, name from appx.t` no longer plans), the insert does not propagate, and a reference fails with the staleness diagnostic.

## Cause

A materialized view records the plain views its body reads in `TableDerivation.sourceViews`, and the materialized-view manager marks a view stale on `view_removed` for any of them. `drop view` fires that event from its emitter. The lens deploy in `lens-compiler.ts` instead drops every lens view of the logical schema with `Schema.removeView` and re-adds the freshly compiled set with `addView`, firing nothing, so the manager never learns that `appx.t` was replaced.

## Expected behaviour

A lens redeploy that removes or replaces a view a materialized view reads marks that materialized view stale, exactly as `drop view` does. A redeploy that leaves a lens view's compiled body unchanged may leave dependents live.

## Notes for the fix stage

- The view-removal notification lives in the emitter (`drop-view.ts`), not in `Schema.removeView`, so every removal path has to remember it. Moving the notification to the removal boundary would cover the class, but the store catalog also listens to `view_removed` / `view_added` to persist plain views, and lens views are compiled on deploy rather than persisted that way. Check what the store does with a lens view's events before choosing.
- Unverified: prepared statements compiled against a lens view may keep their plan across a redeploy for the same reason (the statement's dependency listener keys on view events). Confirm with a prepared `select` across a redeploy.
