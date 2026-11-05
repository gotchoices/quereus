description: When a table has a column and a per-statement context value with the same name, a CHECK that names the column through its table, such as `t.who > 0`, now tests the column instead of the context value, on writes and when ALTER validates existing rows.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # OWN_ROW_QUALIFIER, stripColumnQualifier's shadowed branch, requalifyOwnRowRef
  - packages/quereus/src/schema/expr-scope/frame.ts  # ScopeFrame.barrier and hasBarrierFrame
  - packages/quereus/src/planner/building/constraint-builder.ts  # registers the shadowed names, passes them to the strip
  - packages/quereus/src/planner/analysis/check-extraction.ts  # comments only: the screen stays, with an accepted-tradeoff NOTE
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Tests 27, 28, 29
  - docs/sql-ddl.md  # §2.6.2
  - docs/sql-alter.md  # Existing-row validation of a CHECK
  - docs/optimizer-fd.md  # Row-invariant gate, fourth leg
----

## What landed

A column is "shadowed" when a declared context variable has the same name. In a CHECK, `<table>.<name>` and `<schema>.<table>.<name>` of a shadowed column fold to a reserved qualifier, `__quereus_own_row__`, which the CHECK's scope registers against the NEW row on INSERT and UPDATE and the OLD row on DELETE. The existing-row scan rewrites the same spellings to its scan alias under the column's internal name. A `<table>.<name>` that names only a variable still reads the variable, and `context.<name>` with no schema still reads the variable on a table literally named `context`. The optimizer still draws no fact from the spelling.

Two things go beyond the original design:

- The fold stops at CTE, derived-table and DML bodies (`ScopeFrame.barrier`), so a name there fails with `t.who isn't a column`. Without this, a CTE body judged every row on the first row's value and let a violating row in.
- `main."new".x` on a table named `new` now works in the ALTER scan, and `new.ghost` there, where `ghost` is only a variable, reads the variable as the write path does.

## Release note

A CHECK that spells a column as `<table>.<column>` or `<schema>.<table>.<column>`, on a table declaring a context variable of the same name, now tests the column rather than the variable. Existing rows are not re-validated, so a table may hold rows that violate the CHECK as now read, and writes that were accepted may now be rejected (and the reverse). Writes to such a table no longer need that variable supplied if nothing else reads it. Queries still return those rows, since the optimizer draws no fact from this spelling, except on a table literally named `new`, where the spelling is `new.<column>` and a fact is drawn.

## Review findings

Reviewed `ticket(implement): bug-self-qualified-check-reads-context-variable` from the diff first, then ran two probe scripts on a fresh `dist` build, memory module.

**Validation.** `yarn workspace @quereus/quereus test`: 11057 passing, 26 pending, 0 failing. `yarn workspace @quereus/quereus run lint`: exit 0. `46-mutation-context.sqllogic` passes under `node test-runner.mjs --store --grep 46-mutation-context`. The full store suite was not run. The 11057 count is the same as before my added ALTER statement, since that statement sits inside an existing logic file.

**Checked and correct, by running it unless marked as read:**

- INSERT, UPDATE, DELETE, upsert, `insert or replace`, mixed-case spellings, three-part names and `apply schema` all judge the column.
- A subquery whose source has a same-named column, an `in (select …)` and a function-source argument all reach the outer row's column, and an inner FROM that rebinds the qualifier keeps it. A self-join alias (`from s2 as x where x.who = s2.who`) was not confirmed: the probe also named an unshadowed `s2.a`, which refuses as `bug-check-self-qualifier-beside-same-named-subquery-column` describes.
- CTE and derived-table bodies refuse, while a name beside a function source in the same FROM folds. Sealed frames inherit `barrier` through `opaqueScopeFrame` (read).
- The failure message prints the CHECK as written. `query_plan` details show `__quereus_own_row__.who`, which is cosmetic and left as is.
- The stored AST is untouched, because the fold runs on a clone (read; `schema()` still prints `t.who` after writes).
- On a table named `old`, a write reads the row the operation judges, as the design measured for unshadowed names.

