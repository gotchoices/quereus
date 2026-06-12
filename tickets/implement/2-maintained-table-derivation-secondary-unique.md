description: Enforce declared secondary UNIQUE constraints against rows the derivation writes on a `create table … maintained as` table. The memory host's applyMaintenance records upserts with no `checkUniqueConstraints`, so two derived rows colliding on a declared UNIQUE (non-PK) key are stored silently. Collision-based, so structurally distinct from the per-row CHECK/FK validation.
prereq: maintained-table-derivation-check-fk-validation
files:
  - packages/quereus/src/vtab/memory/layer/manager.ts                # applyMaintenanceToLayer (bypass site), checkUniqueConstraints / checkSingleUniqueConstraint (the enforcement to reuse)
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation (bulk reconcile validation seam from prereq)
  - packages/quereus/src/core/database-materialized-views.ts         # maintainRowTime / flushDeferredRebuilds (steady-state validation seam from prereq)
  - packages/quereus/src/schema/constraint-builder.ts                # validateUniqueOverExistingRows pattern (store module has an analogue)
  - packages/quereus-store/src/common/store-module.ts                # validateUniqueOverExistingRows (existing store-side whole-set UNIQUE validation to mirror)
  - packages/quereus/test/logic/51.7-maintained-table-attach-detach.sqllogic
  - docs/materialized-views.md
difficulty: hard
----

# Declared secondary UNIQUE enforcement on maintained-table derivation writes

A `create table … maintained as` backing carries its declared secondary
(non-PK) UNIQUE constraints, and the memory module builds covering indexes for
them — but `applyMaintenanceToLayer` (`vtab/memory/layer/manager.ts`) records
upserts via `recordUpsert` **without** calling `checkUniqueConstraints`, and the
covering indexes are not flagged unique (insert-time enforcement routes through
`uniqueConstraints`, which maintenance never invokes). So two derived rows that
collide on a declared UNIQUE key are stored silently — the same gap as CHECK/FK,
but a property of a **pair** of rows, not a single row.

The prereq ticket (`maintained-table-derivation-check-fk-validation`) established
the validation seams (bulk reconcile + steady-state per-delta + attribution
diagnostic + zero-overhead gate). This ticket adds secondary UNIQUE enforcement
at the same seams, with collision-aware mechanics.

The backing PK itself is already a uniqueness gate: the "must be a set" reject
(`assertDerivedRowsAreSet`) and the btree key reject duplicate **primary** keys.
This ticket is **only** the declared secondary UNIQUE constraints
(`tableSchema.uniqueConstraints` minus the PK).

## Design

### Bulk paths → whole-set UNIQUE validation

After the reconcile `applyMaintenance` in `attachMaintainedDerivation`, validate
each declared secondary UNIQUE over the table's effective contents — a
duplicate-key scan under the constraint's per-column collations (mirror the
store module's `validateUniqueOverExistingRows`, and the in-engine collation-aware
duplicate pairing already in `assertDerivedRowsAreSet`, which keys under the PK
collations — reuse that comparison shape keyed on the UNIQUE columns instead).
A collision throws an attributed CONSTRAINT naming the maintained table, the
UNIQUE constraint, and the colliding key values.

This validates the full post-reconcile set, so detach can never strand a
UNIQUE-violating pair.

### Steady-state → per-delta collision check against effective backing

For each insert/update `BackingRowChange` the maintenance produced, check the
new image's UNIQUE-column values against the effective backing contents for a
row at a **different PK** with the same UNIQUE-column values (collation-aware).
The cleanest reuse: route maintenance upserts through (or alongside) the memory
manager's existing `checkSingleUniqueConstraint` / `checkUniqueConstraints`
against the pending layer — these already do the collation-aware duplicate scan
(and the auto-index fast path). Decide whether to:
  - (a) call `checkUniqueConstraints` from inside `applyMaintenanceToLayer`
    before `recordUpsert` (host-side enforcement; throws CONSTRAINT — but note
    maintenance must NOT do REPLACE eviction, so pass `onConflict = ABORT`), or
  - (b) keep the host privileged-and-silent and do the collision check
    engine-side in `database-materialized-views.ts` via a `scanEffective`
    prefix/equality lookup on the covering index.

