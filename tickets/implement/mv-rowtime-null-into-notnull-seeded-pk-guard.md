---
description: |
  A materialized view can silently store a NULL into one of its own columns that it still
  declares as "cannot be null", corrupting the view's data with no error. Add a loud error so
  the offending insert fails instead.
prereq:
files:
  - packages/quereus/src/core/database-materialized-views.ts               # maintainRowTime (~626-654) + flushDeferredRebuilds (~683-725) — the two guard sites
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts  # buildMaintenancePlan (~136) — precompute the skew flag here (has `analyzed` + `mv`)
  - packages/quereus/src/core/database-materialized-views-plans.ts          # MaintenancePlanCommon — new optional `nullGuardColumns` field
  - packages/quereus/src/core/database-materialized-views-apply.ts          # optional home for the shared per-change scan helper (sits next to validateDerivedChanges)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts          # nullInNotNullSeededPkError (~80) — reword vector-neutral, share it
  - packages/quereus/test/materialized-view-refresh-reshape.spec.ts         # § NOT-NULL ordering-seeded PK guard — add the row-time regression here
difficulty: medium
---

# Guard row-time MV maintenance against storing NULL into a NOT-NULL ordering-seeded backing PK column

## Plain summary

A materialized view whose body has `order by <col>` pins `<col>` into the backing table's
*physical* primary key, and a NOT-NULL source column becomes a NOT-NULL backing column. If the
source column later drops NOT NULL and a NULL row is inserted, the view's **row-time maintenance**
(the write-through that runs on every source `insert`/`update`/`delete`) stores that NULL into a
backing column whose schema still says NOT NULL — silently. The backing then holds a NULL in a
declared-NOT-NULL PK column.

A sibling ticket (`mv-refresh-null-into-notnull-seeded-pk-guard`, landed) added a loud error on the
**refresh** path (`rebuildBacking` → `assertNoNullInNotNullSeededPk` in
`runtime/emit/materialized-view-helpers.ts`). But row-time maintenance is the **primary** vector and
fires *before* any refresh, so the corruption already happened by the time refresh's guard runs. This
ticket adds the equivalent loud error to the row-time path.

## Reproduction (confirmed on current tree, post refresh-guard)

```sql
create table par (id integer primary key, x integer not null);
insert into par values (1, 5);
create materialized view par_ix as select id, x from par order by x;  -- backing PK = [x, id], x NOT NULL
alter table par alter column x drop not null;                          -- par_ix NOT marked stale — recompiles live
insert into par (id, x) values (2, null);                              -- row-time maintenance stores {2, NULL} — silent, no error
select id, x from par_ix;                                              -- BUG: returns {1,5} AND {2, NULL}
```

Expected after fix: the `insert into par (id, x) values (2, null)` itself throws a `CONSTRAINT`
error naming `x` and attributed to `par_ix`, nothing commits, and `par_ix` stays `{1,5}`.

## Why row-time stays attached after `drop not null` (this is what makes the bug reachable)

`alter table par alter column x drop not null` is a source change that leaves `par_ix`'s backing
column/PK shape identical, so the MV manager's schema-change listener routes it through
`tryRecompileMaterializedViewLive` (`materialized-view-helpers.ts:2016`) instead of marking `par_ix`
stale. That helper's content-stability gate is a **no-op for a plain NOT-NULL loosen** (only a
value-semantics type/collation ALTER trips it), so it calls `db.registerMaterializedView(backing)`
(line 2084) → `buildMaintenancePlan` and the row-time plan stays live. The next source insert
maintains straight into the backing. (The refresh ticket's "only refresh is affected" scope finding
was empirically wrong precisely because it assumed this ALTER marks the MV stale — it does not.)

**This is load-bearing for the fix's freshness argument:** because `drop not null` re-runs
`buildMaintenancePlan`, a skew flag precomputed *there* is recomputed at exactly the moment the skew
appears (source column goes nullable while the backing PK column stays NOT NULL). No separate
invalidation is needed.

## The fix — precompute the skew once, scan per change only when it is set

### 1. New plan field (`database-materialized-views-plans.ts`)

Add to `MaintenancePlanCommon` (so every arm inherits it, exactly like `derivedRowValidator` /
`coarseningWatch`):

```ts
/** Backing columns that are BOTH declared NOT NULL AND physical-PK members AND whose re-derived
 *  body output column is nullable — the exact reachable "NOT-NULL ordering-seeded PK over a
 *  loosened source" skew. Present ONLY when non-empty (the zero-overhead gate: nearly every MV
 *  carries `undefined` and pays a single boolean check per maintained write). Precomputed once
 *  at plan build (buildMaintenancePlan). Read by the row-time guard in maintainRowTime /
 *  flushDeferredRebuilds. See fix/bug-mv-rowtime-null-into-notnull-seeded-pk. */
nullGuardColumns?: ReadonlyArray<{ readonly index: number; readonly name: string }>;
```

### 2. Precompute in `buildMaintenancePlan` (`database-materialized-views-plan-builders.ts:136`)

`buildMaintenancePlan` already has both inputs it needs:
- `mv` is the live backing/maintained `TableSchema` — `mv.columns[i].notNull` and
  `mv.primaryKeyDefinition` give the "NOT NULL and physical-PK member" set.
- `analyzed` is the optimized body — `rootRelationalNode(analyzed)` (already imported in this file
  from `database-materialized-views-analysis.ts`) → `.getType().columns[i].type.nullable` gives the
  re-derived body output nullability.

