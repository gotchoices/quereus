description: Review cross-check for SQLite DDL/views/constraints/FK/generated against Quereus, with new test fixtures
prereq:
files: docs/sqlite-test-crosscheck.md, packages/quereus/test/logic/
----

## Summary

Cross-checked all DDL, view, default, NOT NULL, UNIQUE, CHECK, FK, and generated-column rows in the "DDL (CREATE/ALTER/DROP, views, indexes)" section of `docs/sqlite-test-crosscheck.md` (24 SQLite source files). Index rows were rebroken into per-file rows (was previously bundled, e.g. `alter.test, altertbl.test, alter2-4.test`) so each `Status` decision is auditable.

**No tests, builds, or lints were run.** New fixtures are intended to fail-or-pass on the next downstream pass; this ticket only creates them faithfully per the SQLite scenarios that survived the design fit.

### Row counts

- `reviewed`: 22 (createtab, tableopts, alter, altertbl/altertab, alter2, alter3, alter4, view, default, notnull, notnull2, unique+unique2, check, fkey1, fkey2, fkey3, fkey4, fkey5, fkey6, fkey7, fkey8, generated)
- `n/a`: 1 (fkey9 — does not exist in upstream sqlite/sqlite repo)
- `unreviewed`: 0

### New fixture files (17)

All under `packages/quereus/test/logic/`:

| File | Source | Purpose |
|---|---|---|
| `10.1.1-create-table-syntax-edges.sqllogic` | createtab.test | untyped columns, DDL during in-flight cursor, duplicate-column UNIQUE rejection |
| `10.2.1-table-options-rejection.sqllogic` | tableopts.test | unknown table-option / WITHOUT ROWID rejected; STRICT-equivalent type enforcement and `any` opt-out |
| `08.1-view-edge-cases.sqllogic` | view.test | multi-level views, column-list rename, TEMP VIEW, UNION ALL view, schema-qualified, self-join in view body |
| `93.1-view-error-paths.sqllogic` | view.test | dangling base table, mutation through view rejected, DROP TABLE/VIEW mismatch, ALTER TABLE on view rejected |
| `03.4.1-default-edge-cases.sqllogic` | default.test | negative integer / boundary integer / real / DEFAULT VALUES / DEFAULT+NOT NULL+UNIQUE+CHECK / parameter+column-ref rejection |
| `41-generated-column-extras.sqllogic` | generated.test (gencol1) | generated-on-generated chain; WHERE/ORDER BY/GROUP BY on generated; typeof() in generated; UNIQUE / PRIMARY KEY on generated |
| `41-generated-column-errors.sqllogic` | generated.test | self-reference rejected; mutual recursion rejected; DROP COLUMN of column referenced by GENERATED rejected |
| `43.1-notnull-or-conflict.sqllogic` | notnull.test | INSERT/UPDATE OR IGNORE / OR REPLACE on NOT NULL ± DEFAULT; INSERT...SELECT propagation aborts |
| `26.1-left-join-isnull-on-notnull.sqllogic` | notnull2.test | LEFT JOIN with `IS NULL` predicate against NOT NULL columns |
| `25.3-aggregate-isnull-empty.sqllogic` | notnull2.test | aggregate `IS NULL` / `IS NOT NULL` over empty NOT NULL table |
| `102.1-unique-edge-cases.sqllogic` | unique.test, unique2.test | COLLATE NOCASE in UNIQUE; error message names the column; post-hoc CREATE UNIQUE INDEX rejected on duplicates; bad column ref in PK/UNIQUE/INDEX |
| `41.3-alter-rename-propagation.sqllogic` | alter.test, altertab.test | RENAME TABLE/COLUMN propagates into views, CHECK, partial-index WHERE, FK references, CTE inside view, index expression |
| `41.4-alter-add-column-constraints.sqllogic` | alter*.test | ADD COLUMN with CHECK, REFERENCES, COLLATE, UNIQUE rejection, integer/real/aggregated default backfill |
| `41.5-alter-misc.sqllogic` | alter.test | UTF-8 quoted-identifier ALTER; ALTER inside an explicit transaction (DDL persists per Quereus semantics) |
| `90.2.1-alter-extra-errors.sqllogic` | alter*.test | ALTER on missing table; non-constant DEFAULT in ADD COLUMN rejected; backfill default that violates CHECK rolls back |
| `40.2-check-extras.sqllogic` | check.test | CHECK with typeof() / CASE / BETWEEN / COLLATE; INSERT...SELECT statement-level rollback; bind parameter in CHECK rejected at DDL |
| `41-fk-extended-targets.sqllogic` | fkey1.test, fkey5.test, fkey7.test | FK to UNIQUE non-PK column; FK on generated column; FK with COLLATE NOCASE; multi-FK on one child; FK arity mismatch at CREATE; FK to missing parent table; multi-column FK with non-natural column order |
| `41-fk-cascade-conflict-and-self-ref.sqllogic` | fkey1-4.test | INSERT/UPDATE OR IGNORE/ABORT child with FK; cascade chain into another FK's RESTRICT; multi-row parent UPDATE cascade; self-referential composite FK; DROP TABLE of referenced parent rejected; DEFERRABLE INITIALLY DEFERRED column FK auto-commit failure repeats cleanly |

