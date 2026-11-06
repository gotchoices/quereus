description: Renaming or dropping a column or table no longer changes or blocks a CHECK or DEFAULT that reads a per-statement context value, because the rename and drop machinery now knows which context variables the owning table declares. A declarative-schema migration that renames such a column now also updates its CHECK in the same apply.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/rename/shared.ts  # RowImageContext is 'none' | WrittenRowContext { kind, contextVariables }; contextVariableNames, NO_CONTEXT_VARIABLES, CONTEXT_QUALIFIER
  - packages/quereus/src/schema/rename/column-rename.ts  # ScopeFrame.isSeed, unqualifiedRefBinding, readsContextVariable, newSpellingReadsContextVariable, checkReadsColumnBare
  - packages/quereus/src/schema/rename/table-rename.ts  # rowImageContext carries variables; TableRef.contextVariableCaptures
  - packages/quereus/src/runtime/emit/alter-table.ts  # assertRenamedColumnNotReadAsContextVariable (RENAME COLUMN pre-flight)
  - packages/quereus/src/schema/expression-dependents.ts  # DROP guards take the owning table's variables
  - packages/quereus/src/schema/schema-differ.ts  # reconciledDeclaredBody (review fix), cross-table read edges, UndoRenderer.replayRenames
  - packages/quereus/src/schema/catalog.ts  # CatalogTable.contextVariables
  - packages/quereus-store/src/common/store-module-alter.ts
  - packages/quereus-store/src/common/store-module-rename.ts
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Test 30
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic  # case 28 (review)
  - docs/sql-ddl.md
  - docs/sql-alter-rename.md
----

## What was wrong

A table can declare per-statement context variables (`with context (who integer null)`). In its CHECKs and DEFAULTs a bare `who` means the variable when one is declared, and `context.who` with no schema always means the variable. The rename and drop machinery did not know a table's variables, so `rename column who to w` rewrote `check (who > 0)` to `w > 0`, `drop column who` was refused, another table's `check (context.x > 0)` blocked `drop table context`, and renames into a variable's name or to a table named `context` changed what a CHECK read.

## What changed (implement stage)

The column walker's written-row mode carries the owning table's variable names (`WrittenRowContext`), and the table walker's `rowImageContext` option does too, so no caller can say "written row" without saying which variables apply. Generated bodies always pass none. A bare name reaching the implicit owning-table binding and naming a variable binds nothing; an unbound `context.<variable>` is neither a column nor a table reference. A rename that would turn a self-qualified reference into `context.<variable>` writes `<schema>.context.<name>` instead. `RENAME COLUMN` to a variable's name is refused while an own CHECK reads the column bare (`assertRenamedColumnNotReadAsContextVariable`). The DROP guards, store module, and declarative differ pass the owning table's variables. See `ticket(implement): bug-column-rename-rewrites-check-read-of-context-variable` for the full diff; docs in `docs/sql-ddl.md` §2.6.2 and `docs/sql-alter-rename.md`.

## Review findings

**Checked, by reading the implement diff and running ad-hoc SQL against `src` (scratch script, since deleted):**
- Every caller of the column and table walkers (`grep` for `rowImageContext`, `kind: 'own'|'foreign'`, `NO_CONTEXT_VARIABLES`, and the `*Referenced*` / `rename*InCheckExpression` entry points). Each CHECK/DEFAULT site passes the owning table's variables; generated bodies, index predicates, assertions and view bodies pass none, which matches the planner (`constraint-builder.ts`, `buildNotNullDefaults` register context symbols; generated-column scope does not).
- `isQualifierReboundAboveSeed` now skips the flagged seed instead of index 0. For unseeded walks this only matters where `resolveQualifierBinding` already returned undefined, i.e. nothing on the stack binds the qualifier, so the scan's answer is unchanged for `new.`/`old.`. Confirmed by reading both functions.
- Behaviour probes, all correct: a generated column `g as (who + 1)` on a variable-shadowed column follows `rename column who to w` and still blocks dropping `w`; another table's CHECK `(select … from context where context.x > 0)` follows column and table renames of `context` (the subquery rebinds `context`) and blocks dropping it; another table's DEFAULT `(context.x)` reading its own variable does not block `drop table context`; the pre-flight refuses a bare read inside a subquery over an unrelated table, allows `(select … from W2 as s where s.x = 1)`, and is case-insensitive on the new name; a case-only rename of a shadowed column leaves `who > 0` alone; `rename to CONTEXT` writes `main.CONTEXT.who`.
- Tests: Test 30 in `46-mutation-context.sqllogic` covers the ticket's cases without restating the implementation; the four spec files changed only for the signature. No tests cut.
- Docs: `docs/sql-ddl.md` §2.6.2 and `docs/sql-alter-rename.md` describe the new behaviour accurately. `docs/schema-declarative.md` needs no change for the fix below (it restores the documented rename behaviour).

**Found and fixed in this pass:**
- **Declarative migration did not converge (regression introduced by this ticket).** Live `constraint k check (who > 0)` with variable `who` and column `who`; declared column `w` (`previous_name = 'who'`) with `check (w > 0)`. The differ's inverse rename mapped the declared `w` back to `who`, which reads the variable, so it matched the live body and the plan was only `RENAME COLUMN who TO w`. The live CHECK stayed `who > 0` (still reading the variable) and the next `diff schema` was non-empty. Fix in `reconciledDeclaredBody` (`schema-differ.ts`): when a column rename's old name is a declared variable and the declared CHECK reads the new name bare at the owning row (`checkReadsColumnBare`), no live body can reconcile to it, so the declared text is returned unreconciled and the CHECK is dropped and re-added. Regression case 28 in `50.2-declare-schema-renames.sqllogic`; it fails with the fix disabled (verified) and passes with it.
- Stale comment in `isQualifierReboundAboveSeed` (`column-rename.ts`) still spoke of "index 0"; reworded to the seed flag.

**Found and filed:**
- **Declarative plan refused by the new RENAME COLUMN pre-flight.** Live `check (x > 0)`, declared rename `x` → `who` (a variable) with the CHECK changed to `new.who > 0`: the plan runs `RENAME COLUMN` (stage 1) before `DROP CONSTRAINT k` (stage 2), so the pre-flight refuses a migration whose result is valid. Nothing changes; the apply fails cleanly. This is the same class as the open backlog ticket `bug-apply-schema-refuses-parent-removed-with-its-foreign-key` (a `DROP CONSTRAINT` scheduled after a step the constraint blocks), so it was appended there as an arm with a verified repro rather than filed separately.

**Considered, no action:**
- Store-module rollback after `rename t to context` reverses `main.context.who` to `main.t.who` rather than `t.who`. Same meaning, different text, reachable only when the persist fails. Left as is.
- Declared `main.context.who` after a table rename to `context` reconciles to `main.t.who`, which does not textually match live `t.who`, so the CHECK is dropped and re-added once in the same apply. The result is correct in one apply; it only causes one extra recreate. Left as is.
- The differ ignores changes to a table's `with context` declaration. This predates this ticket and is out of scope.

**Validation:** `yarn lint` in `packages/quereus` clean; `yarn test` (all workspaces) exit 0, quereus 11097 passing. `yarn test:store` was not run. The review fix is in the module-independent differ, and the implement stage ran the store subset for the touched files.