Prefer **(a)** if it can be done without disturbing the value-identical-upsert
skip and the effective-change reporting contract (a same-PK upsert that replaces
a row is NOT a UNIQUE violation against itself — `checkSingleUniqueConstraint`
already excludes the same PK). (a) reuses shipped, collation-correct enforcement
and keeps the covering-index fast path. Resolve this during implement; both are
viable, (a) is less new code.

Attribution: the host's native UNIQUE message (`UNIQUE constraint failed: <t>`)
is not maintained-table-attributed. If (a), wrap/translate the thrown
constraint error at the maintenance boundary into the attributed form (the
maintenance caller knows it is a derived write); if (b), throw the attributed
error directly.

## Edge cases & interactions

- **Same-PK upsert (value change on a unique column, no collision)**: replacing
  the row at its own PK with new unique-column values that collide with **no
  other** row must succeed — the same-PK exclusion in
  `checkSingleUniqueConstraint` handles this; verify it holds on the maintenance
  path.
- **Partial UNIQUE (`unique … where <pred>`)**: only in-scope rows collide; the
  existing predicate-aware unique check must be honored (do not roll a naive
  all-rows compare).
- **NULL in a UNIQUE column**: SQL UNIQUE treats NULLs as distinct — multiple
  derived rows with NULL in a UNIQUE column do not collide. Confirm the reused
  check preserves this.
- **Collation**: UNIQUE enforcement uses each column's declared collation (e.g.
  NOCASE) — two derived rows differing only in case under a NOCASE UNIQUE column
  collide. The covering index carries per-column collation already.
- **Coarsened backing key interaction**: a coarsened lineage PK already
  last-write-merges colliding PKs; a secondary UNIQUE is independent — a UNIQUE
  collision among rows at distinct PKs must still reject.
- **MV-over-MV cascade**: a consumer maintained table with a declared secondary
  UNIQUE validates its own cascaded deltas.
- **Full-rebuild floor**: the rebuild diff's insert/update images are
  UNIQUE-checked at flush.
- **Bulk vs steady-state consistency**: a collision present in the initial
  derivation fails create/attach; a collision introduced by a later source write
  fails that write — same attributed diagnostic.
- **Zero overhead**: a maintained table with no secondary UNIQUE (every MV-sugar
  table, and most maintained tables) pays nothing — gate on
  `uniqueConstraints` non-empty beyond the PK.
- **Store module**: `quereus-store`'s `applyMaintenance` analogue has the same
  bypass; the engine-side seam (if (b)) covers both, but if (a) the store host
  needs the parallel guard. Run `yarn test:store` for the new logic file or
  document the deferral.

## Key tests & expected outputs

```sql
create table src (id integer primary key, tag text);
insert into src values (1, 'x'), (2, 'x');
create table mt (id integer primary key, tag text unique)
  maintained as select id, tag from src;
-- EXPECT: CONSTRAINT error — derived rows (1,'x') and (2,'x') collide on mt's
-- UNIQUE(tag); attributed to mt.
```
- Steady-state: a clean create, then `insert into src values (3, 'x')` collides
  with an existing derived row on `mt.UNIQUE(tag)` → attributed CONSTRAINT.
- NOCASE UNIQUE: `'X'` vs `'x'` collide.
- Partial UNIQUE: only in-scope collisions reject.
- NULLs distinct: multiple derived NULL-tag rows coexist.
- Zero overhead regression: existing 51.x / 53.x suites stay green.

## TODO

- Resolve approach (a) host-side vs (b) engine-side; implement the chosen one.
- Bulk: whole-set secondary-UNIQUE validation after reconcile (attributed).
- Steady-state: per-delta collision check on insert/update images (attributed),
  reusing `checkUniqueConstraints` / `scanEffective` per the chosen approach.
- Ensure same-PK / partial / NULL / collation semantics preserved.
- Tests: new logic file section + spec for cascade / steady-state; zero-overhead
  regression.
- Docs: extend `docs/materialized-views.md` § derived-row constraint validation
  with secondary UNIQUE.
- `yarn build`, `yarn test` (tee-streamed), `yarn lint`; `yarn test:store` or
  documented deferral.
