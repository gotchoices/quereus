description: Let the persistent store (LevelDB, IndexedDB and the other key-value backends) answer a descending-order query by reading an ascending index or the primary key backwards, instead of sorting the whole table.
prereq: reverse-index-walk-engine-and-memory
architecture: docs/module-authoring.md
files:
  - packages/quereus-store/src/common/store-module-access-plan.ts   # buildPkOrderingAdvertisement, buildIndexOrderingAdvertisement, indexOrderingSatisfies, chooseOrderingPlan, buildOrderingWalkPlan
  - packages/quereus-store/src/common/store-table-scan.ts           # query(): full-scan, scanPKRange, scanIndex/produceIndexEntries pass `reverse`
  - packages/quereus-store/src/common/store-table-base.ts           # iterateEffective / mergeWithPending already take `reverse` — no change expected
  - packages/quereus-store/test/index-ordering.spec.ts              # two "no reverse walk" pins flip
  - packages/quereus-plugin-indexeddb/src/store.ts                  # readBatch NOTE on per-row reverse reads (read, do not change)
  - packages/quereus-store/README.md
  - docs/optimizer-rules.md                                         # minmax coverage caveat — finish what the prereq started
----

# Backwards index walks: store backend

## Context

`reverse-index-walk-engine-and-memory` (prereq) defines the contract this ticket implements for the store module:

- a module serves a required ordering by reversing an index when, after skipping equality-pinned columns, every matched index column has the opposite direction from the request (all flipped; a partial flip is not a reverse);
- it says so by returning `indexDescriptor: reversedIndexDescriptor(tableSchema, indexName)` alongside the claim;
- the engine then puts `reverse=1` in `idxStr`, read at runtime with `idxStrWalksReverse(decodeIdxStr(idxStr))`;
- `nullSafeOrderingPrefixLength(…, reverse)` gates NULL placement on the effective direction (`!!col.desc !== reverse`).

Read that ticket's Design section (now in `tickets/complete/` or `review/`) before starting; the memory module's `indexSatisfiesOrdering` is the reference implementation of the matching rule.

The store has every runtime piece already. Every `KVStore.iterate` backend accepts `reverse` (LevelDB, IndexedDB, React Native LevelDB, NativeScript SQLite, the in-memory store), `pagedIterate` handles reverse resume edges, and `StoreTableBase.iterateEffective(store, bounds, reverse)` merges this transaction's pending writes in reverse byte order (tested directly in `store-ryow.spec.ts` § "iterateEffective (direct merge harness)"). Unlike the memory B-tree, the store addresses windows as byte ranges `[gte, lt)`, which are direction-agnostic, so it has no start-of-group positioning problem: the same window iterated with `reverse: true` yields exactly the reverse of the forward read, primary-key suffix within one index value included (index keys are `{index columns}{PK}` bytes). That is the order the isolation overlay merge expects for `reverse: true`.

## Design

### Planner (`store-module-access-plan.ts`)

- `indexOrderingSatisfies` returns `'forward' | 'reverse' | undefined`, mirroring memory's `indexSatisfiesOrdering` (same equality-pinned skip, same all-or-nothing direction agreement, `nullsFirst` still declines).
- The NULL gate depends on direction, so each caller computes the claimable prefix per direction: `nullSafeOrderingPrefixLength(…, reverse=false)` for the forward attempt and `(…, reverse=true)` for the reverse attempt, each followed by the matching check. Forward is tried first.
- `buildIndexOrderingAdvertisement` (single-window seek arms): with a `requiredOrdering`, a reverse match returns `{ providesOrdering: required, orderingIndexName, indexDescriptor: reversedIndexDescriptor(...) }`; widen its return `Pick` to include `indexDescriptor`. With no request, the bare advertisement stays forward — never advertise reverse unasked. Replace the "Never reversed … the store has no reverse secondary-index walk" paragraph.
- `chooseOrderingPlan` / `buildOrderingWalkPlan` (ordering-only walk of a secondary index, `plan=0`): try both directions per index; a reverse walk carries the reversed descriptor. Same cost as the forward walk; keep the existing cheapest-then-narrowest tie-break (forward candidates of an index are considered before its reverse).
- `buildPkOrderingAdvertisement`: when the required ordering is the exact element-wise reverse of a prefix of the (order-preserving, reverse-NULL-gated) primary key, claim it with `indexDescriptor: reversedIndexDescriptor(tableInfo, '_primary_')`, `orderingIndexName: '_primary_'`, and `monotonicOn.direction` flipped to the leading member's effective direction. Add a parameter so a caller can disallow the reverse claim, and pass it from the primary-key **multi-seek** arm (the `return` at the end of `primaryKeyMultiSeekPlan`): `scanMultiSeekPrimary` sorts its points ascending by encoded key and has no reverse mode. The full-scan arm and the leading-PK range arm allow reverse. When the request does not match in either direction, behaviour is unchanged (forward `monotonicOn`, no claim).
- `orderingAlreadySatisfied` compares claims only; no change.
- Leave a `NOTE:` at the reverse-claim cost site: a backwards walk is priced like a forward one, but IndexedDB reads backwards by stepping a cursor one request per row instead of its batched forward read (see the NOTE in `quereus-plugin-indexeddb/src/store.ts` `readBatch`, unmeasured); if an unbounded backwards walk on IndexedDB profiles slower than scan-plus-sort, add a reverse-read ratio to `KVCostProfile` or batch the reverse read as that NOTE describes. Under a LIMIT (the motivating "newest N" and `max(c)` shapes) the walk reads only N entries, so this matters only for unbounded descending reads.

