description: When the planner knows nothing about table sizes, it reads a whole table it could have looked up by key — a filtered or single-row side joined to an indexed table becomes a full scan of that table — because it guesses unknown tables are tiny and forgets that a filter has already narrowed the other side; on remote storage that full scan is the most expensive thing a plan can do.
architecture: docs/progressive-optimizer.md#1-design-principles
files: packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/util/row-estimates.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/optimizer/index-nested-loop.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, packages/quereus/test/plan/join-selection.spec.ts, docs/progressive-optimizer.md, docs/optimizer-joins.md, docs/optimizer-costing.md
repro: verified
----

# With no statistics, joins scan tables they could seek

`docs/progressive-optimizer.md` §1 promises: "Missing statistics degrade to defaults, never to a bad plan shape by construction." On never-analyzed tables join selection breaks that promise in three shapes, all of which full-scan an indexed table where a keyed lookup per (few) outer rows was on offer. `cardinality-feedback-rows-per-key` (plan/) names this slug as its prerequisite — keep the slug.

## Reproduction (verified 2026-11-01, fix stage, tree at `6fa9e5dc1`, all three prerequisites landed)

Fixture, memory backend:

```sql
pragma auto_analyze = false;
pragma cardinality_feedback = false;
create table big (id integer primary key, w integer, k integer);
create index big_k on big(k);
create table mid (id integer primary key, x integer, big_id integer);
create table small (id integer primary key, v integer);
insert into big select value, value % 97, value % 50 from generate_series(1, 20000);
insert into mid select value, value % 20, value * 61 % 20000 + 1 from generate_series(1, 300);
insert into small select value, value from generate_series(1, 10);
```

Costs printed by `DEBUG=quereus:optimizer:rule:join-physical-selection` (plan shape from `stmt.getPlanShape().nodeTypes`):

| case | query | candidates today | plan today |
| --- | --- | --- | --- |
| F1 filtered outer, primary-key inner | `select m.x, b.w from mid m join big b on b.id = m.big_id where m.x = 1` (and the `left join` form) | nl 1100, **hash 120**, merge 1389, index-NL 180 — "for 100 x 100 rows" | `HashJoin` + full `IndexScan` of `big` |
| F1 through a join | `select s.v, m.x, b.w from small s join mid m on m.id = s.v join big b on b.id = m.big_id where s.v = 3` | second join: **hash 120**, index-NL 180, "100 x 100" | inner join seeks `mid`; outer join is `HashJoin` over full scan of `big` |
| F2 single-row outer, secondary-index inner | `select s.v, b.id from small s join big b on b.k = s.v where s.id = 2` | **nl 11**, hash 40.8, index-NL 31.5 — "1 x 100" | `Join` over `Cache` of a full scan of `big` |

Timings from the original report (medians of 9): F1 16.8 ms against 0.32 ms once analyzed; F1-through-a-join 15.1 ms against 0.05 ms; F2 14.2 ms against 0.80 ms. Only the memory backend was re-run at the fix stage; the store column of the original report predates `feat-planner-asks-the-backend-how-big-a-table-is`, which now sizes store tables — the memory backend is the repro that stays unknown.

## Root cause

`rule-join-physical-selection.ts` `sideRows()` prices a side whose physical estimate is `undefined` at `UNKNOWN_SIDE_ROWS = 100`, while scan costing, the memory module's no-statistics answers and `NaiveStatsProvider` all assume `tuning.defaultRowEstimate` (1000). And a side whose own estimate is unknown because its *leaf* is unknown — a Filter over a never-analyzed scan (`FilterNode.computePhysical` applies its stamped selectivity only to a known source count), or a join over one (`estimateJoinRows` needs both inputs) — reads as the same flat 100, so the filter's reduction is invisible:

