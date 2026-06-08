description: Cross-check of SQLite WHERE-clause, BETWEEN, and NULL-predicate tests against Quereus
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/21.1-where-null-comparisons.sqllogic, packages/quereus/test/logic/21.2-between-edges.sqllogic, packages/quereus/test/logic/100.1-where-extras.sqllogic
----

## Summary

Cross-checked the three WHERE-related rows of the **WHERE, JOIN, indexing** section of `docs/sqlite-test-crosscheck.md`:

- `where.test`, `where2-9.test`, `whereA-J.test`
- `between.test`
- `null.test`

All three rows updated to `reviewed (claude, 2026-05-06)`. JOIN and index rows were untouched (owned by separate tickets).

## Counts

- **Rows reviewed**: 3 (all three in-scope rows)
- **Rows n/a**: 0
- **Rows unreviewed remaining**: 0
- **New `.sqllogic` fixtures written**: 3
- **Engine code modified**: none
- **Test/build/lint commands run**: none

## New fixtures

- `packages/quereus/test/logic/21.1-where-null-comparisons.sqllogic` — WHERE-context three-valued logic for NULL operands. Covers `col <op> NULL` for every comparison op, `NULL <op> col`, `NULL <op> NULL`, bare `NULL` in WHERE, `NOT NULL`, arithmetic NULL propagation, `NOT (val = null)` etc., and the null-safe `IS` / `IS NOT` operators (including `val IS 10`). Distilled from SQLite `test/where5.test` and `test/null.test`.
- `packages/quereus/test/logic/21.2-between-edges.sqllogic` — BETWEEN edge cases beyond the basic operator: NULL-bound propagation (value/lower/upper/both), reversed bounds (`val between 10 and 5` → empty), NOT BETWEEN with reversed bounds and with NULL operands, expression bounds (`a+1`, `b*2`), column-as-bound where bounds may be NULL, lexicographic TEXT bounds, BETWEEN inside HAVING and CASE, and BETWEEN in INNER and LEFT JOIN ON clauses. Distilled from SQLite `test/between.test`.
- `packages/quereus/test/logic/100.1-where-extras.sqllogic` — WHERE-clause shapes not in `100-predicate-normalization-edge-cases`: constant WHERE (`WHERE 0/1/true/false/1=1/1=0`) and combinations with column predicates, AND with multi-branch OR, composite tuple OR (`(a=10 AND b=100) OR (a=30 AND b=300)`), BETWEEN inside OR, multi-range OR, three-column AND/OR composite, IS NULL as an OR disjunct, IN-list duplicate dedup, and ON-clause conjunction reordering / index-presence invariance for LEFT JOIN. Distilled from SQLite `test/where.test`, `test/where4.test`, `test/where7.test`, `test/where8.test`, `test/where9.test`.

## Validation use cases (for the review-stage agent)

The fixtures assert observable output. When run, they will exercise:

- Quereus's three-valued logic at the WHERE-clause level (filters out unknown).
- Quereus's `IS` operator behaviour against non-null right-hand sides (null-safe equality, not just `IS NULL`).
- Quereus's BETWEEN evaluation under reversed bounds, NULL bounds, and expression bounds — none of which has a dedicated fixture today.
- Quereus's predicate normalization under composite AND/OR shapes that cross BETWEEN, IN, IS NULL, and constant short-circuits.
- LEFT JOIN ON-clause semantics with reordered conjuncts and BETWEEN-as-range-predicate.

If any of these fail at runtime, the failures should be triaged in three buckets:

1. Engine bug (file a fix ticket).
2. Documented Quereus deviation (update fixture to assert `-- error: <substring>` or remove the case with a one-line comment).
3. Test bug (the SQLite scenario doesn't apply — likely affinity coercion that slipped through; remove or convert to error assertion).

## Confirmation

- No engine source modified.
- No `yarn`, `eslint`, `tsc`, or test commands invoked.
- Only `docs/sqlite-test-crosscheck.md` and three new files under `packages/quereus/test/logic/` were written.

## Followups (not filed; per ticket constraint)

The ticket explicitly forbids filing follow-up tickets. Any failures discovered when these fixtures run should be addressed by the next implementation pass (engine or test fix as appropriate).
