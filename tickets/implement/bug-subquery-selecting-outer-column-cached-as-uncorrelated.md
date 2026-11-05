description: A subquery that simply selects a column of the outer query, such as `(select t.b from u)`, is treated as if it did not depend on the outer row, so every outer row gets the first row's value, and a CHECK written this way lets bad rows into a table. The fix makes such a subquery count as dependent on the outer row and stops sharing one stored result of a WITH query between outer rows.
architecture: docs/runtime-caching.md#shared-cte-materialization-multi-reference-ctes
files:
  - packages/quereus/src/planner/nodes/project-node.ts  # attributesCache: the branch that keeps a plain column's attribute id
  - packages/quereus/src/planner/cache/materialization-advisory.ts  # shouldMaterializeCTE and the recursive branch of markCTEMaterialization
  - packages/quereus/src/planner/cache/correlation-detector.ts  # no code change expected; its doc comment should state the new guarantee
  - packages/quereus/src/planner/nodes/returning-node.ts  # same branch, deliberately left alone (see below)
  - packages/quereus/test/logic/07.8-correlated-subquery-edges.sqllogic  # neighbour of the new test file
  - docs/runtime-caching.md  # § Shared CTE materialization
  - docs/optimizer.md  # Materialization Advisory
repro: verified
----

## Cause (confirmed)

`ProjectNode` gives a projected plain column the attribute id of the column it reads, even when that column comes from an outer query and not from the projection's own source. So `(select t.b from u)` outputs an attribute carrying `t.b`'s own id.

`collectDefinedAttributes` in the correlation detector adds every relational node's output attributes to the set the subquery "defines". The outer id lands in that set, the reference to `t.b` no longer looks external, and the subquery reads as uncorrelated. Nodes above the projection (`Filter`, `Sort`, `Limit`, `Alias`, `Cache`, set operations) republish their source's attributes, so a fix that only skipped the projection inside the detector would still see the outer id arrive from them.

## Fix

**Part 1: a projection only keeps an id its source publishes.** In the `attributesCache` of `ProjectNode`, keep the id only when the source has it; otherwise fall through to the existing branch that mints a fresh id:

```ts
if (proj.node instanceof ColumnReferenceNode && sourceTypeById.has(proj.node.attributeId)) {
```

The result is that a projection cannot output an outer column's id, so the detector and everything else that reads `getAttributes()` get the right answer without changes. At run time the reference itself still resolves to the outer row, including an `order by t.b` above the projection (`ordered` below). `withChildren` and `withProjections` keep the fresh id through optimizer rebuilds because they pass predefined attributes.

Do not make the same change in `ReturningNode`. Its columns read the old and new row of the write, which its source may not publish as attributes, and a subquery that writes already takes the run-once path in `emitScalarSubquery`. Under Part 1, `(insert ... returning t.b)` gave 5, 5, 5 and wrote one row per statement, which is the documented run-once contract. Record this as a `NOTE:` at that branch.

**Part 2: a WITH query that reads the outer row is not stored for the whole statement.** `emitCTE` keeps one buffer per statement execution, so a stored body that reads the outer row replays the first row's values. Part 1 does not change this (`cte2ref`, `cteHint` below). The original ticket asked for an answer here, either refusing the shape or not storing it. The decision is to use both, depending on whether re-running the body can change the result:

| WITH body reads the outer row, and it would be stored (two or more references, or `materialized`) | Behavior | Why |
|---|---|---|
| Deterministic and read-only (`PlanNodeCharacteristics.isFunctional`) | Not stored, even when hinted `materialized`; each reference re-runs the body | Same results as sharing, so the hint is only a performance request |
| Non-deterministic | Refused at planning with an error naming the CTE | Re-running would give two references different values, and sharing would freeze the first row |
| Recursive, marked for shared buffering | Refused at planning with an error naming the CTE | Sharing replays the first row, and un-sharing brings back the runaway described at the recursive branch of `markCTEMaterialization` |

A body that writes cannot reach this: planning already rejects a data-modifying WITH inside a subquery (`dmlCte` below). `not materialized` keeps working as written (`notMat` below). A WITH body that does not read the outer row should keep its one buffer, even inside a correlated subquery.

## Evidence

Table data: `u` holds one row; `t` holds `(1, 5), (2, -5), (3, 9)` as `(a, b)`. "Part 1" is the attribute change alone. "Both" adds a trial gate of `if (isCorrelatedSubquery(node.source)) return false;` before the hint and count check in `shouldMaterializeCTE`. These were temporary patches and have been removed, so none of this code is in the tree.

With both patches, `yarn workspace @quereus/quereus run test` reported 11057 passing, 26 pending, no failures. That run has no refusal arm, and `yarn test:store` was not run.

Shapes with no stored WITH query, in the select list of `from t` unless a full statement is shown:

