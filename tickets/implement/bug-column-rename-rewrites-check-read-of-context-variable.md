description: Renaming a column or table can silently change a CHECK or DEFAULT that reads a per-statement context value, so it reads a column instead, or the reverse, and dropping or renaming an unrelated table named `context` can wrongly be refused or break that CHECK. The rename and dependency walkers need to know which context variables the table owning the expression declares.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/rename/shared.ts  # RowImageContext: the written-row mode the column walker takes
  - packages/quereus/src/schema/rename/column-rename.ts  # ColumnRewriteState, unqualifiedRefBindsTarget, the `case 'column'` arm, renameColumnInCheckConstraints, renameColumnInColumnExpressions, columnReferencedInCheckExpression
  - packages/quereus/src/schema/rename/table-rename.ts  # TableRenameOpts.rowImageContext, walkTableRefs, the column arm of visitTableRefs (~line 1005), renameTableInCheckConstraints, renameTableInColumnExpressions
  - packages/quereus/src/runtime/emit/alter-table.ts  # runRenameColumn pre-flight (~line 374), rewriteTableForColumnRename (~line 2733), table-rename propagation (~line 2602)
  - packages/quereus/src/schema/expression-dependents.ts  # drop guards' reach and column probes (lines ~210, ~242, ~345, ~365)
  - packages/quereus/src/schema/schema-differ.ts  # declarative rename replay / inverse reconcile (lines ~1529, ~2014, ~2025, ~2758, ~2779, ~4171, ~4186, ~4246)
  - packages/quereus-store/src/common/store-module-alter.ts  # calls renameColumnInCheckConstraints / renameColumnInColumnExpressions (~line 473)
  - packages/quereus-store/src/common/store-module-rename.ts  # calls renameTableInCheckConstraints / renameTableInColumnExpressions (~line 251)
  - packages/quereus/src/planner/building/mutation-context.ts  # reference: how the planner scopes variables (registerMutationContextSymbols)
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # reference: stripColumnQualifier already applies the `context.<name>` rule on the write path
  - packages/quereus/test/logic/46-mutation-context.sqllogic
  - docs/sql-ddl.md
  - docs/sql-alter-rename.md
difficulty: hard
repro: verified
----

## What goes wrong

A table may declare per-statement context variables (`with context (who integer null)`). §2.6.2 of `docs/sql-ddl.md` sets the meaning of names in its CHECKs and DEFAULTs:

- A bare `who` means the variable when the table declares one, even if a column has that name. Inside a subquery, a source of that subquery that has the column binds it first; only a name reaching the outer level reaches the variable.
- `new.who`, `old.who` and `t.who` reach the column.
- `context.who` (no schema) always reaches the variable, including on a table literally named `context`; `<schema>.context.who` reaches the column there.
- A generated column's bare name always means the column.

The planner implements this (`registerMutationContextSymbols` registers the variable before the column; `stripColumnQualifier` honours `context.<name>`). The rename and dependency walkers do not know a table's variables at all, so they treat every bare name reaching the owning table as a column, and every `context.<name>` as a reference to a table named `context`.

All of the following were run against the current `dist` build, memory module (a throwaway script, `select expr from check_constraint_info(...)` to read the stored text):

| Setup | Statement | Today | Expected |
|---|---|---|---|
| `check (who > 0)`, column and variable `who` | `rename column who to w` | stored `w > 0`; `with context who = -5 values (1, 9)` accepted, `who = 5 values (2, -9)` rejected | unchanged `who > 0` |
| same | `drop column who` | refused: referenced by CHECK `k` | allowed |
| `check ((select count(*) from u where u.k = who) >= 0)`, same names | `rename column who to w` | stored `... u.k = w` | unchanged |
| `b integer null default (who)`, same names | `rename column who to w` | stored `default w`; next insert fails `Column not found: w` | unchanged |
| `check (x > 0)`, variable `who`, no column `who` | `rename column x to who` | stored `who > 0`, now reads the variable; `insert into t values (2, -1)` accepted | rename refused (see decision below) |
| table `context(k, x)`; `items` has `check (context.x > 0) with context (x ...)` | `drop table context` | refused: referenced by `items`'s CHECK | allowed |
| same | `alter table context rename to foo` | `items` stores `foo.x > 0`; every write fails `foo.x isn't a column` | `items` unchanged |
| same | `alter table context rename column x to y` | `items` stores `context.y > 0`; every write fails | `items` unchanged |
| table `context` with column and variable `who`, `check (context.who > 0)` | `rename column who to whom` | stored `context.whom > 0` (now reads the column) | unchanged |
| same | `drop column who` | refused | allowed |
| same | `alter table context rename to foo` | stored `foo.who > 0` (now reads the column) | unchanged `context.who` |
| `t` with column and variable `who`, `check (t.who > 0)` | `alter table t rename to context` | stored `context.who > 0` (now reads the variable) | `main.context.who > 0` |
| same | `rename column who to w` | stored `t.w > 0` | correct today — keep it |

