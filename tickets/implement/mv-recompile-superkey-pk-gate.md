----
description: Relax tryRecompileMaterializedViewLive's strict backing-PK equality to a superkey check, so ADD CONSTRAINT UNIQUE that subsumes the recorded key no longer forces the stale fallback.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic
  - docs/materialized-views.md
difficulty: easy
----

# Relax the recompile gate's backing-PK equality to a superkey check

## Problem

`tryRecompileMaterializedViewLive` gates in-place recompile on
`describeBackingShapeMismatch`, which requires the re-derived backing PK to equal
the live backing's PK **positionally and exactly**.

The concrete trigger: a table with `UNIQUE(a, b)` as its only projected key gets
`ADD CONSTRAINT UNIQUE (a)`. `normalizeKeys` drops the compound key `{a,b}`
(subsumed by the new minimal key `{a}`), so `keysOf(root)` now returns `{a}` first.
The re-derived `shape.primaryKey = [{index:0}]` (1 column) doesn't match the live
backing's `primaryKeyDefinition = [{index:0}, {index:1}]` (2 columns) →
`describeBackingShapeMismatch` returns a "PK length 1 → 2" string → stale fallback.

Yet the old backing PK `{a, b}` is still a valid unique key of the re-planned body:
`{a} ⊆ {a, b}`, so `{a, b}` is a superkey. The MV can be recompiled in place
with the existing backing unchanged.

This is an optimization: before the recompile carve-out every constraint DDL staled
dependents, so the new behavior is strictly no worse than before.

## Design

### `BackingShape.allProvedKeys`

Expose all minimal candidate keys (from `keysOf(root)`) as column-index arrays in
`BackingShape`. This is already computed in `deriveBackingShapeUnguarded`; surfacing
it avoids re-running the planner in the gate check.

Add to the `BackingShape` interface:
```typescript
/** All minimal candidate keys proved by `keysOf` for the body root, as sorted
 *  column-index arrays. Present only when `keysOf` returned at least one key
 *  (i.e., not the coarsened-lineage or all-columns path). Used by
 *  tryRecompileMaterializedViewLive to check if the existing backing PK is
 *  still a superkey after a body-irrelevant constraint change. */
allProvedKeys?: ReadonlyArray<ReadonlyArray<number>>;
```

Populate it in `deriveBackingShapeUnguarded` at the return statement (line ~177):
- Add `allProvedKeys: keys.length > 0 ? keys.map(k => Array.from(k)) : undefined`
- Place it in the returned object alongside `primaryKey`

### Two new private helpers (add before `tryRecompileMaterializedViewLive`)

**`backingColumnsStructurallyMatch`** — column-only structural check without PK:
```typescript
function backingColumnsStructurallyMatch(current: TableSchema, shape: BackingShape): boolean {
    if (current.columns.length !== shape.columns.length) return false;
    for (let i = 0; i < shape.columns.length; i++) {
        const a = current.columns[i];
        const b = shape.columns[i];
        if (!backingTypeMatches(a, b)) return false;
        if (!backingNotNullMatches(a, b)) return false;
        if (!backingCollationMatches(a, b)) return false;
    }
    return true;
}
```

This reuses the three shared column-comparison predicates that already exist for
`describeBackingShapeMismatch`.

**`isBackingPkASuperkeyInShape`** — the superkey check:
```typescript
function isBackingPkASuperkeyInShape(current: TableSchema, shape: BackingShape): boolean {
    if (!shape.allProvedKeys) return false;
    const backingPkCols = new Set(current.primaryKeyDefinition.map(pk => pk.index));
    return shape.allProvedKeys.some(k => k.every(idx => backingPkCols.has(idx)));
}
```

"Some proved minimal key fits entirely inside the existing backing PK's column set"
= the existing backing PK column set is a superkey of the re-planned body.

### Modify `tryRecompileMaterializedViewLive` (line ~1603)

Replace the current hard-fail on mismatch with a two-branch check:

