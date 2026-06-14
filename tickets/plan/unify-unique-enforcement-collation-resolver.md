description: The per-column UNIQUE-enforcement collation resolution (index-COLLATE-else-declared for a `derivedFromIndex` constraint) is implemented three times across three packages — quereus, quereus-store, quereus-isolation. Unify behind one shared helper so they cannot drift, OR lock the agreement with a cross-module conformance test if a true import-time share is infeasible.
prereq:
files:
  - packages/quereus/src/schema/unique-enforcement.ts        # uniqueEnforcementCollations (the canonical copy)
  - packages/quereus-store/src/common/store-table.ts          # private uniqueEnforcementCollations(uc) — duplicate
  - packages/quereus-isolation/src/isolated-table.ts          # private uniqueEnforcementCollations(uc) — duplicate
difficulty: medium
----

# Unify the UNIQUE-enforcement collation resolver across packages

## Problem

Three packages independently resolve the comparison collation for an index-derived
UNIQUE constraint, all computing the identical rule:

```ts
const index = uc.derivedFromIndex
  ? schema.indexes?.find(ix => ix.name === uc.derivedFromIndex)
  : undefined;
return uc.columns.map((col, i) => index?.columns[i]?.collation ?? schema.columns[col].collation);
```

Locations:

- `packages/quereus/src/schema/unique-enforcement.ts` — `uniqueEnforcementCollations`
  (the canonical copy, landed by `covering-mv-index-derived-unique-collation`; consumed
  by memory's `checkUniqueViaMaterializedView` and the covering-MV eligibility gate).
- `packages/quereus-store/src/common/store-table.ts` — private `uniqueEnforcementCollations(uc)`.
- `packages/quereus-isolation/src/isolated-table.ts` — private `uniqueEnforcementCollations(uc)`.

The memory module's `checkUniqueViaIndex` resolves the same value inline a fourth way
(`index.specColumns[i]?.collation ?? schema.columns[col].collation`).

These MUST stay in lockstep: the row-time covering-MV gate
(`coveringMvHonorsIndexCollation`) decides MV eligibility using the quereus copy, while
the store/isolation re-validators filter conflicts using *their* copy. A drift between
the gate's notion of the index collation and a re-validator's notion could re-open the
exact subset-miss the gate was added to close (a coarser-index covering MV silently
missing a conflict), or conversely over-reject. Today they agree only because three
hand-maintained copies happen to be identical.

## Why it was deferred

`covering-mv-index-derived-unique-collation` scoped the shared helper to the **quereus
package only**. A true cross-package share spans 3 packages and risks an import cycle
(`quereus-store` / `quereus-isolation` already depend on `@quereus/quereus`; pulling a
schema helper down is plausible but was not vetted). The positional-alignment invariant
(`uc.columns[i]` ↔ `index.columns[i]`, guaranteed by `appendIndexToTableSchema`) is also
load-bearing for all copies.

## Desired outcome (specification, not a plan)

Either:

1. **Single source of truth** — `quereus-store` and `quereus-isolation` import and call
   the `@quereus/quereus` `uniqueEnforcementCollations` (passing their own `TableSchema`
   + `uc`), deleting their private copies; confirm no import cycle is introduced. The
   memory `checkUniqueViaIndex` inline resolution also routes through it.

2. **Conformance lock** (fallback if a shared import is genuinely infeasible) — a single
   cross-module test that drives the same `(schema, uc)` shapes (finer / coarser / equal
   / plain / composite / non-derived) through all three resolvers and asserts identical
   per-column collation output, so a future edit to one copy that diverges fails loudly.

Whichever path, the index-derived covering-MV gate and every re-validator must demonstrably
resolve the index collation identically.