### Runtime (`store-table-scan.ts`)

Decode `reverse` once in `query()` (`idxStrWalksReverse(idxSpec)`), and thread it to every multi-row arm:

- full table scan (an ordering-only `_primary_` walk lands here, since `resolveIndexFromIdxStr` returns null for `_primary_`): `iterateEffective(store, bounds, reverse)`;
- `scanPKRange`: same;
- `scanIndex` → `produceIndexEntries` → `iterateEffective(indexStore, bounds, reverse)`, for the `plan=0` walk, the prefix point window and both range windows. `resolveIndexEntries` / `resolveRowBatch` already preserve entry order.
- PK point lookup: one row, ignore.
- Multi-seek (`plan=5`, primary or secondary) with `reverse`: neither backend's planner produces this; fail loudly via `malformedFilterInfo` rather than return forward order under a reverse claim.

## Edge cases & interactions

- **Read-your-own-writes inside a transaction**: pending puts/deletes merge in reverse via `mergeWithPending` (already tested). End to end it is covered by the in-transaction case the prereq adds to `10.5.3-desc-index-ordering.sqllogic`, which `yarn test:store` runs against the store behind the isolation layer.
- **Isolation overlay merge**: reads `accessPath.index.reverse`, which the engine fills from this module's descriptor. Same sqllogic case.
- **DESC-declared columns** (bit-inverted bytes): a reverse walk of a DESC column is an ascending read with NULLs first — the reverse NULL gate allows it on a nullable column; verify by the sqllogic answers from the prereq (NULL section) under `yarn test:store`.
- **Collation / semantic types**: the order-preserving prefix (`indexOrderPreservingPrefixLength`, `pkOrderPreservingPrefixLength`) is symmetric under reversal; apply it before the direction match exactly as forward does. By inspection.
- **Equality-pinned prefix** (`where k = 1 order by r desc` over `(k, r)`): the `point` window `[P, incr(P))` iterated backwards. Covered by the sqllogic prefix-equality case.
- **Leading-PK range + reverse** (`where id <= 100 order by id desc limit 10`): `buildPKRangeBounds` window iterated backwards.
- **Multi-seek arms**: never reverse (planner parameter above; runtime assertion).
- **`ruleMinMaxIndexBoundary`**: `max(c)` over an ascending index now fires on the store for a NOT NULL column. A nullable column still declines on the store because the rule's `IS NOT NULL` filter is unclaimed (backlog `feat-store-claim-is-not-null-seek-bound`) — unchanged by this ticket. Update the coverage caveat in `docs/optimizer-rules.md` and the rule's header comment to say both backends walk backwards.
- **`plan-time-limit.spec.ts` / `expected-latency-plan.spec.ts`**: may pin plans that now change; update a pin only where the new plan is the intended reverse walk, and say which in the handoff.

## Tests (keep to these)

- `index-ordering.spec.ts`: flip the two pins that assert no reverse walk (`planFor('t1', [gt(1, 900)], [desc(1)])` "no reverse secondary-index walk exists", and `planFor('t4', [], [asc(1)])` "no reverse walk") to assert the claim plus `indexDescriptor.reverse === true`; add one case for the primary key (`order by id desc` claims with a reversed `_primary_` descriptor) and one for the reverse NULL gate (nullable ascending column: bare `desc` declines, `desc` under `gt(…)` claims).
- No new runtime test: the reverse merge is already covered in `store-ryow.spec.ts`, and the answers are covered by the prereq's sqllogic under `yarn test:store`.

## TODO

- `indexOrderingSatisfies` tri-state; per-direction NULL gate in its callers.
- `buildIndexOrderingAdvertisement` reverse claim + descriptor; widen return type; rewrite the "Never reversed" doc paragraph.
- `chooseOrderingPlan` / `buildOrderingWalkPlan` reverse candidates with descriptor.
- `buildPkOrderingAdvertisement` reverse claim, flipped `monotonicOn`, allow-reverse parameter (false from the PK multi-seek arm).
- Cost-site `NOTE:` about IndexedDB per-row reverse reads.
- `store-table-scan.ts`: decode `reverse` in `query()`; pass it through full scan, `scanPKRange`, `scanIndex`/`produceIndexEntries`; `malformedFilterInfo` on reverse multi-seek.
- Update `index-ordering.spec.ts` as above; fix any other plan pins that now pick the reverse walk.
- Docs: `packages/quereus-store/README.md` (ordering claims may be served by a backwards walk), `docs/optimizer-rules.md` minmax caveat, minmax rule header.
- Run `yarn workspace @quereus/store test`, `yarn test` (all workspaces), `yarn test:store`, and `yarn workspace @quereus/quereus lint`.
