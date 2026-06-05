description: Invalidate cached write-through plans after `ALTER VIEW/MATERIALIZED VIEW … SET TAGS`, via a new `view` schema-dependency type plus `view_modified`/`materialized_view_modified` change events recorded on every view-mediated write. Reviewed and completed.
files:
  - packages/quereus/src/schema/change-events.ts            # ViewModifiedEvent + MaterializedViewModifiedEvent added to the union
  - packages/quereus/src/schema/manager.ts                  # setViewTags / setMaterializedViewTags fire the new events (canonical objectName)
  - packages/quereus/src/planner/planning-context.ts        # SchemaDependency.type union gained 'view'
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildViewMutation records the 'view' dependency (single funnel)
  - packages/quereus/src/core/statement.ts                  # compile() listener maps view_/materialized_view_modified → 'view'
  - docs/sql.md                                             # §2.7 note re-softened to describe the fix
  - packages/quereus/test/plan/view-tag-mutation-plan.spec.ts  # regression spec (view + MV write-through, + case-mismatch case)
----

# Complete: invalidate cached write-through plans after `ALTER VIEW … SET TAGS`

## What shipped

A view-/MV-mediated write (`insert/update/delete into v`) reads the view's
behavioral `quereus.update.*` override tags to steer its lowering. Before this
work, `ALTER VIEW … SET TAGS` swapped the in-memory schema object but fired **no**
schema-change event, and a view-mediated write recorded **no** schema dependency,
so an already-prepared (cached) statement kept its stale routing until re-prepared.

The fix mirrors the `ALTER TABLE … SET TAGS` path (which fires `table_modified` on
a tracked `table` dependency):

1. **`change-events.ts`** — new `view_modified` (carries `ViewSchema`) and
   `materialized_view_modified` (carries `MaterializedViewSchema`) events, added to
   the `SchemaChangeEvent` union. Deliberately distinct from the create events so
   the MV maintenance manager does NOT re-register maintenance on a tag-only change.
2. **`manager.ts`** — `setViewTags` / `setMaterializedViewTags` fire the new events
   after the in-memory schema swap, using the **canonical** stored object name.
3. **`planning-context.ts`** — `SchemaDependency.type` gained `'view'`; the key
   `${type}:${schema}:${name}:${version}` keeps it distinct from a same-named `table`.
4. **`view-mutation-builder.ts`** — `buildViewMutation` records the `view`
   dependency once at the top — the single funnel for *all* view-/MV-mediated writes
   (single-source, multi-source join, decomposition, set-op, lens), DRY across every
   write-through path and all three ops.
5. **`statement.ts`** — the `compile()` invalidation listener maps
   `view_modified` / `materialized_view_modified` → `'view'`.

## Review findings

Adversarial pass over the implement-stage diff (`176eec17`). Read every touched
file plus the files it interacts with (the dependency tracker, the listener, the
other four schema-change listeners, the schema-object storage layer, and the docs).

### Major — fixed inline (with regression test)

- **Case-sensitivity invalidation miss.** SQL identifiers are case-insensitive and
  the schema stores the **canonical** create-time-cased object name (the map *key*
  is lowercased, but the stored `ViewSchema.name` keeps its original casing). The
  `view` plan dependency records `view.name` (canonical), but `setViewTags` /
  `setMaterializedViewTags` fired the event with `objectName: viewName` / `name` —
  the **raw user-typed** `ALTER` token from `plan.name`. The `statement.ts` listener
  matches with exact `dep.objectName === event.objectName`, so
  `create view MyView …; insert into MyView … (cached); alter view MYVIEW set tags …`
  silently **failed to invalidate** the cached plan (`'MyView' !== 'MYVIEW'`).
  - This diverged from the established `table_modified` path the fix is modeled on:
    `commitTagUpdate` fires `objectName: newSchema.name` (canonical), so the table
    path is case-robust.
  - **Fix:** both view/MV setters now fire `objectName: updated.name` (canonical),
    exactly mirroring `commitTagUpdate`. Added a focused regression case
    (`invalidates a cached plan when ALTER uses a different identifier case …`) that
    creates `MyView`, caches a write through `MyView`, retags via `MYVIEW`, and
    asserts re-routing. **Verified it fails on the pre-fix manager.ts** (1 failing)
    and passes with the fix.

### Minor — verified correct (no action)

