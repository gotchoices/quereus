description: When a table has a column and a per-statement context value with the same name, a CHECK that names the column through its table, such as `t.who > 0`, tests the context value and leaves the column unchecked. The maintainer has decided this spelling must mean the column, so the CHECK has to be changed to read it, on writes and when ALTER validates existing rows.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # stripColumnQualifier (write path) and requalifyOwnRowRef (existing-row scan)
  - packages/quereus/src/planner/building/constraint-builder.ts  # buildConstraintChecks: registers the row's names, calls the strip
  - packages/quereus/src/schema/constraint-builder.ts  # scanContextVariables, storedRowPredicate: callers of the scan rewrite
  - packages/quereus/src/planner/analysis/check-extraction.ts  # readsContextVariable, containsContextVariableRef, containsOldRowImageRef comments
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Test 27 and Test 28 pin the old meaning
  - docs/sql-ddl.md  # §2.6.2
  - docs/sql-alter.md  # Existing-row validation of a CHECK
  - docs/optimizer-fd.md  # Row-invariant gate, fourth leg
repro: verified
----

## The decision

The maintainer accepted this meaning on 2026-11-04: `<table>.<column>` always reaches the column, which also settles a table literally named `new`. Rows stored under the old meaning are not re-validated, and the docs and the release notes must say so.

## Cause

`stripColumnQualifier` folds `t.who` to the bare `who`, because the scope a CHECK compiles in has no `<table>.<column>` names. For a name a context variable also claims, the bare name is the variable (`buildConstraintChecks` skips registering the column under it), so the column is lost. `requalifyOwnRowRef` copies that reading on purpose for the ALTER scan, rewriting `<table>.<name>` of a variable to `context.<name>`.

## Measured today (`dist` build, memory module)

All with a column and a variable both named `who`, unless the row says otherwise.

| Case | Today | Required |
|---|---|---|
| `check (t.who > 0)`, `insert … with context who = 5 values (1, -1)` | accepted | rejected |
| same CHECK, `with context who = -5 values (2, 5)` | rejected | accepted |
| `main.t.who`, same two inserts | same as `t.who` | same as `t.who` now required |
| `update … with context who = 5 set who = -1` | accepted | rejected |
| `check on delete (t.who > 0)`, delete a row holding -1 with `who = 5` | accepted | rejected: it reads the old row, as `old.who` does |
| NOT NULL variable, `check (t.who > 0)`, `insert into t values (1, 5)` | `requires mutation context variable 'who'` | accepted: the variable is no longer read |
| table `"new"`, `check (new.who > 0)`, `insert into "new" values (1, -1)` | accepted, and `select … where who <= 0` loses the row | rejected |
| table `context`, `check (context.who > 0)` | reads the variable | unchanged: `context.<name>` always reaches the variable |
| table `context`, `check (main.context.who > 0)` | reads the variable | reads the column: three-part names are table references |
| `check (exists (select 1 from u where u.who = t.who))`, `u` has a column `who` | every write fails: `t.who isn't a column` | works, reading the column |
| `check (exists (select 1 from "new" where "new".who = t.who))` | every write fails: `t.who isn't a column` | works: `"new".who` is the table, `t.who` the column |
| `alter table t add constraint k check (t.who > 0)` over a row holding -1 | accepted | rejected: existing rows violate |
| same ALTER with a NOT NULL variable | rejected: cannot supply context | judged against the column |
| `check (t.ghost > 0)`, `ghost` a variable and not a column | reads the variable | unchanged: not covered by the decision |
| generated column `generated always as (g.who + 1)` | reads the column | unchanged |

`ALTER TABLE … RENAME COLUMN` and `DROP COLUMN` already treat `t.who` as the column (it is rewritten to `t.whom`, and the drop is refused), so they need no change for this spelling. The bare spelling's problem there is `bug-column-rename-rewrites-check-read-of-context-variable`.

## A column DEFAULT does not have this bug

The maintainer asked for this to be measured. A DEFAULT's scope has no `<table>.<column>` names and no strip runs on it, so the spelling can never read the variable:

| DEFAULT | Table | Result |
|---|---|---|
| `default (d.b)` | no context | refused at CREATE: `may not reference a bare column; use 'new.<column>'` |
| `default (d.who)`, also `main.d.who` | has context | accepted at CREATE, then every write that evaluates it fails: `d.who isn't a column` |
| `default (d.b)`, `b` not shadowed | has context | same late failure |
| `c integer not null default (d.who)` under `insert or replace` | has context | same late failure |
| `alter table … add column c … default (t.who)` | has context | refused: `t.who isn't a column` |
| `default (new.who)` | has context | reads the column |

No wrong value is possible, so no DEFAULT code changes here. The late refusal is `bug-self-qualified-default-accepted-until-first-write`. The docs only need to say a DEFAULT does not take this spelling.

## Design

**Write path.** Fold `<table>.<name>` of a shadowed column to a reserved qualifier the scope registers, instead of to the bare name. A shadowed column is one whose name is both a column of the table and a declared variable.

- Add `OWN_ROW_QUALIFIER`, an exported lowercase constant in `self-qualifier-strip.ts`, such as `__quereus_own_row__`, spelled so no FROM source a user writes can rebind it. This follows the `STORED_ROW_ALIAS` and `writeRowRelationCorrelation` precedents.
- In `buildConstraintChecks`, for each shadowed column, register `<OWN_ROW_QUALIFIER>.<column>` where the bare name would have been registered: the NEW attribute on INSERT and UPDATE, the OLD attribute on DELETE. The scope therefore decides the row image, and the strip needs no operation argument.
- Give `stripSelfQualifierInSchemaExpression` an optional parameter holding the shadowed column names. `buildConstraintChecks` computes it from `shadowedByContext` and `tableSchema.columns`. The generated-column caller passes nothing and is unchanged, as is `t.ghost`.
- In `stripColumnQualifier`, after the existing rebind and schema checks and before the capture loop, a shadowed name is rewritten to `<OWN_ROW_QUALIFIER>.<name>`. It skips the capture loop because a qualified name cannot be captured by a subquery's source, which is what fixes the two subquery rows above.
- Exception: an unqualified-schema `context.<name>` of a shadowed name stays as written, so that on a table literally named `context` it still reaches the variable.

