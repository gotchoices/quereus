description: Re-applying a logical schema replaces its views without telling anyone, so a materialized view that reads one of them keeps computing from the old view definition, and a prepared statement that reads one keeps running its old plan.
architecture: docs/mv-schema-change.md
files:
  - packages/quereus/src/schema/lens-compiler.ts # ~240-262: clear-and-rebuild of lens views (removeView / addView), fires no change event
  - packages/quereus/src/schema/change-events.ts # event union; ViewAddedEvent doc comment explains why lens views are excluded from view_added/view_removed
  - packages/quereus/src/core/database-materialized-views.ts # ~195 view_removed arm stales MVs whose derivation.sourceViews names the view
  - packages/quereus/src/core/statement.ts # ~386-412 cached-plan invalidation listener; maps event type -> dependency types
  - packages/quereus-store/src/common/store-module-schema-sync.ts # ~455-526 dispatchSchemaChange; persists plain views on view_added/view_removed, `default: return` for unknown types
  - packages/quereus/test/logic/53.5-materialized-view-over-view-redefine.sqllogic # the plain-view counterpart test
  - docs/mv-schema-change.md # first paragraph: "Dropping a view the body reads marks the MV stale"
  - docs/lens-deployment.md
repro: verified
----

## Reproduction (verified, memory module)

Materialized view arm, as a sqllogic file:

```sql
declare schema ybasis { table t { id integer primary key, name text } }
apply schema ybasis;
insert into ybasis.t values (1, 'alpha');
declare logical schema appx { table t { id integer primary key, name text } }
declare lens for appx over ybasis { }
apply schema appx;
create materialized view main.mm as select id, name from appx.t;
declare logical schema appx { table t { id integer primary key } }
apply schema appx;
insert into ybasis.t values (2, 'beta');
select id, name from main.mm order by id;
-- error: is stale
```

Today the final select returns two rows: maintenance still runs the old lens body and the insert propagated. Expected: the staleness error, as for the plain-view case in `53.5-materialized-view-over-view-redefine.sqllogic`.

Prepared-statement arm (verified with a throwaway mocha spec, since removed): `db.prepare('select * from appx.t')`, iterate → `[[1,'alpha']]`; redeploy `appx` without `name`; iterate the same statement again → still `[[1,'alpha']]`, while a fresh `db.eval` of the same SQL returns `[{id:1}]`. The statement kept its cached plan because no event matched its `view_read` dependency on `appx.t`.

## Cause

Readers of a view record that dependency at plan time: the select builder (`planner/building/select.ts` ~557) records a `view_read` dependency for every view it inlines, lens views included. A materialized view copies those into `TableDerivation.sourceViews`; a prepared statement keeps them in its dependency list. Both are invalidated by the `view_removed` (and, for statements, `view_added` / `view_modified`) events, which only the `drop view` / `create view` / rename emitters fire.

`deployLogicalSchema` in `lens-compiler.ts` replaces the lens views directly with `Schema.removeView` / `Schema.addView` and fires nothing. That silence is partly deliberate: the doc comment on `ViewAddedEvent` in `change-events.ts` says lens views must not raise `view_added` / `view_removed`, because the store catalog listener (`store-module-schema-sync.ts`) persists plain views on those events, while lens views are recompiled on every deploy and must never be persisted as `create view` DDL.

## Fix (recommended)

Give lens view replacement its own events, so consumers opt in and the store catalog keeps ignoring them (its `dispatchSchemaChange` already has `default: return`).

Add to `change-events.ts` (and the `SchemaChangeEvent` union):

- `LensViewRemovedEvent = SchemaObjectRemoved<'lens_view_removed', ViewSchema>` — a lens view present before the deploy and absent after it (logical table removed from the declaration).
- `LensViewReplacedEvent = SchemaObjectModified<'lens_view_replaced', ViewSchema>` — a lens view present before and after (matched by lowercased name), carrying the old and new `ViewSchema`. Fired for every surviving view, not only those whose body text changed: a write-through plan depends on the lens slot (constraints, inverse, provenance), which can change while the get-body text does not, and recompiling a cached plan is cheap.

