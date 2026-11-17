description: A subquery used as a single value — `(select val from t where …)` — yields null when it finds no row, but the engine currently tells callers it can never be null whenever the selected column is declared not null. Announce it as possibly null unless the subquery is guaranteed to produce a row.
architecture: docs/types.md#enforcement-quereus_repr_strict
files:
  - packages/quereus/src/planner/nodes/subquery.ts                 # ScalarSubqueryNode.getType — the one site
  - packages/quereus/src/planner/analysis/                         # new small analysis: does a relation always yield at least one row
  - packages/quereus/src/planner/nodes/aggregate-node.ts           # ungrouped Aggregate — exactly one row
  - packages/quereus/src/planner/nodes/stream-aggregate.ts         # physical forms of the same
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/single-row.ts               # `select <expr>` with no FROM
  - packages/quereus/src/planner/nodes/values-node.ts
  - packages/quereus/src/planner/nodes/limit-offset.ts             # constantNumber() helper
  - packages/quereus/src/planner/building/row-count-expression.ts  # LIMIT/OFFSET reject nullable expressions — consumer
  - packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic    # `limit (select lim from sqx_limits where lim = 2)` — will now be rejected
  - packages/quereus/test/lens-advertisement.spec.ts               # EAV pivot lens: `city` read as NULL from a correlated subquery
  - docs/sql-select.md                                             # §3.6 LIMIT/OFFSET — list of rejected nullable shapes
----

# Scalar subqueries announce nullable unless they always produce a row

## Background

`ScalarSubqueryNode.getType()` (`planner/nodes/subquery.ts`) returns the subquery's first column type unchanged. A scalar subquery that finds no row evaluates to NULL, so when the first column is declared NOT NULL the announcement is false. The 2026-11-16 measurement (temporary "announced non-nullable ⇒ no null cell" check at statement egress) hit it in:

- `select (select val from e)` over an empty table;
- `(select v from sqx_dups order by v limit 1 offset 100)`;
- `(select count(*) from wg t group by t.a having …)` and `(select count(*) from cc where … group by cc.pid)` — `count(*)` is non-null, but a grouped or HAVING-filtered aggregate can produce zero rows;
- a view column `(select lbl from qc_l where …)` (`test/logic/93.4-view-mutation.sqllogic`);
- a lens over an EAV advertisement: the logical column `city` is compiled to a correlated scalar subquery over the pivot table, and an entity with no `city` triple reads NULL (`test/lens-advertisement.spec.ts`, "missing triple → null").

## Design

```
nullable = firstColumn.nullable || !alwaysYieldsARow(subquery)
```

`alwaysYieldsARow(relation)` is a new, small, purely structural analysis in `planner/analysis/` (one function, conservative: `false` whenever unsure). It returns true for:

- an aggregate with **no grouping keys** (logical `AggregateNode`, and the physical `StreamAggregateNode` / `HashAggregateNode` the optimizer may substitute) — an ungrouped aggregate yields exactly one row regardless of its input, so a filter *below* it does not matter;
- `SingleRowNode` (a `select` with no FROM) and a `ValuesNode` with at least one row;
- a row-preserving wrapper over a relation that always yields a row: `ProjectNode`, `AliasNode`, `SortNode`, `DistinctNode` (≥1 row in ⇒ ≥1 row out), and `LimitOffsetNode` only when its limit is a constant ≥ 1 and its offset is absent or the constant 0 (use `constantNumber` from `limit-offset.ts`).

Everything else — a `FilterNode` above the aggregate (that is what HAVING becomes), a grouped aggregate, a table scan, a join, a set operation — returns false. Keep it to that list; widening it later is cheap and a wrong `true` is a false promise.

The analysis must give the same answer before and after optimization for the shapes it accepts; that is why the physical aggregate nodes are on the list. If an optimizer rule replaces an ungrouped aggregate with some other node (a constant, a statistics read), the answer may turn from true to false after optimization — the sound direction — and is acceptable.

## Edge cases & interactions

- **LIMIT/OFFSET (user-visible).** `row-count-expression.ts` rejects a nullable LIMIT/OFFSET expression at prepare time. After this change `limit (select lim from sqx_limits where lim = 2)` is rejected with "LIMIT expression may be NULL" — correct per `docs/sql-select.md` §3.6 (a subquery that finds no row is NULL); the documented remedy is `coalesce(…)`. Update `test/logic/07.6.1-subquery-extras.sqllogic` lines ~27 and ~31 to wrap in `coalesce(…, 0)` (or assert the error once and then use coalesce). `limit (select count(*) from wg t where t.b = wg.b)` in `07.3-group-by-extras.sqllogic` stays accepted (ungrouped aggregate with a filter below it). Add "a scalar subquery that may find no row, such as `limit (select n from cfg where k = 1)`" to the rejected-shapes sentence in §3.6.
- **Lens prover (deploy-blocking).** The prover reads body expression nullability. EAV-pivot and other subquery-mapped columns now report nullable, so a `not null` logical column over one raises `lens.nullability-mismatch` and `apply schema` fails. In `lens-advertisement.spec.ts` the logical table is declared `{ id integer primary key, nick text, city text }` under the shipped `default_column_nullability = 'not_null'`, so `city` is NOT NULL while the test asserts it reads NULL — the test was relying on this bug. Declare the optional attributes nullable (`nick text null, city text null`). Check `docs/lens-default-mapper.md` / `docs/lens.md` for EAV examples declared the same way and fix them alike. Run every `lens*.spec.ts` and `test/logic/5*-lens*.sqllogic`; any other test that fails the same way gets the same treatment, never a skip.
- **Rewrites that replace the subquery.** Decorrelation rules and `planner/analysis/scalar-subqueries.ts` (`substituteSubqueries`, which keeps a wrapping `coalesce(<substitute>, 0)`) replace a `ScalarSubqueryNode` with another expression; that expression carries its own nullability (an outer-join column is already nullable). No change expected — confirm by the suite rather than by auditing each rule.
- **`withParametersAssumedNonNull`** (row-count-expression.ts) deliberately does not descend into a subquery body; unchanged.
- **Correlated vs. uncorrelated** makes no difference to the rule.
- **EXISTS / IN subqueries** are different node types with their own (boolean) typing; out of scope.

## Test

The suite already exercises every shape listed above (they are where the measurement found them); once `announced-nullability-egress-check` installs the strict check they become regressions automatically. Add one pin to `test/announced-result-types.spec.ts` for the branching that matters: `(select count(*) from t)` announces non-null; `(select count(*) from t group by k)` and `(select v from t where …)` with `v` NOT NULL announce nullable. No other new tests.

## TODO

- Add `alwaysYieldsARow` in `planner/analysis/` (one function, doc comment stating the accepted shapes).
- Use it in `ScalarSubqueryNode.getType()`.
- Fix the fallout: `07.6.1-subquery-extras.sqllogic`, `lens-advertisement.spec.ts`, and whatever else the suite reports for the same reason.
- `docs/sql-select.md` §3.6: add the subquery-may-find-no-row example.
- Add the three-case pin.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
