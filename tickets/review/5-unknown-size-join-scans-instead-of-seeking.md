description: When the planner knows nothing about table sizes, it now prices an unmeasured table at the same 1000-row default everything else uses, and remembers that a filter has already narrowed the other side, so a filtered or single-row side joined to an indexed table looks that table up by key instead of reading all of it.
architecture: docs/progressive-optimizer.md#1-design-principles
files: packages/quereus/src/planner/util/relative-rows.ts, packages/quereus/src/planner/util/row-estimates.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts, packages/quereus/src/planner/rules/access/rule-key-set-seek.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/test/optimizer/index-nested-loop.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, packages/quereus/test/optimizer/index-seek-row-estimates.spec.ts, packages/quereus/test/optimizer/key-set-seek.spec.ts, packages/quereus/test/plan/joins/simple-join.plan.json, packages/quereus/test/plan/aggregates/group-by.plan.json, packages/quereus/bench/reference/execution.json, docs/optimizer-joins.md, docs/optimizer-costing.md, docs/progressive-optimizer.md
----

# With no statistics, joins scan tables they could seek — implemented

`cardinality-feedback-rows-per-key` (plan/) names this slug as its prerequisite.

## What changed

- **`planner/util/relative-rows.ts` (new)** — `relativeRows(side, unknownLeafRows)`: a side's physical estimate when known (floored through `costedRows`, so a measured 0 keeps its one-row floor); otherwise `unknownLeafRows` at the unknown leaf carried up through Filter (`filterRowsFrom` with stamped selectivity, else `DEFAULT_FILTER_SELECTIVITY`), the join family `JoinNode` / `BloomJoinNode` / `MergeJoinNode` (`joinPhysicalRows` with no coverage — key coverage not re-derived), the three aggregates (their own `rowsFrom`, now public so divisors don't drift), and any single-relation node as a pass-through; anything else reads the default. Separate module because it imports node classes and those import `row-estimates.ts`.
- **`row-estimates.ts`** — `filterRowsFrom(sourceRows, selectivity)`, now used by `FilterNode.estimatedRows`, `FilterNode.computePhysical` and the walker.
- **`rule-join-physical-selection.ts`** — `sideRows(side, tuning)` = `relativeRows(side, tuning.defaultRowEstimate)`; `UNKNOWN_SIDE_ROWS = 100` deleted. Every row read (work terms, hash build/probe choice and swap, merge, both index-NL outer counts, batched candidates, latency drains) goes through it. `rowsRead`'s unknown-leaf fallback is now the leaf's own relative estimate (the default), not the side's filtered count. Also fixed two `debug` log lines using `%.2f` (debug has no precision formatter; the args were shifting).
- **`rule-monotonic-merge-join.ts`** — cost gate reads `relativeRows` instead of the logical `estimatedRows ?? 100` (this also makes it read real physical counts for analyzed sides). Added the `NOTE:` tripwire that it never prices index-NL. Same `%.2f` log fix. No spec moved.
- **`rule-key-set-seek.ts`** — comment only: `NOTE:` tripwire (see below).
- The plan-recorded estimate stays `undefined` everywhere: the relative figure only feeds these two rules' comparisons, so `batchedOuterMinRows`, the cross-branch caps and `nestedLoopRightOpensOnce`'s size gate still refuse on unknown.

## Verified plan changes (fixture from the ticket, memory backend, `auto_analyze` / `cardinality_feedback` off)

Costs from `DEBUG=quereus:optimizer:rule:join-physical-selection`:

- F1 `mid m join big b on b.id = m.big_id where m.x = 1` (inner and left): index-NL 180 for 100 outer rows → `Join` + `IndexSeek` on `big`.
- F1 through a join (`small s join mid m on m.id = s.v join big b … where s.v = 3`): outer estimate 10 → index-NL 18 seeking `big`. (The first join is now a nested loop over a constant `mid` primary-key seek — `s.v = 3` propagates to `m.id = 3` — 1 × 100 rows, nl 11.)
- F2 `small s join big b on b.k = s.v where s.id = 2`: index-NL 31.5 on `big_k` (was nested loop over a cached full scan).

## Tests