The rename also brings back the optimizer wrong result fixed in `bug-check-facts-read-context-variable-as-column`: once `who > 0` is rewritten to `w > 0`, the CHECK yields a column fact covering rows stored under the variable meaning, and `select * from t where w <= 0` misses them. Fixing the rewrite fixes that.

## Root cause

One site: the written-row mode the walkers take (`RowImageContext` in the column walker, `TableRenameOpts.rowImageContext` in the table walker) says "this expression is evaluated against a written row" but not *which variables that row's statement carries*. Every caller that passes `'own'`, `'foreign'` or `rowImageContext: true` is walking a CHECK or DEFAULT whose owning table may declare variables, and none can say so.

## Fix

**Representation (preferred, rung 1).** Make the written-row mode carry the owning table's declared variable names, so a caller cannot say "written row" without saying which variables. For example, replace `'own' | 'foreign'` with `{ kind: 'own' | 'foreign'; contextVariables: ReadonlySet<string> }` (lowercase names, possibly empty) and `rowImageContext?: boolean` with an optional object of the same shape. `'none'` (view bodies, assertions, partial-index predicates) stays as it is: there is no written row and no variables there. A generated-column body passes an empty set: its bare names always mean the column, and `context.<name>` there is a self-qualifier, not a variable. The exported entry points (`renameColumnInCheckConstraints`, `renameColumnInColumnExpressions`, `renameTableInCheckConstraints`, `renameTableInColumnExpressions`) are called by persisting modules, so they gain a parameter, or take the table schema's `mutationContext`; a public signature change is accepted (AGENTS.md: backwards compatibility is not a concern yet).

**Column walker (`column-rename.ts`).**

- Bare name: in `unqualifiedRefBindsTarget`, when the walk reaches the *seed* frame (index 0 of a seeded walk, the implicit binding to the owning table) and `oldCol` is a declared variable, the name reads the variable: no match. A frame above the seed that binds the target (a subquery selecting from the table itself) still matches first, as the planner resolves it there. This covers the CHECK, its subqueries, and the DEFAULT arm. In a DEFAULT a bare name reaching the seed is never a column (rejected at CREATE TABLE), so the same rule is exact there.
- `context.<name>`: an unqualified `context` qualifier that no FROM/WITH frame above the seed binds, with a declared variable `name`, is the variable. It must not match, either through the seed (own table named `context`) or through `resolveRef` (another table named `context`, the `'foreign'` arm). This mirrors `matchesRowImage`'s handling of `new`/`old`, including `isQualifierReboundAboveSeed` for a subquery that really selects from a table named `context`.
- `renameColumnInColumnExpressions` must split its two arms: DEFAULTs get the table's variables, generated bodies get none.
- `columnReferencedInCheckExpression` inherits all of this, so the DROP COLUMN guards (`expression-dependents.ts`) stop refusing over variable reads.

**Table walker (`table-rename.ts`).** In the column arm of `visitTableRefs`, the unbound-qualifier branch already skips `new`/`old` under `rowImage`; add: skip `context` when the column name is a declared variable of the owning table. This fixes DROP TABLE refusals (`reachableObjects` in `expression-dependents.ts`), table-rename rewrites of other tables' CHECKs, and the own-table `context` → `foo` rename.

**Table rename *to* `context`.** When the renamed table's own CHECK has a self-qualifier `t.<name>` where `<name>` is both a column and a declared variable, and the new name is `context` (case-insensitive), the rewrite must write `<schema>.context.<name>`, which §2.6.2 says reaches the column. The emitted ref already has a `qualify` hook for unbound qualifiers; the sink, or a wrapped `setName`, can set the schema in this one case. The same applies to a column rename on a table named `context` whose new column name is a variable (`context.x` → `<schema>.context.who`).