```typescript
const mismatch = describeBackingShapeMismatch(backing, shape);
if (mismatch) {
    // Relaxed superkey gate: columns match structurally AND the existing backing
    // PK column set is still a superkey of the re-planned body (some proved
    // minimal key is ⊆ the backing PK's column set). Covers ADD CONSTRAINT UNIQUE
    // that subsumed the compound key — keysOf now returns a smaller key first,
    // changing the physical PK shape, but the old backing PK is still uniquely
    // identifying. Re-register with the EXISTING backing (unchanged PK).
    if (!backingColumnsStructurallyMatch(backing, shape) || !isBackingPkASuperkeyInShape(backing, shape)) {
        log('Marking materialized view %s.%s stale instead of recompiling: backing shape mismatch (%s) — REFRESH rebuilds it',
            mv.schemaName, mv.name, mismatch);
        return false;
    }
    log('Recompiling materialized view %s.%s with existing backing PK (superkey check passed): %s',
        mv.schemaName, mv.name, mismatch);
}
db.registerMaterializedView(backing);
log('Recompiled materialized view %s.%s in place after a body-irrelevant source change',
    mv.schemaName, mv.name);
return true;
```

Note: `registerMaterializedView(backing)` is called with the EXISTING backing (which
has the old PK unchanged). This is intentional: the old PK is still a valid unique
key, so row identity semantics are preserved. The "better" single-column key from the
new constraint is an optimization the MV can only adopt via a fresh REFRESH.

### Update the docstring of `tryRecompileMaterializedViewLive`

The comment in the docstring (around line 1567–1575) currently says gate 3 is strict
PK equality with "known acceptable conservatism" about ADD UNIQUE reordering. Update
it to describe the relaxed superkey gate:

```
 *  3. `backingColumnsStructurallyMatch` + `isBackingPkASuperkeyInShape`: the column
 *     structural attributes (type / not-null / collation) must match positionally,
 *     AND the live backing's physical PK column set must be a superkey of the
 *     re-planned body (some proved minimal key ⊆ backing PK columns). This forces
 *     staleness when a dropped UNIQUE un-proves the recorded backing key (`keysOf`
 *     falls back to a smaller key or all-columns → no proved key ⊆ old PK). An
 *     ADD CONSTRAINT UNIQUE that subsumes the compound key passes: the new minimal
 *     key is a subset of the old compound backing PK. Re-registers with the
 *     EXISTING backing (PK unchanged) — the better key is adopted only by REFRESH.
```

### Update `docs/materialized-views.md` §615 fallback causes

In the bullet at line ~623 that mentions "the strict-PK-equality conservatism on an
ADD CONSTRAINT UNIQUE that reorders the first proved key (stale fallback — no worse
than before; a follow-up could relax this to a superkey check)", remove that clause
(the follow-up is now implemented). The bullet should cover only the DROP UNIQUE case:

```
- the re-derived backing shape no longer matches the live backing — most notably a
  **dropped UNIQUE that backed the recorded backing key** (`keysOf` no longer proves
  it, so the derived key shifts to a smaller set or all-columns fallback, which is
  not a superkey of the old PK → mismatch forces staleness until drop-and-recreate).
  An ADD CONSTRAINT UNIQUE that subsumes the existing compound key now passes via the
  superkey check (the new minimal key fits inside the old compound PK column set);
```

### Add test §14 to `53.3-materialized-view-constraint-only-ddl.sqllogic`

The key scenario: a compound unique key `UNIQUE(a, b)` is the only projected key
(source PK `id` is not projected). Backing PK = `{a=0, b=1}`. Adding `UNIQUE(a)`
causes `normalizeKeys` to subsume `{a,b}` → `keysOf` returns `{a}` first →
shape.primaryKey shrinks to `{0}`. With the superkey check: `{a=0} ⊆ {0,1}` → live.

