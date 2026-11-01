description: When the planner knows nothing about table sizes, it reads a whole table it could have looked up by key — a filtered or single-row side joined to an indexed table becomes a full scan of that table — because it guesses unknown tables are tiny and forgets that a filter has already narrowed the other side; on remote storage that full scan is the most expensive thing a plan can do.
prereq: feat-per-row-latency-cost-for-remote-scans, feat-planner-asks-the-backend-how-big-a-table-is, bug-measured-empty-table-costed-as-thousand-rows
architecture: docs/progressive-optimizer.md#1-design-principles
files: packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/util/row-estimates.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/rules/join/index-nested-loop.ts, packages/quereus/src/planner/optimizer-tuning.ts, packages/quereus/test/optimizer/index-nested-loop.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, packages/quereus/test/plan/join-selection.spec.ts, docs/progressive-optimizer.md, docs/optimizer-joins.md, docs/optimizer-costing.md
repro: verified
----

# With no statistics, joins scan tables they could seek

`docs/progressive-optimizer.md` §1: "Missing statistics degrade to defaults, never to a bad plan shape by construction." This ticket is the result of checking that floor on never-analyzed tables (2026-11-01, built `dist` at `d4fdaaf98`, `auto_analyze` and `cardinality_feedback` off so nothing is learned mid-test). Keep this slug for the implement ticket you emit — `cardinality-feedback-rows-per-key` names it as a prerequisite.

## What holds (no work needed)

On both the memory backend and an isolated store module over an in-memory provider:

- Single-table access seeks on an equality match: primary key, secondary index, `in` list (multi-seek), primary-key range. `order by id limit 10` walks the primary key with no sort.
- A constant that reaches a join key through an equality is pushed into both sides' seeks (`… join child c on c.parent_id = p.id where p.id = 7` seeks both tables).
- Decorrelation fires: `exists` / `in` → semi join, `not exists` → anti join, a correlated scalar aggregate → grouped left join; a correlated scalar subquery on a primary key stays a per-row primary-key seek.
- No cross products are introduced: the written join order is kept (QuickPick cannot adopt a different order today — `debt-node-self-cost-reads-the-blank-estimate`), and every join keeps its predicate.
- An equi-join with no usable index picks a hash join, never a nested loop; a non-equi join is a nested loop over a cached inner, the only option.

Existing coverage pins these (`test/plan/index-selection.spec.ts`, `subquery-decorrelation.spec.ts`, `scalar-agg-decorrelation.spec.ts`, `join-selection.spec.ts`, `golden-plans.spec.ts`), so no new guard tests for them.

## What fails

Fixture (memory backend):

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

| case | query | never analyzed | after `analyze` |
| --- | --- | --- | --- |
| F1 filtered outer, primary-key inner | `select m.x, b.w from mid m join big b on b.id = m.big_id where m.x = 1` (also its `left join` form) | hash join, full scan of `big` — 16.8 ms | nested loop seeking `big` — 0.32 ms |
| F1 through a join | `select s.v, m.x, b.w from small s join mid m on m.id = s.v join big b on b.id = m.big_id where s.v = 3` | first join seeks `mid`; the second is a hash join over a full scan of `big` — 15.1 ms | both seek — 0.05 ms |
| F2 single-row outer, secondary-index inner | `select s.v, b.id from small s join big b on b.k = s.v where s.id = 2` | plain nested loop over a cached full scan of `big` — 14.2 ms | nested loop seeking `big_k` — 0.80 ms |

Medians of 9 executions on one machine. On the isolated store the same shapes fail the same way (26.6 / 26.3 / 24.7 ms against 0.46 / 0.08 / 9.5 ms) — but `feat-planner-asks-the-backend-how-big-a-table-is` (a prerequisite) makes store tables sized, so re-run the store column after it lands; the memory backend is the repro that stays unknown. Check plans with `getPlanShape().nodeTypes` (want `Join` + `IndexSeek` on `big`, no `HashJoin`, no full `IndexScan` of `big`).

On remote storage F1 and F2 are the worst outcome available: a full read of a table of unknown size where a keyed lookup per narrowed outer row was on offer — exactly the "no nested loop over an unknown-size inner without a seek" and "seek on an equality match" the floor promises.

## Hypothesis — the arithmetic, from `rule-join-physical-selection`

- **F1.** The outer is a Filter over an unknown-size scan, so its physical estimate is `undefined` (`FilterNode.computePhysical` applies its stamped selectivity only to a known source), and so is the inner's. Both read as the rule's `|| 100`: hash `100 × 0.8 + 100 × 0.4 = 120` beats index-nested-loop `100 × (1.0 + 0.5 + 0.3) = 180`. The filter's reduction is invisible.
- **F1 through a join.** The outer of the second join is a nested-loop join whose estimate is `undefined` (`estimateJoinRows` needs both sides) → 100 → the same 120 against 180, although its real cardinality is one row.
- **F2.** The outer is a one-row primary-key seek (known); the inner reads as 100. Plain nested loop `1 × 1.0 + 1 × 100 × 0.1 = 11` beats index-nested-loop `1 × (1.5 + 0.3 × 100) = 31.5`, where 100 is the memory module's no-statistics equality estimate (10% of its 1000-row default).

