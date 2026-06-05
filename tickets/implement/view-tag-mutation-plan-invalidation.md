description: Invalidate cached write-through plans after `ALTER VIEW/MATERIALIZED VIEW … SET TAGS` by adding a `view` schema-dependency type, firing `view_modified`/`materialized_view_modified` events from the tag setters, and recording a view dependency on every view-mediated write.
files:
  - packages/quereus/src/schema/change-events.ts            # add view_modified + materialized_view_modified events to the union
  - packages/quereus/src/schema/manager.ts                  # setViewTags (~732) / setMaterializedViewTags (~754) fire the new events
  - packages/quereus/src/planner/planning-context.ts        # add 'view' to SchemaDependency.type union (line 29)
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildViewMutation: record the 'view' dependency (single funnel for all view-mediated writes)
  - packages/quereus/src/core/statement.ts                  # compile(): map view_/materialized_view_ modified events → 'view' dependency type (~157-178)
  - packages/quereus/src/core/database-materialized-views.ts # confirm its listener ignores the new MV-modified event (no maintenance re-registration)
  - docs/sql.md                                             # re-soften the §2.7 "Known limitation" note (line 1362)
  - packages/quereus/test/plan/materialized-view-plan.spec.ts  # model for the regression test (prepared-stmt reuse + reset + re-execute)
----

# Implement: invalidate cached write-through plans after `ALTER VIEW … SET TAGS`

## Reproduced (confirmed failing on this branch)

A throwaway spec (memory backend) using the ticket's reproduction shows the bug
exactly: after `ALTER VIEW v SET TAGS ("quereus.update.default_for.created" = '200')`,
re-running the **same** cached prepared `insert into v …` still writes the *old*
default.

```
REPRO ROWS [{"id":1,"created":100},{"id":2,"created":100}]   // row 2 expected created=200
AssertionError: expected 100 to equal 200
```

A fresh `prepare`/`exec` routes correctly — the gap is plan-caching-specific.

## Root cause (verified against code)

Two gaps combine, both confirmed by reading the sources:

1. **No event.** `SchemaManager.setViewTags` (`manager.ts:732`) and
   `setMaterializedViewTags` (`manager.ts:754`) swap the in-memory schema object
   via `schema.addView(updated)` / `schema.addMaterializedView(updated)` and fire
   **no** change event (deliberately — `materialized_view_added` would mislead the
   MV manager into re-registering maintenance, and there was no `*_modified`
   event for views/MVs).
2. **No `view` dependency.** A view-mediated write funnels through
   `buildViewMutation` (`view-mutation-builder.ts`), which reads view-level
   `quereus.update.*` tags via `collectMutationTags(view, …)` but records **no**
   schema dependency on the view — only the base table(s) it decomposes to get a
   `SchemaDependency` (`type: 'table'`, in `schema-resolution.ts`). The
   `SchemaDependency.type` union (`planning-context.ts:29`) has no `'view'`, and
   `Statement.compile()`'s invalidation listener (`statement.ts:157-188`) only
   maps `table_/function_/module_/collation_` events to dependency types.

So `ALTER VIEW … SET TAGS` touches neither the base table nor any recorded
dependency → the cached plan is never invalidated.

Contrast: `ALTER TABLE … SET TAGS` (`setTableTags` → `commitTagUpdate`) and
`ALTER INDEX … SET TAGS` (`setIndexTags`, `manager.ts:802`) both fire
`table_modified` on a *tracked* table dependency, which correctly invalidates.

## Chosen approach — precise (`view` dependency type + `*_modified` events)

Mirror the table path. This is the option the source ticket flagged as "most
precise"; the surface is small and isolated, and it avoids the over-invalidation
of the coarse global-generation alternative.

### 1. New events (`change-events.ts`)

Add (import `ViewSchema` from `./view.js`; `MaterializedViewSchema` is already
imported):

```ts
export type ViewModifiedEvent = SchemaObjectModified<'view_modified', ViewSchema>;
export type MaterializedViewModifiedEvent = SchemaObjectModified<'materialized_view_modified', MaterializedViewSchema>;
```

Add both to the `SchemaChangeEvent` union. These are **distinct** from the
create events (`materialized_view_added`), preserving the "no spurious
maintenance re-registration" rationale — no maintenance listener subscribes to
them.

### 2. Fire from the setters (`manager.ts`)

In `setViewTags`, after `schema.addView(updated)`:

