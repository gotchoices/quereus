description: |
  Correctness bug: a grouped-aggregate query whose WHERE filters a column that is part of a
  COMPOSITE primary key but is NOT in the GROUP BY silently drops the WHERE predicate. The
  Filter node survives in the optimized plan, but at runtime it is bypassed when its output
  feeds a StreamAggregate — every base row reaches the aggregate, so the filter has no effect.
  The same query without GROUP BY, or against a single-column-PK table, returns correct rows.
  Surfaced (and worked around) during `3.1-mv-query-rewrite-aggregate-rollup`; no existing spec
  exercises this shape, so it does not fail the suite at HEAD.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts      # StreamAggregate physical plan / source wiring (prime suspect)
  - packages/quereus/src/planner/rules/predicate/rule-predicate-pushdown.ts       # filter movement around the aggregate
  - packages/quereus/src/planner/rules/predicate/rule-aggregate-predicate-pushdown.ts
  - packages/quereus/src/planner/rules/predicate/rule-filter-merge.ts
  - packages/quereus/src/planner/nodes/filter.ts                                  # Filter physical props (constantBindings, {} -> col FD)
  - packages/quereus/src/runtime/emit/aggregate-streaming.ts                      # streaming aggregate emitter (confirm it reads from the Filter, not the scan)
  - packages/quereus/src/planner/util/fd-utils.ts                                 # key/FD derivation: r=const + PK(d,r) => d is a key
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts # RULED OUT (requires >1 GROUP BY col) — see below

# Grouped aggregate drops WHERE filter on a non-leading composite-PK column

## Symptom

A grouped aggregate that filters on a column which is part of a **composite** primary key but
is **absent from the GROUP BY** silently ignores the WHERE predicate. Every base row reaches
the aggregate.

```sql
create table bt (d integer not null, r integer not null, total integer null, primary key (d, r));
insert into bt values (1,10,150),(1,20,null),(2,10,7),(2,20,3);

select d, sum(total) from bt where r = 10 group by d;
--   actual:   [1,150] | [2,10]      -- the r = 10 filter is ignored: d=2 -> 7+3 = 10
--   expected: [1,150] | [2,7]       -- only r=10 rows: d=2 -> 7
```

(`d=1` is non-discriminating: the dropped row `(1,20,null)` contributes `null`, which `sum`
ignores, so `d=1` reads `150` either way. `d=2` is the tell.)

## Reproduction harness

The inline `node -e` form in the original report fails for an unrelated reason: `register.mjs`
uses paths relative to the **repo root**, so the script and cwd must both be the repo root and
relative imports must be written from there. Working form — write a script at the repo root and
run it from the repo root:

```
# C:\projects\quereus\_repro.mts
import { Database } from './packages/quereus/src/core/database.ts';
const db = new Database();
await db.exec('create table bt (d integer not null, r integer not null, total integer null, primary key (d, r))');
await db.exec('insert into bt values (1,10,150),(1,20,null),(2,10,7),(2,20,3)');
for await (const row of db.eval('select d, sum(total) from bt where r = 10 group by d'))
  console.log(JSON.stringify(Object.values(row)));
await db.close();
```

```
node --import ./packages/quereus/register.mjs ./_repro.mts
```

`query_plan('<sql>')` (a built-in table-valued function) dumps the optimized plan for analysis.

## What was established

Trigger conditions (all required):
- **Grouped aggregate.** Without `GROUP BY` the same filter works: `select d, r, total from bt
  where r = 10` correctly returns only the two `r=10` rows.
- **Composite PK.** A single-column-PK table with the analogous query returns correct rows
  (per the original report).
- **Filter column is a non-leading PK member absent from the GROUP BY.** Here PK is `(d, r)`,
  GROUP BY is `d`, filter is on `r`.

Not the cause / ruled out:
- **`rule-groupby-fd-simplification`** — the repro `GROUP BY d` has a *single* column, and that
  rule early-returns when `groupBy.length <= 1` (`rule-groupby-fd-simplification.ts:48`). Not
  reached.
- **Constant-binding-only theory.** A *range* filter `where r > 9 and r < 11` (which produces
  no constant binding) is **also** dropped and yields the same wrong `[1,150] | [2,10]`. So the
  bug is broader than the `r = const` constant-pin; equality and range both fail.
- **`attributeDefaults` / `constant-fd`.** The Filter node's physical props carry
  `attributeDefaults: {13: {kind: 'constant-fd', value: 10}}` and
  `constantBindings: [{attrs:[1], value: 10}]`, but that surface is **insert-default
  provenance** (consumed by the view-write / update-lineage backward pass), not by SELECT
  evaluation. It is a red herring for this result.

Key observation — the Filter survives but is bypassed:
- In `query_plan(...)` output for **both** the equality and range variants, the tree is
  `Block -> StreamAggregate -> Filter (WHERE r = 10) -> IndexScan (USING _primary_, matchedClauses=0,
  full scan) -> TableReference`. The Filter node is physically present and the predicate AST still
  reads `r` (attr 13). The IndexScan does **not** push the predicate down (`matchedClauses: 0`).
- Yet at runtime all four base rows reach the aggregate (`d=2` sums `7+3`). So the Filter is in
  the plan but does not actually remove rows **when its consumer is a StreamAggregate** — the
  identical Filter feeding a plain projection (no aggregate) does remove rows.

This points at a runtime/wiring defect in the grouped-aggregate path (the StreamAggregate
pulling from the IndexScan and skipping the interposed Filter, or the Filter↔Aggregate fusion
losing the predicate) rather than at FD-based filter *elimination* in the optimizer — the
predicate is still in the tree. The composite-PK + non-leading-filtered-column shape is what
selects this plan (the FD machinery derives that `r = const` + PK `(d, r)` makes `d` a key,
visible as the StreamAggregate FD `{0} -> {1}` and a Filter `{} -> {1}` constant FD), so the
trigger is real even though the constant binding is not itself the defect.

## Why it matters / current workaround

The aggregate-rollup MV-rewrite re-aggregates over the MV backing (whose PK is the often-composite
MV group key), so a rollup carrying a residual WHERE over the backing produces exactly this
bug-triggering shape. `matchAggregateFragmentToMv` therefore **forgoes any rollup that needs a
residual filter** (`query-rewrite-matcher.ts`, `fail('rollup-residual')`). Exact-key rewrites
(direct scan, no GROUP BY) answer residual queries correctly and are unaffected. Once this base
bug is fixed, that forgo can be relaxed and the equivalence harness extended with
rollup-plus-residual shapes.

## TODO

- Confirm at runtime whether the StreamAggregate's source instruction is the Filter or the
  IndexScan (instrument `aggregate-streaming.ts` emit / dump the scheduler program via
  `scheduler_program('<sql>')`); determine whether the Filter is being elided during emit or
  fused into the aggregate with its predicate dropped.
- Add a regression spec (sqllogic under `test/logic/`) covering: composite-PK table, filter on a
  non-leading PK column absent from the GROUP BY, for both `=` and range predicates; plus the
  passing controls (no GROUP BY; single-column PK) to lock the boundary.
- After the fix, relax `fail('rollup-residual')` in `query-rewrite-matcher.ts` and extend the MV
  equivalence harness with rollup-plus-residual shapes.