Using `new.` or `old.` as the target instead was rejected. `from "new" where "new".who = t.who` would then become `"new".who = new.who`, a comparison of the subquery's column with itself, which silently passes. It would also need the operation passed to the strip.

A table named `new` or `old` needs no special case. `new.who` on a table `new` folds like any self-qualifier, and this matches how an unshadowed `new.b` and `old.b` behave on such tables today (measured: on table `new`, `check on delete (new.b > 0)` reads the old row; on table `old`, `check (old.b > 0)` reads the new row on INSERT).

**Existing-row scan.** In `requalifyOwnRowRef`, the `context.<name>` rewrite stays only for a name that is a variable and not a shadowed column, or that is spelled `context.<name>` without a schema. A shadowed `<table>.<name>` falls through to the existing line that rewrites to the scan alias under the column's internal name. Update the `OwnRowContextVariables` comment, and narrow its `NOTE:` to what stays true: a non-column variable under a subquery source of the same name.

**Optimizer screen stays.** `readsContextVariable` keeps treating `t.who` as unliftable, because rows stored under the old meaning may violate the CHECK and lifting a fact would make them vanish from queries. Rewrite its reason and record it at the site:

`// NOTE: accepted tradeoff — rows stored while <table>.<name> read the variable were never validated against the column, so no fact is lifted from this spelling even though enforcement now reads the column; revisit if a re-validation of stored rows ever exists.`

Remove the existing `NOTE:` about a table named `new`. `new.<name>` stays liftable there, so rows already stored in such a table under the old meaning can still be missed by a query. That needs a table literally named `new` plus a same-named variable plus existing rows, and it falls under the accepted "not re-validated" decision, so state it in the release note rather than widening the screen.

## Release note, for the review handoff to carry

A CHECK that spells a column as `<table>.<column>` or `<schema>.<table>.<column>`, on a table declaring a context variable of the same name, now tests the column rather than the variable. Existing rows are not re-validated, so a table may hold rows that violate the CHECK as now read, and writes that were accepted may now be rejected (and the reverse). Writes to such a table no longer need that variable supplied if nothing else reads it. Queries still return those rows, since the optimizer draws no fact from this spelling, except on a table literally named `new`, where the spelling is `new.<column>` and a fact is drawn.

## Tests

Extend `46-mutation-context.sqllogic`, which also runs under the store module. This is the reproduction for the bug and pins §2.6.2:

- Test 27 `FactSelf`: the insert of -1 now errors with `CHECK constraint failed`. Keep the screen pinned with `select op from query_plan('select * from FactSelf where who <= 0') where op = 'EMPTYRELATION'` returning `[]`.
- Test 28 `AvShadow`: `k3` and `k4` now fail with `existing rows in 'AvShadow' violate`. Rewrite the comment above them, and keep `k5` reaching its error on its own.
- New test: the insert pair, UPDATE and DELETE rows from the table above, one three-part spelling, the NOT NULL variable with no envelope, a table `"new"`, a table `context` (two-part reads the variable, three-part the column), and the two subquery rows.

The existing `context` table test at the end of Test 28 should pass unchanged. No new unit test for the strip: the SQL covers it at a lower cost than mocking the catalog resolver.

## TODO

- Add `OWN_ROW_QUALIFIER`, the strip's new parameter and the shadowed branch in `stripColumnQualifier`; update the function comment.
- Register the qualified names and pass the shadowed set in `buildConstraintChecks`; update the comment at `shadowedByContext`.
- Change `requalifyOwnRowRef` and its comments as above.
- Reword `containsContextVariableRef` and `readsContextVariable`, add the accepted-tradeoff `NOTE:` and remove the old one. Correct `containsOldRowImageRef`'s claim that a table named `old` keys `old.<col>` to the OLD image: the strip folds it first (measured above), and skipping that conjunct stays sound.
- Update Tests 27 and 28 and add the new test.
- `docs/sql-ddl.md` §2.6.2: replace the last sentence of the paragraph starting "Because context variables shadow same-named columns" with the accepted text, then add the remaining sentences:

  > The `new.<column>`, `old.<column>` and `<table>.<column>` forms always reach the column. On a write that stores a row, `<table>.<column>` means `new.<column>`; on a DELETE it means `old.<column>`. `context.<name>` always reaches the variable. A column DEFAULT reads a sibling only as `new.<column>` and does not accept `<table>.<column>`. A `<table>.<name>` whose name is a variable and not a column reads the variable. Rows stored before `<table>.<column>` took this meaning, when it read the variable, are not re-validated, so a table can hold rows that violate its CHECK as now read.

- `docs/sql-alter.md`, *Existing-row validation of a CHECK*: change the last sentence so a bare shared name is the variable, and `<table>.<name>` and `new.<name>` reach the column.
- `docs/optimizer-fd.md`, fourth leg: `t.who` is screened because rows stored under its former meaning may violate it, not because enforcement reads the variable. Adjust "as do self-table qualifiers" and "That includes a self-qualified `t.who`" to match.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus run lint`. Search for other tests that pin the old meaning if any fail.
- Copy the release note above into the review handoff.
