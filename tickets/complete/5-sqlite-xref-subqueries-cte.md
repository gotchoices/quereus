description: Review SQLite subquery / CTE / IN / EXISTS / set-op cross-check fixtures
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic, packages/quereus/test/logic/07.7.1-in-extras.sqllogic, packages/quereus/test/logic/13.4-cte-extras.sqllogic
----

## Summary

Cross-checked the SQLite subquery / CTE / IN-EXISTS / set-op test corpus against existing Quereus coverage. New gap-fill fixtures land in three files; six index rows updated.

### Row tally

| Status | Count | Rows |
|---|---|---|
| reviewed | 4 | `subquery.test`+`subquery2.test`; `with1.test`–`with5.test`; `exists.test`; `in.test`+`in2-5.test` |
| n/a | 2 | `subqueryAsExpr.test` (404 upstream); `compound.test` (404 upstream — surface covered by select4/select8 review) |
| unreviewed | 0 | — |

### New fixture files

- **`packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic`**
  - Correlated scalar subquery in UPDATE SET clause
  - Dynamic LIMIT / OFFSET via scalar subquery
  - Scalar subquery with DISTINCT + ORDER BY + LIMIT in projection
  - Scalar subquery with constant projection + ORDER BY + LIMIT
  - EXISTS in SELECT projection (and inside CASE)
  - NOT EXISTS in SELECT projection
  - EXISTS with arithmetic / function-call correlation predicate

- **`packages/quereus/test/logic/07.7.1-in-extras.sqllogic`**
  - Row-value (tuple) IN with literal list and with subquery
  - Tuple NOT IN with subquery
  - IN with extra parentheses around the subquery (parser robustness)
  - IN with CASE expression as operand
  - IN list with arithmetic expressions in the value list
  - IN list with duplicate values (dedupe)
  - UPDATE / DELETE filtered by IN-subquery

- **`packages/quereus/test/logic/13.4-cte-extras.sqllogic`**
  - CTE name shadowing a same-named base table (and base table visible again outside the WITH scope)
  - VALUES clause as direct CTE source (and used in JOIN)
  - LIMIT applied inside a recursive CTE definition (early termination)
  - Nested WITH inside a recursive CTE base case
  - CTE inside a VIEW definition (and post-mutation re-evaluation)
  - CTE column-count mismatch (declared vs SELECT) — `-- error` assertion

### Validation guidance for the next pass

These tests are written faithfully against the SQLite scenarios; they have **not** been executed. Expect a mix of pass and fail when the engine pass runs:

- The scalar / EXISTS surface in 07.6.1 should largely pass — Quereus has solid scalar-subquery and EXISTS support; the dynamic LIMIT-via-scalar-subquery scenario is the most likely to surface a planner-side gap.
- The row-value (tuple) IN cases in 07.7.1 are the most uncertain — they exercise SQL standard `(a, b) IN ((..., ...))` syntax that may or may not be wired through the parser/planner. If they fail at parse time, that's a documented design choice to make.
- The CTE column-count-mismatch test in 13.4 asserts `-- error: column count`. Substring is conservative; adjust if Quereus's actual error message uses different phrasing.
- 13.4 includes a CTE-inside-VIEW scenario; if Quereus rewrites view bodies in a way that drops the WITH, the `select * from cte_view order by id;` should still produce the same rows.

### Constraints honored

- No engine code modified.
- No tests, builds, or lint commands run during this ticket.
- Six rows updated in `docs/sqlite-test-crosscheck.md`; no new gaps log created.
- `compound.test` and `subqueryAsExpr.test` confirmed 404 against `https://raw.githubusercontent.com/sqlite/sqlite/master/test/<file>.test` (`HTTP/1.1 404 Not Found`).

## Review-stage TODO

- [ ] Run the affected fixtures (`07.6.1-subquery-extras.sqllogic`, `07.7.1-in-extras.sqllogic`, `13.4-cte-extras.sqllogic`) and triage failures: engine fix vs. test reclassification.
- [ ] If row-value IN is rejected at parse time and that's the documented design, convert those scenarios to `-- error:` assertions or excise them and mark the row n/a *for tuple IN*.
- [ ] Adjust the `-- error: column count` substring in 13.4 if Quereus's mismatch error uses different phrasing.
- [ ] Confirm CTE-in-VIEW scenario in 13.4 against the view rewrite pipeline; the post-mutation re-evaluation should reflect the new base-table state.
- [ ] No code changes required if every new fixture passes; close out by moving to `complete/`.
