description: Review the fix that invalidates cached write-through plans after `ALTER VIEW/MATERIALIZED VIEW … SET TAGS`, via a new `view` schema-dependency type plus `view_modified`/`materialized_view_modified` change events recorded on every view-mediated write.
files:
  - packages/quereus/src/schema/change-events.ts            # ViewModifiedEvent + MaterializedViewModifiedEvent added to the union
  - packages/quereus/src/schema/manager.ts                  # setViewTags (~732) / setMaterializedViewTags (~754) now fire the new events
  - packages/quereus/src/planner/planning-context.ts        # SchemaDependency.type union gained 'view' (line 29)
  - packages/quereus/src/planner/building/view-mutation-builder.ts  # buildViewMutation records the 'view' dependency (single funnel)
  - packages/quereus/src/core/statement.ts                  # compile() listener maps view_/materialized_view_modified → 'view' (~159)
  - packages/quereus/src/core/database-materialized-views.ts # listener confirmed to ignore materialized_view_modified (no maintenance re-registration)
  - docs/sql.md                                             # §2.7 note re-softened (~1362)
  - packages/quereus/test/plan/view-tag-mutation-plan.spec.ts  # NEW regression spec (view + MV write-through)
----

# Review: invalidate cached write-through plans after `ALTER VIEW … SET TAGS`

## What the bug was

A view-/MV-mediated write (`insert/update/delete into v`) reads the view's
behavioral `quereus.update.*` override tags to steer its lowering. Before this
fix, `ALTER VIEW … SET TAGS` (→ `SchemaManager.setViewTags`) swapped the
in-memory `ViewSchema` but fired **no** schema-change event, and a view-mediated
write recorded **no** schema dependency. So an already-prepared (cached)
statement that wrote through the view kept its stale routing until re-prepared.
Confirmed reproduced on this branch: after retagging `default_for.created` from
100 → 200, a re-run of the *same* cached `insert into v …` still wrote 100.

`ALTER TABLE … SET TAGS` did not have this bug — it fires `table_modified` on a
tracked `table` dependency. The fix mirrors that path for views/MVs.

## What changed (the chain)

1. **`change-events.ts`** — two new events, `view_modified` (carries
   `ViewSchema`) and `materialized_view_modified` (carries
   `MaterializedViewSchema`), added to the `SchemaChangeEvent` union. They are
   **deliberately distinct** from the create events: the MV maintenance manager
   re-registers maintenance on `materialized_view_added` but must NOT on a
   tag-only change.
2. **`manager.ts`** — `setViewTags` / `setMaterializedViewTags` now fire the new
   events after the in-memory schema swap. Doc comments updated (they previously
   asserted "no event is fired").
3. **`planning-context.ts`** — `SchemaDependency.type` gained `'view'`. The
   dependency key is `${type}:${schema}:${name}:${version}`, so a `view`
   dependency never collides with a same-named `table` dependency.
4. **`view-mutation-builder.ts`** — `buildViewMutation` records the `view`
   dependency once at the top. This is the **single funnel** for *all*
   view-/MV-mediated writes (single-source spine, multi-source join,
   decomposition fan-out, set-op membership, lens-backed), so recording here
   (rather than at each builder's `getView` site) is DRY and covers every
   write-through path and all three ops.
5. **`statement.ts`** — the `compile()` invalidation listener maps
   `view_modified` / `materialized_view_modified` → `'view'` (a branch *before*
   the `startsWith('table_')` chain). The existing name/schema match then fires.

## Why the MV-maintenance invariant is preserved

`database-materialized-views.ts`'s schema-change listener handles only
`table_removed`, `table_modified`, and `materialized_view_removed`. It does
**not** act on `materialized_view_modified`, so an MV tag change invalidates
dependent cached write-through plans but does **not** re-register maintenance or
rebuild the backing. The other three listeners (`database-assertions.ts`,
`database-watchers.ts`, `assertion-hoist-cache.ts`) also ignore the new events
(verified by reading each). Only `statement.ts` was taught to react.

## Use cases to validate (reviewer checklist)

- **Core regression (covered, green):** prepare `insert into v (id) values (?)`
  once; run with id=1 (created=100); `ALTER VIEW v SET TAGS
  ("quereus.update.default_for.created" = '200')`; run the *same* statement with
  id=2; assert row 2 has created=200. Without the fix row 2 is 100. See
  `test/plan/view-tag-mutation-plan.spec.ts`.
- **MV analogue (covered, green):** same shape via
  `create materialized view mv … with tags (…)` + `alter materialized view mv
  set tags (…)`. Confirms MV write-through (which funnels through the same
  builder) invalidates AND that maintenance still works for the post-retag write.
- **Invariant (covered by existing suite, green):** the
  `declarative-equivalence` "MV tag-only drift … without a rebuild" test stays
  green — the new MV event does not trigger re-materialization.
- **Read path (by design, not tested):** a read-only `select … from v` records
  **no** view dependency, so a view retag does not invalidate read plans. This is
  intentional (view tags do not change read results). Confirm you agree with that
  semantics.

## Known gaps / honest limitations (reviewer: treat tests as a floor)

- **Only INSERT-via-`default_for` is directly tested.** The `view` dependency is
  recorded op-agnostically (once, at the top of `buildViewMutation`, before any
  op branch), and `quereus.update.*` tags affect UPDATE/DELETE routing too, so
  the mechanism covers them — but there is **no direct UPDATE/DELETE retag
  regression test**. A reviewer wanting belt-and-suspenders could add one
  (e.g. a `quereus.update.where_for.*` / predicate-pin tag whose change alters an
  UPDATE's base predicate), but it exercises the identical invalidation path.
- **Only single-source view + single-source MV are tested.** Multi-source/join
  views, decomposition-backed logical tables, set-op membership writes, and
  lens-backed logical tables all funnel through the same `recordDependency` call,
  so they are covered by construction — but none has a dedicated retag test. Low
  risk (one shared funnel), flagged for transparency.
- **WeakRef consideration (no action expected).** `recordDependency` stores a
  `WeakRef` to the `view` object alongside the dependency. `setViewTags` swaps in
  a *new* object, so the old one may be GC'd — but invalidation here is
  event-driven (name+type+schema match in the listener), not WeakRef-driven
  (`checkIntegrity()` is the only WeakRef consumer). This matches the existing
  `table` dependency pattern exactly (a `table_modified` also swaps the
  `TableSchema`), so it introduces no new risk; noted only so the reviewer
  doesn't have to rediscover it.

## Validation run

- `yarn workspace @quereus/quereus test` → **4811 passing, 9 pending** (run with
  all src changes in place; the two added view/MV regression cases pass in
  isolation, 3 passing for the new spec).
- `yarn workspace @quereus/quereus lint` → **clean**.
- `yarn build` (quereus) → clean (exhaustive `never` switches over the event
  union compile, so the new variants are wired everywhere they must be).
- Not run: `yarn test:store` (no store-specific code touched — tag setters are
  catalog-only and never round-trip through `alterTable`; the store caveat for
  tag re-persistence is pre-existing and documented in `docs/sql.md`).
