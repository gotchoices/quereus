description: A query that filters with "in (select ...)" and sorts by an indexed column could read the whole table when a few direct lookups followed by a sort would do. It now does the lookups and sorts their results at run time, and keeps the ordered read for the cases where that is cheaper.
architecture: docs/optimizer-rules.md
files:
  - packages/quereus/src/planner/nodes/key-set-semi-join-node.ts # seekRestoresTargetOrder, ordering claim, KeySetCostLine on the pushdown
  - packages/quereus/src/runtime/emit/key-set-semi-join.ts # buffered sort on the seek branch only
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts # both ordering declines removed on the hash arm; merge arm unchanged
  - packages/quereus/src/planner/rules/access/rule-key-set-seek-row-bound.ts # new rule (phase 2)
  - packages/quereus/src/planner/optimizer.ts # registers the new rule
  - packages/quereus/src/planner/nodes/table-access-nodes.ts # comment only
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts # comment only
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts # comment only
  - packages/quereus/src/planner/rules/shared/index-style-context.ts # comment only
  - packages/quereus/test/vtab/key-set-semi-join-runtime.spec.ts
  - packages/quereus/test/optimizer/key-set-seek.spec.ts
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic
  - packages/quereus-store/test/key-set-seek-store.spec.ts # comment only
  - packages/quereus-isolation/test/key-set-seek-merge.spec.ts # comment only
  - docs/optimizer-rules.md
  - docs/optimizer.md
  - docs/optimizer-retrieve.md
  - docs/optimizer-fd.md
  - tickets/backlog/debt-seek-leaf-admission-gates-duplicated.md # "five gates" corrected to four for rule-key-set-seek
repro: verified
----
**Where the diff is.** An earlier implement run was killed by the runner while lint was still running, and the runner committed its work in `fabd41152`. Read `git show fabd41152` together with this stage's commit, which adds only two comments: the `NOTE:` on parameterized limits in the row-bound rule, and a corrected comment in `rule-grow-retrieve.ts`. Lint had passed in 45 seconds, so lint hanging was not the cause of the kill. An earlier run's log shows its Bash progress stopping for about 40 minutes, which looks like the machine stalling, though I did not confirm that.

## What changed

Sort absorption can drop a Sort in favour of an index walk before decorrelation turns the `in (select ...)` into a semi join. `rule-key-set-seek` then used to decline, because a multi-seek on another index would lose the order the walk now has to provide. The result was a full index walk with a hash probe.

Whether a seek is cheaper is only known once the key source is drained, so that choice stays in the run-time decision `KeySetSemiJoinNode` already makes:

- **Phase 1.** New predicate `seekRestoresTargetOrder`: the leaf's order is load-bearing and non-empty, and a seek would not produce it. When it holds and the runtime seeks, the emitter buffers the probed rows and sorts them with the comparator `emitSort` uses. The scan branch still streams, so a LIMIT above it stops early. The node claims `ordering` but not `monotonicOn`. The predicate is derived where used, never stored. The hash arm's walk-leaf decline and `admitSeekLeaf`'s gate 5 are gone. The merge arm keeps its `seekPreservesTargetOrder` gate.
- **Phase 2.** New rule `ruleKeySetSeekRowBound`, anchored on `LimitOffset`. A literal limit lowers `breakEvenKeys` to the largest `K` where `(seekAt2 + slope * (K - 2)) * K <= baselineCost * (limit + offset)`, using the module's own costs kept on `KeySetPushdown.costLine`. It peels through Alias, Project and Filter, and declines at anything else. It leaves a node alone when `seekRestoresTargetOrder` does not hold, because that seek streams.

## Measured

Rows read from `big` on the memory backend (fixture in the first test below). The "before" column comes from the fix ticket's measurements at the old code. I did not re-measure it.

| Query | Before | Now |
|---|---|---|
| `... b.id in (select bid from small) order by b.v` (aliased, unaliased, `exists`) | 2000 | 3 |
| same, `limit 2` | 1999 | 3 |
| `... b.c in (select bid from small) order by b.v` (non-unique) | 2000 | 120 |
| `min(b.v)`, aliased and unaliased | 1998 | 3 |
| `v >= 5 and id in (...) order by v`, `small` analyzed | 1995 | 3 |
| 1000 evenly spread keys, `order by b.v limit 1` | 2 | 2 (phase 1 alone would read 1000) |

## Validation

