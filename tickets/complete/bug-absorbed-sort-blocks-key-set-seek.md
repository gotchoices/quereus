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
**Where the diff is.** The implement run was killed by the runner and its work was committed under the subject `tess: timed out on bug-absorbed-sort-blocks-key-set-seek — added resume note`. The later `ticket(implement): bug-absorbed-sort-blocks-key-set-seek` commit adds two comments only. Read both together.

## What shipped

Sort absorption can drop a Sort in favour of an index walk before decorrelation turns `in (select ...)` into a semi join. `rule-key-set-seek` used to decline there, because a multi-seek on another index loses the order the walk must provide, and the query read the whole index.

Whether a seek is cheaper is only known once the key source is drained, so the choice stays in the run-time decision `KeySetSemiJoinNode` already makes:

- **Seek branch restores the order.** `seekRestoresTargetOrder` holds when the leaf's order is load-bearing and non-empty and a seek would not produce it. The emitter then buffers the probed rows and sorts them with the comparator `emitSort` uses. The scan branch still streams, so a LIMIT above it stops early. The node claims `ordering` but not `monotonicOn`. The merge arm keeps its `seekPreservesTargetOrder` gate.
- **A literal LIMIT can favour the walk.** `ruleKeySetSeekRowBound`, anchored on `LimitOffset`, lowers `breakEvenKeys` to the largest `K` where `(seekAt2 + slope * (K - 2)) * K <= baselineCost * (limit + offset)`, using the module's own costs kept on `KeySetPushdown.costLine`.

## Measured

Rows read from `big`, by `rowsScanned`. The "before" column comes from the fix ticket's measurements at the old code and was not re-measured.

| Query, memory backend | Before | Now |
|---|---|---|
| `... b.id in (select bid from small) order by b.v` (aliased, unaliased, `exists`) | 2000 | 3 |
| same, `limit 2` | 1999 | 3 |
| `... b.c in (select bid from small) order by b.v` (non-unique) | 2000 | 120 |
| `min(b.v)`, aliased and unaliased | 1998 | 3 |
| `v >= 5 and id in (...) order by v`, `small` analyzed | 1995 | 3 |
| 1000 evenly spread keys, `order by b.v limit 1` | 2 | 2 |

Store backend, measured in review (`order by v` over a primary-key `in`, analyzed and not, same counts both ways):

| N | K | Limit | Rows read | Taken |
|---|---|---|---|---|
| 2000 | 3 | 1 | 3 | seek |
| 2000 | 100 | 1 | 20 | walk |
| 2000 | 100 | 10 | 100 | seek |
| 2000 | 1000 | 1 | 2 | walk |
| 2000 | 1000 | 10 | 20 | walk |
| 20000 | 300 | 1 | 67 | walk |
| 20000 | 300 | 10 | 300 | seek |

`rowsScanned` counts rows the engine's scan received, not key-value store operations, so these show which branch the gate picks and not its store I/O cost.

## Review findings

**Checked by running code (memory and store unless stated).** Throwaway scripts compared each query against a control that forces a real Sort, and none were added to the repository.

- Order agreement, memory only, in 31 ORDER BY shapes with `limit 3`, `limit 2 offset 4` and `limit 1` forms: text under binary, NOCASE and RTRIM, an index collation that disagrees with the column, nullable integers, a DESC index, a mixed-direction composite index, an `any` column holding mixed storage classes, real, blob, timespan, date, json and boolean. 11 of the 31 took the order-restoring path. The only differences were among rows that compare equal under NOCASE (`APPLE`, `apple`), in plans that do not use the restoring path, and SQL does not order ties.
- Both backends: a composite primary key with a descending column, a descending primary key, DESC and nullable-DESC secondary indexes, each with LIMIT and OFFSET. No differences. A nullable column keeps its real Sort on these shapes, so the restoring path did not run there.
- Memory only: a second `in` and a `not in` stacked on the same query, `min` and `max` through the boundary rewrite, and an `insert ... select ... order by` reading through the node. No differences.
- The row-bound gate on the store's own cost line, table above. It picked the lower read count in every case. This closes the handoff's "store read counts are unmeasured" gap for primary-key seeks. A secondary-index seek on the store was not measured.

**Checked by reading.**

