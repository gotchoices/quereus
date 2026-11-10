description: A generated column added with ALTER TABLE ADD COLUMN stopped being computed after most later ALTERs of the same table, so rows written afterwards stored NULL in it. Every ALTER path (and the programmatic table-definition API) now rebuilds the generated-column evaluation order, and storing a table schema refuses one whose order misses a generated column.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/runtime/emit/alter-table.ts  # withEngineGeneratedColumnGraph helper; applied in every ALTER arm that registers a module answer
  - packages/quereus/src/runtime/emit/add-constraint.ts  # module path
  - packages/quereus/src/core/database.ts  # defineTable derives the order (review pass)
  - packages/quereus/src/schema/table.ts  # assertGeneratedColumnGraphMatchesColumns
  - packages/quereus/src/schema/schema.ts  # Schema.addTable calls the check
  - docs/invariants.md  # SCH-007
  - docs/schema.md  # TableSchema § Generated-column evaluation order
  - docs/sql-alter.md  # ADD COLUMN paragraph
  - packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic  # section 17, the reproduction
----
## What was wrong

A table schema carries two engine-derived fields, `generatedColumnDependencies` and `generatedColumnTopoOrder`. INSERT and UPDATE compute generated columns by walking `generatedColumnTopoOrder ?? []`. The memory module builds every `alterTable` answer from its own cached schema, which never received the order ADD COLUMN computed, and most ALTER arms registered that answer unchanged — so after e.g. `rename column`, an added generated column was NULL on every later write.

## What changed

- `withEngineGeneratedColumnGraph(db, schema)` (in `alter-table.ts`) re-derives the order; every ALTER arm that registers a module answer calls it before `schema.addTable` (rename column, add / drop column, alter column, add / drop / rename constraint, tag edit, native alter primary key), and passes the registered schema in its `table_modified` notify.
- Rename column rewrites the renamed table's own CHECK / DEFAULT / generated bodies before re-deriving (the derivation would otherwise reject a body naming the old column); `propagateColumnRename` then finds nothing left to rewrite on that table.
- `Schema.addTable` asserts (`INTERNAL`) that the order covers exactly the generated columns — invariant SCH-007.

## Review findings

- **Diff read first, fresh.** All arms checked against the claim. The table-rename arm spreads the catalog schema (graph preserved), ADD COLUMN's revert re-registers the pre-ALTER catalog schema, and the other `addTable` producers (index create/drop, tag swaps, MV helpers, import, store stats re-stamp) all spread an already-registered schema or go through CREATE TABLE's derivation — the seam check covers them, and no suite trips it.
- **Found and fixed — public `Database.defineTable`.** It registered a caller-supplied `TableSchema` as-is. With the new seam check, a definition with a generated column but no precomputed order would now fail with `INTERNAL` (a "producer bug" code for what is caller input); before, it silently wrote NULLs. SCH-007 says the order is engine-derived, so `defineTable` now derives it (`withEngineGeneratedColumnGraph(this, definition)`), documented in its JSDoc and in `docs/schema.md`. Verified with a scratch spec (not kept: one-line wiring, below the test bar).
- **Rename column's earlier in-place rewrite.** The rewrite and its ASTs are shared with `oldObject` exactly as before; only the timing moved ahead of the first notify, and the renamed table now gets one `table_modified` instead of two. No listener depends on the second one (MV, rename-propagation and sync suites pass under both backends).
- **Derivation throwing after the module mutated** (alter column, constraint arms, native alter primary key): checked the alter-column forms — NOT NULL, data type, default, collation — none touches a generated body, and the constraint / key arms do not change the column list, so the throw paths (unknown column, unbound qualifier, cycle) are unreachable there. Agree with the implementer: no NOTE.
- **Representation:** `ColumnSchema` allows `generated: true` with no `generatedExpr`; the graph skips such a column and the seam check would then refuse it. That refusal is the right outcome (it cannot be computed); no producer creates one. No action.
- **Scratch scenario (not kept):** add generated column → rename table → rename column → add / rename / drop check → alter column set default → insert + update: generated values correct throughout.
- **Tests:** none added or cut. Section 17 of `41.13` is the reproduction; the seam check runs on every registration in the suite.
- **Helper placement:** `add-constraint.ts` and now `core/database.ts` import the helper from `runtime/emit/alter-table.ts`. Moving it into `schema/` would add an import cycle (`schema/table.ts` → memory module → `column-source-resolver.ts`); `database.ts` already imports from `runtime/emit/`, so left as is.
- **Docs:** `invariants.md` SCH-007, `schema.md` and `sql-alter.md` read; `schema.md` updated for `defineTable`. Nothing else describes the graph's producers.
- **Validation:** `yarn workspace @quereus/quereus lint` clean; `yarn workspace @quereus/quereus test` 11141 passing, 26 pending. Store / isolation / sync suites were run by the implementer on the same arms; this pass's only code change is `defineTable`, which those suites do not call.
- **Pre-existing:** `yarn docs:check` word-cap failure on `docs/sql-select.md` was already triaged (commit `tess: triage pre-existing test failure`); not re-reported.