- `tsc -b tsconfig.build.json`: clean.
- `packages/quereus` tests: 11046 passing, 26 pending, 0 failing.
- `packages/quereus` tests with `--store`: 11039 passing, 33 pending, 0 failing.
- Every other workspace's `test`, plus `yarn test:scripts`: all pass. I ran these per workspace rather than as one `yarn test`, to stay under the runner's 10-minute limit.
- `yarn lint` in `packages/quereus`: exit 0. It was run before the row-bound `NOTE:`, and re-run on that file afterwards. The other packages' lint scripts are intentional no-ops, so I did not run them.
- Throwaway differential check, not in the repo, memory backend only: 50 query shapes run against two identically loaded tables, one with the ordering indexes and one without, so the second uses a real Sort. There were 0 differences, and 28 of the 50 went through the order-restoring path. Shapes included NULLs in both directions, `collate nocase`, a BINARY column over a NOCASE index, DESC and composite indexes, timespan, blob, `min`/`max`, distinct, group by, window functions, derived tables, a CTE, and a scalar subquery re-run per outer row.

## Tests added or changed

`test/vtab/key-set-semi-join-runtime.spec.ts`:

- `seeks and sorts: <name>`, 7 cases (aliased, unaliased, `exists`, `min` both ways, non-unique seek column, filtered seek leaf): both row order and `rowsScanned`. These are the reproduction.
- `keeps seeking when the key set is small: 3 keys, limit 2`: the bound does not push a small key set onto the walk (3 rows read).
- `walks when many keys make the first match close: 1000 keys, limit 1`: the bound does favour the walk (2 rows read).
- `reaches through the is-not-null Filter of min over a nullable column`: the peel crosses the Filter between the limit and the node (5 rows read).
- `takes the ordered walk and streams it, with no buffering`: above the break-even, the runtime walks, and one row out needs one row read.

`test/optimizer/key-set-seek.spec.ts`:

- `fires when the leaf order absorbed the Sort (ORDER BY pk), and claims that order`: replaces the old decline test. No Sort comes back, `ordering` is claimed, and `monotonicOn` is not.
- `fires over an absorbed-Sort seek leaf (orderingLoadBearing), re-applying its predicate`: replaces the old decline test. The Filter sits directly above the node and rows stay in order.

`test/logic/08.4-key-set-semi-join.sqllogic`, new section running on both backends: NULLs first, NOCASE, a DESC index, a composite index by prefix and in full, LIMIT and OFFSET over sorted rows, and staged rows sorted in with committed ones inside a transaction.

## Known gaps

- **Parameterized LIMIT gets no bound, measured.** Over 1000 evenly spread keys in 2000 rows, `limit ?` bound to 1 reads 1000 rows where the literal reads 2. I measured that on the current code only. The old plan was the same streaming walk the literal form now takes, so it should also have read 2, which would make this a read-count regression for that shape, never a wrong row. The ticket scoped the rule to literals, so I recorded it as a `NOTE:` in the rule's header. The reviewer may want to weigh whether it should be a ticket instead.
- **Store read counts are unmeasured.** The store backend ran the row-order cases through 08.4, but every read count above is from the memory backend, and the hand-worked gate table in the fix ticket used memory costs only. Whether the phase 2 gate picks well on the store's cost line is not established.
- **The sort is uncharged.** The break-even charges nothing for buffering or sorting, so a large key set over a low-cardinality column can buffer most of a table where the walk streamed it. This is the accepted limit the ticket named, parked as a `NOTE:` on `interpolateBreakEven`. I did not measure the memory cost.
- **Out of scope, unchanged:** a filtered target over a never-analyzed key source plans an index-nested-loop semi join and never reaches this rule (the existing `NOTE:` in the rule header). That is why the filtered and nullable-`min` tests run `analyze small`.
- **Reverse walks stay as they were.** On the memory backend `order by n desc` over an ascending index keeps a real Sort, so the seek branch has no order to restore there.

## Worth checking

- `buildOrderRestoringComparator` reads `plan.target.physical.ordering` rather than `providesOrdering`. The two are the same value on both index leaf types, and using `physical` avoids narrowing away `SeqScanNode`.
- `seekRestoresTargetOrder` returns false for a load-bearing leaf with an empty advertised order, and the rule no longer declines there, so such a leaf would silently lose its order. I read the code and it looks unreachable: absorption requires `providesOrdering` to match a non-empty sort key list, and the physical arms I checked by grep pass it through. No test pins this.
- `peelToKeySetJoin` passes through any Project, not just trivial ones. A Project does not reorder rows, and a writing Project only makes the walk read more than estimated (covered by the rule's `NOTE:`).
