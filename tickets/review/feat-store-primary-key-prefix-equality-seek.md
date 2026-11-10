description: On the persistent storage backend, a query that fixes only the first part of a multi-column primary key (for example every line of one order) now reads just the matching rows instead of the whole table, and can return them already sorted by the rest of the key. Review the new planner choice and the matching read path.
architecture: docs/module-authoring.md
files: packages/quereus-store/src/common/store-module-access-plan.ts (`pkPrefixPlan`, `computeFilterAccessPlan`, `buildPkOrderingAdvertisement`, `NO_PINNED_COLUMNS`), packages/quereus-store/src/common/store-table-scan.ts (`analyzePKAccess`, `pkEqualityRun`, `pkPrefixWindow`, `pkPrefixRangeSeekLength`, `pkRangeAtPositionIsOrderSafe`, `buildPKRangeBounds`, `buildIndexRangeBounds`, `foldRangeWindow`, `PKAccessPattern`), packages/quereus-store/test/pk-prefix-seek.spec.ts, packages/quereus-store/test/pushdown.spec.ts, packages/quereus-store/README.md, docs/store.md
----

# What changed

For `create table t (a integer, b integer, v text, primary key (a, b)) using store`, `where a = 1` used to plan a full scan with a residual Filter. It now plans one contiguous read of the data store over the rows whose key starts with `a = 1`. `where a = 1 and b > 2` adds the bound on `b` to that window. Both claim `order by b` and `order by b desc` with no Sort.

## Planner (`store-module-access-plan.ts`)

- New `pkPrefixPlan` builds a `_primary_` candidate:
  - The prefix is the leading equality run from `resolveEqualityPins`, cut at the first multi-value pin (a multi-value `IN` or any runtime-valued set). The cut prefix is re-resolved, so `collationsExact` describes the cut run.
  - The arm applies only when the prefix length `p` satisfies `1 ≤ p < pk.length`.
  - A trailing bound on `pk[p]` needs all of: no cut, a collation-exact prefix, `pkOrderPreservingPrefix > p`, and `rangeServedOn(filters, pk[p])`. If any fails, the arm stays a plain prefix seek and the bound stays residual.
  - **Gate the ticket did not list:** the bound is refused when the cut landed at `p`. In that case `pk[p]` carries a multi-value `IN`, and the rule's `eqBySeekCol` (it picks any equality on a column it considers handled) would read it as an equality seek column. It would then build a `_primary_` multi-seek of width `p + 1 < pk.length`, which `scanMultiSeekPrimary` throws on. I found this by reasoning, not by running it.
  - Claims are positional (`claimFirstPerRole`). Seek columns are in primary-key order. Pricing is `rangeScan(rowsToProduce(...), 0.2)` with no `pointRead`, and there is no veto. Rows come from `resolveArmEstimate('eq' | 'prefixRange', prefixCols, boundCol)`.
  - The ordering advertisement passes the prefix as pinned columns.
- `computeFilterAccessPlan`: `pkWindowPlan = pkPrefixPlan(...) ?? leadingPkRangePlan(...)` replaces `pkRangePlan` at every use, with the same ranking rules.
- `buildPkOrderingAdvertisement` gained a `pinnedCols` parameter (default `NO_PINNED_COLUMNS`), threaded into both `indexOrderingSatisfies` and `walkOrdering`.
- Doc comments were updated: the file header, the decision list, the `ARM_SELECTIVITY` note, the `NO_PINNED_COLUMNS` NOTE (rewritten; the primary-key half is now settled) and `orderingPrefixSatisfies`.
- A `NOTE:` at `pkPrefixPlan` records the composite-secondary-index ranking. On an un-analyzed table, `index (a, c)` with `a = 1 and c = 5` loses to the primary-key prefix, which leaves `c = 5` residual. `ANALYZE` fixes it.

## Runtime (`store-table-scan.ts`)

- `PKAccessPattern` is now a discriminated union: `point { values }`, `range` (`PKWindowAccess { prefixValues, constraints }`), and `scan`. A `range` with an empty prefix is the old leading-member range.
- `analyzePKAccess` tries three arms in order:
  1. The full-key point. It is ungated, and its logic is unchanged apart from moving into `pkEqualityRun`.
  2. Only when `decodeIdxStr(idxStr).indexName` is `_primary_` (compared case-insensitively): `pkPrefixWindow`. It cuts the run at the first unfaithful semantic probe and returns null if the run is empty. For `plan=7` it reads `prefixLen` from the idxStr: `pkPrefixRangeSeekLength` throws `malformedFilterInfo` when the value is outside `1 … pk.length-1`. The bound is attached only when `prefixLen ≤ run length` and `pkRangeAtPositionIsOrderSafe(prefixLen)`; otherwise the plain prefix window is served.
  3. Then, only when `resolveIndexFromIdxStr(idxStr) === null`: the leading-member range.
- `leadingPkRangeIsOrderSafe()` became `pkRangeAtPositionIsOrderSafe(position)`.
- `buildPKRangeBounds` and `buildIndexRangeBounds` now both call one module-level `foldRangeWindow`, parameterized by a prefix encoder. It holds the op/direction table, the max-lower / min-upper fold, and the widen-don't-decline skips.
- The comment in `query` about when the secondary-index arm is reached was updated.

## Docs

