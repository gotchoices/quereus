description: When statements overlapped on one database, a statement could commit or roll back another statement's automatic transaction, causing double commits and silently losing writes reported as successful. Each statement now finishes its transaction before the next one can start, and this needs a review.
architecture: docs/sql-txn.md
files:
  - packages/quereus/src/core/database.ts # _iterateSerialized, _iterateFinalizing, the guard in _finalizeImplicitTransaction, eval, _evalSerialized, _evalGenerator
  - packages/quereus/src/core/statement.ts # iterateRows, all, run, get, iterateRowsWithTrace, _iterateRowsNestedWithTrace
  - packages/quereus/src/func/builtins/explain.ts # execution_trace and row_trace use the nested method
  - packages/quereus/src/func/registration.ts # NOTE for table-valued function authors
  - packages/quereus/src/vtab/connection.ts # commit() doc comment
  - packages/quereus/src/util/async-iterator.ts # deleted
  - packages/quereus/test/core/overlapping-statement-finalize.spec.ts # new
  - docs/module-authoring-transactions.md # commit() rule
  - docs/change-scope.md # watch handler rule
repro: verified
----

Reported in GitHub issue #38.

## What changed

`db.eval`, `stmt.iterateRows`, `stmt.all` and `stmt.iterateRowsWithTrace` used to finalize their implicit transaction from `wrapAsyncIterator`, outside the generator holding the execution mutex. Any of them could therefore commit or roll back whichever implicit transaction happened to be open.

Every serialized iteration now goes through `Database._iterateSerialized`, which holds the mutex until the transaction has finished. `stmt.run` and `stmt.get` use it too, so there is one finalize path apart from the `exec` batch loop. `wrapAsyncIterator` and `_runWithMutex` are deleted.

`_finalizeImplicitTransaction` now throws an internal error if the mutex is not held, so a future finalize outside it fails in an ordinary single-caller test.

`execution_trace` and `row_trace` run inside a statement that already holds the mutex, so they use a new method, `Statement._iterateRowsNestedWithTrace`, which takes no mutex. If an implicit transaction was already open when it started, it leaves that transaction to the enclosing statement. Otherwise it finalizes as before.

## Behaviour to expect

- A read issued during a commit waits for it. Callers who do not want to wait have `readConcurrency: 'committed'`, which is unchanged.
- A failing commit rejects the statement that owns it, from `next()` or `return()`. A later statement sees nothing.
- A statement that is aborted before it starts, or an iterator that is never started, touches no transaction. A statement with a syntax error queues for the mutex, fails after the commit, and also touches no transaction.
- On `return()`, the row source now unwinds before the commit. Normal completion already had this order.
- On the `eval`, `all` and `iterateRows` paths, a commit that fails under OR FAIL now replaces the conflict error, matching `exec`, `run` and `get`.
- `_isExecuting()` is now true during these commits.
- A module `commit()` or `db.watch` handler that awaits a statement on the same database now hangs on every path. This is documented. Making handlers safe is `bug-watch-handler-awaiting-query-hangs-database`.

## Differences from the ticket's sketch

- **Catch-and-finalize is a separate generator.** `_iterateFinalizing` is split out of `_iterateSerialized` so the nested method can share it. This puts one more generator layer on each row, in place of the deleted wrapper layer. `stmt.run` and `stmt.get` previously had no such layers and now have them. I did not measure the per-row cost.
- **`_iterateSerialized` also calls `checkOpen()`.** `stmt.iterateRows()` on a closed database now reports "Database is closed" instead of "Statement finalized"; both are `MisuseError`. A prepared statement run during `close()`, before the statement sweep finalizes it, is now refused where it used to proceed. I found nothing in the repository that does this, but I did not audit every module's `disconnect()`.
- **`_iterateRowsNestedWithTrace` is not tagged `@internal`.** The package builds with `stripInternal`, and the NOTE in `registration.ts` sends table-valued function authors outside the package to this method, so a tag would remove it from their types. It has the underscore prefix and is left on the type surface, like `_isExecuting`. The ticket called it internal, so please confirm this reading.

Additions the ticket did not ask for: doc comments on `VirtualTableConnection.commit` and `Database.watch`, and the change-scope bullet "Re-entrancy is safe" narrowed to subscription changes, because it contradicted the new section.

## Tests added

All are in `test/core/overlapping-statement-finalize.spec.ts`. The first nine failed before the fix.

- Four cases, one each for `db.eval`, `stmt.all`, `stmt.iterateRows` and `stmt.iterateRowsWithTrace` as the writer: an overlapping `select` waits for the commit, `commit` is called once, and the `select` sees the row. This is the issue's reproduction.
- A failing commit rejects the writer and not the overlapping `select`, with one commit and one rollback.
- Three cases with the commit parked: an already-aborted `eval`, a syntax-error `eval`, and `return()` on a never-started iterator cause no rollback and no second commit, and the row survives.
- `insert into u select 1 from execution_trace('select 1')` fails and leaves `u` empty.
- `select * from execution_trace('insert ...')` commits its own write. This one passed before the fix too. It is beyond the ticket's list, and pins the other branch of the nested method.

## Validation

- `yarn build`, `yarn lint` and `yarn test` pass in every workspace, including sync, store and isolation, with no hangs.
- `yarn test:store` passes (10988 passing). It is not the default for agents; I ran it because this changes when commits run on every `eval` path.

Checked once with a throwaway script, with no test kept:

- A `db.watch` handler or module `commit()` awaiting `db.eval` hangs with both an `exec` writer and an `eval` writer. This was judged by the write not settling within a bounded wait.
- A watch handler that starts a query without awaiting it runs once and sees the committed row, which is the advice now in the docs.
- Two overlapping `db.eval` inserts give begin 2, commit 2, and both rows.
- OR FAIL keeps the earlier rows, and a failing commit replaces the conflict error.
- `break` out of an `eval` commits; `stmt.get` commits, and rejects if the commit fails.
- `_isExecuting()` is true during a commit.
- `eval` on a closed database rejects, and a finalize outside the mutex throws.

## Known gaps

- `@optimystic/quereus-plugin-optimystic` is outside this repository and was not inspected. A `commit()` there that awaits a statement on the same database would now hang on `eval` writers too, as it already would on `exec` writers.
- Only `iterateRowsWithTrace` and the four writer paths have overlap tests. `stmt.run` and `stmt.get` were already correct and are rerouted without a new overlap test, and are covered by the existing suites and the mutex guard.
- `docs/review.html` still praises `wrapAsyncIterator`. It is a review dated July 2026, so I left it unedited as a historical record.
- A NOTE on `_iterateRowsNestedWithTrace` records the tripwire from the ticket: a failed nested statement's partial writes stay in an enclosing implicit transaction, because the trace functions swallow the error.
