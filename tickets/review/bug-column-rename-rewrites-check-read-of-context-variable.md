description: Renaming or dropping a column or table no longer changes or blocks a CHECK or DEFAULT that reads a per-statement context value; the rename and drop machinery now knows which context variables the owning table declares. Ready for an adversarial review.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/rename/shared.ts  # RowImageContext is now 'none' | WrittenRowContext { kind, contextVariables }; contextVariableNames, NO_CONTEXT_VARIABLES, CONTEXT_QUALIFIER
  - packages/quereus/src/schema/rename/column-rename.ts  # ScopeFrame.isSeed, unqualifiedRefBinding, readsContextVariable, newSpellingReadsContextVariable, checkReadsColumnBare, split DEFAULT/generated arm
  - packages/quereus/src/schema/rename/table-rename.ts  # TableRenameOpts.rowImageContext carries variables; TableRef.contextVariableCaptures; unbound `context.<var>` skipped
  - packages/quereus/src/runtime/emit/alter-table.ts  # assertRenamedColumnNotReadAsContextVariable (pre-flight), rewriteTableForTableRename, rewriteTableForColumnRename, rewriteOtherTableColumnExpressions
  - packages/quereus/src/schema/expression-dependents.ts  # DROP guards: probes take the owning table's variables per expression kind; describeCheck exported
  - packages/quereus/src/schema/schema-differ.ts  # reconciledDeclaredBody, recordCrossTableReads, dropsReleasedByDeclaration rules, UndoRenderer.replayRenames
  - packages/quereus/src/schema/catalog.ts  # CatalogTable.contextVariables (optional, lowercased)
  - packages/quereus/src/schema/catalog-rendering.ts  # contextVariables omitted from the render (the ddl already carries the clause)
  - packages/quereus-store/src/common/store-module-alter.ts
  - packages/quereus-store/src/common/store-module-rename.ts
  - packages/quereus/src/index.ts  # exports contextVariableNames
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Test 30
  - docs/sql-ddl.md
  - docs/sql-alter-rename.md
----

## What was wrong

A table can declare per-statement context variables (`with context (who integer null)`). In its CHECKs and DEFAULTs a bare `who` means the variable (when declared), and `context.who` with no schema always means the variable, even on a table named `context`. The rename and drop machinery did not know a table's variables, so it treated those reads as column references (or as references to a table named `context`). Results: `rename column who to w` silently rewrote `check (who > 0)` to `w > 0`; `drop column who` was refused; another table's `check (context.x > 0)` blocked `drop table context` and was broken by renaming `context`; renaming a column `x` to a variable's name made `check (x > 0)` start reading the variable; renaming `t` to `context` turned `t.who` (column) into `context.who` (variable).

## What changed

**Representation.** The column walker's written-row mode is now `{ kind: 'own' | 'foreign'; contextVariables: ReadonlySet<string> }` (`'none'` unchanged), and the table walker's `rowImageContext` option is `{ contextVariables }` instead of `true`. Every caller that says "written row" must say which variables, taken from the table that OWNS the walked expression. Generated bodies always pass the empty set. The four exported collection helpers (`renameColumnInCheckConstraints`, `renameColumnInColumnExpressions`, `renameTableInCheckConstraints`, `renameTableInColumnExpressions`) gained a required `contextVariables` parameter; `contextVariableNames(mutationContext)` builds it.

**Column walker.**
- Bare name: when the scope walk reaches the implicit seed (now flagged `isSeed` on the frame) and the old name is a declared variable, it binds nothing. An inner subquery frame that binds the target or exposes the name still decides first.
- `context.<old>` with no schema, where `<old>` is a declared variable and no frame above the seed rebinds `context`, never matches, whether the seed binds `context` (own table so named) or the catalog does (another table so named).
- A hit on `context.<old>` (not rebound) whose new name is a declared variable is written `<schema>.context.<new>`.
- `isQualifierReboundAboveSeed` now skips the flagged seed instead of index 0, so unseeded ("foreign") walks scan every frame. For `new.`/`old.` this changes nothing (it is only reached when no frame binds the qualifier).
- `with inverse` / `with defaults` subtrees run with a foreign context and no variables.