**Index alignment:** backing column `i` corresponds 1:1 to body output column `i` (`deriveBackingShape`
builds the backing column list positionally from the body's output columns). So the guarded set is:

```
{ index: i, name: mv.columns[i].name }
  for each i where
    mv.columns[i].notNull === true
    && mv.primaryKeyDefinition.some(d => d.index === i)   // physical-PK member
    && rootRelationalNode(analyzed).getType().columns[i].type.nullable !== false  // body now yields nullable
```

Compute it in a small helper (`computeNullGuardColumns(mv, analyzed)`), then attach to the built plan
before returning: `plan.nullGuardColumns = guarded.length > 0 ? guarded : undefined;` — same
post-build attachment pattern `registerMaterializedView` uses for `derivedRowValidator` /
`coarseningWatch`. (`MaintenancePlanCommon` fields are mutable, so mutating the returned union member
is fine.)

Why gate on body-nullability, not just "is the guarded set non-empty": the NOT-NULL/physical-PK set is
non-empty for **almost every MV** (the logical-key PK column is normally the NOT-NULL source PK), so a
naive per-change scan would run on essentially every maintained write. The `type.nullable !== false`
term is the real discriminator — it is true only for the rare loosened-source skew, so the field stays
`undefined` (zero per-write cost) for the common case. Matches `deriveBackingShape`'s own
`notNull = c.type.nullable === false` derivation, so the two agree by construction.

**Permitted case stays permitted:** a physical-PK column declared **nullable** (a nullable-source
ordering column) has `mv.columns[i].notNull !== true`, so it is never guarded — it self-consistently
stores NULL and must keep working.

### 3. Enforce at the two row-time choke points (`database-materialized-views.ts`)

Both spots already have `backingChanges` in hand and call `validateDerivedChanges` conditionally. Add
a `plan.nullGuardColumns` guard immediately alongside — placed **before** the MV-over-MV cascade so a
NULL row never reaches a consumer:

- `maintainRowTime` (~638, right where `if (plan.derivedRowValidator)` is) — covers the
  bounded-delta arms (inverse-projection, residual-recompute, prefix-delete, join-residual).
- `flushDeferredRebuilds` (~708, the matching spot) — covers the full-rebuild floor.

Shared helper (a good home is `database-materialized-views-apply.ts` next to `validateDerivedChanges`,
or a private method on the manager):

```ts
if (plan.nullGuardColumns) {
  for (const change of backingChanges) {
    if (change.op === 'delete') continue;          // a delete writes no image
    for (const g of plan.nullGuardColumns) {
      const v = change.newRow[g.index];
      if (v === null || v === undefined) {
        throw nullInNotNullSeededPkError(plan.mv.schemaName, plan.mv.name, g.name);
      }
    }
  }
}
```

The throw unwinds the source statement with nothing committed — the backing write rides the pending
layer and a throw before commit discards it, same as `validateDerivedChanges`.

### 4. Generalize the error wording (`materialized-view-helpers.ts:80`)

`nullInNotNullSeededPkError` currently opens `"refresh of materialized view '…' would store NULL …"`.
Reword the message body to be **vector-neutral** (e.g. `"maintaining materialized view '…' would
store NULL in column '…' …"`) so it reads correctly from both the refresh call site (`rebuildBacking`)
and the new row-time call sites. Signature is unchanged (`schemaName, viewName, columnName`). Update
its JSDoc (which currently says "Refresh raises this") to note both vectors.

## Test homes

- **`packages/quereus/test/materialized-view-refresh-reshape.spec.ts` § NOT-NULL ordering-seeded PK
  guard.** This describe already documents the vector (see the inline scope note on the first test).
  Add the row-time regression from the reproduction above: the `insert into par (id, x) values (2,
  null)` must throw a `CONSTRAINT` naming `x`, and `select id, x from par_ix` must still return only
  `{1,5}`.
- **Companion positive case (do NOT regress):** after `drop not null` with only non-NULL values,
  ordinary maintained inserts (`insert into par (id, x) values (2, 7)`) still succeed and `par_ix`
  reflects them — the guard fires only on an actual NULL in a guarded column.
- **Nullable-PK not guarded:** an MV `order by <col>` over a column that was **already nullable** at
  create time (e.g. `x integer` with no `not null`) must keep accepting NULL inserts — confirm the
  guard does not over-reject (its `notNull === true` gate handles this, but a test pins it).

## Ultimate resolution

`backlog/debt-mv-ordering-seed-to-materialized-index` removes the pinned-NOT-NULL physical-PK column
entirely (expressing body order as a materialized secondary index), rooting out both this row-time
vector and the refresh vector. This ticket is the interim loud-error guard for the row-time path,
matching what the refresh guard already did for refresh.

## TODO

- [ ] Add `nullGuardColumns?` to `MaintenancePlanCommon` (`database-materialized-views-plans.ts`) with the JSDoc above.
- [ ] Add `computeNullGuardColumns(mv, analyzed)` and attach its result to the built plan in `buildMaintenancePlan` (`database-materialized-views-plan-builders.ts`); gate the field to non-empty.
- [ ] Add the shared per-change NULL scan helper and call it (gated on `plan.nullGuardColumns`) in both `maintainRowTime` and `flushDeferredRebuilds` (`database-materialized-views.ts`), before the cascade.
- [ ] Reword `nullInNotNullSeededPkError` (`materialized-view-helpers.ts`) vector-neutral; update its JSDoc; keep the signature. Verify the existing refresh call site still reads correctly.
- [ ] Add the row-time regression + the two positive cases to `materialized-view-refresh-reshape.spec.ts`.
- [ ] `cd packages/quereus`; run `yarn build` then the spec (e.g. `yarn test 2>&1 | tee /tmp/mv.log; tail -n 80 /tmp/mv.log`), and `yarn lint` (it type-checks spec call sites too).