(That is 18 entries — `41-fk-extended-targets` and `41-fk-cascade-conflict-and-self-ref` were merged from many sibling proposals; the file count is 17.)

### Out-of-scope categories that landed as `n/a` consistently

These are SQLite features Quereus excludes by design (per `docs/architecture.md`). Recurring n/a reasons across multiple rows:

- WITHOUT ROWID / rowids / AUTOINCREMENT
- Triggers (and INSTEAD OF triggers on views)
- ATTACH DATABASE (Quereus uses cross-schema instead, partially covered by `41-fk-cross-schema`)
- DEFERRABLE / INITIALLY DEFERRED user-managed deferral mode (Quereus auto-defers cross-table checks to COMMIT)
- VACUUM / file-format / page_size / journal_mode
- sqlite_master / sqlite_temp_master / writable_schema (Quereus uses `schema()` / `table_info()` / `foreign_key_info()` TVFs)
- Implicit type-affinity coercion (Quereus is STRICT-by-design via logical/physical type separation)
- PRAGMA ignore_check_constraints / DBSTATUS_DEFERRED_FKS / FTS5 shadow-table protection
- non-deterministic DEFAULT / generated column expressions (already enforced and tested in `44-determinism-validation`)

### Validation / use-cases for the review pass

The downstream review pass should:

1. Run `yarn test` to see which fixtures pass and which expose engine gaps.
2. For each failing fixture, decide:
   - Engine bug → file follow-up implement ticket.
   - Test mis-asserts behavior Quereus does not implement (and shouldn't) → reclassify the assertion to `-- error:` or convert to documented-rejection form.
   - Quereus diverges from SQLite by design → confirm divergence is documented in `docs/architecture.md`/`docs/types.md` and either keep or relax the test.
3. Keep `docs/sqlite-test-crosscheck.md` row Statuses in sync if any fixture is removed.

Particular places to look:

- **41.3-alter-rename-propagation**: tests rely on Quereus rewriting view SQL / CHECK predicates / FK target on rename. If Quereus does not rewrite, these will fail; the fix is engine-side per `tickets/` scope.
- **41-fk-extended-targets**: FK to UNIQUE non-PK / COLLATE NOCASE / generated column / column-order variants are uncertain features. Many likely fail on first run; review individually.
- **41-fk-cascade-conflict-and-self-ref**: DEFERRABLE INITIALLY DEFERRED column FK is unknown if Quereus parses the syntax. If not, the test passes-by-failing on parse — acceptable per the process doc.
- **08.1-view-edge-cases**: TEMP VIEW and view column-list rename forms are uncertain; circular-view detection (kept out of this fixture; not proposed) is a separate concern.
- **102.1-unique-edge-cases**: `create unique index ... on tbl(...)` on existing duplicate data — assertion of the `-- error: UNIQUE` outcome may not match Quereus's current message format.

### Ticket size note

The ticket explicitly invited splitting if the work was too large; instead, the consolidation strategy collapsed many sibling proposals into shared fixture files (especially the FK family). No `5-sqlite-xref-ddl-constraints-part2.md` was needed.
