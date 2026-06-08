description: Review SQLite DML cross-check fixtures (INSERT/UPDATE/DELETE/UPSERT/RETURNING/REPLACE/CONFLICT)
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/01.5-insert-select.sqllogic, packages/quereus/test/logic/01.6-update-extras.sqllogic, packages/quereus/test/logic/01.7-update-from.sqllogic, packages/quereus/test/logic/01.8-delete-extras.sqllogic, packages/quereus/test/logic/42.1-returning-extras.sqllogic, packages/quereus/test/logic/47.1-upsert-conflict-targets.sqllogic, packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic, packages/quereus/test/logic/29.1-column-level-conflict-clause.sqllogic
----

## Summary

Cross-checked the 7 DML rows (INSERT family, UPDATE family, DELETE family, UPSERT family, RETURNING, REPLACE, CONFLICT family) of `docs/sqlite-test-crosscheck.md` against existing Quereus fixtures and the upstream SQLite test suite.  All 7 rows now carry final status; 8 new fixture files added.

Row counts:
- 7 of 7 rows reviewed.
- 0 unreviewed.
- Several individual files within multi-file rows are `n/a` (specifically: `update_from.test`, `updatecursor.test`, `upsert.test`, `replace.test`, `conflict4.test` do not exist upstream — confirmed via `gh api repos/sqlite/sqlite/contents/test/<name>` returning 404; `delete2.test` is n/a because its scenarios concern internal cursor-lock / index-corruption regressions not observable at the SQL surface).

## New fixtures

All under `packages/quereus/test/logic/`:

1. **`01.5-insert-select.sqllogic`** — INSERT…SELECT variants distilled from `insert2.test`, `insert4.test`, `insert5.test`:
   - column-reordering / partial column mapping
   - GROUP BY aggregation source
   - compound source (UNION ALL, EXCEPT)
   - LEFT JOIN source with NULL padding
   - DISTINCT source
   - LIMIT source
   - self-referential INSERT…SELECT
   - view-mediated INSERT…SELECT (view of target table)
   - CHECK constraint propagation across INSERT…SELECT
   - correlated WHERE referencing target table

2. **`01.6-update-extras.sqllogic`** — UPDATE features from `update.test`, `update2.test`:
   - UPDATE all rows (no WHERE)
   - scalar subquery in SET
   - multiple columns + mixed expressions in SET
   - column-list assignment `(a, b) = (select x, y)` (ticket-listed gap)
   - NOT condition in WHERE
   - OR conditions in WHERE
   - PK-column UPDATE (key change)

3. **`01.7-update-from.sqllogic`** — UPDATE…FROM (`update_from.test` n/a, but the feature is real per SQLite 3.33+):
   - basic single-table FROM equi-join
   - subquery in FROM
   - CTE in FROM
   - multi-table join in FROM

4. **`01.8-delete-extras.sqllogic`** — DELETE features from `delete.test`, `delete4.test`:
   - EXISTS / NOT EXISTS subquery
   - NOT(...) condition
   - OR conditions across columns
   - multi-column AND on non-PK columns
   - self-referential EXISTS
   - delete-all on composite-PK table
   - IN-subquery target

5. **`42.1-returning-extras.sqllogic`** — RETURNING extras from `returning1.test`:
   - scalar subquery in RETURNING list
   - INSERT…SELECT with RETURNING (multi-row)
   - quoted / bracketed identifier RETURNING
   - RETURNING empty on no-op DO NOTHING upsert
   - RETURNING with computed expressions (`||`, `length`)
   - generated-column projection
   - RETURNING empty on UPDATE OR IGNORE skip

6. **`47.1-upsert-conflict-targets.sqllogic`** — UPSERT advanced conflict targets from `upsert2.test`–`upsert4.test`:
   - composite UNIQUE target (full match, reversed order, partial-target rejection)
   - `excluded.col` arithmetic
   - `INSERT … AS alias` for the existing-row reference
   - UPSERT with CTE source
   - DO UPDATE WHERE filter (skip update if predicate fails)
   - column-list assignment in DO UPDATE SET
   - multi-row UPSERT (mix of conflict and non-conflict)

7. **`47.2-replace-and-or-clauses.sqllogic`** — REPLACE / OR-clause surface (the ticket calls this out as
   conflict-resolution that may differ in Quereus and needs to be pinned):
   - REPLACE INTO keyword (with conflict and without)
   - multi-row REPLACE
   - REPLACE that resolves multiple existing rows on different UNIQUE columns
   - REPLACE + RETURNING
   - UPDATE OR REPLACE on UNIQUE conflict
   - INSERT OR ABORT semantics (whole statement aborts; nothing inserted)
   - INSERT OR FAIL semantics (rows before the violation remain inserted)
   - INSERT OR ROLLBACK semantics (rolls back enclosing transaction)
   - INSERT OR IGNORE on CHECK
   - INSERT OR REPLACE does NOT mask CHECK violations

8. **`29.1-column-level-conflict-clause.sqllogic`** — DDL-level ON CONFLICT directives from `conflict2.test`,
   `conflict3.test`:
   - PRIMARY KEY ON CONFLICT REPLACE
   - PRIMARY KEY ON CONFLICT IGNORE
   - UNIQUE ON CONFLICT REPLACE
   - NOT NULL ON CONFLICT IGNORE
   - CHECK ON CONFLICT IGNORE
   - statement-level OR ABORT overrides column-level ON CONFLICT IGNORE

## Status calibration notes

Several upstream test files referenced in the index row do not exist in `sqlite/sqlite`:

| Filename | Status | Confirmed via |
|---|---|---|
| `update_from.test` | n/a (file absent) | `gh api repos/sqlite/sqlite/contents/test/update_from.test` → 404 |
| `updatecursor.test` | n/a (file absent) | 404 |
| `upsert.test` | n/a (file absent; `upsert2-4.test` do exist) | 404 |
| `replace.test` | n/a (file absent) | 404 |
| `conflict4.test` | n/a (file absent; `conflict.test`, `conflict2.test`, `conflict3.test` exist) | 404 |
| `delete2.test` | n/a by design (cursor-lock/index-corruption — not user-observable) | content review |

The features these absent files would have covered (UPDATE…FROM, REPLACE INTO, OR FAIL/ROLLBACK semantics, column-level ON CONFLICT) are still pinned by the new fixtures, distilled from the ticket's stated scope rather than from a non-existent upstream test file.

## Validation / usage

These fixtures are written *faithfully* per the process doc ("write each test asserting what the SQLite scenario demonstrates *should* work, then stop").  Running them is **explicitly out-of-scope for this ticket** — it's a downstream pass.  When the test suite is run:

- some tests may pass cleanly (existing well-supported features),
- some may fail because Quereus rejects a scenario by design (e.g. column-level ON CONFLICT directives may not be supported — the new fixture pins the answer either way),
- some may surface real engine gaps (e.g. UPDATE…FROM, column-list assignment, OR FAIL / OR ROLLBACK).

The next pass should run the fixtures, classify each failure as (engine-fix / test-adapt / reclassify-as-n/a), and either land an engine fix, adapt the assertion, or split the row into a finer-grained `n/a` slice.

## Constraints honored

- No test, build, or lint commands were executed.
- No engine code was modified.
- 8 new `.sqllogic` files added under `packages/quereus/test/logic/`.
- Index doc updated with final status for every DML row.
- No follow-up tickets filed; gaps are recorded in the new fixture files (per process).
