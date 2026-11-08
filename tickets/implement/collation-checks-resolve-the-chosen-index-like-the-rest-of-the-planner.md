description: The planner's two collation safety checks look up the module's chosen index by its exact name, so when a module names the index any other legal way (different letter case, or a per-plan alias with a descriptor) one check trusts the module's ordering promise while the other drops the index, and a filtered `order by` comes back mis-ordered or a case-sensitive filter returns case-insensitive matches.
architecture: docs/optimizer-retrieve.md#access-path-selection
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts (`orderingClaimSurvivesCollation`, `indexColumnCollationLookup`, `classifyConstraintCover`, `classifyCollationCover`), packages/quereus/src/vtab/index-descriptor.ts (`resolveIndexDescriptor`, `primaryKeyDescriptor`), packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts (`planDeliversOrdering`, the guard's only caller), packages/quereus/test/vtab/test-aliased-index-module.ts, packages/quereus/test/vtab/access-path.spec.ts, docs/module-authoring.md ("Naming the chosen index"), docs/optimizer-retrieve.md (the `orderingClaimSurvivesCollation` bullet near line 89)
repro: verified
----

## Background

This ticket replaces the fix ticket `bug-collated-equality-keeps-an-ordering-claim-the-plan-cannot-serve` (filed from Optimystic, measured on 4.25.0) and absorbs the backlog ticket `bug-index-collation-lookup-ignores-module-descriptor` (filed from lamina), because both resolve at the same two lookups.

What the fix ticket reported, and what already landed:

- **Reported:** `select id from t where b = 'x' collate nocase order by c` over `idx_bc(b, c)` returned the `'X'` group ahead of the `'x'` group. The module claimed `idx_bc` delivers `order by c` (it treats any `=` as pinning `b`; it cannot see the collation), the Sort was removed on that claim, and physical selection then declined the NOCASE seek over the BINARY index and emitted a sequential scan.
- **Already fixed for exact index names.** `orderingClaimSurvivesCollation` (commit `9053b59b2`, shipped in v4.26.0) runs the collation cover classification against the claim's index before `trySortAbsorbViaIndexOrdering` drops a Sort, which is arm 2 of the fix ticket's proposal. Verified at HEAD against the memory module with 300 filler rows: the module's seek wins pricing (cost 30.5 vs 1000), the absorb is refused, and the plan is `SORT` over `FILTER` over `SEQSCAN` with the correct rows 2, 5, 1, 4. Probes of streaming group-by, window `order by`, `order by … limit`, `min()`, a join on `c`, `distinct` and a singleton `in (… collate nocase)` were also correct. `05.1.1-secondary-index-range-scan.sqllogic` (lines 174–183) already pins the memory-table shape, so no new logic test is needed for it.
- **Arm 1 of the fix ticket** (put the comparison's collation on `PredicateConstraint` so modules can see it) is no longer needed for correctness once this ticket lands. It is filed as backlog `feat-predicate-constraint-carries-comparison-collation`.

## The defect that remains

Both collation checks in `rule-select-access-path.ts` find the module's index with their own exact-name lookup, `tableSchema.indexes?.find(i => i.name === indexName)`. Everything else in the planner resolves the index through `resolveIndexDescriptor` (`vtab/index-descriptor.ts`), which takes the module's `indexDescriptor` first, then `_primary_`/`primary`, then a **case-insensitive** schema match. `docs/module-authoring.md` ("Naming the chosen index") documents the case-insensitive match and the alias-plus-descriptor form as supported.

When the exact lookup misses, the two checks fall back in opposite directions:

| site | on a miss | effect |
|---|---|---|
| `orderingClaimSurvivesCollation` (~line 1578) | `if (!keyColumns) return true` trusts the claim | Sort dropped |
| `indexColumnCollationLookup` (~line 1540) | returns `BINARY` for every column | a NOCASE equality is `MISMATCH_UNSAFE` → seek declined to a sequential scan; a BINARY equality over a NOCASE index is `MATCH` → no re-check filter |

**Arm A, mis-ordering (repro verified at HEAD).** A `MemoryTableModule` subclass whose `getBestAccessPlan` only upper-cases `indexName`/`orderingIndexName` (`idx_bc` → `IDX_BC`, a name the engine resolves case-insensitively elsewhere), with the fix ticket's table plus row `('5','X','a')` and 300 filler rows `('f<i>','z<i>','q<i>')`:

```sql
select id from t where b = 'x' collate nocase order by c
-- plan: PROJECT / FILTER WHERE b = 'x' collate nocase / SEQSCAN t   (no SORT)
-- returned 1, 2, 4, 5   correct 2, 5, 1, 4
```

The plain memory module, which reports the exact name, plans `SORT` over the same scan and returns 2, 5, 1, 4.

**Arm B, extra rows (repro verified at plan level; this is the absorbed lamina ticket).** Same subclass, index `idx_bc on t(b collate nocase, c)`:

```sql
select id from t where b = 'x'           -- BINARY comparison over a NOCASE index
-- exact name 'idx_bc':  FILTER WHERE b = 'x' over INDEXSEEK USING idx_bc   (re-check present)
-- name 'IDX_BC':        INDEXSEEK USING IDX_BC                             (re-check missing)
```

Without the re-check, the NOCASE seek returns the `'X'` rows as well. The subclass cannot execute that seek (the memory runtime looks the index up by exact name), so the wrong rows were not observed through it; lamina measured the same missing re-check end-to-end on 4.20.2 with its own alias names (`_compound__pk_t_2`): `select k from t where g = 1 and k = 'ALICE' collate binary` over a NOCASE key returned `'alice'`. Lamina now refuses such seeks on its side, with a `NOTE:` naming the absorbed ticket as its revisit condition.

## Change

Resolve the index once, through `resolveIndexDescriptor`, in both checks, and make an unresolvable index fail safe in both.

- `indexColumnCollationLookup(tableSchema, accessPlan)` reads `resolveIndexDescriptor(tableSchema, accessPlan, name)?.keyColumns` (match on `columnIndex`) and returns the normalized collation, or `undefined` when the index or the column is not resolvable. Which name to pass: the seek arms call it with `accessPlan.indexName`; keep that, and pass `orderingIndexName ?? indexName` from the guard as it does today.
- `classifyConstraintCover` takes `indexColl: string | undefined`. An unknown index collation is classified the way the lattice allows without knowing it: a BINARY **equality** is `COARSER_SAFE` (a BINARY-equal value is equal under every collation, so the seek returns a superset and the residual recovers the exact rows); anything else (a non-BINARY equality, or any range) is `MISMATCH_UNSAFE`. Keep this rule in `classifyConstraintCover`, not at the call sites, so `rule-key-set-seek` (which already resolves through the descriptor) and the guard share it.
- `orderingClaimSurvivesCollation` takes its key columns from the same resolved descriptor. When the index cannot be resolved, treat every column as possibly in the index and classify each bearing constraint with an unknown index collation. That keeps the Sort exactly when a collated constraint is present and still absorbs it when every bearing constraint is a BINARY equality or there are none. Do not keep `return true` on a miss.
- Primary key: `primaryKeyDescriptor` reads `primaryKeyDefinition[].collation`, while today's lookup reads the table column's declared collation. `schema/table.ts` carries the PK member's collation from its column (around line 856/918), so they should agree; confirm before relying on it, and if they can differ keep the column's declared collation for the primary key.
- An unresolvable alias is already logged by `buildIndexAccessPath` (`warnLog`); no new log is needed.

Docs: in `docs/module-authoring.md` "Naming the chosen index", state that the collation checks read `indexDescriptor.keyColumns[].collation` (so a module that describes a collation-folded index gets correct seeks), and that an unresolvable index gets the conservative classification above. Update the `orderingClaimSurvivesCollation` bullet in `docs/optimizer-retrieve.md` to say the claim's index is resolved the same way as the access path's.

## Tests

One reproduction per arm, at the planner layer:

- Arm A end-to-end: a `MemoryTableModule` subclass that upper-cases the reported index names, the data above, asserting rows 2, 5, 1, 4 (and, optionally, a `SORT` in `query_plan`). The seek is declined, so the memory runtime never sees the upper-cased name.
- Arm B at plan level: the same subclass over `idx_bc(b collate nocase, c)`, asserting a `FILTER` above the `INDEXSEEK` for `where b = 'x'`. Alternatively extend `test/vtab/test-aliased-index-module.ts` (it already mints `_primary_1` with an optional descriptor) with a NOCASE primary-key column and assert that a descriptor-carried NOCASE collation yields a seek plus re-check for a BINARY equality, and a plain seek for a NOCASE equality.

Put them beside the existing descriptor tests (`test/vtab/access-path.spec.ts` or `test/vtab/index-descriptor.spec.ts`). Run `yarn test` and `yarn lint` from the repo root.

## TODO

- Route `indexColumnCollationLookup` and `orderingClaimSurvivesCollation` through `resolveIndexDescriptor`; drop both exact-name `indexes.find` calls.
- Teach `classifyConstraintCover` an unknown index collation (BINARY equality → `COARSER_SAFE`, else `MISMATCH_UNSAFE`); update its callers' types.
- Make the guard fail safe on an unresolvable index (classify, do not `return true`).
- Confirm primary-key collations are unchanged by the switch.
- Add the arm A and arm B tests.
- Update `docs/module-authoring.md` and `docs/optimizer-retrieve.md` as above.