Added (in `test/optimizer/index-nested-loop.spec.ts`, new top-level describe "index-nested-loop over never-analyzed tables", 2,000-row `big` — sizes don't matter, nothing is measured):
- "seeks a primary-key inner under a filtered outer (inner and left joins)" — F1; drive from `mid`, seek `big`, no hash join, every read of `big` a seek.
- "seeks a primary-key inner when the filter sits below another join" — F1 through a join.
- "seeks a secondary-index inner under a single-row outer" — F2.

Changed, each reviewed as an intended consequence:
- `cardinality-feedback.spec.ts` — `joinSql` re-pointed to the unfiltered join (unknown × unknown hashes 1,200 vs index-NL 1,800; observing `big` at 20,000 makes index-NL win 1,800 vs 8,800); expected row counts 60 → 300.
- `index-seek-row-estimates.spec.ts` "does not claim at-most-one-row for a correlated primary-key seek" — `analyze probe` added. Never analyzed, the 2-row `probe` now prices at 1000 against an analyzed 2,000-row `big`: hash 1,600 beats 1,000 seeks at 1,800. The spec is about the FD claim on a correlated seek, so it now measures the outer.
- `key-set-seek.spec.ts` — both fixtures `analyze` the empty `small` key source. Never analyzed, `small` prices at 1000 and a filtered `big` (`pk > 1`, `s = 'x'`, `w = 5`, …) drives an index-NL **semi** join seeking `small` per `big` row instead of the hash semi join the key-set rewrite anchors on (9 specs). The rewrite presumes a small key source; measured empty it prices at one row.
- Goldens `joins/simple-join` and `aggregates/group-by` (`users u join departments d on u.dept_id = d.id where u.age > …`): `HashJoin` + full `IndexScan` of `departments` → `Join` + `IndexSeek` on `departments` primary key keyed on `u.dept_id`. F1's shape exactly.
- Comment in "keeps the spelled orientation when neither side is analyzed": numbers now 1800 / 1200 / merge 600; outcome unchanged.

Bench: `execution/join-1kx1k` re-baselined (`yarn bench:accept --allow-dirty`, provenance = parent commit, same practice as the previous accept). Same instructions and row counts; the hash join now builds on the filtered left range seek (est. 250, real 100) and probes the 1,000-row `right_t` scan, which used to read as 100 — emission order swapped. `yarn bench:gate` passes.

Docs: `optimizer-joins.md` new *Side row counts* paragraph under the cost model, Storage latency paragraph no longer says "100 today"; `optimizer-costing.md` unknown-default sentence; `progressive-optimizer.md` §1 principle cell, §3 measured example re-measured on the unfiltered query (15.5 ms hash vs 3.0 ms seek once `big`'s size is known, median of 11, this machine), §5 item removed.

Validation run: full quereus suite **without** `--bail` (`mocha "packages/quereus/test/**/*.spec.ts"`): 10,849 passing, 25 pending, 0 failing. Note `yarn test` passes `--bail`, so its "1 failing" hides later failures — run without it when sweeping plan changes. `yarn lint` (packages/quereus) clean. `yarn test:store` not run.

## Known gaps / for the reviewer

- **Key-set seek is not a priced candidate.** It rewrites semi joins that already chose hash/merge. With never-analyzed key sources under a filtered target, the index-NL semi join now wins first, so the key-set rewrite never sees the join. Parked as a `NOTE:` tripwire in `rule-key-set-seek.ts` header. Worth a reviewer's judgement whether this should be a ticket instead (I judged it conditional: correct when the key source really is the larger side, and the hash semi cost formula is itself optimistic for semi joins — it uses `min` as build though semi must build right).
- **Hash cost for semi/left joins assumes the cheaper build side** even though only inner joins may swap (pre-existing, unchanged; the larger default makes the optimism matter more for a large unknown right side).
- Relative estimate does not re-derive join key coverage (a PK-covered join over an unknown side reads the 10% heuristic rather than the other side's count). Acceptable per ticket for a compared-only figure.
- `rule-quickpick-enumeration.ts:354` still logs with `%.2f` (not touched; same cosmetic debug bug).
- Out of scope, as the ticket said: non-unique index inner under a filtered outer still hashes (memory module's 10%-per-key no-statistics guess) — `cardinality-feedback-rows-per-key`; node self-costs still read `estimatedRows ?? 100` — `debt-node-self-cost-reads-the-blank-estimate`; scalar-aggregate decorrelation — `feat-decorrelation-cost-model`.
- Store backend: only the memory backend was exercised; store tables are sized by the module (`feat-planner-asks-the-backend-how-big-a-table-is`), so this change mostly affects filters/joins above them there.