```ts
this.changeNotifier.notifyChange({
  type: 'view_modified',
  schemaName: targetSchemaName,
  objectName: viewName,
  oldObject: view,
  newObject: updated,
});
```

In `setMaterializedViewTags`, after `schema.addMaterializedView(updated)`, the
analogous `materialized_view_modified` (oldObject: `mv`, newObject: `updated`).
Update both setters' doc comments — the current ones explicitly state "no event
is fired"; replace that with the new behavior and note the event is distinct
from `*_added` so MV maintenance is not re-registered.

### 3. `'view'` dependency type (`planning-context.ts:29`)

```ts
readonly type: 'table' | 'view' | 'function' | 'vtab_module' | 'collation';
```

### 4. Record the dependency (`view-mutation-builder.ts`)

In `buildViewMutation`, near the top (it is the single funnel for *all*
view-/MV-mediated writes — single-source, multi-source, decomposition, set-op —
and `view` is a `MutableViewLike` with `name`/`schemaName`):

```ts
ctx.schemaDependencies.recordDependency(
  { type: 'view', schemaName: view.schemaName, objectName: view.name },
  view,
);
```

Recording here (not in the three builders' `getView` sites) keeps it DRY and
covers MV write-through and lens-backed logical tables too (all consult
`collectMutationTags`). Read-only `SELECT … FROM v` is intentionally **not**
given a view dependency — view tags do not change read results, so no need to
invalidate reads.

### 5. Map the events (`statement.ts`, in `compile()`'s listener ~157-178)

Add a branch *before* the `startsWith('table_')` chain (neither new type starts
with `table_`/`function_`/`module_`/`collation_`, but matching the literal types
is clearest):

```ts
if (event.type === 'view_modified' || event.type === 'materialized_view_modified') {
  dependencyType = 'view';
} else if (event.type.startsWith('table_')) {
  ...
```

The existing name/schema match (`dep.objectName === event.objectName && (!dep.schemaName || dep.schemaName === event.schemaName)`) then fires for the recorded `view` dependency.

## Why the MV-maintenance invariant is preserved

`database-materialized-views.ts`'s schema-change listener handles source
`table_*` events and `materialized_view_removed` only (it re-registers/releases
row-time plans there); it does **not** act on `materialized_view_added` and will
not act on the new `materialized_view_modified`. So an MV tag change fires the
new event → invalidates dependent cached write-through plans → but does **not**
re-register maintenance or rebuild the backing. The `declarative-equivalence`
"MV tag-only drift … without a rebuild" test must stay green (verify).

## Acceptance

- The reproduction yields `created = 200` for row 2 on the **same** cached
  statement after `ALTER VIEW … SET TAGS`.
- New regression spec (memory backend), modeled on
  `test/plan/materialized-view-plan.spec.ts` (prepare → run → `ALTER VIEW SET
  TAGS` → `reset()` → run → assert new default). Place it under
  `packages/quereus/test/` (a `.spec.ts`, since `.sqllogic` re-prepares every
  statement and cannot express prepared-statement reuse). Cover the MV analogue
  if MV write-through with `quereus.update.*` is exercisable.
- `declarative-equivalence` MV tag-only drift test still passes (no spurious
  maintenance re-registration / rebuild).
- `docs/sql.md` §2.7 note re-softened (drop the "Known limitation" paragraph;
  keep the "behavioral tags" sentence, now noting cached statements *are*
  invalidated).
- `yarn workspace @quereus/quereus test` green; `yarn lint` clean.

## TODO

- Add `ViewModifiedEvent` + `MaterializedViewModifiedEvent` to
  `change-events.ts` (import `ViewSchema`) and to the `SchemaChangeEvent` union.
- Fire `view_modified` from `setViewTags` and `materialized_view_modified` from
  `setMaterializedViewTags`; update both doc comments.
- Add `'view'` to the `SchemaDependency.type` union in `planning-context.ts`.
- Record the `view` dependency in `buildViewMutation`.
- Map `view_modified`/`materialized_view_modified` → `'view'` in
  `statement.ts`'s invalidation listener.
- Confirm (read) `database-materialized-views.ts`'s listener ignores the new
  MV-modified event — no maintenance re-registration.
- Add the regression spec; assert row 2 gets the new default on the cached stmt.
- Re-soften `docs/sql.md` line ~1362 (remove the "Known limitation" wording).
- Run `yarn workspace @quereus/quereus test` and `yarn lint`; ensure the
  `declarative-equivalence` MV tag-only test still passes.