- F1: outer and inner both 100 → hash `100×0.8 + 100×0.4 = 120` beats index-NL `100 × (1.0 + 0.5 + 0.3) = 180`.
- F1 through a join: outer is a nested-loop join with an `undefined` estimate → 100 → same 120 against 180, though it really yields one row.
- F2: outer is a known one-row seek; inner reads 100 → nested loop `1 + 1×100×0.1 = 11` beats index-NL `1 × (1.5 + 0.3×100) = 31.5` (100 is the memory module's no-statistics equality estimate, 10% of its 1000-row default).

## Fix: one relative-estimate helper for every side-row read in the rule

Replace `sideRows` with a helper that returns:

- the side's physical estimate when known, through `costedRows` (so a measured 0 keeps its one-row floor from `bug-measured-empty-table-costed-as-thousand-rows`);
- otherwise a **relative** estimate: `tuning.defaultRowEstimate` at the unknown leaf, carried up through the side's operators with each operator's own shared formula:
  - Filter → its stamped selectivity, min-1 / 0-stays-0. Factor the formula out of `FilterNode.computePhysical` and the `estimatedRows` getter into a pure `filterRowsFrom(sourceRows, selectivity)` in `row-estimates.ts` so the node and the helper cannot drift (unstamped → `DEFAULT_FILTER_SELECTIVITY`, as the getter does).
  - Join family (`JoinNode`, `BloomJoinNode`, `MergeJoinNode`) → `estimateJoinRows(rel(left), rel(right), joinType)` floored (as `joinPhysicalRows` does). Key coverage is not re-derived; acceptable for a relative figure.
  - Aggregates → `aggregateRowsFrom` with that flavour's grouped flag and divisor.
  - Single-relation pass-throughs (Alias, Project, Sort, Cache, Distinct, LimitOffset, …) → the source's relative estimate (an upper bound, which is fine here).
  - Anything else (unrecognised multi-relation node, a leaf with no count) → `defaultRowEstimate`.

The estimate stays `undefined` everywhere else in the planner: the helper feeds only this rule's comparison, so the gates that deliberately refuse on unknown (`batchedOuterMinRows`, the cross-branch caps, `nestedLoopRightOpensOnce`'s size gate) keep refusing. Put the walker in its own module (e.g. `planner/util/relative-rows.ts`), not in `row-estimates.ts` — it dispatches on node classes, and `row-estimates.ts` is imported by those node modules (circular import).

