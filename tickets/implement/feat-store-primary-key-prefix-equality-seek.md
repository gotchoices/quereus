description: On the persistent storage backend, a query that fixes only the first part of a multi-column primary key (for example every line of one order, keyed by order and line number) reads the whole table instead of jumping to the matching rows. Serve it as one contiguous read of the matching key range, and let it satisfy an ORDER BY on the rest of the key.
architecture: docs/module-authoring.md
files: packages/quereus-store/src/common/store-module-access-plan.ts (`computeFilterAccessPlan`, `leadingPkRangePlan`, `resolveEqualityPins`, `buildPkOrderingAdvertisement`, `NO_PINNED_COLUMNS`), packages/quereus-store/src/common/store-table-scan.ts (`query`, `analyzePKAccess`, `buildPKRangeBounds`, `scanPKRange`, `PKAccessPattern`, `buildIndexRangeBounds`, `prefixRangeSeekLength`), packages/quereus-store/src/common/store-table-base.ts (`encodePkPrefixBounds`), packages/quereus/src/planner/rules/access/rule-select-access-path.ts (`selectPhysicalNodeFromPlan` — read only, no change expected), packages/quereus-store/README.md (§ IN-list index seeks), packages/quereus-store/test/index-ordering.spec.ts (pattern for plan/answer/plan-shape assertions)
----

# What is wrong today

For `create table t (a integer, b integer, v text, primary key (a, b)) using store`, `where a = 1` plans a full sequential scan with a residual Filter. In `computeFilterAccessPlan`:

- `resolvePrimaryKeyPins` returns null unless every primary-key member is pinned, so neither the point-lookup arm nor the `_primary_` multi-seek arm applies;
- `leadingPkRangePlan` needs a `>`/`>=`/`<`/`<=` bound on the leading member, so an equality does not qualify;
- with no secondary index the result is `scanPlan`, which claims nothing.

The data store is ordered by encoded primary key, so the rows with `a = 1` are one contiguous byte window, `encodePkPrefixBounds([1])`.

Even if the planner advertised it, the runtime would not serve it: `StoreTableScan.analyzePKAccess` only knows a full-key point and a leading-member range, so it would fall through to the full scan. The result would be correct and just as slow.

The engine side already works. `rule-select-access-path`'s index-aware path (`selectPhysicalNodeFromPlan`) treats `_primary_` like any index: seek columns `[a]` with an equality become an `eqSeek` (`plan=2`), and `[a, b]` with an equality on `a` and a bound on `b` become a `prefixRangeSeek` (`plan=7`, `prefixLen=1`). The memory module already exercises both through its `_primary_` pseudo-index (`MemoryTableModule.gatherAvailableIndexes`). No engine change is expected.

# Design

## Planner: a new primary-key prefix candidate

Add `pkPrefixPlan(tableInfo, request, estimatedRows, pkOrderPreservingPrefix)` beside `leadingPkRangePlan` in `store-module-access-plan.ts`. It returns a `_primary_` candidate or null.

The equality prefix:

- `resolveEqualityPins(request.filters, tableInfo.primaryKeyDefinition)` gives the leading pinned run. Cut it at the first member whose pin `isMultiValueEquality` (a multi-value `IN` or any runtime-valued set). Call the result `prefixCols`, with length `p`.
- The arm applies only for `1 ≤ p < pk.length`. A full-length run is the point / multi-seek arms' business, and they have already returned. If the multi-seek declined, its run contains a multi-value pin, so the cut leaves `p < pk.length`, which is correct.
- The cut is required. Without it, the rule's `eqBySeekCol` would turn a multi-value `IN` seek column into a `_primary_` multi-seek, and `scanMultiSeekPrimary` throws when `seekWidth` does not cover the whole key. A prefix multi-seek is out of scope (backlog `feat-store-primary-key-prefix-in-list-seek`).
- `collationsExact` must be recomputed over the cut run, or tracked while cutting. `resolveEqualityPins` reports it for the whole run.

The optional trailing bound, on member `pk[p]`, mirrors the secondary `prefixRange` arm in `tryIndexAccessPlan`. All of these must hold:

- the cut prefix is collation-exact (the rule checks a prefix-range's prefix equalities as range bounds);
- `rangeServedOn(request.filters, pk[p])`;
- key-byte order safety at position `p`: `pkOrderPreservingPrefix > p`. For a primary-key member the key collation, declared collation and residual collation are the same (`reconcilePkCollations`), and `pkOrderPreservingPrefixLength` also covers the semantic-ordering allow-list. This is slightly conservative because it also requires the prefix members to be order-safe. Accept that and note it at the site.

If any of these fails, the arm stays a plain prefix equality and the bound stays unclaimed, so it survives as a residual. That is the same degradation the secondary arm makes.

No semantic-ordering decline is needed in the planner. The single-valued secondary `eq` arm has none either: the runtime cuts the prefix at an unfaithful probe, which only widens the window (see Runtime).

Claims, positional as everywhere else:

- `claimFirstPerRole(filters, equalityRoles(prefixCols))`, plus `rangeRoles(pk[p].index)` when the trailing bound applies;
- `setIndexName('_primary_')`;
- `setSeekColumns(prefixCols)`, or `[...prefixCols, pk[p].index]` with a trailing bound. Primary-key definition order is required, because the rule derives the window positionally from it.

Rows and cost:

- Rows come from `resolveArmEstimate(tableInfo, filters, arm, prefixCols, boundCol)`, with `arm = 'eq'` (bound column undefined) or `'prefixRange'`. A secondary index on the same columns then competes on the same estimate.
- `rows = max(1, floor(estimatedRows × selectivity))`.
- Price it as `AccessPlanBuilder.rangeScan(rowsToProduce(...), 0.2)`, the same formula `leadingPkRangePlan` uses. It reads a contiguous window of the data store directly, with no index-entry resolution, so it carries no `pointRead` term.
- The cost is therefore ≤ `0.2 + 0.5·N < N`, and the arm needs no seek-versus-scan veto, for the same reason the leading range needs none. The scan never claims the prefix equality, so a LIMIT never shrinks the scan's N. Restate this argument at the new function, or merge it with `leadingPkRangePlan`'s.
- Explanation: `Store primary key prefix seek(prefix=p)` or `Store primary key prefix-range seek(prefix=p)`, plus `walkExplanationSuffix`.

Ordering:

- `buildPkOrderingAdvertisement` gains a `pinnedCols: ReadonlySet<number> = NO_PINNED_COLUMNS` parameter, threaded to both `indexOrderingSatisfies` and `walkOrdering` inside it. The new arm passes `new Set(prefixCols)`.
- This lets `where a = ? order by b` and `order by b desc` claim forward and reverse walks. The `scanPKRange` window is a `[gte, lt)` byte range and iterates backwards exactly.
- NULL placement and order-preserving truncation come from the existing helpers. `nullSafeOrderingPrefixLength` already treats pinned columns as NULL-free.
- `pkMonotonicAdvertisement` stays as it is. The leading member is constant inside the window, which is still non-strictly monotonic.
- Rewrite the NOTE on `NO_PINNED_COLUMNS`. It names this ticket as the missing piece; after this change the primary-key half of its argument is settled, and the walk can stay unpinned.

Placement in `computeFilterAccessPlan`:

- `const pkWindowPlan = pkPrefixPlan(...) ?? leadingPkRangePlan(...)`, replacing `pkRangePlan` at every later use.
- The prefix arm is always at least as narrow as the leading range: both apply only to `a = 1 and a > 0`-style predicates, and the prefix arm then leaves the bound residual.
- It competes against the secondary-index seeks exactly as the range candidate does: strict `<` on `seekRankingCost`, with ties going to the primary key, and it goes ahead of `costOnlyFallback` and the vetoed-scan return.
- Update the order-of-decisions list in the function's doc comment.

## Runtime: serve the window, and only when the plan named `_primary_`

`StoreTableScan.query` runs `analyzePKAccess` before the secondary-index arm, whatever index the plan chose. A primary-key prefix arm placed there without a gate would take over plans that chose a secondary index.

Here is a shape I ran on 2026-11-10 against the in-memory store provider: `primary key (a, b)`, `create index ic on t (a, c desc)`, `where a = 2 order by c`. The plan is `INDEX SEEK t USING ic ORDER BY 2` with the Sort removed. Today it returns rows ordered by `c`, because `analyzePKAccess` ignores an equality prefix. An ungated prefix arm would serve it from the primary-key window in `b` order and return wrong-order rows.

So:

- Extend `PKAccessPattern` so a window carries `prefixValues: SqlValue[]` plus optional trailing `constraints` on member `p`. The existing leading-member range becomes `prefixValues = []`.
- In `analyzePKAccess`, keep the full-key point arm as it is (ungated; it yields at most one row). Then, only when `decodeIdxStr(filterInfo.idxStr)?.indexName` is `_primary_` (compare case-insensitively, as `resolveIndexFromIdxStr` does):
  - Collect the contiguous leading EQ run over `primaryKeyDefinition`. Stop at a member whose probe fails `semanticProbeIsKeyFaithful`; that widens the window, as `analyzeIndexAccess` does.
  - When the run is non-empty and shorter than the key, return a prefix window.
  - When the idxStr is a `prefixRangeSeek`, read `prefixLen` from it, as `prefixRangeSeekLength` does for an index: a value outside `1 … pk.length - 1` is `malformedFilterInfo`. Attach the LT/LE/GT/GE constraints on `pk[prefixLen]` only when `prefixLen ≤ run length`. A shorter run means an unfaithful probe cut it, so drop the bound and serve the shorter prefix window, which is a superset.
  - A full-length run whose probes are all faithful is already the point arm. A full-length run cut short by an unfaithful probe now lands here as a prefix window, which is strictly narrower than today's full scan.
- Gate the existing leading-member range arm the same way: only when the idxStr does not name a secondary index (`resolveIndexFromIdxStr(filterInfo.idxStr) === null`).
  - Today a secondary-index range on a column that is also the leading primary-key member is served from the primary-key window. That emits primary-key order, not the index's, under a plan that may have claimed the index's order.
  - I did not get the planner to pick such a plan in a quick probe: it preferred the primary-key range for `where a > 1 order by a, c desc`. So this is hardening of the same site, not an observed bug.
  - The gate for the range arm can be "not a secondary index" rather than "is `_primary_`", so it keeps serving any caller that builds a FilterInfo without an index name.
- Generalize `buildPKRangeBounds` into one window builder: base `encodePkPrefixBounds(prefixValues)`, then each bound encoded as `encodePkPrefixBounds([...prefixValues, value])`, with the lower/upper swap driven by `pkDirections[prefixValues.length]`.
  - That is exactly `buildIndexRangeBounds`' algorithm. Factor the op/direction table and the max-lower / min-upper fold into one shared helper parameterized by a prefix encoder, instead of keeping a second copy. `buildPkPrefixBounds([])` already returns full-scan bounds, so the leading-range case is the empty prefix.
  - Keep the widen-don't-decline rules: skip a NULL or undefined bound, and skip an unfaithful semantic bound value (`semanticProbeIsKeyFaithful` on `pk[p]`'s logical type).
