---
description: |
  Fixed: when the isolation layer wraps a storage module and a transaction has uncommitted writes,
  a query scanning by a secondary index the underlying module named itself (a synthetic name the
  isolation layer's private scratch table never declared) crashed with "Secondary index not found".
  The merged read now full-scans the scratch table, filters and sorts the delta itself, and never
  asks it to resolve the foreign index name.
files:
  - packages/quereus-isolation/src/isolated-table.ts        # mergedSecondaryIndexQuery rewrite; buildConstraintMatcher / buildMultiRangeWindowMatcher / constraintCollation / buildDescriptorComparators (new)
  - packages/quereus-isolation/test/isolation-layer.spec.ts # new describe "underlying-minted secondary index names (synthetic scan shapes)" — 3 regression tests
  - docs/design-isolation-layer.md                          # Read Operations bullet 4 + "Secondary Index Handling" rationale updated
difficulty: hard
---

# Review: isolation overlay no longer asked to resolve underlying-minted index names

## What changed

`IsolatedTable.mergedSecondaryIndexQuery` (packages/quereus-isolation/src/isolated-table.ts) previously
made TWO overlay queries: a full scan to collect modified primary keys, then a second query re-issuing
the caller's FilterInfo — which still named the underlying's index. When that name was one the
underlying module minted itself (lamina mints `_compound_v_0`-style names per plan) the overlay's
private MemoryTable could not resolve it and threw `Secondary index '_compound_v_0' not found`
(scan-layer.ts:189). Now:

- **One overlay full scan** collects modified PKs AND the non-tombstone data rows. The step-2
  index-named overlay query (the crash site) is deleted.
- **The isolation layer window-filters the overlay rows itself, unconditionally**
  (`buildConstraintMatcher`): whether the engine puts a residual Filter above the isolation scan
  depends on the underlying's `handledFilters`, which the isolation layer does not control. The
  matcher interprets the pushed constraints by plan kind:
  - `eqSeek` / `rangeSeek` / `prefixRangeSeek` / `multiSeek`: per-column EQ values form an IN set
    (the planner encodes an IN multi-seek as one EQ constraint per seek value on the same column,
    and a composite IN as its full per-column cross-product — verified in
    rule-select-access-path.ts), so EQ matches on ANY value; range bounds AND together.
  - `multiRangeSeek` (OR of ranges): the constraint entries are positional placeholders (all
    stamped GE), so the ranges are decoded from the idxStr `rangeCount`/`rangeOps` params exactly
    as the memory module's scan-plan builder does. A naive conjunctive read of those constraints
    would have DROPPED valid rows.
  - `scan` (ordering-only walk) and unknown ops (LIKE, MATCH, …): no filtering — can only
    over-yield rows a residual Filter still removes, never drop rows.
  - NULL uses seek semantics: a NULL operand or NULL row value never matches, mirroring what an
    index seek returns.
  - Collation: index key column's declared collation, falling back to the table column's, else
    BINARY.
- **The isolation layer sorts the collected overlay rows** by the merge's (indexKey, PK) sort key
  before the step-3 merge — the full scan emits PK order, and correctness no longer depends on the
  overlay re-planning any index.
- **Descriptor-derived merge comparators** (`buildDescriptorComparators`): when the underlying
  exposes no `getIndexComparator` for the index (always true for synthetic names), the per-column
  comparators now come from the descriptor's `keyColumns` (desc + collation) instead of a
  BINARY-ascending guess — so a synthetic index with a DESC key column merges in the underlying's
  actual emission order. This goes slightly beyond the ticket's TODO; it was the remaining
  order-correctness hole for exactly the index family this fix enables.

Primary-key paths (`adaptFilterInfoForOverlay` retarget of aliased-PK names) and declared-secondary
paths are untouched; `queryOverlayAsMergeEntries` still serves only the primary/full-scan merge.

## How to validate

- `yarn build` — green.
- `yarn workspace @quereus/isolation test` — 248 passing (was 245 before this ticket; +3 regressions).
- `npx tsc -p tsconfig.test.json --noEmit` in packages/quereus-isolation — clean.
- `yarn test` (full workspace) — all suites green (run at the fused-scan stage; only
  quereus-isolation changed after that, re-validated by its own suite).

New regression specs (isolation-layer.spec.ts, describe `underlying-minted secondary index names`),
all driving `IsolatedTable.query()` directly with an engine-shaped FilterInfo over a custom
underlying module that advertises `_compound_v_0` with a `role: 'secondary'` descriptor:

1. **Row set AND order** under a dirty overlay (staged insert + delete + update): previously threw
   `Secondary index '_compound_v_0' not found`; now yields the merged view in (v, pk) order. The
   overlay's full scan emits PK order, so this test fails if the isolation-side sort is removed.
2. **Equality window** (`v = 'b'` as a pushed EQ constraint): an out-of-window staged row must be
   dropped by the isolation layer's own filter — the direct query() call has no residual Filter
   above it to catch it.
3. **DESC key column**: descriptor-derived comparators merge overlay rows into a descending
   underlying stream correctly.

Existing suites that pin the unchanged routing stayed green: `idx_email` declared-secondary merge,
`_primary_extra` (secondary index named like the PK), suffixed-PK (`_primary_1`) suites, and the
unresolvedIndex loud-failure spec.

## Cross-repo acceptance

The lamina project can now un-skip
`packages/lamina-quereus-test/src/isolation-overlay-underlying-index-names.test.ts` and close its
`tickets/blocked/quereus-isolation-overlay-cannot-serve-underlying-index-names.md`. The engine-side
contract is pinned by the regression module here, independent of lamina.

## Known gaps / honest notes for the reviewer

- **Research note resolved by construction**: the fix filters unconditionally, so it is correct
  whether or not the underlying marks its index constraints handled. Test 2 exercises the
  no-residual case directly.
- **Multiple genuinely-conjunctive EQ constraints on one column** (`v = 1 AND v = 2`) would be
  treated as an IN set and over-yield overlay rows. The engine's planner never emits that shape
  into pushed index constraints (same-column EQ sets only come from IN multi-seeks), and
  over-yield is caught by any residual Filter; noted here rather than guarded in code.
- **`argvMap`-only constraint encodings**: scan-plan.ts also consults an `argvMap` idxStr param
  mapping args to `indexInfoOutput.aConstraint` entries. Every engine FilterInfo builder
  (`makeIndexFilterInfo`, `makeIndexEqSeekFilterInfo`) populates `filterInfo.constraints`
  directly, so the matcher reads only those; a hypothetical producer that encodes its window
  exclusively via `argvMap` would see the overlay side unfiltered (over-yield, not row loss).
- **Descending scan codes (`plan=1`/`plan=4`/`ordCons=DESC`)** remain unmodelled in the typed
  access path (per index-descriptor.ts, nothing in this repo emits them); the DESC coverage added
  here is per-key-column `desc` in the descriptor, which IS emitted.
- Pre-existing unused-parameter warnings (`tombstoneIndex` in the two unique-conflict helpers,
  `_exhaustive`) predate this ticket and were left alone.

## Review findings (seed — reviewer completes)

- Tripwire parked in code: `mergedSecondaryIndexQuery` full-scans the overlay on every merged
  secondary read — fine while overlays hold one transaction's writes; the `NOTE:` at the scan site
  (isolated-table.ts, step 1 of mergedSecondaryIndexQuery) says to add retarget-by-key-columns as
  an optimization if it ever shows up hot.
