description: A generated column added with ALTER TABLE ADD COLUMN stops being computed after most later ALTERs of the same table (rename a column, change a column, add/drop/rename a constraint, change the primary key): rows written afterwards silently store NULL in it. Fix the ALTER paths so the computation order is always rebuilt, and add a check where table schemas are stored so this cannot quietly happen again.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/runtime/emit/alter-table.ts  # runRenameColumn (addTable ~459), runDropConstraint (~1401), runRenameConstraint (~1483), runAlterColumn (~1644), runAlterPrimaryKey native path (~1991); runDropColumn (~1335) and runTagEdit (~1746) already do it right
  - packages/quereus/src/runtime/emit/add-constraint.ts  # module.alterTable (~260) then schema.addTable (~267)
  - packages/quereus/src/schema/schema.ts  # Schema.addTable (~69) — the seam; assertPrimaryKeyCollationsMatchColumns is the precedent for a seam check
  - packages/quereus/src/schema/table.ts  # withGeneratedColumnGraph (~1615), extractGeneratedColumnDependencies (~1707)
  - packages/quereus/src/vtab/memory/layer/manager.ts  # the memory module's own cached TableSchema (addColumn ~1892, renameColumn ~2123)
  - packages/quereus/src/core/database.ts  # defineTable (~1717) also calls addTable
  - packages/quereus/test/logic/41.13-alter-add-column-generated-backfill.sqllogic  # section 17 — the reproduction, already added
repro: verified
----
## Root cause (confirmed)

Each table schema carries two derived fields, `generatedColumnDependencies` and `generatedColumnTopoOrder` (the order in which generated columns are evaluated on a write). INSERT and UPDATE planning read `generatedColumnTopoOrder ?? []` (`planner/building/insert.ts` ~316 and ~443, `planner/building/update.ts` ~222), so a schema without it computes no generated column at all — the column is left NULL, or fails NOT NULL.

The ADD COLUMN arm computes the graph (`withGeneratedColumnGraph`) only for the copy it stores in the catalog. The memory module keeps its own cached `TableSchema` inside its layer manager, which never receives that graph. Every later `module.alterTable(...)` returns a schema derived from that cached copy, and most ALTER arms store the returned schema with `schema.addTable` unchanged — so the graph disappears from the catalog.

Measured with a scratch script (memory module): after `add column d ... generated always as (a + 100)` the catalog has `generatedColumnTopoOrder = [2]`; after `rename column a to aa` it is `undefined`. Same result after each of: `alter column ... set default`, `alter column ... drop not null`, `add constraint ... check`, `drop constraint`, `rename constraint`, `alter primary key`. Not affected: `rename to` (table rename), `add column` (plain), `drop column` and tag edits (both already recompute). A generated column declared in CREATE TABLE survives because it is in the module's cached copy from the start, with the same column positions.

The store module (`yarn test:store`) passes the new test section: it refreshes its cached schema from the catalog's `table_modified` notification. So the bug reaches users through the memory module, but the engine relying on a module to hand back engine bookkeeping is the actual flaw — `runTagEdit` already states the contract: "A module's answer carries no generated-column bookkeeping."

## Fix

Two parts.

**1. Every ALTER arm that stores a module-returned schema re-derives the graph.** Add one small helper in `alter-table.ts` (exported for `add-constraint.ts`), e.g. `withEngineGeneratedColumnGraph(rctx, returned)` = `withGeneratedColumnGraph(returned, buildColumnSourceResolver(rctx.db))`, and apply it before `schema.addTable` in: `runAlterColumn`, `runDropConstraint`, `runRenameConstraint`, `runAlterPrimaryKey` (native re-key path; the shadow-rebuild fallback goes through CREATE TABLE and is fine), the `add-constraint.ts` module path, and `runRenameColumn`. Switch `runDropColumn` / `runTagEdit` to the same helper so there is one spelling. Pass the *registered* (graph-carrying) schema as `newObject` in each arm's `table_modified` notify, as `runDropColumn` does.

**Rename column needs one extra step.** Recomputing on the module's returned schema directly would fail: the generated body still says `a + 100` (the engine rewrites it in place later, in `propagateColumnRename` → `rewriteTableForColumnRename`), while the columns already say `aa`, and `extractGeneratedColumnDependencies` rejects a bare `a` as "not found". Recommended: rewrite the renamed table's own definition before the catalog swap — call `rewriteTableForColumnRename(updatedTableSchema, tableSchema.name, oldName, newName, objectResolvers, renamedTableKey, resolveColumnInSource)` right before recomputing the graph, mirroring how `runRenameTable` calls `rewriteTableForTableRename` before its swap. The rewrite is in place and idempotent (per its own comments), so the later propagation pass finds nothing left on this table. Fallback if that proves awkward: carry the graph from the pre-ALTER catalog schema (`tableSchema`), which is exactly right for a rename because column positions and dependency edges do not change — but this is the second-choice spelling because it trusts that the arm moved no column.

**2. A seam check in `Schema.addTable`.** Every registration goes through `addTable` (CREATE TABLE, each ALTER result, ANALYZE, store reopen, MV backing tables, `Database.defineTable`). Add `assertGeneratedColumnGraphMatchesColumns(registered)` next to `assertPrimaryKeyCollationsMatchColumns`: the set of indices in `generatedColumnTopoOrder` must equal the set of indices of columns with `generated` set (both empty/undefined when there are none). Throw `INTERNAL` naming the table. This turns any future arm that forgets the graph into a loud failure at the ALTER instead of silent NULLs on later writes. It is a set comparison over the column list — negligible next to a DDL statement. If the full test suite shows a legitimate registration path that lacks the graph (check `Database.defineTable`, the store's reopen path, MV backing-table paths in `materialized-view-helpers.ts`, `schema/manager.ts` sites), fix that path to compute the graph rather than weakening the check.

Do not change the memory module to compute the graph itself; the engine owns that bookkeeping.

## Test

Section 17 of `test/logic/41.13-alter-add-column-generated-backfill.sqllogic` is the reproduction: it adds a generated column, then runs rename column, alter column set default, add constraint, rename constraint, drop constraint, and alter primary key, inserting a row after each, and checks every row's computed value. It currently fails on the memory module at the first post-rename row (`g` is null) and passes under the store module. No other new test needed; the seam check is exercised by the whole suite.

## TODO

- Add the shared graph helper in `alter-table.ts`; apply it in `runAlterColumn`, `runDropConstraint`, `runRenameConstraint`, `runAlterPrimaryKey` (native path), `add-constraint.ts`'s module path; convert `runDropColumn` and `runTagEdit` to use it; notify with the registered schema.
- `runRenameColumn`: rewrite the table's own definition (`rewriteTableForColumnRename`) before recomputing the graph and swapping the catalog; confirm `propagateColumnRename` then leaves this table alone and that `41.3-alter-rename-propagation.sqllogic` still passes.
- Add the `addTable` seam check in `schema/schema.ts`; update the `addTable` JSDoc `@throws`.
- Run `yarn test` (section 17 of 41.13 must pass) and `yarn test:store` for the logic suite; run `yarn lint` in `packages/quereus`.
- Update `docs/sql-alter.md` with one sentence (near the ALTER overview or the ADD COLUMN notes) that a generated column added by ADD COLUMN is computed on every later write regardless of subsequent ALTERs, and in `docs/schema.md` (where `TableSchema`'s generated-column fields are described, if they are) that `addTable` enforces the graph covers every generated column.
