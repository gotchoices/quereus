description: Review SQLite SELECT/ORDER BY/LIMIT/DISTINCT cross-check fixtures (5-sqlite-xref-select-and-output)
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/01.1-select-projection-extras.sqllogic, packages/quereus/test/logic/28.1-compound-limit-offset.sqllogic, packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic, packages/quereus/test/logic/94.2-limit-offset-extras.sqllogic, packages/quereus/test/logic/10.6-distinct-edge-cases.sqllogic, packages/quereus/test/logic/90.6-select-error-paths.sqllogic
----

## Summary

Cross-checked the **"SELECT, projection, ORDER BY, LIMIT"** section of `docs/sqlite-test-crosscheck.md` against existing Quereus fixtures and SQLite's `select*.test`, `orderby*.test`, `limit*.test`, `distinct*.test`, and `e_select.test`. Six new `.sqllogic` files distill the genuinely-uncovered scenarios; the rest of the row coverage was already adequate or n/a by design.

Row counts (this section):

- **reviewed**: 14 row entries (`select1`–`select9`, `selectA`, the `selectB-E` bundle, the `orderby1-9` bundle, `limit`+`limit2`, `distinct`+`distinct2`, `e_select`)
- **n/a (file)**: `orderby9.test` — confirmed not present upstream
- **unreviewed**: 0
- Aggregate-heavy rows (`minmax*`, `count`, `having`, `groupby`) were already `reviewed` under the aggregates-windows ticket on a prior pass; `select3.test` and `select5.test` are tagged `(see aggregates-windows ticket)` for the same reason.

## New fixtures (no tests run; failing-on-write expected)

- `packages/quereus/test/logic/01.1-select-projection-extras.sqllogic` — Duplicate wildcard expansion (`SELECT *, *`), wildcard-plus-literal, `table.*` across self-join with shared column names, qualified column refs through a comma-syntax cross-join, parenthesized FROM clauses (`(t1 JOIN t2) JOIN t3` and `t1 LEFT JOIN (t2 JOIN t3)`), UNION column-name derivation (left SELECT wins).
- `packages/quereus/test/logic/28.1-compound-limit-offset.sqllogic` — LIMIT / OFFSET applied to UNION, UNION ALL, INTERSECT, EXCEPT (ASC and DESC), `LIMIT 0` short-circuit, VALUES clause as compound operand (UNION/INTERSECT/EXCEPT), VALUES mixed with SELECT, compound query as derived table with outer WHERE / DISTINCT / GROUP BY, inner LIMIT inside derived table.
- `packages/quereus/test/logic/28.2-orderby-expression-extras.sqllogic` — ORDER BY positional reference (1, multi-column, mixed direction), ORDER BY arithmetic / abs() / CASE / `a + b NULLS LAST`, multi-key per-column COLLATE override (`order by a collate binary, b collate nocase`), many-computed-column ordering preserves correct sort, alias and positional reference resolve to the same key.
- `packages/quereus/test/logic/94.2-limit-offset-extras.sqllogic` — Expression-valued LIMIT / OFFSET (`limit 1+1`, `offset 4-2`, both expression), OFFSET without LIMIT (rest of rows; OFFSET equal to row count returns empty), DISTINCT + LIMIT / OFFSET, multi-column DISTINCT + LIMIT, GROUP BY + LIMIT (alphabetical-key, top-N by aggregate, HAVING + LIMIT).
- `packages/quereus/test/logic/10.6-distinct-edge-cases.sqllogic` — `SELECT DISTINCT *`, DISTINCT after dropping the unique-key column, DISTINCT with reordered SELECT list, DISTINCT across CROSS JOIN, DISTINCT across LEFT JOIN with NULL-padded rows, DISTINCT inside both recursive and non-recursive CTEs, DISTINCT with explicit COLLATE NOCASE in projection, DISTINCT with duplicate column reference (`distinct x, x`).
- `packages/quereus/test/logic/90.6-select-error-paths.sqllogic` — Wrong-arity aggregate calls (`count(a, b)`, `sum(a, b)`, `min(*)`, `max(*)`), ORDER BY positional reference out of range (past column count, zero, negative), compound SELECT column-count mismatch in UNION / INTERSECT / EXCEPT.

## Test plan

- [ ] Run `yarn test` in `packages/quereus/`; new fixtures will likely surface mixed pass/fail results — that is expected (per process doc, this ticket created tests; making them pass is a separate downstream pass).
- [ ] For 90.6, verify the error substrings (`count`, `sum`, `min`, `max`, `order by`, `column`) match the engine's actual messages and tighten as needed.
- [ ] For 28.1, verify compound + LIMIT / OFFSET path: if Quereus's emitter doesn't yet accept LIMIT on a compound, expected behavior here is "fix the engine" rather than "weaken the test."
- [ ] For 28.1's VALUES-as-compound-operand cases (`values (...) union values (...)`), confirm parser support; if parser rejects, decide whether to tighten the grammar or restate the SQL using `select ... from (values ...)` while preserving the scenario.
- [ ] For 28.2's `order by 1, 2 desc` and other positional refs outside GROUP BY contexts, confirm the planner resolves positional ORDER BY against the projected SELECT list (existing positional usage in 07.3 is co-located with GROUP BY).
- [ ] For 10.6's `select distinct x, x from dc`, confirm the column-disambiguation serialization (`x`, `x:1`) matches existing convention used in 01.1 and elsewhere.
- [ ] For 94.2's `offset 2` (no LIMIT), confirm parser support — if `OFFSET` requires an accompanying `LIMIT` token in Quereus's grammar, this scenario should be reclassified as a parse-error (rare; the SQL standard allows OFFSET-only).
- [ ] Sanity-check the entries on the index doc — every row in the SELECT section should now be `reviewed` (or `n/a`); none `unreviewed`.

## Notes for reviewer

- No engine code was modified. No `yarn test`, no `yarn build`, no `yarn lint` — per ticket constraints.
- Subagent reports flagged many "uncovered" scenarios that were already exercised in existing fixtures (e.g., commutative equality, basic GROUP BY ordinal, COALESCE wrapping aggregates, NULL+DISTINCT). Those duplicates were filtered out before writing fixtures.
- Optimizer plan-shape concerns (SortCallback elimination, sqlite_search_count, block-sort thresholds, query-flattening with WHERE pushdown, merge-detection for compound SELECT, indexed DISTINCT skip-ahead) are uniformly `n/a` — they don't apply to Quereus's planner / cost model and aren't observable at the SQL surface.
- SQLite-specific surface that's `n/a` by design and documented inline: implicit type-affinity coercion, rowid arithmetic, `sqlite_master` direct edits, PRAGMA short_column_names / case_sensitive_like, NATURAL JOIN (not in parser), RIGHT/FULL OUTER JOIN (already pinned in `90.5`), FTS-specific `orderby7` content, alias-in-WHERE (SQLite extension).
- `select3.test` and `select5.test` are aggregate-heavy and were marked `(see aggregates-windows ticket)` per the implement ticket's coordination instruction; the aggregates row entries already cover the GROUP BY / DISTINCT-aggregate scenarios.
- `orderby9.test` is `n/a` — confirmed absent upstream. The bundled `orderby1.test – orderby9.test` row's reviewed status applies to the 1–8 files that exist.
