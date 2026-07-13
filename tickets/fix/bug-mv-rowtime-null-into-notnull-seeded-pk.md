---
description: |
  Inserting a NULL into a source column silently stores that NULL into a materialized view's
  backing column that the view's schema still declares NOT NULL — corrupting data with no error.
prereq:
files:
  - packages/quereus/src/core/database-materialized-views.ts          # maintainRowTime (~626-640), flushDeferredRebuilds (~698-710) — the two apply choke points
  - packages/quereus/src/core/database-materialized-views-apply.ts     # applyInverseProjection / applyFullRebuild etc. build the ops that store the NULL
  - packages/quereus/src/core/database-materialized-views-plans.ts     # MaintenancePlan — where a precomputed "guarded" flag would live
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts     # nullInNotNullSeededPkError (already landed) — share it
difficulty: medium
---

# Bug: row-time maintenance silently stores a NULL into a NOT-NULL ordering-seeded backing PK column

## Plain summary

A materialized view whose body carries `order by <col>` seeds `<col>` into the backing table's
*physical* primary key, and a NOT-NULL source column becomes a NOT-NULL backing column. If the source
column later drops NOT NULL and a NULL row is inserted, the view's **row-time maintenance** stores that
NULL into the backing column its own schema still declares NOT NULL — silently. The backing schema then
lies (declares NOT NULL while holding a NULL), and a NULL sits in a declared-NOT-NULL PK column.

## Why this exists after the refresh guard landed

The sibling ticket `mv-refresh-null-into-notnull-seeded-pk-guard` added a loud-error guard in
`rebuildBacking` (materialized-view-helpers.ts) so a **refresh** cannot store this NULL. During that
work the row-time vector was discovered: it is the **primary** vector and fires *before* any refresh.

The refresh ticket's scope finding ("Only the refresh rebuild path is affected") was **empirically
wrong**. It assumed `alter … drop not null` marks the MV stale (detaching row-time). It does not: for a
plain projection body the change recompiles the MV **live** (`isBodyIrrelevantTableChange` /
`tryRecompileMaterializedViewLive`), so the row-time plan stays attached and maintains the NULL insert
straight into the backing.

## Reproduced (confirmed on current tree, post refresh-guard)

```sql
create table par (id integer primary key, x integer not null);
insert into par values (1, 5);
create materialized view par_ix as select id, x from par order by x;  -- backing PK = [x, id], x NOT NULL
alter table par alter column x drop not null;                          -- par_ix NOT marked stale (recompiles live)
insert into par (id, x) values (2, null);                              -- ROW-TIME maintenance stores {2, NULL} — silent
select id, x from par_ix;                                              -- returns {1,5} AND {2, NULL}
```

Empirically: after the `insert`, `par_ix.derivation.stale === false`, the insert threw nothing, and
`select id, x from par_ix` returns `[{"id":1,"x":5},{"id":2,"x":null}]` — the NULL is in the backing
**before** any `refresh` runs. (The refresh guard then correctly throws on a subsequent refresh, but the
corruption already happened.)

## Scope of the affected code

- **Confirmed:** the incremental **inverse-projection** arm (`applyInverseProjection`) — the plan
  chosen for `select id, x from par order by x` — projects the source NULL into the backing and upserts
  it; the memory backing host tolerates NULL key components, so nothing rejects it.
- **By inspection (not separately reproduced):** the **full-rebuild** arm (`applyFullRebuild`) has the
  same hole — it applies a `'replace-all'` of the recomputed rows and the only post-apply validation is
  `validateDerivedChanges`, which checks declared CHECK/FK, never column NOT NULL. Any full-rebuild MV
  with a NOT-NULL ordering-seeded PK column over a loosened source is equally affected. The
  forward/join/prefix residual arms build the same kind of `upsert` ops and are presumed affected too.

## Requirements / expected behavior

- Maintaining a source write must **not** silently store a NULL into a backing column that is declared
  NOT NULL **and** is a physical-PK member (the exact reachable contradiction). It must fail loudly with
  a `CONSTRAINT` error attributed to the MV and naming the column — the same posture the refresh guard
  established. Reuse `nullInNotNullSeededPkError` (materialized-view-helpers.ts) — or generalize its
  wording, which currently opens with "refresh of materialized view …", to be vector-neutral.
- Do **not** reject the permitted case: a physical-PK column declared **nullable** (a nullable-source
  ordering column) self-consistently stores NULL and must keep working (guard only on `col.notNull === true`).
- The failing source statement should unwind with nothing committed (the backing write rides the pending
  layer; a throw before commit discards it — same as `validateDerivedChanges`).

## Design note (keep the hot path cheap)

The natural choke points are the two spots in `database-materialized-views.ts` where `backingChanges`
already exists and `validateDerivedChanges` is called conditionally: `maintainRowTime` (~638) and
`flushDeferredRebuilds` (~708). A validation over `backingChanges` (skip `op === 'delete'`; check each
guarded column in `newRow`) covers all arms at once.

**But** the guarded set (columns both NOT NULL and physical-PK) is **non-empty for almost every MV** —
the logical-key PK column is normally the source PK, which is NOT NULL — so a naive per-change scan runs
on essentially every maintained write, not just the rare skewed ones. The cheap discriminator is not
"is the set empty" but "does a guarded physical-PK backing column have a **nullable source** column"
(the actual NOT-NULL/nullable skew). Precompute that skew flag once at plan build (`buildMaintenancePlan`
in database-materialized-views-plans.ts) and only run the per-change NULL scan when the flag is set —
so the overwhelming common case pays a single boolean check.

## Ultimate resolution

`backlog/debt-mv-ordering-seed-to-materialized-index` removes the pinned-NOT-NULL physical-PK column
entirely (expressing body order as a materialized secondary index), which roots out **both** this
row-time vector and the refresh vector. This bug is the interim loud-error guard for the row-time path,
matching what the refresh guard already did for refresh.

## Test homes

- `packages/quereus/test/materialized-view-refresh-reshape.spec.ts` § *NOT-NULL ordering-seeded PK guard*
  already documents this vector (see the inline scope note in the first test). Add the row-time repro
  above as a new regression once the guard lands: the `insert into par (id, x) values (2, null)` itself
  must throw a CONSTRAINT naming `x`, and `par_ix` must stay `{1,5}`.
- Companion positive case: after `drop not null` with only non-NULL values, ordinary maintained inserts
  still succeed and keep `x` NOT NULL (this is the existing sibling behavior).