Use it for every row read in the rule: `leftRows` / `rightRows` (work terms, hash build/probe choice and swap, merge, both index-NL orientations' outer counts, batched candidates) **and** the latency drains. In `rowsRead`, the unknown-leaf fallback must become the leaf's own relative estimate (`defaultRowEstimate`), not the side's filtered count — a Filter over a scan still pulls every scanned row; today it inherits the side's `rows`. Delete `UNKNOWN_SIDE_ROWS` and its comment.

Expected costs with the helper (selectivity 0.1 for the equality filters, as `NaiveStatsProvider` stamps):

- F1: outer `1000 × 0.1 = 100`, inner 1000 → hash `80 + 400 = 480`, index-NL 180, merge > 330 (needs a sort) → **index-NL**.
- F1 through a join: outer `estimateJoinRows(…)` ≈ 10 → index-NL ≈ 18 against hash ≈ 408 → **index-NL**.
- F2: nested loop `1 + 1000×0.1 = 101`, index-NL 31.5, hash 400.8 → **index-NL** on `big_k`.
- Unfiltered unknown × unknown joins keep their algorithm: hash, merge (no sort) and index-NL are linear in the shared default, the nested loop is quadratic and only falls further behind. E.g. `index-nested-loop.spec.ts` "keeps the spelled orientation when neither side is analyzed (no coin toss)": merge 600 < hash 1200 < index-NL 1800, same winner as 60 < 120 < 180 today. Also checked: `small s join big b on b.id = s.id where s.v = 3` (PK=PK, both scans ordered) is a merge join today (merge 60) and becomes index-NL (180 against merge 330) — the right call, it stops walking all of `big`.

Alternatives rejected at the fix stage: charging every candidate for reading its inputs (principled, but moves plans over analyzed tables too and needs a benchmark-backed recalibration — latency-declaring modules already get this charge from `feat-per-row-latency-cost-for-remote-scans`); a structural override ("unknown inner with an at-most-one seek → always seek") bypasses the cost model, where one consistent default reaches the same plans.

## `rule-monotonic-merge-join` (inspected)

It reads `node.left.estimatedRows ?? 100` — the *logical* getter, which is `undefined` through physical access nodes even for analyzed tables — and compares merge only against hash and plain nested loop (no index-NL). Its precondition (both sides advertise `monotonicOn` on a join key; memory module advertises it only when the access plan walks a named index) was not met by any repro query (no log line from the rule), so it does not cause F1/F2. Switch its two reads to the same helper anyway for one default (unknown × unknown stays scale-invariant: merge and hash linear, NL quadratic); this also makes it read real physical counts for analyzed sides. If that perturbs its specs beyond intent, keep the old reads and leave a `NOTE:` there instead. Either way add a `NOTE:` tripwire that it does not price index-NL and so can pre-empt a cheaper seek plan when both sides are monotonic on the key — fine while `monotonicOn` is rare; revisit if it starts winning over seekable inners.

## Out of scope — record in the review handoff, do not fix here

- A **non-unique** index inner under a filtered outer (`… parent p join child c on c.parent_id = p.id where p.name = 'p7'`, index on `child.parent_id`) stays a hash join even with the fix: the memory module's no-statistics guess of 10% of the table per key prices 100 seeks × 100 rows at ≈3,150 against hash 480. Learning rows-per-key from executed seeks is `cardinality-feedback-rows-per-key`; changing the module's no-statistics per-key guess is a separate decision.
- Node self-costs in `BloomJoinNode` / `MergeJoinNode` / `JoinNode` / `KeySetSemiJoinNode` constructors still read `estimatedRows ?? 100`; that is `debt-node-self-cost-reads-the-blank-estimate`.
- Scalar-aggregate decorrelation always fires: `feat-decorrelation-cost-model` (backlog).

## Edge cases & interactions

- **Cardinality-feedback specs depend on the failing plan.** `test/optimizer/cardinality-feedback.spec.ts` — "an observed size reaches the plan: the join flips from hash to a primary-key seek" (line ~181), "re-plans at the execution after the one whose scan shifted a table it reads" (~228), "re-plans when a module-reported size drifts 10x from the one the plan was costed with" (~252) — use F1's filtered query (`joinSql`, line 32) and expect hash before the observation; with the fix the first plan already seeks. Re-point them to the unfiltered `select m.x, b.w from mid m join big b on b.id = m.big_id`: unknown × unknown plans hash (1,200 against index-NL 1,800); observing `big` at 20,000 makes index-NL win (1,800 against hash 8,800). Update the measured example in `docs/progressive-optimizer.md` §3 to match.
- **Golden plans and plan specs** over never-analyzed tables with filtered or single-row outers will move from hash / nested loop to index-NL. Review each diff as intended (seek where a seek was available), not just re-bless.
- **Bench counters**: a workload joining a never-analyzed table under a filter may change plan; re-baseline with a stated reason per `docs/benchmarking.md`. `yarn bench:gate` (foreground, ~35 s).
- **Measured zeros** keep the one-row floor (`costedRows`), including a 0 relayed through a Filter (`filterRowsFrom` keeps 0, `costedRows` floors it at the read).
- **Tie order**: the strict-`<` fixed comparison order in the rule is unchanged; two unknown sides still tie between index-NL orientations and the un-mirrored one wins.

## TODO

- Factor `filterRowsFrom(sourceRows, selectivity)` into `planner/util/row-estimates.ts`; use it from `FilterNode.estimatedRows` and `FilterNode.computePhysical`.
- Add the relative-estimate walker module (physical estimate when known; else `defaultRowEstimate` at the leaf carried up through Filter / join family / aggregates / single-relation pass-throughs).
- In `rule-join-physical-selection.ts`: replace `sideRows` and `UNKNOWN_SIDE_ROWS` with the helper; make `rowsRead`'s unknown-leaf fallback the leaf's relative estimate; update the rule's comments (the tie comment mentions "the 100-row default").
- `rule-monotonic-merge-join.ts`: switch to the helper (or keep + `NOTE:`), plus the index-NL pre-emption `NOTE:` tripwire.
- Regression tests, one per failing case, asserting plan shape on the fixture above with `auto_analyze` / `cardinality_feedback` off (want `Join` + `IndexSeek` on `big`, no `HashJoin`, no full `IndexScan` of `big`): F1, F1 through a join, F2 — in `test/plan/join-selection.spec.ts` or `test/optimizer/index-nested-loop.spec.ts`, whichever already hosts the never-analyzed cases.
- Re-point the three cardinality-feedback specs to the unfiltered query.
- Docs: `docs/optimizer-joins.md` cost model + the "Storage latency" paragraph (drop "100 today; `unknown-size-join-scans-instead-of-seeking` revisits it"), `docs/optimizer-costing.md` unknown-default wording, `docs/progressive-optimizer.md` §1 floor, §3 example, §5 — remove the "Unknown sizes default consistently" item.
- `yarn test` (quereus), `yarn lint` in `packages/quereus`, `yarn bench:gate`; review golden-plan diffs individually.
