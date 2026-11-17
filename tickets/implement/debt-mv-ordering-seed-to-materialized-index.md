description: When a materialized view is sorted by a column and that source column later starts allowing blanks, the view currently refuses blank values; now that key columns may hold blanks, let the view's stored copy accept them like any other column and delete the special-case guards.
architecture: docs/materialized-views.md#refresh-materialized-view
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts      # nullInNotNullSeededPkError (~87), computeBackingPrimaryKey NOTE (~302), assertNoNullInNotNullSeededPk (~1004-1038) + call in rebuildBacking (~1836-1846), isPhysicalPkColumn (~1935-1953), mask in describeBackingShapeMismatch (~1972-1988), skip in classifyBackingReshape recordAttrShift (~2515-2528), coarsened-key comment (~231-237)
  - packages/quereus/src/core/database-materialized-views-apply.ts      # assertNoNullInNotNullSeededPkRowTime (~179-213), import of nullInNotNullSeededPkError (18)
  - packages/quereus/src/core/database-materialized-views.ts            # import (~90) + call (~808)
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # computeNullGuardColumns (~236-287) and its assignment
  - packages/quereus/src/core/database-materialized-views-plans.ts      # MaintenancePlanCommon.nullGuardColumns (~232-239)
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts     # describe 'NOT-NULL ordering-seeded PK guard' (~500-745) — delete
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic  # §16 (refresh resumes maintenance) — add 16f
  - docs/materialized-views.md                                          # line 73 (physical vs logical key), 92 (coarsened), 219-224 (known limitation)
----

# Retire the "backing primary-key columns stay NOT NULL" policy

## Decision (plan stage)

The plan ticket proposed moving a materialized view's body `order by` out of the backing table's physical primary key into a separate secondary index. Research rejected that design; this ticket implements the smaller fix that removes the same root cause.

**Why the original proposal was declined.** Seeding the body's `order by` columns into the backing's physical primary key is load-bearing, not a stopgap:

- The lens architecture defines a materialized view with an `order by` *as* a clustered index (`docs/lens.md` ~250, "Indexes are a basis-layer concern, expressed as materialized views").
- Covering-UNIQUE enforcement (`lookupCoveringConflicts` / `tryBuildCoveringPrefix` in `core/database-materialized-views.ts` ~1290-1440, `docs/mv-constraints.md` ~117) does an O(log n) prefix seek that depends on the UNIQUE columns leading the backing primary key, which they do only because of the seed.
- The lateral-TVF `prefix-delete` maintenance arm and the declared-shape form (`create table … maintained as`, whose frozen basis includes the seeded key) also read the seeded key.

Moving ordering to a secondary index would rewrite all of those, and it would still not remove the guards: a loosened *logical-key* column (the source primary key itself after `drop not null`) hits the same mask.

**The actual root cause.** The ticket's premise — "a primary-key column cannot hold NULL" — is out of date. `docs/schema.md` § Primary-key nullability now states that primary-key membership does not force NOT NULL, NULL is an ordinary key value on both backends (memory compares NULL == NULL and sorts it first; the store codec encodes NULL as a type tag), and `alter column … drop not null` on a key column is permitted and metadata-only (pinned by `test/logic/43.3-nullable-primary-key.sqllogic` §9). The code's own NOTE at `isPhysicalPkColumn` already calls "backing PK columns stay NOT NULL" a *policy* of the materialized-view backing, not an engine constraint. That policy is the single site behind both guards:

- `describeBackingShapeMismatch` masks a NOT NULL → nullable loosening on a physical-PK column, so the live recompile after `alter … drop not null` keeps the view live against a backing that still declares the column NOT NULL, and refresh takes the data-only path instead of reshaping.
- `classifyBackingReshape` skips the `loosenNotNull` op for a physical-PK column.
- Because of those two masks, a NULL can reach a declared-NOT-NULL column, so two loud guards were added: `assertNoNullInNotNullSeededPk` (refresh) and `assertNoNullInNotNullSeededPkRowTime` + `plan.nullGuardColumns` (row-time).

**The fix.** Treat a physical-PK backing column's nullability exactly like any other backing column's: remove the mask, remove the skip, and delete both guards. The ordering seed (`computeBackingPrimaryKey`) stays as it is.

## Behaviour after the change

Example: `create table par (id integer primary key, x integer not null)`, `create materialized view par_ix as select id, x from par order by x` (backing primary key `[x, id]`, `x` NOT NULL).

- `alter table par alter column x drop not null` → the re-derived shape says `x` is nullable; `describeBackingShapeMismatch` now reports `column 1 not-null true → false`; `backingColumnsStructurallyMatch` fails too, so `tryRecompileMaterializedViewLive` declines and `par_ix` is **marked stale**. This is exactly what already happens today for a non-key column (see `53-materialized-views-rowtime.sqllogic` §16a, `al_ix`).
- `insert into par values (2, null)` succeeds; the stale view does not maintain it.
- `refresh materialized view par_ix` → `backingShapeMatches` is false → `reshapeBacking` → `classifyBackingReshape` emits a pre-reconcile `loosenNotNull` on `x` (primary key unchanged: still `[x, id]`) → the module's `alterTable` applies it as metadata-only → the reconcile stores `{2, NULL}`. Backing `x` now reads nullable, primary key still `[x, id]`, view no longer stale.
- Afterwards, live maintenance of NULL inserts/updates in `x` works (the row-time plan is re-registered against a nullable backing column).

Uniqueness is unaffected: the seeded key always ends with the logical key, so `(NULL, 1)` and `(NULL, 2)` remain distinct.

