----
description: Review relaxed recompile gate — backing-PK superkey check for ADD CONSTRAINT UNIQUE that subsumes the compound key
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts
  - packages/quereus/test/logic/53.3-materialized-view-constraint-only-ddl.sqllogic
  - docs/materialized-views.md
----

# Review: MV recompile superkey/PK gate relaxation

## What was done

`tryRecompileMaterializedViewLive`'s gate 3 was relaxed from a strict backing-PK equality check to a two-part superkey check:

1. **`BackingShape.allProvedKeys`** — new optional field on the interface, populated in `deriveBackingShapeUnguarded` with `keys.map(k => Array.from(k))` when `keysOf` returned at least one key. Absent on the coarsened-lineage or all-columns path.

2. **`backingColumnsStructurallyMatch(current, shape)`** — new private helper: column count + per-column type/not-null/collation match, without comparing the physical PK. Reuses the three existing shared predicates (`backingTypeMatches`, `backingNotNullMatches`, `backingCollationMatches`).

3. **`isBackingPkASuperkeyInShape(current, shape)`** — new private helper: returns true iff some proved minimal key from `shape.allProvedKeys` is entirely contained in the backing's physical PK column set (a `Set<number>` built from `primaryKeyDefinition`).

4. **Gate 3 in `tryRecompileMaterializedViewLive`** — the `if (mismatch)` block now tries the relaxed path before failing: if `backingColumnsStructurallyMatch` AND `isBackingPkASuperkeyInShape` both pass, log the "superkey check passed" message and fall through to `registerMaterializedView(backing)` with the existing backing unchanged.

5. **Docstring updated** — gate 3 description now describes the relaxed superkey logic instead of the old strict-equality-with-known-conservatism language.

6. **Docs updated** — `docs/materialized-views.md` §615 bullet about fallback causes no longer mentions the ADD-UNIQUE conservatism; instead notes ADD UNIQUE passes via the superkey check.

7. **Test §14 added** — `53.3-materialized-view-constraint-only-ddl.sqllogic`: creates `t14(id, a, b)` with `UNIQUE(a,b)` as the only projected key, creates `mv14 as select a, b from t14`, then `ADD CONSTRAINT uq_a UNIQUE(a)`, and verifies the MV stays live.

## Test results

All 6077 quereus tests pass (plus all other workspace suites) — zero failures.

Key tests to check:
- §6 (`drop constraint uq` → stale fallback) — still stale ✓
- §9 (mid-statement failure independence — stale sibling) — still stale ✓
- §11 (stale cascade down MV-over-MV chain) — still frozen ✓
- §14 (new: ADD UNIQUE subsumes compound key → MV stays live) ✓

## Known gaps / reviewer focus areas

- **`keysOf` return type**: `keysOf` returns `Set<number>[]`. The code converts via `keys.map(k => Array.from(k))`. Confirm this correctly produces sorted index arrays (the `Set` iteration order is insertion order, which for integer-keyed sets like these should be ascending — but this is worth a second look).

- **Ordering-seeded PK interaction**: When the body has `ORDER BY`, `computeBackingPrimaryKey` prepends ordering columns to the logical key. `isBackingPkASuperkeyInShape` uses the FULL physical PK column set from `primaryKeyDefinition` (all components). The ticket design says proved minimal keys are subsets of the full physical PK set — verify that holds when the ordering adds extra leading columns (they would be in `backingPkCols`, so the check would be permissive rather than over-restrictive, which is safe).

- **No new edge cases** were introduced — `allProvedKeys` is absent on the coarsened-lineage/all-columns paths, and `isBackingPkASuperkeyInShape` correctly returns `false` for those bodies.
