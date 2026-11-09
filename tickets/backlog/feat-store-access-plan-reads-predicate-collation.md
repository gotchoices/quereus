description: Make the persistent store's planner answers respect the collation each filter compares under, so it stops offering index plans for case-insensitive filters that the engine will reject, the same way the in-memory table module is being taught to.
prereq: predicate-constraint-carries-comparison-collation
architecture: docs/module-authoring.md
files: packages/quereus-store/src/common/store-module-access-plan.ts (`resolveEqualityPins`, `resolvePrimaryKeyPins`, `claimFirstPerRole`, the range arms, the PK-arm comment near line 588, `NO_PINNED_COLUMNS` near line 785)
tradeoffs: Answers are already correct without it (the engine declines the mismatched seeks and ordering claims), and the store's access-plan file is large and carefully gated, so the gain is plan quality only and a maintainer may prefer to wait until a collated filter on a store table is seen choosing a bad plan.
----

Once `predicate-constraint-carries-comparison-collation` lands, every filter the engine sends a module carries `collation` (the normalized collation the comparison uses; absent means BINARY), and the memory module uses it. The store module (`StoreModule.getBestAccessPlan`, implemented in `store-module-access-plan.ts`) still treats `b = 'x' collate nocase` as an ordinary equality on `b`.

## Expected behaviour

Same contract the memory module follows, documented in `docs/module-authoring.md`:

- An equality fills an equality role (pins a column, seeds a seek) on an index column only when `collationRefines(f.collation ?? 'BINARY', indexColumnCollation)`.
- A range or OR_RANGE bound is offered on an index column only when its collation equals the index column's collation (the store advertises `honorsCollatedRangeBounds`).
- The positional pick is kept: per column and role, only the first filter filling the role is considered; if it fails the collation test, the column fills no role on that index and the filter stays a residual.
- The PK arms' comment near line 588 ("`where pk collate nocase in (…)` … this module cannot see it and always claims") is replaced by the gate itself.
- `NO_PINNED_COLUMNS` (ordering-only walk) may then pin columns whose equality refines the index column, as the memory module does; whether that is worth doing is part of this ticket's planning.

The engine's own collation checks stay unchanged; this is plan quality only.
