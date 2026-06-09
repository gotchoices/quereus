description: The store module's range index-seek filter (`compareValues` in store-table.ts) compares range bounds (LT/LE/GT/GE) with a BINARY JS comparator; only equality (EQ) is collation-aware (NOCASE). Because of this, the access-path collation-cover analysis declines every non-BINARY range/BETWEEN seek for store-backed tables (the store does NOT set `BestAccessPlanResult.honorsCollatedRangeBounds`), falling back to a SeqScan + residual. Correct, but a missed optimization symmetric to what `memory-range-seek-collation-bounds` fixed for the memory vtab. A real fix threads each index column's declared collation into the store's range-bound compare (and any early-termination), then has the store advertise `honorsCollatedRangeBounds` so collation-matched non-BINARY range seeks become usable.
files:
  - packages/quereus-store/src/common/store-table.ts            # compareValues() — LT/LE/GT/GE use raw `<`/`>` (BINARY); only EQ applies NOCASE
  - packages/quereus-store/src/common/store-module.ts           # getBestAccessPlan — returns indexName '_primary_' + seekColumns; would set honorsCollatedRangeBounds once range filter is collation-aware
  - packages/quereus-store/src/common/encoding.ts               # collation ENCODERS (NOCASE lowercases, RTRIM trims) — keys are already collation-encoded; the gap is the post-fetch row filter
  - packages/quereus/src/vtab/best-access-plan.ts               # BestAccessPlanResult.honorsCollatedRangeBounds (the opt-in flag)
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts  # classifyConstraintCover — gates the non-BINARY range MATCH on the flag
----

# Store module: range/prefix seek bounds ignore index collation

## Background

`memory-range-seek-collation-bounds` made the in-memory vtab honour a non-BINARY index
column's declared collation when filtering range bounds and early-terminating a range/
prefix seek, and added an opt-in capability flag
`BestAccessPlanResult.honorsCollatedRangeBounds`. The access-path collation-cover analysis
(`classifyConstraintCover` in `rule-select-access-path.ts`) permits a collation-matched
non-BINARY **range** seek (predicate collation = index collation ≠ BINARY) **only** when the
module advertises that flag. The memory module sets it; the store module does not.

The store module reaches the same access-path cover analysis: its `getBestAccessPlan`
advertises `indexName: '_primary_'` and `seekColumns: [firstPkColumn]` for a primary-key
range scan, so a NOCASE/RTRIM **primary-key** range/BETWEEN goes through
`classifyConstraintCover`. Because the store leaves `honorsCollatedRangeBounds` off, every
non-BINARY range is declined to a `SeqScan` + residual — always correct (the residual
re-applies the predicate with the engine's collation-aware comparison), but the index is
not used.

## Why the store currently can't honour collated range bounds

`StoreTable.compareValues` (store-table.ts) decides which fetched rows fall inside a range:

```
case IndexConstraintOp.EQ: a === b || (NOCASE && a.toLowerCase() === b.toLowerCase());
case IndexConstraintOp.LT: return a < b;   // BINARY
case IndexConstraintOp.LE: return a <= b;  // BINARY
case IndexConstraintOp.GT: return a > b;   // BINARY
case IndexConstraintOp.GE: return a >= b;  // BINARY
```

Only EQ is collation-aware. The range arms use raw JS `<`/`<=`/`>`/`>=`, which is a BINARY
string comparison, so a NOCASE/RTRIM range would under-fetch case/space variants — the same
hazard the memory vtab had before the fix. (Note: the store's *keys* are already
collation-encoded — NOCASE lowercases, RTRIM trims — so range *iteration order* over the KV
store is collation-correct; the gap is purely the post-fetch row filter.)

## Desired behavior

- Thread each index/PK column's declared collation into `compareValues` (and any seek-start
  / early-termination logic) so range bounds are compared under the column collation, not
  BINARY. Reuse the store's existing collation resolution (the same one its key encoders and
  `comparePrimaryKey` use) rather than re-deriving it.
- Once the store's range filter is collation-correct, have `getBestAccessPlan` set
  `honorsCollatedRangeBounds: true` so a `NOCASE`/`RTRIM` PK range/BETWEEN over a
  matching-collation index uses the seek instead of declining to a scan.

## Acceptance

- A store-backed `NOCASE`/`RTRIM` primary-key range or `BETWEEN` uses the index seek and
  returns the same rows as the equivalent sequential scan.
- Cross-backend parity: `test/logic/06.4.2-collation-extras.sqllogic` (run under both
  memory and store via `yarn test` / `yarn test:store`) continues to pass with identical
  result rows; only the store plan improves.
- No regression for BINARY ranges or for collation-mismatched ranges (still declined).
