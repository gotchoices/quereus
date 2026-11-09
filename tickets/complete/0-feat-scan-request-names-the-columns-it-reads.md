description: A table module is now told which of its columns a query actually reads, so a column store can skip assembling the rest (for example for `select count(*)` or a one-column projection).
files: packages/quereus/src/planner/analysis/required-columns.ts, packages/quereus/src/planner/framework/pass.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/vtab/filter-info.ts, packages/quereus/src/vtab/index-info.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/src/runtime/strict-flags.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus/test/optimizer/required-columns.spec.ts, packages/quereus-isolation/test/required-columns-merge.spec.ts, docs/module-authoring.md, docs/optimizer.md, docs/runtime.md, docs/invariants.md, docs/plugins.md
----

# A scan request names the columns it reads

## What shipped

`FilterInfo` (the object a module's `query()` receives) carries `requiredColumns?: ReadonlySet<number>`: the 0-based table-schema column indexes the finished plan reads from that scan's rows. Absent means every column. A module may fill only those columns (any valid value, null is natural, elsewhere; full row width kept); ignoring the field is always correct. Contract: `docs/module-authoring.md` § "Required columns".

- Analysis: `planner/analysis/required-columns.ts`. A column is read if any `ColumnReferenceNode` in the plan names its attribute id, or if an operator reads whole rows of a relation carrying it. Whole-row demand starts at the statement result and passes down only through `Filter`, `Sort`, `LimitOffset`, `Alias`, `Cache` and joins (each emitted side). `Project` and the aggregates read only through expression children. Every other operator reads its relational inputs whole (the sound default for operators added later). Hash and merge joins also add their `equiPairs` attribute ids.
- Delivery: custom-`execute` optimizer pass `required-columns` (order 36, after Materialization, before Final Estimates) runs `stampRequiredColumns`. It clones each changed scan via `TableAccessNode.withRequiredColumns` and re-mints only the paths above them; shared subtrees stay shared. The stamp is authoritative: it adds, changes or removes the set.
- `IndexInfo.colUsed` (always `0n`) removed. No `BestAccessPlanRequest.requiredColumns`: at planning time the plan above the scan is still being rewritten, so a request field could only carry a stale estimate.
- Isolation layer: forwards the set unchanged when it reads only the underlying table. On a merged read it adds the primary-key columns (primary path) or the primary-key plus index-key columns (secondary path) before querying the underlying, and drops the field from overlay queries.
- Harness: `QUEREUS_COLUMNS_STRICT=1` (`yarn test:columns-strict`, in root `yarn check`) nulls every unlisted column at the scan emitter for every module.
- Not in this repo: lamina still has to read `filterInfo.requiredColumns` in its `query()`.

## Review findings

Read the source, test and docs diff of `ticket(implement): feat-scan-request-names-the-columns-it-reads` before reading the handoff.

**Correctness of the analysis — checked, no defect found.**
- The pass-through operators read nothing by position. `emit/project.ts` emits only its projections. `preserveInputColumns` only affects which attribute ids the output reuses, not which values it carries. In `emit/aggregate.ts` and `emit/hash-aggregate.ts` the representative source row is installed as row context and read only through `ColumnReferenceNode`s. Merge and bloom joins read keys through `equiPairs`, which the walk adds. `JoinNode`, `emit/join.ts` and `join-node.ts` have no positional key reads.
- The scan attribute to schema column mapping holds. A scan's attributes come from `TableReferenceNode` in schema order, and the walk does not narrow when the lengths differ. Generated columns, including VIRTUAL ones, are computed on write and stored (`generatedStored` is used only in DDL and schema code), so no read-time computation needs a column the plan doesn't list.
- Every scan path a stamp can reach is covered. Ordinal slice and key-set semi join call `emitSeqScan` with an override that spreads the base `FilterInfo`, so the strict harness masks those paths too. Their leaves sit under unmodelled nodes, so they arrive unstamped anyway. Eager prefetch and fan-out lookup do not call `query()` themselves. Asof, envelope, lens and remote scans are not `TableAccessNode`s, so they are never stamped.
- No caller runs part of a stamped plan on its own. Every `emitPlanNode` caller outside the emitters (statement, database exec, assertions, materialized-view builders, derived-row validator, explain, debug program) takes a whole `optimize()` result or a scalar with no subqueries. `const-evaluator` runs during constant folding, before the stamp exists. Only the property test's isolated-node tier emits a subtree, and it re-stamps first.
- `withFilterInfo` passes the same fields as each subclass's `withChildren` constructor call, except that it keeps its own self-cost.
- Spot-checked 23 shapes under `QUEREUS_COLUMNS_STRICT=1` in a temporary spec, deleted after the run. All gave correct answers. The shapes: windows with and without a partition, a correlated scalar subquery, exists, `not in`, `in`, group by with a having on a non-group column, a CTE joined to itself, a recursive CTE, union, distinct, limit/offset, a left join, range and point seeks on a secondary index, count/max with a residual filter, re-running a prepared statement with new parameters, update from a subquery, delete with returning, insert-select, and a transaction overlay read through a secondary index.

**Validation run in this pass.**
- `yarn lint` (packages/quereus): passed.
- `node scripts/check-docs.mjs`: OK.
- Touched specs (required-columns, filter-selectivity, cost-additivity, rule-manifest): 95 passing.
- `yarn workspace @quereus/isolation test`: 453 passing.
- `node test-runner.mjs --store --columns-strict`: 11116 passing, 33 pending, 0 failing. The implementer had not run this combination.
- I relied on the implementer's normal and `--columns-strict` runs of the memory backend (11123 passing each) and did not re-run the full suite.

**Docs — fixed inline.**
- `docs/module-authoring.md` listed "triggers" among the operators that read whole rows. This engine has no triggers, so I removed it. The same paragraph also implied that any scan under a set operation or `distinct` arrives unstamped. In fact a projection in between stops whole-row demand (`select a from t union select v from u` narrows both scans), so I reworded it.
- `docs/invariants.md`: added **OPT-064**, "A scan's `requiredColumns` names every column the plan reads from it". It records the soundness property the analysis depends on: listed pass-through and expression-only operators read only through `ColumnReferenceNode` children plus the attribute-id fields the walk adds. Guard: the `--columns-strict` harness. Linked from `docs/optimizer.md` § Pass 3.6.
- `docs/runtime.md`, `docs/plugins.md` and `docs/architecture.md` already describe the change correctly. No stale `colUsed` references remain anywhere outside `dist/` and tickets.

**Tests.** I kept the implementer's tests. Each case in `required-columns.spec.ts` pins one reader kind from the contract, and the isolation spec reproduces the widening contract and asserts what the module was asked for. The `cost-additivity` exemption for `this.estimatedCost` is sound, because that expression is always the node's own self-cost. I added no permanent tests: the strict harness already covers the corpus.

**Major findings / tickets filed.** None. Nothing I found needed a ticket.

**Tripwires.** None added. The extra whole-plan walk per `optimize()` is unmeasured but small. It is a single traversal, and a plan where every column is read rebuilds nothing. That is not worth a `NOTE:`.

**Declined / left as-is.**
- The set is not shown in `query_plan` / explain output (`TableAccessNode.getLogicalAttributes`), which would help someone debugging a column store's wrong answer. Adding it would churn plan goldens, so it is not done here.
- The precision the handoff lists as given up (`distinct`, set operations, windows and scalar subqueries read their inputs whole, and an unused computed projection still counts its references) is conservative and correct. It is not a defect.
