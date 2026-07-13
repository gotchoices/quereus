---
description: |
  Adversarial review of the new loud error that stops a materialized view's live
  maintenance from silently storing a NULL into one of its own "cannot be null" columns.
prereq:
files:
  - packages/quereus/src/core/database-materialized-views-plans.ts          # nullGuardColumns field on MaintenancePlanCommon
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # computeNullGuardColumns + attach in buildMaintenancePlan
  - packages/quereus/src/core/database-materialized-views-apply.ts          # assertNoNullInNotNullSeededPkRowTime (the shared per-change scan)
  - packages/quereus/src/core/database-materialized-views.ts                # two call sites: maintainRowTime + flushDeferredRebuilds
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts          # nullInNotNullSeededPkError reworded vector-neutral
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts         # § NOT-NULL ordering-seeded PK guard (refresh + new row-time sub-describe)
  - docs/materialized-views.md                                              # Known-limitation section updated: both vectors now guarded
difficulty: medium
---

# Review: guard row-time MV maintenance against storing NULL into a NOT-NULL ordering-seeded backing PK

## What the bug was (plain terms)

A materialized view whose body says `order by <col>` pins `<col>` into the backing table's
*physical* primary key, and a NOT-NULL source column becomes a NOT-NULL backing column. If the
source column later drops NOT NULL and a NULL row is inserted, the view's **live maintenance**
(the write-through on every source insert/update/delete) stored that NULL into a backing column
whose schema still says NOT NULL — silently, no error. A sibling ticket already added a loud error
on the *refresh* path; this ticket adds the equivalent on the **row-time** (live-maintenance) path,
which is the primary vector and fires *before* any refresh.

## Reproduction the fix closes (was silent, now throws)

```sql
create table par (id integer primary key, x integer not null);
insert into par values (1, 5);
create materialized view par_ix as select id, x from par order by x;  -- backing PK = [x, id], x NOT NULL
alter table par alter column x drop not null;                          -- par_ix NOT marked stale — recompiles live
insert into par (id, x) values (2, null);                              -- now throws CONSTRAINT naming 'x' / par_ix
select id, x from par_ix;                                              -- stays {1,5}; the insert rolled back
```

## What was implemented

- **New plan field** `nullGuardColumns?` on `MaintenancePlanCommon` (`database-materialized-views-plans.ts`).
  Present (non-`undefined`) **only** when the MV carries the reachable skew, so the common case
  pays one boolean check per maintained write.
- **Precompute** `computeNullGuardColumns(mv, analyzed)` in `buildMaintenancePlan`
  (`database-materialized-views-plan-builders.ts`), attached to the built plan before return.
  A backing column `i` is guarded iff **all three**: (1) `mv.columns[i].notNull === true`,
  (2) `i` is a physical-PK member, (3) the re-derived body output column `i` is nullable
  (`root.getType().columns[i].type.nullable !== false`). Term (3) is the discriminator — (1)+(2)
  alone is non-empty for almost every MV. Recomputed at exactly the moment the skew appears because
  `alter … drop not null` re-runs `buildMaintenancePlan`.
- **Shared per-change scan** `assertNoNullInNotNullSeededPkRowTime(plan, changes)`
  (`database-materialized-views-apply.ts`, next to `validateDerivedChanges`): no-op when the field is
  `undefined`; else, for each non-delete change, throws `nullInNotNullSeededPkError` on the first
  guarded column holding `null`/`undefined`.
- **Wired at both row-time choke points** (`database-materialized-views.ts`), placed **before** the
  MV-over-MV cascade (so a NULL never reaches a consumer) and alongside the existing
  `derivedRowValidator` call: `maintainRowTime` (~638, bounded-delta arms) and
  `flushDeferredRebuilds` (~708, full-rebuild floor).
- **Error reworded vector-neutral**: `nullInNotNullSeededPkError` now opens *"maintaining
  materialized view '…' would store NULL in column '…'"* so it reads correctly from both the refresh
  and row-time call sites. Signature unchanged; JSDoc updated to name both vectors. The existing
  refresh test's `/would store NULL in column 'x'/` matcher still passes.