**Column rename *to* a variable's name — decision: refuse.** The ticket allowed either refusing or rewriting. Refusal is chosen: rewriting a bare `x` to a qualified form needs `t.who`, or `<schema>.context.who` on a table named `context`, and still fails when a subquery inside the CHECK aliases another source as `t`. That is three arms, against one for a refusal. Rule: in the `runRenameColumn` pre-flight (`alter-table.ts` ~line 374, before `module.alterTable`, beside `assertRenameDependentsPersistable`), when `newName` is a declared variable of the table (case-insensitive) and an own CHECK has a bare reference to `oldName` that binds at the seed, refuse with an error naming the constraint and advising to qualify the reference as `<table>.<old>` (or `new.<old>`) first. `new.x` / `old.x` / `t.x` references rename to columns and stay correct. DEFAULTs need no check (no bare column refs), and nor do generated bodies (bare means column). Other tables' CHECKs reach `t` only through subqueries whose FROM binds the name first. The probe can be the seeded walk with a flag that records a bare seed hit, or a small dedicated probe built on it.

**Declarative schema (`schema-differ.ts`).** The differ replays renames and reconciles the inverse over declared and live CHECK/DEFAULT expressions with the same walkers and modes (`'own'`, `rowImageContext: true`). Under the type change each site must pass the owning table's declared variables, taken from the declared side when walking declared expressions. Each site gets the variables of the table whose expression it walks, not of the renamed table.

## Docs

- `docs/sql-ddl.md` §2.6.2: state that RENAME COLUMN / RENAME TABLE / DROP COLUMN / DROP TABLE follow the same meaning: a bare or `context.` read of a variable is never rewritten and never blocks a drop; renaming a column to a declared variable's name is refused while a CHECK reads the column bare; renaming a table to `context` writes `<schema>.context.<column>`.
- `docs/sql-alter-rename.md`: one line under RENAME COLUMN / RENAME TABLE pointing to that rule.

## Tests

One sqllogic block per behaviour, in `packages/quereus/test/logic/46-mutation-context.sqllogic` (or the rename propagation file `41.3-alter-rename-propagation.sqllogic` if it fits better). Each one checks the stored text through `check_constraint_info` plus one write that shows the meaning:

- bare CHECK read survives the column rename, and the DROP COLUMN is allowed;
- DEFAULT `(who)` survives the rename (insert with context still works);
- rename of a column to a variable's name is refused when a bare CHECK reads it, and allowed when the CHECK spells `new.x`;
- `items` with `check (context.x > 0)`: `drop table context`, `rename context to foo`, `rename column x to y` on the table `context` all leave `items` working;
- table `context` with `check (context.who > 0)`: column rename, column drop, table rename leave it reading the variable;
- `check (t.who > 0)`: `rename to context` stores `main.context.who`, still reads the column.

Run `yarn test` and `yarn test:store` for the logic file (the store module persists rewritten CHECKs through its own hook), plus `yarn lint` in `packages/quereus` (it type-checks test call sites of the changed signatures, e.g. `test/schema/row-image-context-matrix.spec.ts`, `test/schema/clone-expr-isolation.spec.ts`).

## TODO

- Change the written-row mode types in `shared.ts` / `table-rename.ts` to carry the owning table's declared variable names; update all callers (alter-table, expression-dependents, schema-differ, store module) to pass the variables of the table whose expression is walked (empty set for generated bodies).
- Column walker: bare name reaching the seed with a declared variable name → no match; unbound `context.<declared>` → no match (seed and `resolveRef` alike), respecting a subquery that really binds `context`.
- Split `renameColumnInColumnExpressions` so DEFAULTs get the variables and generated bodies do not.
- Table walker: unbound `context.<declared>` under written-row context is not a table reference.
- Table rename to `context` (and column rename on a table named `context` to a variable's name): write `<schema>.context.<column>` for a self-qualified shadowed column.
- `runRenameColumn` pre-flight: refuse renaming a column to a declared variable's name while an own CHECK reads it bare at the seed.
- Update `docs/sql-ddl.md` §2.6.2 and `docs/sql-alter-rename.md`.
- Add the sqllogic cases above; run `yarn test`, `yarn test:store` for the touched logic file, and `yarn lint` in `packages/quereus`.