- `scanPKRange` then iterates the generalized window with `reverse` as today. `matchesFilters` stays the authoritative row filter.

## Docs

- `packages/quereus-store/README.md`, near the "whole primary key" multi-seek paragraph: a leading-prefix equality on the primary key, optionally with a bound on the next member, is served as one primary-key window and provides primary-key order on the remaining members. A partly pinned `IN` still scans.
- Update the doc comments named above (`computeFilterAccessPlan`'s decision list, `NO_PINNED_COLUMNS`, `analyzePKAccess`, `query`'s comment that the secondary arm is reached "only when the predicate did NOT resolve to a PK point/range").

# Edge cases & interactions

- **Secondary index chosen, equality on leading primary-key member** (`ic (a, c desc)`, `where a = 2 order by c`): it must still be served by `ic` in `c` order. This is the wrong-answer risk. Verify with a test (below).
- **Composite secondary index that pins more columns** (`index (a, c)`, `where a = 1 and c = 5`): on an un-analyzed table both arms use the 0.1 shape constant and the primary-key prefix prices lower (no `pointRead`), so it wins and leaves `c = 5` residual. This is acceptable because `ANALYZE` makes the estimates discriminate. Record it as a `NOTE:` at the new arm, alongside the existing `ARM_SELECTIVITY` NOTE. Verify by inspection.
- **Multi-value pins**: `a in (1, 2)` on `(a, b)` gives no prefix arm (scan, as today). On `(a, b, c)`, `a = 1 and b in (1, 2)` gives prefix `[a]` with `b`'s IN residual. A runtime-valued set (`maxCount` 1 included) is multi-value. Verify by inspection; the `scanMultiSeekPrimary` width throw is the assertion that would catch a miss.
- **Collation**:
  - An equality that is coarser than the key (`a = 'x' collate nocase` over a BINARY member) is not pinned (`equalityServesKeyColumn`), so there is no arm.
  - A finer one (BINARY over NOCASE) is pinned, and the rule keeps the seek plus a residual. A trailing bound is then not claimed (`collationsExact`).
  - A bound under a collation other than the member's is not claimed (`rangeServedOn`).
  - Verify by inspection. `access-plan-predicate-collation.spec.ts` is the existing home if one case is worth a line.
