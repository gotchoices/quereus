description: A query that filters with "in (select ...)" and sorts by an indexed column can read the whole table when a few direct lookups followed by a sort would do. The fix lets the lookups run and sorts their results at run time, and keeps the ordered read for the cases where it is cheaper.
architecture: docs/optimizer-rules.md
files:
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts # new order-restoring predicate, ordering claim, cost line on the pushdown
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts # buffers and sorts on the seek branch only
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts # removes both ordering declines on the hash arm; NOTE and header need rewriting
  - packages/quereus/src/planner/rules/access/rule-key-set-seek-row-bound.ts # new rule for phase 2 (name is a suggestion)
  - packages/quereus/src/planner/optimizer.ts # registers the new rule
  - packages/quereus/src/planner/rules/shared/access-leaf.ts # rebuildChain is reusable; the peel only ends at access leaves
  - packages/quereus/src/util/comparison.ts # createTypedOrderByComparator, the comparator emitSort uses
  - packages/quereus/test/optimizer/key-set-seek.spec.ts # two decline tests change meaning
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts # seek/scan and row-count assertions live here
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic # runs on both backends; its comment at about line 108 goes stale
  - packages/quereus-store/test/key-set-seek-store.spec.ts # header comment goes stale
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts # comment at about line 101 goes stale
  - docs/optimizer-rules.md # ruleKeySetSeek entry
  - docs/optimizer.md # "Where an IN (SELECT ...) predicate ends up"
  - docs/optimizer-retrieve.md # orderingLoadBearing bullet, about line 286
repro: verified
----

Found while reviewing `bug-table-alias-defeats-sort-absorption`. That fix gave aliased tables the plan unaliased tables already had, so this problem now reaches more queries. Answers are correct in every case. Only the amount of work differs.

## Reproduction

```sql
create table big (id integer primary key, c integer not null, v integer not null);
create index big_c on big(c);
create index big_v on big(v);
-- 2000 rows, with v falling as id rises, so low ids sit at the end of the v index
insert into big select value, value % 50 + 1, 2000 - value from generate_series(1, 2000);
create table small (bid integer primary key);
insert into small values (1), (2), (3);
```

Rows read from `big` on the memory backend, from `stmt.getWorkCounters().tables['main.big'].rowsScanned` with the `runtime_metrics` option on. "Prototype" is phase 1 below, applied to the built JavaScript through a throwaway load hook. No repository source was changed for it.

| Query | Current code | Prototype |
|---|---|---|
| `select id from big b where b.id in (select bid from small) order by b.v` | 2000 | 3 |
| `... order by b.v limit 2` | 1999 | 3 |
| `... where b.c in (select bid from small) order by b.v` | 2000 | 120 (all matching rows) |
| `... where exists (select 1 from small s where s.bid = b.id) order by b.v` | 2000 | 3 |
| `select min(b.v) from big b where b.id in (select bid from small)` | 1998 | 3 |
| `select id from big where id in (select bid from small) order by v` | 2000 | 3 |
| `select min(v) from big where id in (select bid from small)` | 1998 | 3 |
| `... where v >= 5 and id in (select bid from small) order by v`, with `small` analyzed | 1995 | 3 |

The last row is the seek-leaf arm of the same decline. If `small` has never been analyzed, a filtered target chooses an index-nested-loop semi join instead and `rule-key-set-seek` never sees it. That is the separate existing `NOTE:` in the rule's header, and it stays out of scope.

## Cause

`trySortAbsorbViaIndexOrdering` runs while the subquery is still a scalar expression inside a Filter. It drops the Sort and marks the leaf `orderingLoadBearing`. Decorrelation later turns the subquery into a semi join. `rule-key-set-seek` then declines, because a multi-seek on a different index would not produce the order the leaf now has to provide, and nothing can put the Sort back. The result is a full index walk with a hash probe.

## Design

Whether the key set is small enough to seek is only known at run time, after the key source is drained. So the choice between "ordered walk" and "seek, then sort" belongs in the same run-time decision `KeySetSemiJoinNode` already makes, not in a plan-time choice.

### Phase 1: the seek branch restores the order

`seekPreservesTargetOrder` stays as it is. Add a sibling next to it:

```ts
/** The leaf's order is required and a multi-seek would not produce it, so the seek branch must sort. */
export function seekRestoresTargetOrder(target: KeySetTargetNode, pushdown: KeySetPushdown): boolean;
// target is not a SeqScanNode, target.orderingLoadBearing, target.providesOrdering is non-empty,
// and !seekPreservesTargetOrder(target, pushdown)
```