- **Docs** (`docs/materialized-views.md`, Known-limitation section) updated: the row-time vector is
  no longer "tracked separately" — both vectors are now guarded.

## Validation performed (all green)

- `yarn build` — exit 0.
- `yarn test` (full quereus suite) — **6991 passing, 13 pending**, exit 0.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`, type-checks spec call sites) — exit 0.

## Tests added / changed (`materialized-view-refresh-reshape.spec.ts` § NOT-NULL ordering-seeded PK guard)

New `row-time maintenance` sub-describe:
- **NULL maintained insert throws** `CONSTRAINT`, names `x` and `par_ix`; backing + source both stay
  `{1,5}` (nothing committed).
- **Non-NULL maintained insert still succeeds** after `drop not null` (guard fires only on an actual NULL).
- **Nullable-at-create seeded PK column** (`x integer null`) keeps accepting NULL maintained inserts —
  the `notNull === true` gate excludes it (not over-rejected).

Rewrote the former refresh "fast path" test → *"the primary (row-time) vector rejects the NULL at the
source INSERT, and a subsequent refresh over the clean backing succeeds"*, and updated the describe's
scope note. Reason: its old mechanism (insert silently stored the NULL, then refresh rejected it) is
**gone** — the insert now throws first. The reshape-arm refresh test and the permitted-nullable test
are unchanged and still pass, so the refresh guard function stays covered.

## Honest gaps / things to scrutinize (your tests are a floor)

- **Full-rebuild call site is wired but NOT exercised by a test.** Every added test drives the
  *inverse-projection* arm (`select id, x … order by x`). The `flushDeferredRebuilds` guard call has no
  regression. A full-rebuild MV that also seeds an ordering column into a NOT-NULL physical PK (e.g. a
  body that falls to the floor — `distinct`, a window/set-op shape — while still `order by <col>`) would
  hit that call site. **Worth adding** a floor-arm regression if such a shape is constructible; I did not
  confirm one produces the seeded-PK skew. Flagging as the main coverage gap.
- **UPDATE-to-NULL not directly tested.** The guard covers `update` (its `newRow` is scanned), but the
  tests only exercise `insert`. An `update par set x = null where id = 1` on the loosened source should
  throw the same way — consider pinning it.
- **MV-over-MV cascade ordering asserted only structurally.** The guard is placed before the cascade so a
  NULL never reaches a consumer; no test builds a consumer MV over the guarded producer to confirm the
  consumer is never fed the NULL. Low risk (a throw unwinds the whole statement), but untested.
- **Refresh fast-path guard is now unreachable via DML** (defense-in-depth only). Because row-time
  rejects the NULL at the source write, a non-stale MV's backing can no longer reach a NULL-in-seeded-PK
  state through supported DML. I confirmed empirically that a source `add column` does **not** mark an
  explicit-projection MV stale, so there is no "stale-but-fast-path" recipe to exercise it. Documented in
  the describe's scope note and in `docs/materialized-views.md`. **This is a tripwire, not a ticket:** if
  a future path can seed a NULL into a non-stale backing (catalog import, a new bypass), the fast-path
  refresh guard becomes live again and should get direct coverage then.
- **Index-alignment assumption.** `computeNullGuardColumns` relies on backing column `i` ↔ body output
  column `i` (matches `deriveBackingShape`'s positional derivation) and on `notNull = type.nullable ===
  false` agreeing with the backing declaration by construction. Sanity-check this holds for an
  explicit-column-list MV (`mv(a, b) as …`) where names are overridden but positions are preserved.

## Ultimate resolution (unchanged)

`backlog/debt-mv-ordering-seed-to-materialized-index` removes the pinned-NOT-NULL physical-PK column
entirely (body order as a materialized secondary index), rooting out both vectors. This ticket is the
interim loud-error guard for the row-time path, matching the refresh guard.
