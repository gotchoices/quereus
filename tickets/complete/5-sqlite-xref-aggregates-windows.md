description: Review SQLite aggregate/window cross-check; verify new fixtures against engine
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/06.5.2-scalar-minmax.sqllogic, packages/quereus/test/logic/07.1-aggregate-filter-clause.sqllogic, packages/quereus/test/logic/07.2-aggregate-order-by.sqllogic, packages/quereus/test/logic/07.3-group-by-extras.sqllogic, packages/quereus/test/logic/07.5.1-window-named.sqllogic, packages/quereus/test/logic/07.5.2-window-nth-value.sqllogic, packages/quereus/test/logic/25.1-nested-aggregates.sqllogic, packages/quereus/test/logic/25.2-having-edge-cases.sqllogic, packages/quereus/test/logic/27.1-window-groups-frame.sqllogic, packages/quereus/test/logic/27.2-window-exclude.sqllogic
----

## Summary

Cross-checked all "Aggregates and window functions" rows in `docs/sqlite-test-crosscheck.md` plus the four aggregate-related rows owned by this ticket from the SELECT section (count, having, groupby, minmax*).

### Row counts

- 8 rows reviewed (with new fixtures added):
  - `aggfunc.test`
  - `aggnested.test`
  - `window1.test`–`window9.test`
  - `count.test`
  - `having.test`
  - `groupby.test`
  - `minmax.test` / `minmax2.test` / `minmax3.test` / `minmax4.test` (single index row)
- 1 row marked `n/a`:
  - `windowfault.test` — confirmed via WebFetch to contain only OOM/`tmpread` fault-injection wrappers around valid SQL; no applicable grammar/error-path subset.
- 0 rows left `unreviewed`.

### New fixtures

All under `packages/quereus/test/logic/`:

- `06.5.2-scalar-minmax.sqllogic` — scalar `min(x, y, ...)` / `max(x, y, ...)` multi-arg form, distinct from single-arg aggregates.
- `07.1-aggregate-filter-clause.sqllogic` — `FILTER (WHERE …)` on plain aggregates and on window aggregates.
- `07.2-aggregate-order-by.sqllogic` — `group_concat(... ORDER BY ...)` and `string_concat(... ORDER BY ...)`, including `DISTINCT` + `ORDER BY` and NULLS-first/last ordering.
- `07.3-group-by-extras.sqllogic` — `GROUP BY` ordinal / expression / `COLLATE NOCASE` / `CASE` / empty-input edge cases.
- `07.5.1-window-named.sqllogic` — named `WINDOW w AS (...)` clause incl. inheritance (one named window extending another).
- `07.5.2-window-nth-value.sqllogic` — `nth_value(expr, n)` with default and explicit frames; n=0/-1 error path.
- `25.1-nested-aggregates.sqllogic` — aggregate over derived/CTE aggregate, two- and three-level nesting.
- `25.2-having-edge-cases.sqllogic` — HAVING with `IS NULL`/`IS NOT NULL`, agg-vs-agg expressions, ungrouped-column rejection.
- `27.1-window-groups-frame.sqllogic` — `GROUPS` frame mode with `CURRENT ROW` / `UNBOUNDED PRECEDING` / `BETWEEN N PRECEDING AND M FOLLOWING`, plus partitioned variants.
- `27.2-window-exclude.sqllogic` — `EXCLUDE NO OTHERS` / `CURRENT ROW` / `GROUP` / `TIES`, including `EXCLUDE GROUP` over a `GROUPS` frame.

### Coverage already-present (no new fixtures written)

- COUNT semantics (`*` vs `expr` vs `DISTINCT`, NULL handling, GROUP BY, HAVING) — covered by 07-aggregates / 25-aggregate-edge-cases / 92-hash-aggregate-edge-cases.
- Most HAVING basics — covered by 07-aggregates and 25-aggregate-edge-cases.
- Most GROUP BY scenarios (NULL keys, multi-key, expressions via `length()`) — covered by 92-hash-aggregate-edge-cases.
- Aggregate MIN/MAX semantics over rows / NULL / empty / type-mixed — covered by 07-aggregates, 25-aggregate-edge-cases, 92-hash-aggregate-edge-cases.
- Core window functions (`row_number`, `rank`, `dense_rank`, `lag`, `lead`, `first_value`, `last_value`, `ntile`, `percent_rank`, `cume_dist`, `ROWS` and `RANGE` frames, NULL/peer handling) — covered by 07.5-window and 27-window-edge-cases.

### Out-of-scope (confirmed `n/a`)

- `windowfault.test` — fault-injection only.
- SQLite-specific scenarios within the in-scope files: `WITHOUT ROWID` MIN/MAX optimization, `OP_Count` plan-shape, rowid arithmetic, implicit type-affinity coercion in aggregate input. These are design-excluded in Quereus.

### Index doc updates

`docs/sqlite-test-crosscheck.md`:
- Aggregates-and-window-functions section: 4 rows updated.
- SELECT section: 4 rows owned by this ticket (count/having/groupby/minmax*) updated with `(see aggregates-windows ticket)` cross-reference.

## Verification points for the reviewer

1. **No tests run.** Per ticket rules and the process doc, no `yarn test` / `yarn build` / lint was executed. Each new fixture asserts the SQLite-faithful expected results; the next downstream pass will run them and decide what to do with failures.
2. **Engine code untouched** — only new `.sqllogic` files and `docs/sqlite-test-crosscheck.md` modified.
3. **Numeric prefixes** are correctly slotted: 06.5.x slots after `06.5-polymorphic-types`, 07.1-07.3 slot between `07-aggregates` and `07.5-window`, 07.5.1-07.5.2 slot after `07.5-window`, 25.x slots after `25-aggregate-edge-cases`, 27.x slots after `27-window-edge-cases`.
4. **One-known-omission** — `groupby.test` source 404'd from all attempted SQLite mirrors (raw.githubusercontent.com on master/main, sqlite.org cgi/file paths). Coverage assessment and gap fixture (`07.3`) drawn from documented SQLite GROUP BY behavior, the existing Quereus fixtures, and the SELECT section's notes for that row. If the reviewer can locate the original source, a follow-up may want to verify the gap list is complete.
5. **Use cases the new fixtures exercise** (in case the engine needs work):
   - FILTER syntax parsing inside aggregate-call and window-aggregate contexts.
   - ORDER BY parsing inside aggregate function calls (alongside DISTINCT).
   - Window NAMED/inherited definitions (`WINDOW w AS (...)`, including base-extension).
   - `nth_value` builtin.
   - `GROUPS` frame mode plus the four `EXCLUDE` clauses.
   - Scalar MIN/MAX dispatch by arity (2+ args = scalar, 1 arg = aggregate).
   - Multi-level aggregate nesting via subquery and CTE.
   - GROUP BY ordinal references.
   - HAVING with ungrouped columns must error.

## End
