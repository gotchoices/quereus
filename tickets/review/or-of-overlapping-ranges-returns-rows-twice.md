description: A query that ORs two ranges on an indexed column returned rows in the overlap twice, and inside a transaction could show an already-deleted row when the ranges were written high-to-low. The memory backend now cuts the ranges into non-overlapping pieces and walks them in index order; this review checks that fix.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts          # normalizeRanges + helpers (after orderSeekKeys), seeksFromUpper, multi-range branch of scanLayerResolved
  - packages/quereus/src/vtab/memory/module.ts                    # buildMonotonicAdvertisement comment + NOTE tripwire; adjustPlanForOrdering comment
  - docs/module-authoring.md                                      # OR_RANGE overlap / NULL / ordering contract (paragraph after the non-literal-bounds one)
  - packages/quereus/test/logic/05.1.2-or-of-ranges-seek.sqllogic # new sqllogic regression
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts    # new "OR-of-ranges multi-range seek" describe block
----
# OR of ranges: overlapping rows returned twice, and staged deletes undone under isolation

## What was wrong

On the memory backend, `where x between 1 and 3 or x between 2 and 4` (an `OR_RANGE`, served as a `plan=6` multi-range seek) walked each range in SQL-text order and joined the results. A row in two ranges came back twice. The rows also came back out of index order, and under `IsolationModule` the primary-key overlay merge (`mergeStreams`) pairs staged rows with stored rows by position, so `pk between 4 and 5 or pk between 1 and 2` with `delete from t where pk = 1` pending showed row 1 again.

## What changed

`scan-layer.ts`, multi-range branch of `scanLayerResolved`: before walking, the ranges go through `normalizeRanges(ranges, comparators.bound, highToLow)`:

- **Drop** ranges that match nothing (`rangeCanMatch`): a NULL bound, crossed bounds, or bounds meeting at a value one of them excludes.
- **Sort** by lower bound (`compareLowerBounds`): unbounded first, inclusive before exclusive on equal values. The tie order matters: `(3,5]` sorted before `[3,4]` would lose 3.
- **Cut, don't merge** (`remainderAfter`): each range is cut to start just above the last kept range's end (`boundJustAbove`: `<= v` becomes `> v`, `< v` becomes `>= v`), or dropped if the last kept range already covers it. `[1,3] or [2,4]` walks `[1,3]` then `(3,4]`.
- **Orient**: reversed when the walk visits the bound column high-to-low.

Direction is `seeksFromUpper(plan, schema, boundPosition)`, a new helper that replaces the two inline copies in the primary and secondary branches (same rule as before, `!descending === boundColumnIsDesc`). The four-case comment moved onto it.

**This departs from the ticket's design.** The ticket said to coalesce overlapping ranges into one. I built that first, and an edge check showed it was wrong. `x < 2 or x > 1` merges into a range with no bounds, and `planAppliesToKey` rejects a NULL key only when the plan has a bound, so the NULL rows came back (id 6 with `x = null`). Cutting keeps every walked range bounded on at least one side, as long as every input range was. The cost is more sub-walks: at most one per input range, never more than before the fix. No primary-key dedup set was added, as the ticket asked.

Comments and docs:
- The old multi-range `NOTE:` ("SQL-text order is harmless") is replaced.
- In `module.ts`, the `buildMonotonicAdvertisement` comment and its JSDoc now say OR_RANGE is index-ordered but not advertised. A `NOTE:` tripwire there covers turning on `monotonicOn` and the ordering claim together. The `adjustPlanForOrdering` comment that said "concatenated ranges" now points to that NOTE.
- `docs/module-authoring.md` gained one paragraph after the non-literal OR_RANGE bounds paragraph: ranges may overlap, nest, repeat, be empty or reversed; each matching row comes back once, and never a NULL; a NULL-bound range is dropped before ranges are combined; the unbounded-merge pitfall; and primary-key order is required under the isolation layer.

## Tests added

- `packages/quereus/test/logic/05.1.2-or-of-ranges-seek.sqllogic` (new file). It covers overlapping ranges on a secondary index and on the primary key, a nested pair, a pair touching at an inclusive bound, and `x < 2 or x > 1` with a NULL row. The overlap and NULL cases are checked against the same query on `orr_plain`, a copy with nothing indexed. It is a new file, not a block in `100-predicate-normalization-edge-cases.sqllogic`, because `create index` requires the `-- requires-capability: standalone-index-ddl` header (enforced by `logic-capabilities.spec.ts`), and adding that header to the predicate-normalization file would skip the whole file on a backend without index DDL. It has no `query_plan` seek assertions, because the store backend doesn't serve OR_RANGE and they failed in `--store` mode. The file passes in both modes. Without the fix it fails with "Row count mismatch. Expected 4, got 6" (I checked by temporarily bypassing `normalizeRanges`).
- `packages/quereus-isolation/test/key-set-seek-merge.spec.ts`, describe block `OR-of-ranges multi-range seek`: ranges written high-to-low on the primary key, with a staged delete of pk 1. It asserts that the deleted row is absent and that the underlying read was `idx=_primary_(0);plan=6;`. Without the fix it fails with pk 1 present (checked the same way, with a rebuilt `dist`).

## Validation run

- `yarn workspace @quereus/quereus test`: 3596 passing, 1 failing. The failure is pre-existing and recorded in `tickets/.pre-existing-error.md`: `21.2-between-edges.sqllogic` gained a `create index` block in commit `2f992bece` without the capability header. This diff doesn't touch that file.
- `yarn workspace @quereus/quereus test --store --grep 05.1.2-or-of-ranges`: passing.
- `yarn workspace @quereus/isolation test`: 456 passing (after `yarn workspace @quereus/quereus build`; this package tests against the built `dist`).
- `yarn workspace @quereus/quereus lint`: clean.
- Scratch comparisons, not kept as tests: overlapping, nested, touching, strict-touching (`(1,3) or (3,5)` keeps 3 out), all-covering with a NULL row, placeholder bounds that are NULL, reversed or equal, `x > ? or x < ?`, and three-way nested. Each ran on a secondary index, the primary key, a DESC secondary index and a DESC primary key, and all matched the unindexed table. The DESC structures emitted in descending order.

## For the reviewer

- Check the invariant `remainderAfter` relies on: comparing each range only against the last kept range is enough because kept ranges have strictly increasing ends. The argument is in my head, not the code: everything from the last kept range's original start to its end is already covered.
- The planner never produces an input range with no bounds, but if one ever arrived, the NULL exclusion would not apply to it. That was already true before this change.
- Equal values under a collation (NOCASE `'a'` and `'A'`) are treated as equal when cutting, which matches the tree's order. No dedicated test covers it.
- The store backend has no OR_RANGE path, so `yarn test:store` doesn't exercise this code.
