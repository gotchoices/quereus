description: When a materialized view is sorted by a column and that source column later starts allowing blanks, the view used to refuse blank values; its stored copy now accepts them like any other column, and the special-case guards are gone.
architecture: docs/materialized-views.md#refresh-materialized-view
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts      # describeBackingShapeMismatch, classifyBackingReshape recordAttrShift, computeBackingPrimaryKey NOTE, rawReadingIsTheLiveOne doc
  - packages/quereus/src/core/database-materialized-views-apply.ts      # row-time guard removed
  - packages/quereus/src/core/database-materialized-views.ts            # guard call + doc comments
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # computeNullGuardColumns removed
  - packages/quereus/src/core/database-materialized-views-plans.ts      # MaintenancePlanCommon.nullGuardColumns removed
  - packages/quereus/src/schema/derivation.ts                           # ordering field comment
  - packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic  # new §16f
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts     # old-policy tests removed
  - packages/quereus/test/mv-backing-normalize-shape.spec.ts            # one test updated to the new flow
  - docs/materialized-views.md                                          # physical-vs-logical note, "Loosening a key column" paragraph
----

# Retired the "backing primary-key columns stay NOT NULL" policy

## What changed

A materialized view's backing table used to keep every physical primary-key column NOT NULL, even after the source column it came from was loosened with `alter … drop not null`. That policy lived in two masks and needed two guards to stop a NULL reaching a declared-NOT-NULL column. All four are gone; physical-key columns now follow the body's derived nullability like any other backing column. The ordering seed (`computeBackingPrimaryKey` putting `order by` columns first in the physical key) is unchanged and now carries an accepted-tradeoff `NOTE:` explaining why it stays (lens clustered-index model, covering-UNIQUE prefix seek, lateral-TVF prefix-delete arm).

Removed:
- the physical-PK loosening mask in `describeBackingShapeMismatch` — any not-null difference is now a mismatch;
- the physical-PK skip in `classifyBackingReshape`'s `recordAttrShift` — a loosening always emits `loosenNotNull`;
- `isPhysicalPkColumn`, `assertNoNullInNotNullSeededPk` (+ its call in `rebuildBacking`), `assertNoNullInNotNullSeededPkRowTime` (+ import/call in `postApplyBackingChanges`), `computeNullGuardColumns`, `MaintenancePlanCommon.nullGuardColumns`, `nullInNotNullSeededPkError`.

## Behaviour now

`create table par (id integer primary key, x integer not null)`, `create materialized view par_ix as select id, x from par order by x` (backing key `[x, id]`):
- `alter table par alter column x drop not null` → `par_ix` goes **stale** (previously it stayed live and rejected NULL inserts).
- NULL inserts into `par` succeed and are not maintained while stale.
- `refresh` → reshape arm → pre-reconcile `loosenNotNull` on `x` → backing `x` nullable, key still `[x, id]`, NULL rows stored, view live again; later NULL inserts/updates are maintained.

## Hand-checked edge cases (throwaway script, memory backend, deleted afterwards)

- **Loosening the source primary key itself** (`alter table par alter column id drop not null`), for both an `order by x` view and a plain projection view: both go stale; after inserting `(null, 7)` and refreshing, backing `id` reads nullable, the key is unchanged (`[x, id]` and `[id]` respectively), the NULL-keyed row is stored, view not stale. `keysOf` still proves `(id)` a key with a nullable PK column — no "physical-PK change is inexpressible" error. No bug ticket needed.
- **Loosening combined with another reshape** (`select *` body, `add column b`, then `drop not null` on `x`): refresh adds `b` and loosens `x` in one reshape; key `[x, id]` kept; NULL row stored.

## Invariant that replaces the guards (by inspection)

Every path that keeps or makes a view live now requires backing nullability == derived nullability: live recompile (`describeBackingShapeMismatch` + `backingColumnsStructurallyMatch`), rename restore (`describeBackingShapeMismatch`), import adopt (`backingShapeMatches`), `set maintained as` (exact nullability). So no NOT-NULL backing column receives rows from a body that says nullable. Reviewer: worth a second look at those four call sites.

## Tests

- **Added** `53-materialized-views-rowtime.sqllogic` §16f — the reproduction: `order by x` view, `drop not null`, NULL insert (stale snapshot shown), refresh (NULL row stored; `table_info` shows `x` `notnull 0`, still `pk 1`), then a live NULL insert and `update … set x = null` both maintained. On the old code this failed at the NULL insert (row-time guard: "would store NULL in column 'x'"). Passes under memory and store (`QUEREUS_TEST_STORE=true`, single-file grep), which covers the store `alterTable … setNotNull: false` on a primary-key column inside a refresh reshape.
- **Deleted** from `materialized-view-refresh-reshape.spec.ts`: the whole `NOT-NULL ordering-seeded PK guard` describe (every test asserted the guard error, or the nullable-at-create case, which exercises no removed code), plus two tests in `expressible in place` that asserted the backing key column *stays* NOT NULL after refresh (`a source DROP NOT NULL on an ordering-seeded backing PK column…`, `a PK-column DROP NOT NULL coexisting with a genuine reshape skips the loosen op…`). They pinned the retired policy; §16f covers the same refresh path through `classifyBackingReshape` on both backends. The ticket only named the describe block — deleting the two extra tests was my call; a reviewer may prefer keeping one of them rewritten for the combined add+loosen case.
- **Updated** `mv-backing-normalize-shape.spec.ts` › `a NOT NULL loosening on the source does not drag the key over to the module K`: it asserted the view stays live and refresh stays on the data-only path (both products of the old mask). Now asserts refresh loosens the key column and keeps its declared `BINARY` collation (not re-keyed to the module's NOCASE) — the property the test exists for (`rawReadingIsTheLiveOne` weighing only rewritten attributes). Its doc comment in `materialized-view-helpers.ts` was reworded accordingly.

## Validation run

- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus test` — 11182 passing, 23 pending, 0 failing.
- Store: `53-materialized-views-rowtime.sqllogic` alone, and all sqllogic files matching `materialized|maintained|mv` (17 files) — passing. The full `yarn test:store` was **not** run (wall-clock risk under the runner's limits).

## Known gaps / follow-ups

- Trade-off accepted per plan: `drop not null` on an ordering column now makes the view stale until refreshed (before, it stayed live and rejected only actual NULLs). Keeping such views live by loosening the backing in place is `backlog/feat-mv-drop-not-null-loosens-backing-in-place`.
- Persisted store backings created before this change whose key column was kept NOT NULL against a now-nullable derived shape will mismatch on reopen and drop + refill (`tryAdoptPreExistingBacking`); accepted (no backwards compatibility yet).
- Covering-UNIQUE enforcement over a now-nullable leading backing column relies on the prefix seek treating NULL as an ordinary key value — verified by inspection only, no test.
