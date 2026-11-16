description: Re-applying a logical schema now announces that its views were replaced, so a materialized view reading one goes stale when the view's definition changed, and a prepared statement reading one re-plans instead of running its old plan.
architecture: docs/mv-schema-change.md
files:
  - packages/quereus/src/schema/change-events.ts # new LensViewRemovedEvent / LensViewReplacedEvent in the union; ViewAddedEvent comment points at them
  - packages/quereus/src/schema/lens-compiler.ts # deployLogicalSchema captures prior views, notifyLensViewsReplaced fires after the catalog mutation
  - packages/quereus/src/core/database-materialized-views.ts # lensGetBodyChanged + markViewDependentsStale; view_removed arm extended
  - packages/quereus/src/core/statement.ts # lens events map to ['view', 'view_read']
  - packages/quereus/src/index.ts # re-exports the two event types
  - packages/quereus/test/logic/53.5.1-materialized-view-over-lens-redeploy.sqllogic
  - packages/quereus/test/lens-foundation.spec.ts # last describe block
  - docs/mv-schema-change.md
  - docs/lens-deployment.md
  - docs/schema.md # event table
----

## What changed

`deployLogicalSchema` (the `apply schema` step for a logical schema) clears and rebuilds the schema's lens views with `Schema.removeView` / `addView`, which fire no event. Readers that inlined a lens view's body therefore never learned it changed: a materialized view kept maintaining from the old get-body, and a prepared statement kept its cached plan.

The deploy now snapshots the prior views before the clear and, right after the new set is registered (next to `invalidateLensFkGate()`, before the snapshot rotation), fires one event per prior view:

- `lens_view_replaced` (old + new `ViewSchema`) when the new set still has the name (case-insensitive match), whether or not the body changed;
- `lens_view_removed` when the logical table left the declaration.

A first deploy fires nothing (no prior views); a blocked deploy throws before the mutation and fires nothing. Event names are the prior view's stored `schemaName` / `name`, which is what `view_read` dependencies and `sourceViews` recorded.

Consumers:

- **Materialized-view manager**: `lens_view_removed` is handled exactly like `view_removed`. `lens_view_replaced` stales dependents only when `lensGetBodyChanged` says so — `sql` differs, or the `columns` lists differ (case-insensitive). The shared stale loop is now `markViewDependentsStale`.
- **Prepared statements**: both events map to `['view', 'view_read']`, so any plan reading or writing through a lens view re-plans on every redeploy.
- **Store catalog** (`store-module-schema-sync.ts`): unchanged; its `default: return` ignores the new types, so lens views are still never persisted. Its post-dispatch durable stale-MV recompute still runs on these events, and `markMaterializedViewStale` also emits the synthetic backing `table_modified`.

### Why an unchanged body keeps the MV live (worth checking)

The select builder also wraps an inlined lens view in an `AssertedKeysNode` built from the lens slot (`computeLensAssertedKeyFds`), so the read plan depends on more than the body text. I concluded that's still sound for an unchanged body: the contributed FDs come from `proved` / `vacuous` obligations (properties of the body over the basis) or `enforced-set-level` row-time obligations (a basis covering structure, which a lens deploy never touches). A redeploy that drops a declared key therefore removes the *contribution*, not the *truth*, so a plan built on the old FDs stays correct. This reasoning is in the `lensGetBodyChanged` doc comment and `docs/mv-schema-change.md`. If a reviewer finds an asserted-FD source that depends on the declaration alone, the fix is to compare slots too (the producer has both before `clearLensSlots`).

## Tests

- `test/logic/53.5.1-materialized-view-over-lens-redeploy.sqllogic` — MV `main.mm` over lens view `appx.t`:
  - unchanged redeploy → still maintained (pins the body-comparison branch: forcing every replace to stale fails this case);
  - redeploy dropping `name` → reference errors `is stale`, the basis insert does not propagate;
  - redeploy restoring `name` → stale snapshot served; `refresh` re-derives and resumes maintenance;
  - redeploy with an empty declaration → `lens_view_removed` → `is stale`.
  It needs `declare lens for appx over ybasis { }`: once the MV populates `main`, default-basis inference is ambiguous.
- `test/lens-foundation.spec.ts` › "lens foundation: redeploy invalidates cached plans" — prepared `select * from x.t`, redeploy without `name`, same statement returns `[{ id: 1 }]`.

Both tests were confirmed to fail with the `notifyLensViewsReplaced` call commented out.

Validation run: `yarn workspace @quereus/quereus lint` (eslint + test tsc), `typecheck`, `build`; `yarn workspace @quereus/quereus test` (11194 passing, 26 pending); store mode for the new file and its neighbours (`node test-runner.mjs --store --grep "53\.5|51-lens|52-lens|55-lens"`, 5 passing); `yarn workspace @quereus/store typecheck` and `test` (2019 passing). The full `yarn test:store` was not run.

## Known gaps / things to look at

- No test asserts directly that a store catalog holds no lens-view DDL after a redeploy. It rests on the store's `default: return`; the store-mode run of 53.5.1 passing is indirect evidence only.
- No test for write-through statements. A prepared `insert into appx.t` should also re-plan (it records a `view` dependency, which the mapping covers), but only the read path is pinned.
- Every `apply schema` of a logical schema now invalidates every prepared statement that reads a lens view in it, even when nothing changed. This was the ticket's design choice (write-through plans depend on slot details that can change while the body doesn't) and re-planning is cheap. If logical applies ever become frequent, comparing body + slot before firing would avoid it.
- Related, filed separately: a redeploy that drops a column an assertion reads is accepted and then breaks every write (`tickets/backlog/bug-lens-redeploy-breaks-assertion-reading-lens-view.md`).
