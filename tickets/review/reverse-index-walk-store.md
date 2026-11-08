description: The persistent store (LevelDB, IndexedDB and the other key-value backends) now answers a descending-order query by reading an ascending index or the primary key backwards instead of sorting the whole table; review the planner claims, the runtime direction threading, and the changed test pins.
prereq: reverse-index-walk-engine-and-memory
architecture: docs/module-authoring.md
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # indexOrderingSatisfies (tri-state), walkOrdering, orderingPrefixSatisfies, walkDirectionFields (+ IndexedDB NOTE), buildPkOrderingAdvertisement (allowReverse), pkMonotonicAdvertisement, buildIndexOrderingAdvertisement, chooseOrderingPlan / buildOrderingWalkPlan
  - packages/quereus-store/src/common/store-table-scan.ts           # query() decodes reverse; full scan, scanPKRange, scanIndex/produceIndexEntries pass it; scanMultiSeek refuses reverse
  - packages/quereus-store/test/index-ordering.spec.ts
  - packages/quereus-store/test/key-set-seek-store.spec.ts
  - packages/quereus-store/README.md                               # new "ORDER BY from key order" paragraph
  - docs/optimizer-rules.md                                         # minmax coverage caveat
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts   # header comment only
----

# Backwards index walks: store backend (review)

Store half of the backwards-walk feature; the engine contract and memory module landed in `reverse-index-walk-engine-and-memory` (see its complete ticket for the contract: reversed descriptor → `reverse=1` in `idxStr`, direction-aware NULL gate).

## What was built

**Planner (`store-module-access-plan.ts`).**
- `indexOrderingSatisfies(tableInfo, request, keyColumns, orderPreservingPrefix, required, pinnedCols)` now returns `'forward' | 'reverse' | undefined`. For each direction (forward first) it builds `walkOrdering(…, reverse)` — the order-preserving prefix cut by `nullSafeOrderingPrefixLength(…, reverse)`, with each column's direction flipped when reversed — and matches it with `orderingPrefixSatisfies` (the old boolean loop, renamed; same equality-pinned skip, `nullsFirst` still declines). One function now serves all three callers: the single-window seek arms, the ordering-only walk, and the primary key.
- `walkDirectionFields(tableInfo, name, direction)` is the only place a reversed descriptor is minted (`reversedIndexDescriptor`). It carries the IndexedDB `NOTE:` (backwards reads step a cursor one request per row; priced like forward; revisit if an unbounded descending read profiles slower than scan-plus-sort).
- `buildIndexOrderingAdvertisement`: a reverse match returns the claim plus the reversed descriptor. With no request it still advertises the forward ordering only.
- `chooseOrderingPlan` / `buildOrderingWalkPlan`: an index matching in either direction is a walk candidate; a reverse walk carries the descriptor. Cost and the cheapest-then-narrowest tie-break are unchanged (an index yields at most one direction, forward preferred).
- `buildPkOrderingAdvertisement(…, allowReverse = true)`: a required ordering that is the flipped prefix of the primary key is claimed with the reversed `_primary_` descriptor, and `monotonicOn.direction` follows the walk (`pkMonotonicAdvertisement`). The primary-key multi-seek arm passes `false`. With no claim, behaviour is as before: forward `monotonicOn`, voided when the leading member is a NULL-reachable DESC column. One structural change: the old code returned `{}` as soon as the forward NULL gate failed on the leading member, which would have hidden a valid reverse claim (`order by a` over a nullable `a desc` key); the reverse attempt now runs first.
- `explains` gets a ` (reverse walk)` suffix on every arm that claims one.

**Runtime (`store-table-scan.ts`).** `query()` decodes `reverse` once (`idxStrWalksReverse`) and passes it to the full scan (where an ordering-only `_primary_` walk lands), `scanPKRange`, and `scanIndex` → `produceIndexEntries` → `iterateEffective(…, reverse)`. The multi-seek window producer passes `false`. `scanMultiSeek` throws `INTERNAL` (via `multiSeekMalformed`) on a `reverse=1` idxStr, for both the primary and secondary arms.

## Use cases to validate