Trade-off accepted: before this change, `drop not null` on an ordering column left the view live (rejecting only actual NULLs); after it, the view goes stale until refreshed, matching every other column. Keeping such views live by loosening the backing in place is filed separately as `backlog/feat-mv-drop-not-null-loosens-backing-in-place`.

## Edge cases & interactions

- **Loosening the source primary key itself** (`alter table par alter column id drop not null` where `id` is the logical key). Previously masked; now stale → refresh → `loosenNotNull` on `id`. This only stays an in-place reshape if `keysOf` still proves `(id)` a key once the source PK column is nullable; if it does not, the derived primary key changes and refresh raises the existing "physical-PK change is inexpressible" sited error. Verify by running this sequence once by hand (or a throwaway spec) during implement; report what happens in the review handoff. If it errors, that is a pre-existing keysOf/nullable-PK question — note it in the handoff and file a `bug-` backlog ticket rather than re-adding a mask.
- **Loosening combined with another shape change** (e.g. `select *` body + `alter … add column` then `drop not null`, the old "reshape-arm" test). Same path as the loosening-only case now — both reach `classifyBackingReshape`. Verified by inspection; the new sqllogic covers the shared path.
- **Tightening** (nullable → NOT NULL) is unchanged: still a real mismatch, still a post-reconcile `tightenNotNull`.
- **Covering UNIQUE enforcement** while the covering view is stale after a loosening: `findIndexForConstraint` only uses a *non-stale* row-time covering view (`vtab/memory/layer/manager.ts` ~65-75), so enforcement falls back to the auto-index. After refresh the backing's leading UNIQUE columns may be nullable; `lookupCoveringConflicts`' prefix seek handles NULL as an ordinary key value on both backends. Verified by inspection — no code change expected.
- **Persisted backings from before this change** whose physical-PK column was kept NOT NULL while the derived shape is nullable: on reopen `tryAdoptPreExistingBacking` (`schema/manager.ts` ~3648) sees a shape mismatch and falls back to drop + refill. Acceptable (AGENTS.md: backwards compatibility not a concern yet); no code needed.
- **Invariant that replaces the guards.** After the change, every path that keeps or makes a view live requires backing nullability == derived nullability: live recompile (`describeBackingShapeMismatch` and `backingColumnsStructurallyMatch`), rename restore (`describeBackingShapeMismatch`), import adopt (`backingShapeMatches`), and `set maintained as` (exact nullability). So no NOT-NULL backing column receives rows from a body that says nullable. Verified by inspection of those four call sites; mention them in the handoff.
- **Store backend.** The novel runtime path is `alterTable … setNotNull: false` on a store-hosted *primary-key* column inside a refresh reshape. Placing the regression test in a `.sqllogic` file means `yarn test:store` exercises it; run that sqllogic file under the store once (see TODO).

## Tests

- Delete the whole `describe('NOT-NULL ordering-seeded PK guard …')` block in `materialized-view-refresh-reshape.spec.ts` (~500-745): every test there asserts the guard's error, which no longer exists.
- Add one regression block **16f** to `53-materialized-views-rowtime.sqllogic` §16 (it runs under both memory and store), for the example above: create the `order by x` view over a NOT-NULL `x`; `drop not null`; insert a NULL row; read shows the pre-alter snapshot; `refresh`; read shows the NULL row; then a live `insert` of another NULL row and an `update … set x = null` are both reflected without a further refresh. Use fresh table names (`par` is already used in §16e). This is the reproduction of the defect the guards were patching (refresh used to fail with "would store NULL in column 'x'").
- No other new tests.

## TODO

- Remove the mask in `describeBackingShapeMismatch` so any not-null difference is reported.
- Remove the physical-PK skip in `classifyBackingReshape`'s `recordAttrShift`; a loosening always pushes `loosenNotNull`.
- Delete `isPhysicalPkColumn`.
- Delete `assertNoNullInNotNullSeededPk` and its call in `rebuildBacking`, plus the comment block above that call.
- Delete `assertNoNullInNotNullSeededPkRowTime`, its import and call in `database-materialized-views.ts`, `computeNullGuardColumns` and its assignment in the plan builder, and `nullGuardColumns` on `MaintenancePlanCommon`.
- Delete `nullInNotNullSeededPkError` (check for remaining references with `find_references`).
- Rewrite the NOTE above `computeBackingPrimaryKey` as an accepted-tradeoff note: body ordering seeds the physical key on purpose (the lens "materialized view with `order by` is a clustered index" model, covering-UNIQUE prefix seeks, the prefix-delete arm); a separate secondary index was considered and declined; seeded columns follow the derived nullability like any column. Revisit if a body ordering ever needs to be non-unique on its own *and* the clustering stops being relied on. Also fix the coarsened-key comment (~231-237) if it still references the old ticket.
- Update `docs/materialized-views.md`: line 73 (drop "generalizes this into a proper materialized index"; say the seeded key is the clustered-index model and that seeded columns keep their derived nullability), and replace the known-limitation block at 219-224 with one short paragraph: a loosening of any backing column, primary-key or not, marks the view stale and the next refresh loosens the backing column in place. Grep `docs/` for `seeded` / `nullGuard` / `isPhysicalPkColumn` for leftovers.
- Add sqllogic §16f; delete the spec describe block.
- Hand-check the "loosen the source primary key" edge case above and record the result in the handoff.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`; then run the 53 sqllogic file under the store (`yarn test:store`, or its single-file filter if one exists) to cover the store `setNotNull` path.
