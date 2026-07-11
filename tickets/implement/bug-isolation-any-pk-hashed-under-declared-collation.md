description: When a table's primary key uses the flexible `any` type and is declared case-insensitive, the transaction layer treated two rows that differed only in letter case as the same row, so one of them could disappear from a query run inside that transaction — now fixed.
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # new pkKeyCollationName, shared decision
  - packages/quereus/src/index.ts                                   # re-exports pkKeyCollationName
  - packages/quereus-isolation/src/isolated-table.ts                # ~line 468 — pkNormalizers, fixed
  - packages/quereus-isolation/src/overlay-rows.ts                  # ~line 70 — makePkKeySerializer, fixed (same defect, wasn't in the fix ticket's file list)
  - packages/quereus-isolation/test/isolation-layer.spec.ts         # new regression test
  - packages/quereus-store/src/common/store-table.ts                # resolvePkKeyCollations now delegates to the shared helper
difficulty: easy
---

# Fix already implemented and verified — handoff for review pass

The root cause, fix, and verification described in the original fix ticket
(`bug-isolation-any-pk-hashed-under-declared-collation`) are already applied to the working
tree. This ticket exists to carry that work through the normal `implement → review` handoff
rather than to redo it.

## What was wrong

`create table t (k any collate nocase primary key)` is accepted, but `ANY_TYPE.compare` always
compares under `BINARY` — the `collate nocase` on an `any` column is inert. `IsolatedTable`'s
secondary-index merge path (`mergedSecondaryIndexQuery` in `isolated-table.ts`) built its
modified-PK hash set with normalizers drawn straight from `column.collation`, so it keyed `'A'`
and `'a'` as the same PK when the engine genuinely treats them as distinct. Inside a transaction,
an update to one of a case-distinct pair could make the query merge drop the other.

The same defect existed in a second spot the original fix ticket's `files:` list did not
mention: `overlay-rows.ts`'s `makePkKeySerializer`, used by `isolation-module.ts` to align
overlay rows with underlying rows for row-validating DDL checks. Same ternary, same bug.

## What changed

Added `pkKeyCollationName(column)` to `packages/quereus/src/planner/analysis/comparison-collation.ts`
(exported from the package root) as the single, engine-level answer to "what collation must a
PK-equality key normalizer use for this column":

- never-text column → `undefined` (normalizer is moot; key bytes are type-native)
- text-capable but not `isTextual` (`any`, `json`, the temporal types) → hard-coded `'BINARY'`,
  since PK equality goes through `logicalType.compare` (`createTypedComparator`), which ignores
  collation for all of those
- `isTextual` (`text`) → the column's own declared collation

Both isolation call sites (`isolated-table.ts` PK-set builder, `overlay-rows.ts`'s
`makePkKeySerializer`) now call this helper instead of their own copy of the ternary.
`quereus-store`'s `resolvePkKeyCollations` — which already made this same decision correctly for
the store's on-disk key encoding — now delegates its branch logic to the same helper too, so all
three sites can no longer drift apart; it keeps its own fallback-to-K and uppercase-normalization
on top, which the isolation callers don't need (their resolver already handles that).

## Verification performed

- Added a regression test, `isolation-layer.spec.ts` → `'keeps case-distinct `any`-typed PK rows
  separate under a declared (inert) NOCASE'`, in the `'merged secondary-index key encoding
  (bigint / collation)'` describe block. It reproduces the ticket's exact scenario: two committed
  rows `('A', 'upper')` / `('a', 'lower')`, a secondary index on `v`, an in-transaction `UPDATE`
  of one row via the indexed column, then asserts both rows are still independently visible.
- Confirmed the test fails without the fix: temporarily reverted the `isolated-table.ts` call site
  back to `this.keyNormalizerResolver(column.collation)` and re-ran — the test failed with
  `expected +0 to equal 1` (the untouched `'a'` row was dropped by the merge). Restored the fix
  and re-ran — passes.
- `yarn build` — clean, all packages including the two bundled apps that pull in `@quereus/quereus`.
- `yarn workspace @quereus/isolation test` — 231 passing (was 230; +1 new).
- `yarn workspace @quereus/store test` — 916 passing, no regressions (`resolvePkKeyCollations`
  refactor didn't change any store-observable behavior — same branch decisions, same output shape).
- `yarn test` (full monorepo) — 6918 + 231 + 104 + 51 + 17 + 28 + 916 + 474 + 52 + 31 + 34 + 117
  passing across every workspace, zero failures.
- `yarn lint` — clean across all packages.

## What's left for review

Nothing functional is known to be missing. The review pass should sanity-check:

- The new `pkKeyCollationName` helper's placement/doc-comment fit the rest of
  `comparison-collation.ts`'s style (that file is unusually dense with cross-referencing prose —
  matched it as closely as reasonable).
- Whether `store-module.ts`'s two other `logicalTypeCanHoldText(column.logicalType) ?
  column.collation : undefined` sites (`validateUniqueOverExistingRows` line ~1177,
  `indexDedupeNormalizers` line ~3521) are correctly OUT of scope. They dedupe UNIQUE
  constraint/index columns via `compareSqlValues`-shaped enforcement, which — unlike PK equality
  — genuinely does honor a declared collation on an `any`/`json`/temporal column at runtime, so
  they were deliberately left alone. Worth a second look if there's any doubt.

## TODO

- Confirm the review pass agrees with the "left alone" call above, or files a follow-up if not.
- No other outstanding work identified.
