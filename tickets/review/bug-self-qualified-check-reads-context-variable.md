description: When a table has a column and a per-statement context value with the same name, a CHECK that names the column through its table, such as `t.who > 0`, now tests the column instead of the context value, on writes and when ALTER validates existing rows.
architecture: docs/sql-ddl.md#262-mutation-context-table-level-parameters
files:
  - packages/quereus/src/schema/rename/self-qualifier-strip.ts  # OWN_ROW_QUALIFIER, stripColumnQualifier's shadowed branch, requalifyOwnRowRef
  - packages/quereus/src/schema/expr-scope/frame.ts  # new ScopeFrame.barrier and hasBarrierFrame
  - packages/quereus/src/planner/building/constraint-builder.ts  # registers the shadowed names, passes them to the strip
  - packages/quereus/src/planner/analysis/check-extraction.ts  # comments only: the screen stays, with an accepted-tradeoff NOTE
  - packages/quereus/test/logic/46-mutation-context.sqllogic  # Tests 27, 28, new 29
  - docs/sql-ddl.md  # §2.6.2
  - docs/sql-alter.md  # Existing-row validation of a CHECK
  - docs/optimizer-fd.md  # Row-invariant gate, fourth leg
----

## What changed

A column is "shadowed" when a declared context variable has the same name. In a CHECK, `<table>.<name>` and `<schema>.<table>.<name>` of a shadowed column now fold to a reserved qualifier, `__quereus_own_row__`. The CHECK's scope registers that qualifier against the NEW row on INSERT and UPDATE and the OLD row on DELETE. The existing-row scan rewrites the same spellings to its scan alias under the column's internal name. A `<table>.<name>` that names only a variable still reads the variable, and `context.<name>` with no schema still reads the variable on a table literally named `context`. The optimizer still draws no fact from the spelling.

## Differences from the ticket's design

Please check these first, because they go beyond what the ticket specified.

- **The fold stops at CTE, derived-table and DML bodies.** The ticket said the shadowed branch skips the capture loop entirely. That loop was also what kept a self-qualified name out of those bodies. Skipping it let `t.who` in a CTE body resolve, and `insert into t values (1, 5), (2, -5)` then stored the second row under a CHECK that should refuse it. I added `ScopeFrame.barrier` to separate "cannot correlate" from "holds an opaque source", so these names stay qualified and fail with `t.who isn't a column`, as they do today and as an unshadowed name does. A name beside a derived or function source in the same FROM still folds.
- **`main."new".x` on a table named `new` now works in the ALTER scan.** It failed with `main.new.x isn't a column` for every column, shadowed or not, because the scan treated any `new` qualifier with a schema as not its own. `requalifyOwnRowRef` now tests the self-qualified and row-image cases separately. This also makes `new.ghost` on a table `new`, where `ghost` is only a variable, read the variable, as the write path does. No test covers that `ghost` case.

## Validation

`yarn workspace @quereus/quereus test`: 11057 passing, 26 pending, 0 failing. `yarn workspace @quereus/quereus run lint`: clean. `46-mutation-context.sqllogic` also passes under `node test-runner.mjs --store --grep 46-mutation-context`; the full store suite was not run.

A scratch script on the `dist` build reproduced every row of the ticket's "Required" column, and also passed for upsert, `insert or replace`, a write through a view, mixed-case spellings, and a CHECK left over from renaming the column.

## Tests

All in `test/logic/46-mutation-context.sqllogic`:

- Test 27 `FactSelf`: the insert of -1 is refused, and the plan shows no `EMPTYRELATION`, which pins that no fact is lifted from the spelling.
- Test 28 `AvShadow` `k3`, `k4`: rejected over the row holding -1, including inside a subquery.
- Test 28 `context` `k3`: a three-part name on a table `context` reaches the column under ALTER.
- Test 28 `AvSelfReq`: a NOT NULL variable the CHECK does not read does not stop ALTER judging the column.
- Test 28 table `"new"`: two-part and three-part spellings are both judged against the column.
- Test 29 `SqPair`, `SqSchema`, `SqDelete`: INSERT and UPDATE, the three-part spelling, and DELETE reading the old row.
- Test 29 `SqReq`: writes need no NOT NULL variable that nothing reads.
- Test 29 table `"new"` and table `context`: `new.who` is the column, and on `context` two parts read the variable while three parts read the column.
- Test 29 `SqSub`, `SqNew`: a subquery whose source has a same-named column, or is itself named `new`, still reaches the outer row's column.
- Test 29 `SqCte`: the barrier arm above.

## Known gaps

- **`bug-subquery-selecting-outer-column-cached-as-uncorrelated` (new, in `tickets/fix/`).** This is a wider wrong-result bug that predates this ticket, found while testing the barrier: `select a, (select t.b from u) as m from t` returns the first row's `b` for every row. It reaches CHECKs too. `check ((select t.who from u) > 0)` lets a bad second row through a multi-row insert, exactly as `new.b` and `t.b` do on a table with no context. This ticket does not fix that and does not make it worse.
- **ADD COLUMN with a computed DEFAULT or generated column** still refuses `t.who` with `t.who isn't a column`, as it does every self-qualified name. It is a loud refusal and already tracked by `bug-add-column-per-row-check-refuses-spellings-the-scan-accepts`. So the "always reach the column" sentence in §2.6.2 is not yet true on that one path.
- **ALTER can accept a CHECK no write can plan.** A self-qualified name inside a CTE or derived-table body is judged by the scan, while every later write fails with `isn't a column`. Unshadowed names already behave this way, and it stores no wrong data. It is recorded in the `NOTE:` on `OwnRowContextVariables`.
- **A false dependency, not filed.** `drop table context` was refused with `referenced by CHECK constraint 'value_check' on table 'items'`, which looks like an earlier CHECK's `context.<name>` variable read being taken for a reference to a table named `context`. I did not investigate it; Test 29 works around it by reusing the table.

## Release note

A CHECK that spells a column as `<table>.<column>` or `<schema>.<table>.<column>`, on a table declaring a context variable of the same name, now tests the column rather than the variable. Existing rows are not re-validated, so a table may hold rows that violate the CHECK as now read, and writes that were accepted may now be rejected (and the reverse). Writes to such a table no longer need that variable supplied if nothing else reads it. Queries still return those rows, since the optimizer draws no fact from this spelling, except on a table literally named `new`, where the spelling is `new.<column>` and a fact is drawn.