Derive it where it is used, as `computePhysical` already does for `seekPreservesTargetOrder`. Do not store a flag, for the reason the comment there gives: a leaf rebuilt through `withChildren` must not leave a stale answer.

- **Emitter.** When the predicate holds and the runtime chose to seek, buffer the probed rows, sort them, then yield them. The scan branch streams exactly as it does today, so a LIMIT above it still stops early.
- **Comparator.** One entry per `target.providesOrdering` element, built as `emitSort` builds its own: `createTypedOrderByComparator(attr.type.logicalType, desc ? 'desc' : 'asc', undefined, ctx.resolveCollation(attr.type.collationName || 'BINARY'))`, where `attr` is `targetAttributes[o.column]`. A leaf's attributes line up one-to-one with table columns. The absorb step has already refused explicit NULLS clauses and collation mismatches, so this comparator agrees with the walk.
- **Physical claim.** Under the new predicate claim `ordering`, since both branches now deliver it. Do not claim `monotonicOn` on this arm: nothing needs it, and dropping it can only lose an optimization. `accessCapabilities` stays dropped.
- **Rule.** Remove the walk-arm decline in `ruleKeySetSeek` and gate 5 in `admitSeekLeaf`. On a seek leaf, the Filter that re-applies the pushed predicate sits above the node and keeps row order, so it needs no change. Keep the merge arm's `seekPreservesTargetOrder` gate as it is: no measured query needs it relaxed.

The prototype's output matched a real Sort exactly (same query with `order by x.n + 0`) on a nullable integer with NULLs, `collate nocase` text with mixed case, a descending index, and a composite `(a, b)` index ordered by `a` and by `a, b`. A `timespan` index, with no such control query, produced values in semantic order, with `PT1H` and `PT60M` interleaved as ties.

### Phase 2: a LIMIT above the node can favour the ordered walk

Phase 1 alone makes some queries worse. It seeks whenever the key count is at or below the break-even, and on the memory module that break-even is 1000 whatever the table size. With 1000 evenly spread keys in 2000 rows, `order by b.v limit 1` reads 2 rows today (measured) and 1000 under the prototype (measured).

A walk stopped after `L` matches reads about `L * N / K` rows when `K` keys are spread evenly over `N` rows. On a unique key, a seek reads `K`. The crossover is near `K = sqrt(L * N)`, which is well below the current break-even.

Decide this from the module's own costs, the same way the break-even is decided. Then no row count has to be known, and no second cost model appears:

- Keep the cost line on `KeySetPushdown`: the seek cost at 2 keys, the slope, and the baseline cost `interpolateBreakEven` already computes.
- Add a PostOptimization rule anchored on `LimitOffset`, registered after the two `key-set-seek` entries. The pass runs bottom-up, so the join has already been rewritten when the limit is visited.
- The rule walks `LimitOffset.source` down through Alias, Project and Filter to a `KeySetSemiJoinNode`, and declines at anything else. It requires `seekRestoresTargetOrder` and a literal numeric LIMIT. OFFSET must be a literal number or the literal null that `rule-minmax-index-boundary` writes, and any other OFFSET declines. The bound is `L = limit + offset`.
- It rebuilds the node with `breakEvenKeys` lowered to the largest `K`, no greater than the current value, where `(seekAt2 + slope * (K - 2)) * K <= baselineCost * L`. Use `rebuildChain` for the wrappers. The left side of the inequality is the seek's cost, multiplied through by `K` from `seekCost <= baselineCost * L / K`.
- It leaves a node alone when `seekPreservesTargetOrder` holds. That seek streams in walk order and stops as early as the walk does, so a LIMIT gives no reason to walk.

This has not been prototyped. Worked by hand against the measured memory costs (seek cost `0.3 * K + 0.5`, baseline `N` when analyzed and 1000 when not) for `N` in 2000 and 20000, `K` in 10, 50, 100, 300 and 1000, `L` in 1 and 10, analyzed and not, the gate picks the lower read count, or misses by at most 2.2 times (`N = 20000` never analyzed, `K = 300`, `L = 10`: walk about 667 against seek 300). Examples, analyzed:

| N | K | L | Walk reads (`L * N / K`) | Seek reads | Gate picks |
|---|---|---|---|---|---|
| 2000 | 3 | 2 | 1334 | 3 | seek |
| 2000 | 100 | 1 | 20 | 100 | walk |
| 2000 | 1000 | 1 | 2 | 1000 | walk |
| 20000 | 100 | 1 | 200 | 100 | seek |
| 20000 | 300 | 1 | 67 | 300 | walk |
| 20000 | 300 | 10 | 667 | 300 | seek |