| Shape | Query | Today | Part 1 |
|---|---|---|---|
| `base` | `(select t.b from u)` | 5, 5, 5 | 5, -5, 9 |
| `derived` | `(select x from (select t.b as x from u) d)` | 5, 5, 5 | 5, -5, 9 |
| `filtered` | `(select x from (select t.b as x from u) d where x is not null)` | 5, 5, 5 | 5, -5, 9 |
| `ordered` | `(select t.b from u order by t.b)` | 5, 5, 5 | 5, -5, 9 |
| `union` | `(select t.b from u union all select null where false)` | 5, 5, 5 | 5, -5, 9 |
| `nestedTwo` | `(select (select t.b from u) from u)` | 5, 5, 5 | 5, -5, 9 |
| `where` | `select a from t where (select t.b from u) > 0` | rows 1, 2, 3 | rows 1, 3 |
| `inWhere` | `select a from t where 9 in (select t.b from u)` | no rows | row 3 |
| `notIn` | `select a from t where 9 not in (select t.b from u)` | rows 1, 2, 3 | rows 1, 2 |
| `lateralFilter` | `select t.a, d.x from t join lateral (select x from (select t.b as x from u) dd where x > 0) d on 1=1` | rows 1, 2, 3 | rows 1, 3 |
| `semi` | `select a from t where a in (select x from (select t.a as x from u) d)` | error: No row context found for column a | rows 1, 2, 3 |

Shapes with a WITH query:

| Shape | Query | Today | Part 1 | Both |
|---|---|---|---|---|
| `cte1` | `(with c as (select t.b as x from u) select max(x) from c)` | 5, 5, 5 | 5, -5, 9 | 5, -5, 9 |
| `cte2ref` | `(with c as (select t.b as x from u) select c1.x + c2.x from c c1 join c c2 on 1=1)` | 10, 10, 10 | 10, 10, 10 | 10, -10, 18 |
| `cteHint` | `(with c as materialized (select t.b + 0 as x from u) select x from c)` | 5, 5, 5 | 5, 5, 5 | 5, -5, 9 |
| `chain` | `(with c as (select t.b as x from u), d as (select x from c) select d1.x + d2.x from d d1 join d d2 on 1=1)` | 10, 10, 10 | not run | 10, -10, 18 |
| `recur` | `(with recursive c(x) as (select t.b union all select x+1 from c where x < t.b+2) select max(x) from c)` | error: exceeded maximum iteration limit | 7, -3, 11 | 7, -3, 11 |
| `recurJoin` | `(with recursive c(x) as (select t.b union all select x+1 from c where x < t.b+1) select max(c1.x + c2.x) from c c1 join c c2 on 1=1)` | error: exceeded maximum iteration limit | 12, 12, 12 | 12, 12, 12 (still wrong, so it needs the refusal) |
| `notMat` | `(with c as not materialized (select t.b as x from u) select c1.x + c2.x from c c1 join c c2 on 1=1)` | not run | 10, -10, 18 | 10, -10, 18 |
| `dmlCte` | `(with c as (insert into log values (t.a, t.b) returning v) select v from c)` | not run | error: only allowed in a statement's own leading WITH | not run |

The CHECK from the original report: `create table w (a integer primary key, b integer null, check ((select new.b from u) > 0))` followed by `insert into w values (1, 5), (2, -5)` stored both rows today. With Part 1 the insert fails with `CHECK constraint failed` and stores nothing. The same held for a bare `b`, for the table-qualified `w.b`, and for a CHECK reading the column through an aggregate over a derived table or a CTE.

`lateralFilter`, `semi`, and `recur` were wrong in ways the scalar cache does not explain. Part 1 corrected all three with no change to any optimizer rule.

**Not measured:**

- The two refusal arms, since the trial gate has no refusal.
- A body with a visibly non-deterministic function. The one trial probe used `random() % 1`, which always yields 0, so it cannot show differing values. Confirm that `random()` makes the body fail `isFunctional` when writing that test.
- An uncorrelated multi-reference WITH query inside a correlated subquery. It is expected to keep its one buffer and return correct rows, but nothing here ran that exact shape.

A recursive query whose two mentions share one reference, `(with recursive c(x) as (select t.b union all select x+1 from c where x < t.b+2) select (select max(x) from c) + (select min(x) from c))`, gave the correct 12, -8, 20 under Part 1 and under both patches. The likely reason is that sharing one reference keeps the count below two so it is never marked, though the count was not inspected. Keep this as a test case: it must not be refused.

## TODO

- Apply Part 1 in `project-node.ts` and update the comment on that branch, which says the id is always preserved
- Add the `NOTE:` at the matching branch in `returning-node.ts`
- State the guarantee in the doc comment of `correlation-detector.ts`: a projection's output never carries an outer column's id, which is what makes the defined-attributes walk sound
- Add the correlated gate to `shouldMaterializeCTE`, the non-deterministic refusal, and the refusal in the recursive branch of `markCTEMaterialization`, using `StatusCode.UNSUPPORTED` if it fits; update the doc comments on both, which currently describe reference count and hint as the whole decision
- Add a new sqllogic file next to `07.8-correlated-subquery-edges.sqllogic` holding the reproduction: the shapes above, the CHECK insert, both refusals, the shared-reference recursive query, and the uncorrelated multi-reference WITH query inside a correlated subquery
- Run the CHECK case under `yarn test:store` as well, because the multi-row insert goes through each storage module's constraint path
- Update `docs/runtime-caching.md` § Shared CTE materialization, which says a CTE is evaluated exactly once per statement execution, and the Materialization Advisory text in `docs/optimizer.md`; check `docs/sql-select.md` for any statement about the `materialized` hint
- Run `yarn build`, `yarn lint`, and `yarn test`