**Table walker.** An unbound `context.<name>` naming a variable of the owning table is not reported as a table reference (fixes DROP TABLE refusals, the reach used by the drop guards, and rename rewrites). At a seedless self-qualifier, a new hook `contextVariableCaptures` makes the rename sink schema-qualify when the new spelling would be `context.<variable>` (`t.who` → `main.context.who` under `rename to context`).

**RENAME COLUMN pre-flight.** `assertRenamedColumnNotReadAsContextVariable` refuses renaming a column to a declared variable's name when an own CHECK reads the old column bare at the seed (probe: `checkReadsColumnBare`). Message: `cannot rename column 'x' of table 't' to 'who': CHECK constraint 'k' reads 'x' unqualified, and 'who' is a mutation context variable of the table, so the CHECK would read the variable instead; qualify the reference as 't.x' or 'new.x' first`. Runs before any side effect, for every module.

**Differ.** Reconcile of declared CHECKs uses the declared table's `contextDefinitions`; the undo renderer uses the new optional `CatalogTable.contextVariables`; the cross-table read edges and released-drop reach pass the owning table's variables per rule (none for generated bodies).

## Tests

- `test/logic/46-mutation-context.sqllogic` Test 30 (one block, each case checks stored text via `check_constraint_info` plus a write):
  - bare `check (who > 0)` and a subquery `... RnPeer.k = who` survive `rename column who to w`; `drop column who` is allowed;
  - DEFAULT `(who)` survives the rename and still fills from the context;
  - rename `x` → variable `who` is refused while `check (x > 0)`; allowed and followed once the CHECK spells `new.x`;
  - another table's `check (context.x > 0)` survives column rename, table rename and `drop table context`;
  - own `check (context.who > 0)` on table `context` survives column rename, column drop and table rename;
  - `check (RnSelf.who > 0)` under `rename to context` stores `main.context.who`, and `RnSelf.x` then `rename column x to w` (w a variable) on `context` stores `main.context.w`; both still read the column.
- Spec files touched only for the signature change (no new specs): `clone-expr-isolation`, `rename-cross-schema`, `row-image-context-matrix`, `table-rename-scope`.

Validation run: `yarn test` (all workspaces, exit 0; quereus 11097 passing), `yarn lint` in `packages/quereus` (clean), store mode for `46-mutation-context|41.3-alter-rename|41.10|50.2-declare-schema-renames|mutation` (205 passing) and the wider `alter|rename|drop|declare|check|context` subset (1621 passing). Store mode needs `packages/quereus` and `packages/quereus-store` rebuilt (`tsc -b`) first, since it imports both through `dist`. The full `yarn test:store` was not run.

## Known gaps / things to look at

- Did not re-run the new cases against the pre-change code. They mirror the rows the fix ticket verified against the old `dist` build, except the `context.x` → `main.context.w` column-rename arm, which was not in that table.
- Store module rollback (a failed persist after `rename t to context`): the reverse pass turns `main.context.who` into `main.t.who`, not the original `t.who`. Same meaning, different text; only reachable when the persist fails.
- Declarative schema: if a user renames `t` to `context` and declares the CHECK as `main.context.who`, the reconcile maps it to `main.t.who`, which does not textually match the live `t.who`, so the CHECK is dropped and recreated once (valid, converges next pass). Not tested. A declared `context.who` correctly differs (it reads the variable).
- A `t.<name>` where `<name>` is a variable but not a column also becomes `main.context.<name>` under `rename to context`. Deliberate: that spelling keeps `t.<name>`'s full meaning (reads the variable now, the column if one is later added), where `context.<name>` would always read the variable.
- The differ still ignores changes to a table's `with context` declaration (pre-existing); declared-side and catalog-side variables are used for declared and catalog expressions respectively, as the fix ticket asked.