- The handoff's three "worth checking" items. `physical.ordering` is `providesOrdering` on both leaf types (`table-access-nodes.ts`). A load-bearing leaf with an empty advertised order is unreachable: `planDeliversOrdering` requires a match against a non-empty sort key list, and a re-grow that would lose the order declines. Passing through any Project is sound, because a Project emits one row per input row in order.
- Row-bound edges. Literal null, string and negative limits decline, and a limit of zero or less never opens its source (`emit/limit-offset.ts`). A break-even lowered to 0 selects the scan, and an empty key set returns before that comparison. The rule is idempotent, because a re-solve from the lowered value returns it unchanged, so it stops at a fixpoint.
- Early termination closes the target cursor on the streaming path. Row buffering matches `emitSort`, which also keeps rows without copying them. Comparators are built once at emission and hold no per-run state.
- Docs: `optimizer-rules`, `optimizer`, `optimizer-retrieve`, `optimizer-fd` and `optimizer-joins`, plus the mentions in `module-authoring`, `optimizer-costing` and `types`, and the store and leveldb READMEs. One stale sentence, fixed below.

**Minor, fixed in this pass.**

- `emitKeySetSemiJoin` routed every streamed row through an extra `probeTarget` generator and `yield*`, a per-row cost added to all key-set queries including those that never sort. The probe is back inline in `run`, with one branch for buffering.
- A comment in `rule-key-set-seek.ts` and the matching sentence in `docs/optimizer-rules.md` said nothing above a hash semi join can depend on order, which is false for an already-dropped Sort. Both now say that order is what the seek branch restores.
- Added `counts the OFFSET in the bound: 1000 keys, limit 1 offset 998`. Adding the offset to the bound is specified logic with a real effect (a walk here reads most of the table, the seek reads 1000) and no test covered it.

**Major.** None. No wrong rows were found in any shape.

**Tripwires, none new.** All are parked as `NOTE:` comments by the implementer and were reviewed as appropriate:

- Parameterized LIMIT, in the header of `rule-key-set-seek-row-bound.ts`. This is the one a maintainer may want to look at: `limit ?` bound to 1 over 1000 evenly spread keys in 2000 rows reads 1000 rows, where the literal form reads 2. The old plan was the same streaming walk the literal now takes, so it probably read 2 as well; that is inferred, since the old code was not run. I kept it as a tripwire rather than a ticket, because it costs reads and never a row, and because the read count stays within the break-even the module's costs allow, which is what the node would accept with no limit at all.
- The uncharged sort and buffering, on `interpolateBreakEven`. Memory cost not measured.
- The even-spread assumption, in the row-bound rule's header.

**Tests.** None cut. The added tests either reproduce the bug with row order and read counts, pin the specified gate behaviour, or replace the two old decline tests whose meaning changed. `takes the ordered walk and streams it` uses the spec's existing `BreakEvenModule`, a memory module subclass that overrides only the quoted costs, so its rows and reads are real. The fix ticket asked for that fixture. A key set past the engine's 1000-key ceiling would reach the scan branch on the plain module too, so the override is a convenience here, and I kept it because the test is short and the helper was already in the file.

**Considered and declined.** An explicit guard for a load-bearing leaf with no advertised order: unreachable as shown above, and `seekRestoresTargetOrder` already fails safe into the streaming branch of the emitter. `boundedBreakEven` counting down rather than solving the quadratic: at most 1000 iterations once per LIMIT at plan time, and the loop is the clearer statement of the inequality.

**Unrelated, already tracked.** My first measuring fixture hit the stack overflow from many single-row inserts in one transaction. That is `bug-many-inserts-in-one-transaction-overflow-stack`, in the backlog, and the fixture was changed to load set-wise.

## Validation, after the review edits

- `tsc -b tsconfig.build.json`: clean.
- `packages/quereus`: 11047 passing, 26 pending, 0 failing.
- `packages/quereus` with `--store`: 11040 passing, 33 pending, 0 failing.
- `packages/quereus-store`: 1986 passing. `packages/quereus-isolation`: 451 passing.
- `yarn workspace @quereus/quereus run lint`: exit 0.
- The other workspaces' tests and `yarn test:scripts` were not re-run in review. The review edits touch only `packages/quereus` and one doc. The implementer's run had them passing.