No `lens_view_added`: no plan or materialized view can hold a dependency on a view name that did not exist yet.

In `deployLogicalSchema`, snapshot the prior lens views (lowercased name → `ViewSchema`) before the removal loop, and after the new set is registered (alongside `invalidateLensFkGate()`, i.e. after the catalog mutation so listeners see the new catalog) fire one event per prior view: replaced if the new set has the name, removed otherwise. Use the stored names (`view.schemaName`, `view.name`) as the `drop-view` emitter does. A deploy that throws (prover errors, tag validation) must fire nothing — it already aborts before the mutation.

Consumers:

- `database-materialized-views.ts` `subscribeToSchemaChanges`: treat `lens_view_removed` exactly like `view_removed`. Treat `lens_view_replaced` the same way only when the get-body changed — `oldObject.sql !== newObject.sql` or the `columns` lists differ (case-insensitive). An unchanged redeploy (or one that only changed tags / constraints) leaves dependent materialized views live; the inlined plan is still the right one. Share the stale loop with the `view_removed` arm rather than copying it.
- `statement.ts` listener: map `lens_view_removed` and `lens_view_replaced` to `['view', 'view_read']`, the same as `view_added` / `view_removed`.
- `store-module-schema-sync.ts`: no code change; the default arm ignores the new types. Update its dispatch doc comment only if it enumerates ignored types.
- Other notifier listeners (assertions, auto-analyze, cardinality feedback, watchers, assertion hoist cache) key on table / assertion events only; leave them.

Update the `ViewAddedEvent` doc comment to point at the lens events instead of saying lens views raise nothing.

Alternative considered and rejected: fire plain `view_removed` / `view_added` from the deploy with an origin flag the store must filter. It inverts the current opt-in contract — every future persisting consumer has to remember to skip lens events — and plain `view_added` would make a store catalog persist lens views unless filtered.

## Tests

- New `packages/quereus/test/logic/53.5.1-materialized-view-over-lens-redeploy.sqllogic` (or a section appended to 53.5): the reproduction above (redeploy that drops the column → stale, write does not propagate, reference fails with "is stale"); then `refresh` after redeploying a body that plans again re-derives and resumes maintenance; and one pinned case where re-applying an unchanged logical declaration (or a tag-only change, if `apply schema` does not short-circuit an identical declaration — check `apply-schema-unchanged-fast-path.spec.ts`) leaves the materialized view live and maintained. The unchanged-body branch is real logic, so it gets the one extra case.
- Prepared-statement arm: one `it` in an existing lens spec (e.g. `test/lens-foundation.spec.ts`) — prepare `select * from appx.t`, redeploy without a column, re-iterate the same statement and expect the new shape.
- Run `yarn workspace @quereus/quereus test` and `yarn test:store` for the new sqllogic file (store path exercises the catalog listener; confirm no lens view is persisted — `test/view-mv-ddl-persistence.spec.ts` is the nearby persistence coverage).

## Related, filed separately

A lens redeploy that drops a column an assertion reads is accepted, after which every write fails with "Column not found" (plain `drop view` refuses this case via `assertNoAssertionDependsOn`). That is a missing guard, not a missing notification: `tickets/backlog/bug-lens-redeploy-breaks-assertion-reading-lens-view.md`.

## TODO

- Add `LensViewRemovedEvent` / `LensViewReplacedEvent` to `change-events.ts` and the union; export alongside the other event types if `index.ts` re-exports them.
- In `deployLogicalSchema`, capture prior lens views before the clear and fire the events after the rebuild.
- MV manager: handle both events (replaced only on body/column change), sharing the stale loop with `view_removed`.
- Statement listener: map both events to `['view', 'view_read']`.
- Update `ViewAddedEvent` doc comment, `docs/mv-schema-change.md` (view-drop paragraph: lens redeploy now stales dependents unless the body is unchanged), and `docs/lens-deployment.md` (deploy fires the lens view events).
- Add the sqllogic file and the prepared-statement `it`; run memory and store test suites.