- **Order safety**: a trailing bound on a member at or past `pkOrderPreservingPrefix` (a custom collation without `orderPreserving`, or a semantic type outside the allow-list) degrades to the plain prefix. Verify by inspection.
- **DESC members**: the prefix encodes through `pkDirections`. A trailing bound on a DESC member swaps lower and upper. This branching needs an answer-level test (below).
- **Nullable members**:
  - A NULL bound value or parameter is skipped (widen), or windows the NULL group, which `matchesFilters` then rejects.
  - A literal NULL equality never reaches here; the rule emits an empty result.
  - Ordering through a nullable DESC member is cut by `nullSafeOrderingPrefixLength`, with pinned columns exempt.
  - Verify by inspection.
- **Semantic-ordering members (TIMESPAN, JSON)**:
  - An unfaithful probe cuts the prefix at runtime. The window widens, possibly to the whole table, and stays in primary-key order. Rows equal under the type's compare share transformed key bytes and so remain one contiguous group, so the ordering claim survives widening. (A secondary index's widening falls back to the data store instead, which is why that arm carries an ordering NOTE and this one does not.)
  - Verify by inspection, and add one line stating this at the runtime site.
- **Read-your-own-writes and the isolation overlay**: `iterateEffective(store, bounds, reverse)` restricts the pending merge to the same window. The isolation layer re-plans its overlay with the same `_primary_` FilterInfo, which the memory overlay already serves. Verified by the store logic-test run (`yarn test:store`) and the existing `isolated-store.spec.ts`.
- **LIMIT**: `rowsToProduce` prices `where a = ? order by b limit 5` at 5 rows when every filter is claimed. Verify by inspection.
- **Ordering-only walk** (`chooseOrderingPlan`): a prefix plan that already satisfies the required ordering skips the walk comparison. Verify by inspection.
- **Existing tests that pin a full scan** for a composite-key prefix shape will change plan. Update them to the new plan if the old shape was incidental. If such a test was deliberately asserting the scan, read why before changing it.

# Tests

Add one spec, `packages/quereus-store/test/pk-prefix-seek.spec.ts`, following `index-ordering.spec.ts`'s in-memory-provider setup. Use only these cases:

- **Plan level**: for `primary key (a, b)` and filters `[a = 1]`, `getBestAccessPlan` returns `indexName: '_primary_'`, `seekColumnIndexes: [a]`, `handledFilters: [true]`. With `requiredOrdering: [b asc]` it also returns `providesOrdering` equal to the request. With `[a = 1, b > 2]` it returns seek columns `[a, b]` and both filters handled.
- **Plan shape plus answer, the order claim**: `select b from t where a = 2 order by b desc` has no `SORT` in `query_plan`, uses `INDEX SEEK … USING primary`, and returns `b` descending.
- **Preemption guard**: with `create index ic on t (a, c desc)` and `c` values not monotonic in `b`, `select b, c from t where a = 2 order by c` returns `c` ascending (the plan uses `ic` with no Sort). This is the ungated-runtime failure.
- **DESC trailing bound**: `primary key (a, b desc)`, `select b from t where a = 2 and b > 2 order by b desc` returns exactly the `b > 2` rows of `a = 2`, descending.

Then run `yarn workspace @quereus/store test`, `yarn test`, and `yarn test:store`. The last runs the engine's logic tests through the store, and every composite-key prefix query in them now takes the new arm. If it exceeds the 10-minute idle window, note the deferral in the handoff.

# TODO

- Add `pkPrefixPlan` (prefix cut at the first multi-value pin, trailing-bound gates, positional claims, `rangeScan` pricing, pinned-set ordering) and wire it ahead of `leadingPkRangePlan` as the single primary-key window candidate in `computeFilterAccessPlan`.
- Thread `pinnedCols` through `buildPkOrderingAdvertisement`; rewrite the `NO_PINNED_COLUMNS` NOTE.
- Add the `NOTE:` on the un-analyzed composite-secondary-index ranking at the new arm.
- Generalize `PKAccessPattern` and `buildPKRangeBounds` to a prefix window with an optional trailing bound, sharing the bound-folding helper with `buildIndexRangeBounds`.
- Extend `analyzePKAccess`: prefix window gated on the idxStr naming `_primary_`, `prefixLen` honored and validated for `prefixRangeSeek`, prefix cut at an unfaithful semantic probe. Gate the existing leading-range arm on the idxStr not naming a secondary index.
- Update `query`'s and `analyzePKAccess`'s comments and the README paragraph.
- Add `pk-prefix-seek.spec.ts` with the four cases above; fix any existing test whose incidental full-scan expectation changes.
- Run `yarn workspace @quereus/store test`, `yarn test`, `yarn test:store`.
