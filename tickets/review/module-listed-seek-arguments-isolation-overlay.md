---
description: Inside a transaction, reads over a storage module's own index now also show the transaction's uncommitted changes, including reads over an index (such as a multi-dimensional one) whose row order cannot be described. Review the merge and the stricter matching of staged rows against the module's filters.
prereq: module-listed-seek-arguments-planner
architecture: docs/design-isolation-layer.md#key-ordering
files:
  - packages/quereus-isolation/src/isolated-table.ts      # IndexScanInfo 'unordered'; OverlayDelta; resolveScanIndex; mergedQuery; mergedSecondaryIndexQuery (step 1 factored out); mergedUnorderedQuery; collectOverlayDelta; buildConstraintMatcher; buildMultiRangeWindowMatcher; constraintComparator; satisfiesBound (EQ arm)
  - packages/quereus-isolation/test/module-seek-overlay.spec.ts   # new spec + test double
  - docs/design-isolation-layer.md                        # "Which index is being scanned": unorderedIndex row, conjunction paragraph
  - docs/module-authoring.md                              # removed the "isolation layer does not yet" sentence
---

# Module-listed seek arguments — isolation overlay half (review)

## What was built

The prereq lets a module list the filters it enforces inside its own index (`BestAccessPlanResult.moduleSeekFilters`, plan kind `moduleSeek`, `plan=8`). When the index cannot be described and the plan claims no order, the access path is `{ kind: 'unorderedIndex' }`. `IsolatedTable` (the wrapper that merges a transaction's staged rows — "the overlay" — into the underlying module's stream) now handles both.

- **Unordered set merge.** `IndexScanInfo` gained `{ type: 'unordered' }`; `resolveScanIndex` maps `unorderedIndex` to it (the prereq's INTERNAL throw is gone). `mergedQuery` routes it to `mergedUnorderedQuery`: collect the overlay delta, stream the underlying (`underlyingFilterInfoForMerge(filterInfo, [])`, so required columns gain the primary key) dropping shadowed rows, then yield the in-window staged rows. No sort, no interleave, never `mergeStreams`. Missing `overlay.query` passes through to the underlying, as the secondary path does.
- **Shared step 1.** The full overlay scan that collects shadowed primary keys (same `makePkKeySerializer` key) and in-window live rows moved verbatim out of `mergedSecondaryIndexQuery` into `collectOverlayDelta`, returning `OverlayDelta { shadows(row), rows }`. Both the secondary and the unordered merge call it. The existing NOTE (full overlay scan per read) moved with it.
- **Conjunctive window.** `buildConstraintMatcher` accepts `unorderedIndex` as well as `index` (previously anything but `index` was match-all, which would have leaked every staged row into the box). For plan `moduleSeek`, each EQ goes into the must-all-hold `bounds` list (renamed from `ranges`; `satisfiesBound` gained an EQ arm) instead of the IN-set `eqValues`. Other plan kinds are unchanged.
- **Comparator collation.** `constraintComparator(columnIndex, index | undefined, fallbackCollation)`: key column's collation when the descriptor holds the column, else the caller's fallback, else BINARY. `moduleSeek` passes no fallback (→ BINARY), matching the planner's collation cover; other kinds pass the table column's declared collation as before. The semantic-ordering arm (TIMESPAN/JSON) is unchanged. `buildMultiRangeWindowMatcher` takes `index | undefined` for typing only (an `unorderedIndex` only ever carries `moduleSeek`).

## Checked by reading (no change needed)

- **Memory overlay given `plan=8` on `_primary_`** (role-primary moduleSeek takes the primary-key merge, which hands the overlay the underlying's FilterInfo): `buildScanPlanFromFilterInfo` (`packages/quereus/src/vtab/memory/layer/scan-plan.ts`) matches no branch for plan 8 and returns an unbounded primary walk; `plan-filter.ts` filters only on the ScanPlan's bounds, of which there are none. So it answers with the whole overlay, and `queryOverlayAsMergeEntries` re-applies the (now conjunctive) matcher. Correct; no test added.
- Dynamic null argument: an EQ or range bound with a null value fails `value === null` in the matcher; the double's underlying returns none.
- Tombstones still only shadow (they are added to the shadow set before the live-row check).
- `unresolvedIndex` still throws INTERNAL; `readCommitted` / no-overlay reads take the fast path in `query()` before any merge.

## Tests added

`packages/quereus-isolation/test/module-seek-overlay.spec.ts`. Its double, `ModuleSeekMemoryModule`, **extends `MemoryTableModule`** rather than being array-backed as the ticket suggested: memory supplies inserts, updates, deletes, commits and `create index`, which the five staged-change cases and the resolved-index case need. It lists every `=`/range filter on columns `x`, `y` under `seekIndexName` (`_box_` → `unorderedIndex`; `t_x` → resolved `index`), answers only plan=8 reads itself (memory full scan, every constraint applied, emitted in descending primary-key order), and records each plan=8 read's access path.

- `merges staged inserts, updates and deletes into a box read over an index with no describable order` — staged insert inside and outside the box, update moving a committed row out and another in, delete of a committed in-box row; the answer inside the transaction equals the answer after commit, and the read was an `unorderedIndex` path. Mutation check: making the matcher match-all for `unorderedIndex` fails it.
- `reads several equalities a module listed on one column as a conjunction` — `x = ? and x = ?` with `[1, 2]` over resolved `t_x`, a staged `x = 1` row; no row inside or after the transaction. Parameters, so the planner cannot fold the contradiction. Mutation check: IN-set semantics for `moduleSeek` fails it.

## Known gaps / for the reviewer

- **A resolved secondary-index `moduleSeek` still takes the interleaving secondary merge**, which assumes the underlying emits in `(indexKey…, pk…)` order. Shadowing is by set membership, so the row set is right whatever order the module emits; only staged-row placement depends on it, and that matters only when the plan claims an order (then the module owes it anyway). The conjunction test's answer is empty, so it does not exercise placement. Not changed; worth confirming the contract wording in `docs/module-authoring.md` covers it.
- **A role-primary `moduleSeek` takes `mergeStreams`**, whose shadowing depends on primary-key order: the module owes primary-key order for any plan on a role-primary index (design doc: "regardless of the plan kind"). Not tested here.
- The BINARY-when-undescribed comparator choice is verified by reading only; no test pins it (a NOCASE column listed on an undescribed index is declined by the planner before it reaches the overlay, so it is hard to reach from SQL).

## Validation

`yarn build` green; `yarn workspace @quereus/isolation run typecheck` green (covers test files); `yarn test` green across all workspaces, exit 0 (quereus 11180 passing / 26 pending; isolation 455 passing, including the 2 new tests; no failures anywhere).