**Major, added to an existing ticket rather than filed new.** The rename and dependency walkers treat `context.<name>` in a CHECK as a reference to a table named `context`. This is the "false dependency" the implement handoff left uninvestigated, and it is wider than that handoff said:

- A separate table named `context` cannot be dropped, and renaming it or its column makes every write to the unrelated table fail.
- Two table renames now change a CHECK's meaning silently because of this ticket: renaming `t` to `context` moves `t.who` to the variable, and renaming `context` to `foo` moves `context.who` to the column. Before this ticket both spellings read the variable, so by the original ticket's measurements those renames were harmless; I did not run the old build. Renaming the column on a table named `context` also moves `context.who` to the column, but the old strip would have done the same, so that case predates this ticket.

All of it needs a table literally named `context`. The arms are in `bug-column-rename-rewrites-check-read-of-context-variable`, which already owns the class of walkers that do not know a CHECK's context variables, and its description and `files:` now cover them.

**Minor, fixed in this pass:**

- `docs/sql-ddl.md` §2.6.2 did not say a three-part name reaches the column on a table named `context`. It now does.
- `docs/sql-ddl.md` §2.6.2 did not say that ADD COLUMN or RENAME COLUMN onto a variable's name moves an existing `<table>.<name>` from the variable to the column without re-validating stored rows. Measured, and now stated. No fact is lifted from this spelling, so queries stay correct.
- The `OWN_ROW_QUALIFIER` comment claimed no user-written source could rebind it. A subquery alias of exactly that spelling does capture the fold, and the CHECK then passes by comparing a column with itself. The comment now says so, with a `NOTE:`.
- The `containsOldRowImageRef` comment said skipping a conjunct "only forgoes its facts". It also skips the ALTER scan. See the tripwire below.
- A Test 28 comment said "all three spellings" above two statements.
- Added one ALTER statement to Test 28 for `new.ghost`, the changed behaviour the handoff flagged as untested. It fails with `isn't a column` if `requalifyOwnRowRef` regresses.

**Tripwires recorded at the site:**

- `containsOldRowImageRef`: on a table named `old`, ALTER accepts a violating row for `old.col` and `main."old".col`, because the scan skips that conjunct. No fact is lifted, so the row stays visible.
- `OWN_ROW_QUALIFIER`: a user alias of that exact spelling captures the fold.

**Already tracked, confirmed and left there:**

- `bug-subquery-selecting-outer-column-cached-as-uncorrelated` (`fix/`): filed by the implement stage, not reproduced again in this pass.
- `bug-add-column-per-row-check-refuses-spellings-the-scan-accepts`: measured `add column d … default (new.a) check (t.who > 0)` refused with `t.who isn't a column`, a loud refusal. The same statement with a literal default judges the column correctly.
- `bug-self-qualified-default-accepted-until-first-write`: not touched.
- `bug-check-self-qualifier-beside-same-named-subquery-column`: its prereq has now landed. Appended that a wider use of the qualifier must keep the barrier, and a measured function-argument shape (`generate_series(1, f.b)`), which fails on an unshadowed name and works on a shadowed one.

**Accepted-tradeoff `NOTE:`.** `readsContextVariable` keeps screening `t.who`, as the maintainer decided. Its revisit condition has not tripped.

**Other categories:**

- ALTER accepting a CHECK no write can plan (self-qualified name inside a CTE body): recorded by the implementer at `OwnRowContextVariables`. It stores no wrong data and unshadowed names behave the same, so it stays a tripwire.
- Tests: no cuts. The implementer's Test 27, 28 and 29 additions each pin a row of the ticket's required behaviour in SQL, with no mocks.
- Performance and resource cleanup: nothing to raise. The fold adds one set lookup per self-qualified column and one extra scan of the frame stack, at plan time, and allocates nothing that outlives planning.
- Type safety and size: `self-qualifier-strip.ts` is about 275 lines, and the change adds no casts beyond the AST casts already used in those files.
