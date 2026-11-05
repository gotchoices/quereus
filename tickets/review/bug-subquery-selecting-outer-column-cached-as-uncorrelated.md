description: A subquery that simply selected a column of the outer query, such as `(select t.b from u)`, was treated as not depending on the outer row, so every outer row got the first row's value and a CHECK written this way let bad rows in. Such a subquery now counts as dependent on the outer row, and a WITH query that reads the outer row is no longer stored for the whole statement.
architecture: docs/runtime-caching.md#shared-cte-materialization-multi-reference-ctes
files:
  - packages/quereus/src/planner/nodes/project-node.ts  # attributesCache: keeps a plain column's id only when the source publishes it
  - packages/quereus/src/planner/cache/materialization-advisory.ts  # shouldMaterializeCTE gate and refusal; recursive refusal in markCTEMaterialization
  - packages/quereus/src/planner/cache/correlation-detector.ts  # doc comment only
  - packages/quereus/src/planner/nodes/returning-node.ts  # NOTE only, behaviour deliberately unchanged
  - packages/quereus/test/logic/07.8.2-subquery-selecting-outer-column.sqllogic  # new
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
| Non-deterministic or writing | Refused at planning | `StatusCode.UNSUPPORTED`: `CTE 'c' reads a column of an outer query and is non-deterministic or writes data...` |
| Recursive, referenced two or more times | Refused at planning | `StatusCode.UNSUPPORTED`: `Recursive CTE 'c' reads a column of an outer query...` |

`not materialized` still runs a non-recursive body once per reference. A body that does not read the outer row keeps its one buffer, even inside a correlated subquery.

## Test added

`test/logic/07.8.2-subquery-selecting-outer-column.sqllogic` is one file, because the logic runner stops at a file's first failure. It covers:

- **Scalar shapes:** base, derived, filtered, ordered, union, nested, plus `group by`, `distinct` and `limit`. The last three were not in the original ticket's table.
- **Predicates and joins:** `where`, `in`, `not in`, lateral with filter, and the semi-join shape that used to raise `No row context found`.
- **WITH queries reading the outer row:** one reference, two references, hinted, chained, `not materialized`, and recursive with one reference. Also the recursive query mentioned twice under one alias, which must not be refused.
- **Both refusals:** non-deterministic (two references, and hinted) and recursive with two references.
- **One buffer kept:** a `random()` body that does not read the outer row must give one distinct value across all outer rows and both references. This is the case the original ticket listed as not measured.
- **CHECK constraints:** a direct read and a read through a WITH query. The bad row is second, so caching the first row would admit it, and the test confirms nothing is stored.

## Validation

- `yarn build`, `yarn lint` and `yarn test` pass; the engine package reports 11058 passing, 26 pending.
- `yarn test:store` passes with 11051 passing, 33 pending. That run's reporter does not name files, so the new file was also run alone under `QUEREUS_TEST_STORE=true`, and it passes.
- Disabling each part of the fix in turn fails the new file at the matching statement: Part 1 at line 22, the correlated gate at line 71, the non-deterministic refusal at line 96, the recursive refusal at line 108.
- `random()` does fail `isFunctional`; the refusal test depends on it, which settles the ticket's open question.
- Extra shapes probed by hand and correct, not added as tests: `order by` on an outer-reading subquery, alias sort inside the subquery with and without `limit`, `values`, window, `intersect`, `except`, `having`, grouped outer query. Top-level WITH queries with `random()` over joins, aggregates, windows and index seeks are not falsely refused, and neither is a top-level recursive query referenced twice.

## Known gaps for the reviewer

- **One name mentioned twice undercounts.** `(with c as (select t.b + random() as x from u) select (select max(x) from c) = (select min(x) from c))` is not refused and gives the two mentions different values, because both share one reference node and the count stays at one. The same happens with no outer read at all, so it predates this work. Filed as `bug-cte-mentioned-twice-under-one-name-runs-twice`. The recursive test case above relies on this undercount, and that ticket says so.
- **The original ticket's claim about writing bodies is not quite right.** It said a body that writes cannot reach the refusal. A data-modifying WITH member cannot, but a body holding a writing scalar subquery does: `with c as materialized (select (insert into log values (t.a) returning v) as x from u)` is refused, which is why the message says "or writes data". The error's advice to use `not materialized` was not run for that writing shape.
- **`ReturningNode` still publishes an outer id.** This is deliberate per the ticket, and recorded as a `NOTE:` at that branch. A probe confirmed `(insert ... returning t.b)` gives 5, 5, 5 and writes one row.
- **View writes.** A view whose filter uses a WITH query reading the view's row can be read but not written through (`b.x isn't a column`). This is separate from this diff. Filed as `bug-view-write-rejects-with-query-reading-the-view-row`.
- **A stale doc statement was also fixed.** `docs/sql-select.md` § 3.7.3 said materialization hints were "not currently enforced". That had stopped being true before this ticket, so it was rewritten alongside the new table.

## Review findings index

- Tripwire parked as a `NOTE:` in `returning-node.ts`: the outer id stays while a writing subquery is run-once; it needs the same check if RETURNING ever becomes re-runnable per outer row.