- The `packages/quereus-store/README.md` IN-list section has a new primary-key prefix paragraph. The "primary-key arms take precedence" sentence is corrected: primary-key windows compete with secondary seeks on cost.
- The `docs/store.md` access-pattern table has a new row, and the ranking paragraph now covers prefix windows.

# Tests

New spec, `packages/quereus-store/test/pk-prefix-seek.spec.ts`. It has four cases:

- **Plan level:** `[a = 1]` gives `_primary_` with seek columns `[a]`, handled `[true]`. With `requiredOrdering [b asc]` the plan provides exactly that ordering. `[a = 1, b > 2]` gives seek columns `[a, b]` with both filters handled.
- **Order claim:** `select b from t where a = 2 order by b desc` has no Sort, uses `INDEX SEEK t USING primary`, and returns `[3, 2, 1]`. This exercises a backwards walk of the prefix window.
- **Preemption guard:** `ic (a, c desc)` on 1200 rows (`a ∈ {1,2}`, `c` scrambled against `b`), followed by `analyze t`. `select b, c from t where a = 2 order by c` must plan `USING ic` with no Sort and return 600 rows with `c` ascending.
  - I confirmed it catches the failure it exists for: with the `_primary_` gate in `analyzePKAccess` removed, this case fails with `c` out of order; with the gate restored it passes.
  - The table size and `ANALYZE` are what make `ic` outrank the primary-key window plus a sort. By the cost formulas the primary-key window ranks about 854 and `ic` about 780. If the cost constants move, the "must choose ic" assertion fails rather than letting the test pass while guarding nothing.
- **DESC trailing bound:** `primary key (a, b desc)` with `where a = 2 and b > 2 order by b desc` returns `[4, 3]`, has no Sort, and uses `primary`. This exercises the lower/upper swap for a DESC member.

Changed test: `pushdown.spec.ts`'s `RangeBoundsProbe` now uses the new `buildPKRangeBounds` argument shape (`prefixValues: []`, no `columnIndex`). The assertion itself is unchanged.

No existing test pinned a full scan for a composite-key prefix shape; nothing else needed changing.

# Validation run

- `yarn workspace @quereus/store test`: 2016 passing.
- `yarn test` (all workspaces): no failures (quereus 11143 passing / 26 pending, store 2016, sync 878, and the rest).
- `yarn test:store`:
  - **First run:** bailed after 3606 passing on one `Timeout of 30000ms exceeded` in `01.9-query-expr-dml.sqllogic` (fuzz seed 3574562973). The runner passes `--bail`, which is why the run stopped there.
  - **Two full re-runs:** 11136 passing / 33 pending, no failures. One of them used the same seed (`QUEREUS_FUZZ_SEED=3574562973`).
  - **That file alone in store mode:** about 0.7 s.
  - Each logic file gets a fresh database and LevelDB directory, so earlier files cannot leave state behind. I read it as a one-off I/O or load stall and did not file `.pre-existing-error.md`, because it did not reproduce. If the reviewer sees it again, it deserves a real look.
- Type checks: `tsc --noEmit` and `tsc -p tsconfig.test.json --noEmit` in `packages/quereus-store` are clean. The store package's `lint` script is a no-op.

# For the reviewer: checked only by reading the code

- **Multi-value cut:** `a in (1,2)` on `(a, b)` gives no arm. On `(a, b, c)`, `a = 1 and b in (1,2)` gives prefix `[a]` with the `IN` residual. A runtime set with `maxCount` 1 counts as multi-value. Also the new no-bound-after-cut gate above. A direct plan-level case for `a = 1 and b in (1,2) and b > 0` on a three-column key would pin that gate if you think it is worth a test.
- **Collations:**
  - A coarser equality is not pinned.
  - A finer equality is pinned; the rule keeps a residual, and no trailing bound is claimed because `collationsExact` is false.
  - A bound under a different collation is rejected by `rangeServedOn`.
- **Order safety:** a bound at or beyond `pkOrderPreservingPrefix` degrades to the plain prefix in both the planner and the runtime. This is conservative for prefix members that are not order-safe; the code comment says so.
- **Semantic-ordering members (TIMESPAN, JSON):** the runtime cuts the prefix at an unfaithful probe, and the ordering claim survives because rows equal under the type's compare stay contiguous (stated at `pkPrefixWindow`).
- **Nullable DESC members:** handled through `nullSafeOrderingPrefixLength`, with pinned columns exempt.
- **LIMIT:** with every filter claimed, `rowsToProduce` prices the plan at `limit + offset` rows.
- **Ordering-only walk:** `chooseOrderingPlan` returns early when the prefix plan already satisfies the ordering.
- **Isolation overlay:** covered only by the green `yarn test:store` run and the isolation package suite.
- **Leading-range runtime gate:** the arm now runs only when the idxStr names no secondary index. This is hardening; I did not reproduce a wrong answer for the shape it guards.

# Known gaps and tripwires

- **File size:** `store-module-access-plan.ts` is now 2076 lines and `store-table-scan.ts` 1534 lines (`wc -l`). This is relevant to backlog `debt-oversized-source-files`, which already names this planner file.
- **Ranking against a composite secondary index on an un-analyzed table:** recorded as a `NOTE:` at `pkPrefixPlan`.
- **A partly pinned `IN` prefix:** still scans; tracked by backlog `feat-store-primary-key-prefix-in-list-seek`, which lists this ticket as its prereq.
