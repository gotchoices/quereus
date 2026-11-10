description: A generated column added with ALTER TABLE ADD COLUMN stopped being computed after most later ALTERs of the same table, so rows written afterwards stored NULL in it. Every ALTER path now rebuilds the generated-column evaluation order, and storing a table schema now refuses one whose order misses a generated column.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/runtime/emit/alter-table.ts  # new withEngineGeneratedColumnGraph helper (top of file); applied in runRenameColumn, runAddColumn, runDropColumn, runDropConstraint, runRenameConstraint, runAlterColumn, runTagEdit, runAlterPrimaryKey (native path)
  - packages/quereus/src/runtime/emit/add-constraint.ts  # module path (~267)
  - packages/quereus/src/schema/table.ts  # assertGeneratedColumnGraphMatchesColumns (next to assertPrimaryKeyCollationsMatchColumns)
  - packages/quereus/src/schema/schema.ts  # Schema.addTable calls the new check; JSDoc @throws updated
  - docs/invariants.md  # new SCH-007
  - docs/schema.md  # TableSchema § Generated-column evaluation order
  - docs/sql-alter.md  # ADD COLUMN paragraph: guarantee holds through later ALTERs
  - packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic  # section 17, the reproduction (added in the fix stage)
----
## What was wrong

A table schema carries two engine-derived fields, `generatedColumnDependencies` and `generatedColumnTopoOrder`. INSERT and UPDATE compute generated columns by walking `generatedColumnTopoOrder ?? []`, so a schema without it computes nothing. The memory module builds every `alterTable` answer from its own cached schema, which never received the order ADD COLUMN computed, and most ALTER arms registered that answer unchanged — so after e.g. `rename column`, the added generated column was silently NULL on every later write.

## What changed

- `withEngineGeneratedColumnGraph(db, returned)` in `alter-table.ts` (exported) = `withGeneratedColumnGraph(returned, buildColumnSourceResolver(db))`. Every ALTER arm that registers a module answer now calls it before `schema.addTable`: rename column, alter column, drop constraint, rename constraint, add constraint (module path in `add-constraint.ts`), alter primary key (native path; the shadow rebuild goes through CREATE TABLE). Add column, drop column and tag edit already did this and now use the same helper. ADD COLUMN's shared `resolveColumnInSource` was removed: the resolver is stateless (reads the live catalog per call, no memo), so a fresh one per call is equivalent.
- Each of those arms now passes the *registered* schema (the `addTable` return) as `newObject` in its `table_modified` notify.
- **Rename column**: before re-deriving the graph, the arm now runs `rewriteTableForColumnRename` on the renamed table's own definition (CHECKs, DEFAULT and generated bodies, self-referencing FK, index predicates) — mirroring the table-rename arm's pre-swap `rewriteTableForTableRename`. Without it the graph derivation rejects a generated body still naming the old column. `propagateColumnRename` later re-runs the same idempotent in-place rewrite over every table and finds nothing left on this one.
- **Seam check**: `Schema.addTable` calls `assertGeneratedColumnGraphMatchesColumns`, which throws `INTERNAL` unless the set of indices in `generatedColumnTopoOrder` equals the set of indices of columns with `generated` set. No registration path in the full suite tripped it (memory, store, isolation, sync, leveldb suites all pass), so no other producer needed fixing.
- Recorded as invariant SCH-007 in `docs/invariants.md`, back-linked from `docs/schema.md` § TableSchema; one sentence added to `docs/sql-alter.md` § ADD COLUMN.

## Validation

- `yarn workspace @quereus/quereus test`: 11141 passing, 26 pending. Section 17 of `41.13-alter-add-column-generated-backfill.sqllogic` (failed before on the memory module at the first post-rename row) passes.
- `yarn workspace @quereus/quereus test:store`: 11134 passing, 33 pending.
- After `tsc -b tsconfig.build.json`: `quereus-store` 2012, `quereus-isolation` 453, `quereus-sync` 878, `quereus-plugin-leveldb` 89 — all passing.
- `yarn workspace @quereus/quereus lint`: clean.
- Scratch check (not kept as a test): generated bodies written as `t.a + new.a + main.t.a + a`, a second generated column that reads the first, then renaming the base column, the generated column itself, and the key column — every later insert computed both generated columns, and the final graph was `topo [2, 3]`, deps `{2: [1], 3: [1, 2]}`.

## Tests added

None. Section 17 of `41.13` (added in the fix stage) is the reproduction; the seam check is exercised by every registration in the whole suite.

## For the reviewer — known gaps and behaviour changes

- **Rename column's first notify is now post-rewrite.** The `table_modified` that rename column fires before propagation now carries a schema whose CHECK / DEFAULT / generated bodies already name the new column (before, they were rewritten in place a moment later by `propagateColumnRename`). The ASTs are shared with `oldObject` either way, as before. All suites pass, including `41.3-alter-rename-propagation` and the MV rename suites under both backends, but this is the most behaviour-sensitive part of the diff.
- **The graph derivation can throw after the module has mutated** in the arms that did not run it before (alter column, constraint arms, native alter primary key, rename column). It throws only for a generated body naming a missing column, an unbound qualifier, or a cycle — none of which those arms can introduce (they do not change the column list, and rename rewrites the bodies first), and tables with such bodies already fail to load (see the accepted-tradeoff NOTE on `unboundQualifierError` in `schema/table.ts`). So I judged it unreachable and added no NOTE; a reviewer who disagrees may want a tripwire at the helper.
- **The memory module's own cached schema still has no graph.** Nothing reads generated-column order from it today (INSERT / UPDATE plan from the catalog); the ticket said not to make the module compute engine bookkeeping.
- **Pre-existing, unrelated:** `yarn docs:check` fails on `docs/sql-select.md` exceeding the 12000-word cap (12222 words, unchanged by this ticket). Written up in `tickets/.pre-existing-error.md` for triage. The docs this ticket touched pass the check.