- **MV-maintenance invariant preserved.** `database-materialized-views.ts` handles
  only `table_removed`, `table_modified`, and `materialized_view_removed`; it does
  **not** act on `materialized_view_modified`, so an MV tag change invalidates
  dependent cached write-through plans without re-registering maintenance or
  rebuilding the backing. The other three listeners (`database-assertions.ts`,
  `database-watchers.ts`, `assertion-hoist-cache.ts`) all use `if (event.type === …)`
  guards over unrelated event types and ignore the new variants. No exhaustive
  `switch` over `SchemaChangeEvent` exists, so adding union members compiled cleanly.
  (The implement handoff's "exhaustive `never` switch" phrasing was slightly
  inaccurate — they are `if` guards — but the conclusion held.)
- **Read path correctly not invalidated.** A read-only `select … from v` records no
  `view` dependency (it never enters `buildViewMutation`), so a view retag does not
  invalidate read plans — correct, since view tags do not change read results.
- **Base-table dependency still recorded.** A write-through also re-plans each base
  op through `schema-resolution.ts`, which records the underlying `table`
  dependency, so a base-table change still invalidates the write plan. The new
  `view` dependency is additive, not a replacement.
- **WeakRef is not a spurious-invalidation vector.** `recordDependency` stores a
  `WeakRef(view)`; `setViewTags` swaps in a new object so the old may be GC'd — but
  `checkIntegrity()` (the only WeakRef consumer) is **dead code**: it,
  `notifyInvalidation`, and `addInvalidationCallback` are defined but called nowhere
  in `src`. Invalidation is purely event-driven. Matches the pre-existing `table`
  dependency pattern exactly; introduces no new risk.

### Minor — pre-existing, shared with the table path (not addressed; out of scope)

- **Schema-name casing fragility.** The listener gates on
  `(!dep.schemaName || dep.schemaName === event.schemaName)`. The event's
  `schemaName` is `targetSchemaName` (`name.schema ?? getCurrentSchemaName()`) while
  the dependency's is the canonical `view.schemaName`. An explicitly-qualified ALTER
  with non-canonical schema casing (`alter view MAIN.v …`) could miss. This is
  **identical to the established `table_modified` path** (`commitTagUpdate` likewise
  uses `targetSchemaName` for the event and `tableSchema.schemaName` for the dep), so
  it is pre-existing and shared, not introduced here. The common unqualified case is
  unaffected (`getCurrentSchemaName()` returns the canonical name). Left as-is to keep
  the view path an exact mirror of the table path; any future hardening should fix
  both together.

### Docs

- `docs/sql.md` §2.7 note correctly re-softened to describe the new
  `view_modified` / `materialized_view_modified` events, the `view` plan dependency,
  and the read-path exemption. Verified no stale references to the old "keeps its
  cached routing / not tracked as plan dependencies / fires no schema-change event"
  limitation remain anywhere in `docs/` or `src/`. `docs/materialized-views.md` §327
  (the separate read-path synthetic-`table_modified` mechanism) is unaffected and
  still accurate.

## Tests checked

- Happy path — view + MV cached write-through re-routes after retag (existing). ✓
- Edge — case-differing ALTER identifier (added this pass). ✓
- Control — fresh `prepare` always re-plans with current tag (existing). ✓
- Regression — `declarative-equivalence` "MV tag-only drift … without a rebuild"
  stays green (MV event does not re-materialize). ✓
- **Not directly covered (low risk, one shared funnel):** direct UPDATE/DELETE-retag
  regression, and multi-source/decomposition/set-op/lens write-through retags. All
  route through the same `recordDependency` call, so covered by construction; flagged
  for transparency, not worth dedicated tests given the single funnel.

## Validation run (this pass, with the fix in place)

- Targeted spec `test/plan/view-tag-mutation-plan.spec.ts` → **4 passing**
  (incl. the new case-mismatch case; confirmed it fails without the manager fix).
- `yarn workspace @quereus/quereus test` (full suite) → **4813 passing, 9 pending,
  0 failing**.
- `yarn workspace @quereus/quereus lint` → clean.
- `yarn workspace @quereus/quereus typecheck` (`tsc --noEmit`) → clean.
- Not run: `yarn test:store` — tag setters are catalog-only and never round-trip
  through `alterTable`; no store-specific code touched (pre-existing deferral,
  documented in `docs/sql.md`).

## End