```sql
-- ===================================
-- 14. ADD UNIQUE that subsumes the existing compound backing key:
--     keysOf's first key shrinks (compound {a,b} → single {a}) but the old
--     backing PK {a,b} is still a superkey → MV stays live.
-- ===================================

create table t14 (id integer primary key, a text not null, b text not null,
                  constraint uq_ab unique (a, b));
-- id is not projected; only compound key {a,b} is the backing PK
insert into t14 values (1, 'x', 'p');
create materialized view mv14 as select a, b from t14;

alter table t14 add constraint uq_a unique (a);
-- keysOf now returns {0} (a alone) as the first key — {a,b} is subsumed
-- superkey check: {0} ⊆ {0,1} → backing PK still valid → stay live

insert into t14 values (2, 'y', 'q');
select * from mv14 order by a;
→ [{"a":"x","b":"p"},{"a":"y","b":"q"}]

drop materialized view mv14;
drop table t14;
```

## Edge cases & interactions

- **Structural column mismatch with superkey-passing PK**: The `backingColumnsStructurallyMatch`
  guard ensures any type/not-null/collation narrowing inferred by the optimizer from
  the new CHECK (or other constraint changes processed alongside ADD UNIQUE) still
  forces staleness. The superkey relaxation ONLY fires when columns are structurally
  identical.

- **Coarsened-key path**: `allProvedKeys` is absent when the body used the
  coarsened-lineage or all-columns path (i.e., `keys.length === 0` in
  `deriveBackingShapeUnguarded`). `isBackingPkASuperkeyInShape` returns false → no
  relaxation for those bodies. Correct: a coarsened-key MV's backing identity is
  semantically different and must not be relaxed.

- **Ordering-seeded PK**: `computeBackingPrimaryKey` prepends `ordering` columns to
  the logical key. If the body has an `order by`, the physical PK = `ordering + key`.
  The existing backing PK contains both ordering columns AND the old logical key. The
  superkey check uses the FULL physical PK column set (all components, including
  ordering). Since any proved minimal key ⊆ the full physical PK column set (because
  the full set includes the old logical key, which was proved), the check passes.

- **Empty allProvedKeys**: `keysOf` could return `[]` (no keys at all) for a bag.
  But a bag body would have been rejected at registration. So an MV currently in the
  recompile path always had a proved key at create time. If `allProvedKeys` is `[]`
  (rather than `undefined`), `some()` returns false → superkey check fails → correct.

- **DROP UNIQUE that backed the key**: `keysOf` no longer proves the old key;
  `allProvedKeys` may be empty or contain only NEW (smaller) keys. The old compound
  backing PK is NOT a superset of any new minimal key (the new "key" shifted to
  all-columns or lineage) → `isBackingPkASuperkeyInShape` returns false → correct
  stale fallback as before. Test §6 and §9 verify this stays stale.

- **`registerMaterializedView` with existing backing PK**: The re-registration runs
  arm selection / eligibility / cost gating against the new catalog. These checks
  operate on the body and the backing schema (which is unchanged). A newly-proved
  single-column key doesn't break any arm gate; the inverse-projection arm will
  continue to work correctly because the backing still uniquely identifies rows.

## TODO

- Add `allProvedKeys?: ReadonlyArray<ReadonlyArray<number>>` to `BackingShape` interface
- Populate `allProvedKeys` in `deriveBackingShapeUnguarded` return statement
- Add `backingColumnsStructurallyMatch(current, shape): boolean` private helper
- Add `isBackingPkASuperkeyInShape(current, shape): boolean` private helper  
- Modify the `if (mismatch)` block in `tryRecompileMaterializedViewLive` to use the two-branch superkey relaxation
- Update the docstring of `tryRecompileMaterializedViewLive` (gate 3 description)
- Update the inline comment in `tryRecompileMaterializedViewLive` that references the known conservatism (remove the "follow-up could relax" note)
- Add §14 test to `53.3-materialized-view-constraint-only-ddl.sqllogic`
- Update `docs/materialized-views.md` §615 fallback causes bullet to remove the ADD-UNIQUE conservatism clause and add a note about the superkey relaxation
- Run `yarn test` and verify §6, §9, §11 (stale cases) and the new §14 (live case) all pass
