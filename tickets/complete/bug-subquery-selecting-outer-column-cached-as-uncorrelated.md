description: A subquery that simply selected a column of the outer query, such as `(select t.b from u)`, was treated as not depending on the outer row, so every outer row got the first row's value and a CHECK written this way let bad rows in. Such a subquery now counts as dependent on the outer row, and a WITH query that reads the outer row is no longer stored for the whole statement.
architecture: docs/runtime-caching.md#shared-cte-materialization-multi-reference-ctes
files:
  - packages/quereus/src/planner/nodes/project-node.ts  # attributesCache: keeps a plain column's id only when the source publishes it
  - packages/quereus/src/planner/cache/materialization-advisory.ts  # references summed per WITH query; storing gate and refusals
  - packages/quereus/src/planner/cache/correlation-detector.ts  # doc comment only
  - packages/quereus/src/planner/nodes/returning-node.ts  # NOTE only, behaviour deliberately unchanged
  - packages/quereus/test/logic/07.8.2-subquery-selecting-outer-column.sqllogic
  - docs/runtime-caching.md
  - docs/optimizer.md
  - docs/sql-select.md
repro: verified
----

## What changed

**Attribute ids.** `ProjectNode` gave a projected plain column the id of the column it read, even when that column came from an outer query. The correlation detector counts every relational node's output as defined by the subquery, so the outer reference stopped looking external. A projection now keeps the id only if its source publishes it, and mints a fresh one otherwise. This corrected the scalar cache, `IN`, lateral joins and CHECK constraints with no change to any optimizer rule.

**WITH queries reading the outer row.** `emitCTE` buffers rows for the whole statement, so a stored body replayed the first outer row. When two or more references or a `materialized` hint would store such a body:

| Body | Behaviour | Error |
|---|---|---|
| Deterministic and read-only | Not stored, even when hinted; each reference re-runs it | none |
| Non-deterministic | Refused at planning | `StatusCode.UNSUPPORTED`, recommends `not materialized` |
| Writes through a scalar subquery | Refused at planning | `StatusCode.UNSUPPORTED`, no recommendation |
| Recursive, referenced two or more times | Refused at planning | `StatusCode.UNSUPPORTED` |

`not materialized` still bypasses the storing decision for a non-recursive body. A body that does not read the outer row keeps its one buffer, even inside a correlated subquery.

**Added in review: reference counting.** Plain WITH queries now sum references per query across plan copies, as recursive ones already did, and the `with recursive` keyword on a non-recursive member no longer blocks storing. See *Review findings*.

## Review findings

**Method.** Read the implement-stage diff (`ticket(implement): bug-subquery-selecting-outer-column-cached-as-uncorrelated`) before the handoff, then ran several dozen SQL probes against the built engine alongside reading the code.

**Major, fixed in this pass.** Both predate this diff, and both let shapes skip the new refusals:

- **A constant expression in a WITH body broke sharing.** Constant folding splits a two-reference WITH query into one copy per reference, each with a parent count of 1, and `shouldMaterializeCTE` read that per-copy count. `with c as (select random() + (1 + 1) as x from u) select c1.x = c2.x from c c1 join c c2 on 1=1` returned false. The correlated form skipped the refusal, and a scalar `insert` in a twice-referenced body ran twice and failed with a UNIQUE error. `MaterializationAdvisory` now sums parent counts per `tableDescriptor` for both kinds of WITH query. These probes now give the correct result, with one write.
- **The `with recursive` keyword disabled storing.** A plain member of a `with recursive` clause builds a `CTENode` with `isRecursive` true, and the gate returned false on that flag, so the member was never stored, even when hinted, and a correlated `random()` body was not refused. Truly recursive queries are `RecursiveCTENode`, a separate class, so the check was removed.

Three cases were added to the `.sqllogic` file for these. Each wrong result was seen in probes before the fix: the folded `random()` case skipped the refusal, the keyword case gave different values, and the one-buffer case returned 0 instead of 1.

