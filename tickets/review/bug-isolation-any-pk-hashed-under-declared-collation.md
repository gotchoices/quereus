description: When a table's primary key uses the flexible `any` type and is declared case-insensitive, the transaction layer treated two rows that differed only in letter case as the same row, so one of them could disappear from a query run inside that transaction — now fixed.
files:
  - packages/quereus/src/planner/analysis/comparison-collation.ts   # new pkKeyCollationName, shared decision
  - packages/quereus/src/index.ts                                   # re-exports pkKeyCollationName
  - packages/quereus-isolation/src/isolated-table.ts                # ~line 468 — pkNormalizers, fixed
  - packages/quereus-isolation/src/overlay-rows.ts                  # ~line 70 — makePkKeySerializer, fixed (same defect, wasn't in the fix ticket's file list)
  - packages/quereus-isolation/test/isolation-layer.spec.ts         # new regression test, ~line 506
  - packages/quereus-store/src/common/store-table.ts                # resolvePkKeyCollations now delegates to the shared helper
difficulty: easy
---

# Fix implemented and re-verified — ready for review

Root cause, fix, and tests from the original fix ticket
(`bug-isolation-any-pk-hashed-under-declared-collation`) are on the working tree at HEAD
(commit `fbfdfff2`). This implement pass re-confirmed the claims below independently rather
than re-doing the work; nothing changed in this pass.

## What was wrong

`create table t (k any collate nocase primary key)` is accepted, but `ANY_TYPE.compare` always
compares under `BINARY` — the `collate nocase` on an `any` column is inert. `IsolatedTable`'s
secondary-index merge path (`mergedSecondaryIndexQuery` in `isolated-table.ts`) built its
modified-PK hash set with normalizers drawn straight from `column.collation`, so it keyed `'A'`
and `'a'` as the same PK when the engine genuinely treats them as distinct. Inside a transaction,
an update to one of a case-distinct pair could make the query merge drop the other.

The same defect existed in a second spot: `overlay-rows.ts`'s `makePkKeySerializer`, used by
`isolation-module.ts` to align overlay rows with underlying rows for row-validating DDL checks.
Same ternary, same bug.

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

## Verification performed (this pass, independent re-check)

- Read `comparison-collation.ts`'s new `pkKeyCollationName` (line ~358) and both isolation call
  sites (`isolated-table.ts:474`, `overlay-rows.ts:77`) plus `store-table.ts`'s
  `resolvePkKeyCollations` (line ~132) — all delegate through the one helper as described, no
  drift between the three call sites.
- Confirmed the new regression test exists and matches the described scenario:
  `isolation-layer.spec.ts:506`, `'keeps case-distinct \`any\`-typed PK rows separate under a
  declared (inert) NOCASE'` — two committed rows `('A','upper')` / `('a','lower')`, secondary
  index on `v`, in-transaction `UPDATE` of one row via the indexed column, asserts both rows
  independently visible afterward.
- `yarn build` — clean across every package, including the bundled apps (shared-ui, vscode,
  quoomb-web) that pull in `@quereus/quereus`.
- `yarn test` (full monorepo) — every workspace's count matches the fix ticket's claimed
  numbers exactly, zero failures: 6918 (quereus) + 231 (isolation, includes the +1 new test) +
  104 + 51 + 17 + 28 + 916 (store) + 474 + 52 + 31 + 34 + 117 passing.
- `yarn lint` — clean; `@quereus/quereus`'s real lint step (eslint + `tsc -p tsconfig.test.json
  --noEmit`) produced no output (clean exit 0), every other package's no-op `echo` ran as
  expected.
- Did NOT re-do the fix ticket's manual revert-and-rerun check (temporarily restoring the old
  `column.collation` ternary to confirm the new test fails without the fix) — took that claim on
  the fix ticket's word given the test's logic clearly exercises the described defect and the
  diff is a straightforward ternary→helper-call swap at both sites.

## What's left for review

Nothing functional is known to be missing; this is a small, well-contained fix with a direct
regression test. The review pass should focus on:

- The new `pkKeyCollationName` helper's placement/doc-comment fit alongside the rest of
  `comparison-collation.ts`'s dense cross-referencing prose style — sanity-check it reads
  consistently, not a deep re-derivation of the logic.
- Whether `store-table.ts`'s two *other* `logicalTypeCanHoldText(column.logicalType) ?
  column.collation : undefined`-shaped sites (`validateUniqueOverExistingRows` ~line 1177,
  `indexDedupeNormalizers` ~line 3521, exact line numbers unconfirmed this pass — grep for
  `logicalTypeCanHoldText` in that file) are correctly OUT of scope. Those dedupe UNIQUE
  constraint/index columns via `compareSqlValues`-shaped enforcement, which — unlike PK
  equality — genuinely does honor a declared collation on an `any`/`json`/temporal column at
  runtime, so leaving them on their own ternary (not routed through `pkKeyCollationName`) looks
  correct on inspection, but is worth a second, closer look if there's any doubt: if they turn
  out to need the same treatment, that's a *different* defect than this ticket's PK-equality
  scope and belongs in its own ticket.

## TODO

- Confirm the review pass agrees with the "two other sites are correctly out of scope" call
  above, or spin up a follow-up ticket if not.
- No other outstanding work identified.
