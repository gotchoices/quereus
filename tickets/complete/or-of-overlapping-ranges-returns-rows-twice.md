description: A query that ORs two ranges on an indexed column returned rows in the overlap twice, and inside a transaction could show an already-deleted row when the ranges were written high-to-low. The memory backend now cuts the ranges into non-overlapping pieces and walks them in index order.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts          # normalizeRanges + helpers, seeksFromUpper, multi-range branch of scanLayerResolved
  - packages/quereus/src/vtab/memory/module.ts                    # buildMonotonicAdvertisement comment + NOTE tripwire; adjustPlanForOrdering comment
  - packages/quereus/src/vtab/best-access-plan.ts                 # NULL_EXCLUDING_OPS comment (review fix)
  - docs/module-authoring.md                                      # OR_RANGE overlap / NULL / ordering contract
  - packages/quereus/test/logic/05.1.2-or-of-ranges-seek.sqllogic # sqllogic regression
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts    # "OR-of-ranges multi-range seek" describe block
----
# OR of ranges: overlapping rows returned twice, and staged deletes undone under isolation

## Summary

On the memory backend, an `OR_RANGE` multi-range seek (`plan=6`, e.g. `x between 1 and 3 or x between 2 and 4`) walked each range in SQL-text order and concatenated the results, so rows in an overlap came back twice, and under `IsolationModule` the position-paired primary-key overlay merge could miss a staged delete when the ranges were written high-to-low.

The fix (`ticket(implement): or-of-overlapping-ranges-returns-rows-twice`): `normalizeRanges` in `scan-layer.ts` drops ranges that cannot match (NULL bound, crossed or empty bounds), sorts by lower bound (unbounded first, inclusive before exclusive on ties), cuts each range to start just above the last kept range's end (dropping it when already covered), and reverses the list when the walk visits the bound column high-to-low. Cutting instead of merging keeps every walked range bounded, so the NULL-key rejection in `planAppliesToKey` still applies (`x < 2 or x > 1` must not return NULL rows). The four-case seek-direction rule was extracted into `seeksFromUpper`, now shared by the primary, secondary and multi-range branches. `docs/module-authoring.md` states the OR_RANGE contract for module authors (each row once, never NULL, primary-key order under isolation).

## Review findings

- **Correctness of the cutting algorithm** — checked by reading and by a scratch comparison against an unindexed copy of the table (not kept): overlapping, nested, three-way, touching inclusive (`>= 3 or <= 3`), touching exclusive (`> 3 or < 3` keeps 3 out), covering-all with a NULL row, placeholder bounds that are NULL / reversed / equal, NOCASE text ranges with case-variant duplicates (`'a'`/`'A'`), on a DESC secondary index and a DESC primary key. All matched; DESC structures emitted in descending order. Confirmed via `query_plan` that these were served as `INDEX RANGE` seeks. The tie-order and cut logic are sound; the implementer's unwritten invariant (comparing against only the last kept range suffices) holds — added a three-line comment stating why at the loop in `normalizeRanges`.
- **Misleading comment (fixed)** — `normalizeRanges` JSDoc said the comparator "mirrors the tree's own order, so the result ascends in structure order". `comparators.bound` is a value comparator that is not reversed for DESC columns (`resolveScanComparators` in `plan-filter.ts`), so the result ascends by value and `highToLow` maps it to physical order. Reworded.
- **Stale doc comment elsewhere (fixed)** — `NULL_EXCLUDING_OPS` in `best-access-plan.ts` still said both backends emit OR_RANGE windows "in range order, not column order". Reworded to: memory walks them in index order but doesn't advertise it; the store doesn't serve OR_RANGE as a seek.
- **Docs** — `docs/module-authoring.md` paragraph is accurate. `docs/memory-table.md` mentions multi-range seek only as a capability; nothing stale. No other doc describes OR_RANGE emission order.
- **Unbounded input range** — the planner never emits a range with no bounds; if one arrived, it would walk everything including NULLs. Same as before this change; the implementer flagged it. Not a current defect, no tripwire added beyond the existing note in the handoff (the plan builder in `scan-plan.ts` only produces bounded ranges from `rangeOps`).
- **Ordering advertisement** — the implementer's `NOTE:` tripwire in `module.ts` (`buildMonotonicAdvertisement`) about optionally advertising `monotonicOn` for OR_RANGE is the right home; left as is.
- **Type safety / DRY / resource cleanup / error handling** — `seeksFromUpper` removes two copies of the direction rule; helpers are small and typed; no resources or error paths involved. Nothing found.
- **Tests** — the sqllogic file (7 queries, two of them reference queries on an unindexed copy) and the isolation regression both pin real defects (implementer verified each fails without the fix). No tests cut or added.
- **Validation** — `yarn workspace @quereus/quereus lint`: exit 0. `yarn workspace @quereus/quereus test`: 11185 passing, 26 pending, 0 failing (the `21.2-between-edges` pre-existing failure was resolved by the triage commit `tess: triage pre-existing test failure`). `yarn workspace @quereus/isolation test`: 456 passing. Store mode not re-run: the review changes are comment-only and the store has no OR_RANGE path.