**Minor, fixed in this pass:**

- **Misleading advice in the error.** The refusal told writing bodies to use `not materialized` to "run it once per reference". Probed: that writes once per statement and returns the first row's value for all rows (`5, 5`, one row written). This answers the implementer's open question about that advice. The refusal is split in two, the writing form gives no advice, and the docs and a new test (nothing written on refusal) match.
- **Docs.** `docs/sql-select.md` § 3.7.3 stated the hints as absolute; it now says multi-referenced recursive and data-modifying WITH queries are always stored. `docs/optimizer.md` described per-parent counting and pointed to the wrong doc for the split-copy buffer. The detector's comment now names `ReturningNode` as the exception.
- **Backlog ticket.** `bug-cte-mentioned-twice-under-one-name-runs-twice` described the old count, so its cause is updated. It also records that a body with a constant expression is already stored in that shape, which was probed. Its repro still fails as filed.

**Tripwires:**

- `returning-node.ts` `NOTE:` (from implement): the outer id stays while a writing subquery is run-once; it needs the same check if RETURNING becomes re-runnable per outer row.
- `materialization-advisory.ts` comment at the writing refusal: `not materialized` on a writing correlated body still bypasses the refusal and replays the first row. That matches how a bare `(insert ... returning t.b)` behaves, so it is left as is.

**Checked, nothing found:**

- **False refusals, the main risk of a planning-time error.** Top-level `random()` bodies over group by, window, join, `in`, `exists`, correlated scalar subquery, lateral, union, table function, order by with limit, and having were not refused. Several of these were re-run with constant expressions after the count fix. Writing bodies whose RETURNING computes from `new` and `old` were not refused either.
- **Non-determinism deeper in a body.** `where random()`, nested scalar, `order by random()`, inside an aggregate and inside `exists` are all refused. A `random()` in a joined table whose column is unused is pruned first, so that body is correctly treated as deterministic.
- **Other nodes forwarding an outer id.** `group by` with `having`, derived aggregate, `intersect`, `except`, `values` and two outputs from one outer column all re-evaluate per row. Only `ReturningNode` forwards one, by design.
- **Write paths.** `insert ... select`, `update set` and `delete where` using an outer-reading subquery act per row.
- **Rebuilds.** `ProjectNode.withChildren` carries ids through, so a fresh id stays stable across optimizer rewrites. Prepared re-execution of a stored split WITH query sees new data.
- **Data-modifying WITH members in a subquery** are rejected at build, so they cannot reach the storing gate.
- **Type safety and resource cleanup.** No new `any` or held resources. `isCorrelatedSubquery` runs only when a body would otherwise be stored.
- **Implementer's tests.** None cut. The scalar shapes look repetitive, but each gives a different plan shape.
- **Backlog tickets.** Both have triage fields. `bug-view-write-rejects-with-query-reading-the-view-row` was read and is unaffected by this pass.

**New tickets:** none. Nothing else met the filing bar.

## Validation

- `yarn lint`, `yarn test` (engine package 11058 passing, 26 pending) and `yarn test:store` (11051 passing, 33 pending) passed after the reference-count fix.
- The refusal split came after those runs and changes only messages, docs and one test. After it, the engine build and lint pass, the `07.8` logic files pass, `07.8.2` passes under `QUEREUS_TEST_STORE=true`, and a `--grep` of CTE, recursive, materialized and `with` tests gives 2451 passing with no failures. The full suites were not re-run after the split.

## Known gaps

- **One name mentioned twice still undercounts** when the mentions share one reference node. Tracked by `bug-cte-mentioned-twice-under-one-name-runs-twice`, and one test case here pins the recursive form, as that ticket says.
- **View writes** with a WITH filter reading the view's row are rejected. Tracked by `bug-view-write-rejects-with-query-reading-the-view-row`.