Checked by hand with a throwaway probe (deleted) against the bare store module and the isolated store module (`createIsolatedStoreModule`), 120 rows; all answers were correct and every shape below had no Sort:
- `order by c desc limit 6` over `index (c)` → `INDEXSCAN … t_c ORDER BY 1 DESC`, ties in reverse primary-key order (118, 111, 104, …).
- `order by id desc limit 3` → `INDEXSCAN … _primary_ ORDER BY 0 DESC`.
- `where k = 1 order by r desc` over `(k, r)` → index seek `ORDER BY 3 DESC`.
- `where id <= 100 order by id desc limit 5` → PK range seek `ORDER BY 0 DESC` → 100…96.
- `max(c)` (NOT NULL `c`, ascending index) and `max(id)` → `LIMIT 1` over a backwards walk.
- nullable `val` with `index (val desc)`, `order by val` (100 rows) → backwards walk, NULLs first.
- Inside `begin … commit` after an insert, a key-moving update of `c` and a delete: the four shapes above, bare and isolated, all correct and still walked backwards.
- Still sorts, as designed: `where id in (5, 3, 9) order by id desc` (PK multi-seek), `where c in (1, 2) order by c desc` (secondary multi-seek).

## Tests

Added (both in `index-ordering.spec.ts`, plan level):
- "a nullable ASC column read backwards claims only under a NULL-excluding bound" — the reverse NULL gate: bare `desc` declines with no descriptor; `desc` under `gt(…)` claims with `reverse: true`.
- "an ascending primary key read backwards claims with the reversed _primary_ descriptor" — claim, descriptor name and `reverse`, and `monotonicOn` flipped to `desc`.

Existing pins changed because the behaviour changed (please sanity-check each still tests what its name says):
- `index-ordering.spec.ts`, plan level: "declines a direction mismatch rather than reversing the walk" became "serves a fully flipped ordering by walking the window backwards"; "DESC index column: claims order by k desc, declines order by k" (collation describe) and "DESC index column: walks order by n desc, declines order by n" (walk describe) now assert the reversed claim for the ascending request.
- `index-ordering.spec.ts`, answer level: "DESC index: order by n desc elides the Sort; order by n keeps it" now asserts both elide (seek, no Sort, same rows); "DESC index: NOT NULL column walks; nullable column keeps its Sort" now asserts `order by n` over `(n desc)` is an index scan with no Sort and the full ascending answer.
- `key-set-seek-store.spec.ts` › "a DESC primary key seeks, emits descending, and keeps its own `order by`": `order by pk asc` over a DESC key used to keep a real Sort; the backwards walk now absorbs it, and the key-set seek branch re-sorts because the multi-seek is forward (`seekPreservesTargetOrder` false). Asserts no Sort, answer `[1, 3, 4]`, and that the multi-seek is still taken. This is the store twin of the memory pin the prereq changed in `key-set-seek.spec.ts`.
- `plan-time-limit.spec.ts` and `expected-latency-plan.spec.ts` needed no change.

## Known gaps / judgment calls for the reviewer

- **No test for the reverse multi-seek assertion.** Nothing in the planner produces it, and SQL cannot reach it; same treatment as the prereq's `createPlanSeqScan` assertion.
- **Index-window decline still falls to the data-store scan.** If `analyzeIndexAccess` declined a window under a claimed index ordering (forward or reverse), `query()` full-scans the data store in primary-key order, which is the wrong order either way. The planner and the scan gate on the same helpers so this should not happen; it is unchanged by this ticket, and passing `reverse` there neither helps nor hurts.
- **`supportsAsofRight` on a reversed primary-key claim** is kept `true` with `monotonicOn` in the walk's direction, mirroring the memory module's `buildMonotonicAdvertisement`. The asof probe asks for ascending order, so on a DESC primary key the store now claims a backwards walk where it previously claimed nothing. Not tested.
- **`ruleMinMaxIndexBoundary` on a nullable column** still declines on a backend with costly row reads, because its `IS NOT NULL` filter is unclaimed (backlog `feat-store-claim-is-not-null-seek-bound`). The caveat in docs/optimizer-rules.md and the rule header now say that rather than "the store walks forwards only".
- **README:** the prefix-range paragraph said "No ordering is advertised for this path", which was already stale before this ticket (`prefixRange` claims, pinned in `index-ordering.spec.ts`). Replaced it with a paragraph on ordering claims that covers backwards walks and lists what still sorts.
- `store-module-access-plan.ts` is now 1,749 lines (`wc -l`; 1,650 before this ticket). Already tracked by backlog `debt-oversized-source-files`; the new measurement is appended there rather than filed.

## Validation runs (all passing)

- `yarn workspace @quereus/store typecheck` (source + tests) and `yarn workspace @quereus/store test` (1991 passing).
- `yarn workspace @quereus/quereus lint`.
- `yarn test:store` (11109 passing, 33 pending), after rebuilding `@quereus/quereus` and `@quereus/store` `dist`; it runs the prereq's `10.5.3-desc-index-ordering.sqllogic` (NULL section, prefix equality, composite-PK range at the bound, in-transaction block) against the store.
- `yarn test` across all workspaces.
- `yarn docs:check`.