The walk column assumes evenly spread keys. The measured walk reads for the even-spread rows in the first sweep matched this formula (`N = 2000`, `K = 100`: 20 for `limit 1`, 200 for `limit 10`). When matches cluster at the far end of the walk, the walk costs more than the estimate, and the worst result is today's full walk.

### Alternatives rejected

- **Leave the Sort in place when the Filter holds a subquery.** The Sort then also sits above the walk when the key set is too large to seek, so a LIMIT reads and sorts the whole table. It also penalizes filters that never become seeks (no usable index, correlated subquery).
- **Put a SortNode above the new node at plan time.** Same loss on the scan branch, and it would sort rows that are already in order.
- **Walk first, then switch to seeking after a budget of rows.** No plan-time limit needed, but rows already emitted would have to be skipped in the sorted seek output, which needs per-row identity tracking and two cursors. Too much machinery for this gap.

## Accepted limits

Record these as `NOTE:` comments at the sites named. They are conditions to watch, not work to do.

- `interpolateBreakEven`: the break-even does not charge for the sort, or for buffering matched rows in memory. A seek's cost does not reflect window size on the memory module, so a key set matching most of a low-cardinality column can buffer and sort most of the table, where the walk streamed it. The Sort this replaces buffered the same rows. Revisit if this shows up in a memory profile.
- The new row-bound rule: the spread assumption is an estimate, and a Filter between the limit and the node makes the walk read more than estimated. Either error costs reads, never a row, and is bounded by today's full walk. Revisit if a measured query picks badly.

## TODO

Phase 1:

- Write the failing test first: in `key-set-semi-join-runtime.spec.ts` or `key-set-seek.spec.ts`, use the fixture above with `runtime_metrics` on and assert both `rowsScanned` and row order for the aliased, unaliased, `exists`, `min` and non-unique (`b.c`) forms in one table-driven test.
- Add `seekRestoresTargetOrder` and the `ordering` claim to `key-set-semi-join-node.ts`. Add the predicate to `getLogicalAttributes` as `restoresTargetOrder` so plans show it.
- Add the buffered sort to `emitKeySetSemiJoin`, seek branch only.
- Remove both declines in `rule-key-set-seek.ts`. Rewrite the header's decline list, the `admitLeaf` and `admitSeekLeaf` comments, and the `NOTE:` that names this ticket. Backlog `debt-seek-leaf-admission-gates-duplicated` says "five gates" for this function, so update it to four.
- Replace `declines when the leaf order absorbed the Sort (ORDER BY pk)` in `key-set-seek.spec.ts`: the node now fires, no Sort appears, and rows still arrive sorted. Do the same for `declines an absorbed-Sort seek leaf (orderingLoadBearing)`, keeping its check of the re-applied Filter and of `['a', 'm', 'x']`. Keep the `ORDER BY on the seek column itself` and merge-arm tests unchanged.
- Add one scan-branch test using the doctored break-even module in `key-set-semi-join-runtime.spec.ts`: above the break-even, the runtime takes the ordered walk with no buffering, and rows are still in order.
- Add an order check to `08.4-key-set-semi-join.sqllogic` covering NULLs, `collate nocase`, a descending index and a composite index, so both backends run it. Fix the stale comment there and the ones in the store and isolation specs, and re-check any 08.4 case that claimed to exercise the surviving hash join.

Phase 2:

- Keep the cost line on `KeySetPushdown` and write the row-bound rule and its registration, with a comment on the registration explaining the order.
- Add two tests: 3 keys with `limit 2` seeks and reads 3 rows, and 1000 evenly spread keys in 2000 rows with `limit 1` walks and reads a few rows (2 measured today).
- Check `min` over a nullable column: the `Filter(is not null)` sits between the LimitOffset and the node, and must still get the bound.

Finish:

- Update the `ruleKeySetSeek` entry and add the new rule in `docs/optimizer-rules.md`, the key-set paragraph in `docs/optimizer.md`, and the `orderingLoadBearing` bullet in `docs/optimizer-retrieve.md`, which says a rewrite "must decline".
- Add the two `NOTE:` comments listed under Accepted limits.
- Run `yarn test`, `yarn lint`, and `yarn test:store`, since seek branches now run under ORDER BY on the store and isolation paths for the first time on secondary indexes.