Root cause: the rule prices an unknown side at **100** rows while scan costing, the memory module and `NaiveStatsProvider` all assume **1000**, and it cannot see reductions above an unknown leaf. (After `bug-measured-empty-table-costed-as-thousand-rows` the read is `undefined → 100`, `0 → 1`.)

## Recommended fix (confirm, then emit the implement ticket)

One helper, used for every side-row read in `rule-join-physical-selection` (the engine terms and the latency drains `feat-per-row-latency-cost-for-remote-scans` adds): the side's physical estimate when known; otherwise a **relative** estimate — `tuning.defaultRowEstimate` at the unknown leaf, carried up through the side's reducing operators with each operator's own shared formula: a Filter's stamped selectivity (factor `FilterNode`'s min-1 formula into a shared function so the node and the helper cannot drift), `joinPhysicalRows` / `estimateJoinRows` for a join, `aggregateRowsFrom` for an aggregate, pass-through for Alias / Project / Sort / Cache. With it:

- F1: outer `1000 × 0.1 = 100`, inner 1000 → hash `80 + 400 = 480` against the seek plan's 180.
- F1 through a join: outer `estimateJoinRows(1, 100) = 10` → seek plan 18 against hash 408.
- F2: nested loop `1 + 100 = 101` against the seek plan's 31.5.
- Unfiltered unknown × unknown joins keep their algorithm — hash, merge and the seek plan all scale linearly with the shared default, and the nested loop only falls further behind — e.g. `index-nested-loop.spec.ts` "keeps the spelled orientation when neither side is analyzed": merge 600 < hash 1200 < seek plan 1800.

The estimate stays `undefined` everywhere else: the helper feeds this rule's comparison only, so the gates that refuse on unknown (`batchedOuterMinRows`, the cross-branch caps) keep refusing.

Alternatives weighed:

- **Charge every candidate for reading its inputs** (hash and merge pay a read of both sides, the nested loop a read of its inner per open). The principled cost-model fix — today only the seek plan pays for what it reads — and it also fixes F1 and F2, but it moves plans over *analyzed* tables too (by the formulas, a 1,000 × 1,000 primary-key join would flip from hash, 1,200 + 2,000 of reads, to the seek plan, 1,800 + 1,000) and needs a benchmark-backed recalibration of the in-process constants. Out of scope; latency-declaring modules get exactly this charge from `feat-per-row-latency-cost-for-remote-scans`.
- **A structural override** ("unknown inner with an at-most-one seek → always the seek plan"): bypasses the cost model; the relative defaults reach the same plans for the failing cases through one consistent default.

## Known, not covered here

- A **non-unique** index inner under a filtered outer (`… parent p join child c on c.parent_id = p.id where p.name = 'p7'`, `child_parent` index; 5.9 ms hash against 1.24 ms analyzed) stays a hash join even with the fix: the memory module's no-statistics guess of 10% of the table per key (100 rows) prices 100 seeks at 3,150. Learning rows-per-key from executed seeks is `cardinality-feedback-rows-per-key`; changing the module's no-statistics guess is a separate decision — record it in the implement ticket's handoff, not here.
- Scalar-aggregate decorrelation always fires, full-scanning the inner to group it; the inverse case is `feat-decorrelation-cost-model` (backlog).

## Edge cases & interactions (for the implement ticket)

- **Cardinality-feedback tests and doc depend on the failing plan.** `cardinality-feedback.spec.ts` "an observed size reaches the plan" and "re-plans at the execution after the one whose scan shifted a table it reads" use F1's query and expect a hash join before the observation; with the fix the first plan already seeks. Re-point them to a shape the observation still flips — the unfiltered `select m.x, b.w from mid m join big b on b.id = m.big_id`: unknown × unknown plans hash (1,200 against 1,800), and observing `big` at 20,000 makes the seek plan win (1,800 against 8,800). Update the measured example in `docs/progressive-optimizer.md` §3 to match. Verify: those specs.
- **Golden plans and plan specs** over never-analyzed tables with filtered or single-row outers will change from hash to seek plans; review each change as intended. Verify: `yarn test`.
- **Bench counters**: a workload joining a never-analyzed table under a filter may change plan; re-baseline with a stated reason per `docs/benchmarking.md`. Verify: `yarn bench:gate` (foreground, ~35 s).
- **Measured zeros** keep the one-row floor from `bug-measured-empty-table-costed-as-thousand-rows`. Verify: inspection.
- **`rule-monotonic-merge-join`** reads `node.left.estimatedRows ?? 100` (the logical getter); check whether it needs the same helper for the same shapes, and say what you found. Verify: inspection.

## TODO

- Reproduce F1, F1-through-a-join and F2 on the memory backend (fixture above; `DEBUG=quereus:optimizer:rule:join-physical-selection` prints every candidate's cost).
- Confirm the arithmetic above against the tree as it stands after the prerequisites.
- Emit the implement ticket (this slug) with the recommended helper, the three regression tests (one per failing case, asserting plan shape), the cardinality-feedback test re-pointing, and the docs (`docs/optimizer-joins.md` cost model, `docs/optimizer-costing.md` unknown-default wording, `docs/progressive-optimizer.md` §1 floor, §3 example, and §5 — remove the "Unknown sizes default consistently" item).
