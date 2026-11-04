description: When statements overlapped on one database, a statement could commit or roll back another statement's automatic transaction, causing double commits and silently losing writes reported as successful. Each statement now finishes its transaction before the next one can start.
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
  - docs/usage.md # commit failure on iterators, watch handler rule
repro: verified
----

Reported in GitHub issue #38.

## What changed

`db.eval`, `stmt.iterateRows`, `stmt.all` and `stmt.iterateRowsWithTrace` used to finalize their implicit transaction from `wrapAsyncIterator`, outside the generator holding the execution mutex. Any of them could therefore commit or roll back whichever implicit transaction happened to be open.

Every serialized iteration now goes through `Database._iterateSerialized`, which holds the mutex until the transaction has finished. `stmt.run` and `stmt.get` use it too, so there is one finalize path apart from the `exec` batch loop. `wrapAsyncIterator` and `_runWithMutex` are deleted.

`_finalizeImplicitTransaction` now throws an internal error if the mutex is not held, so a future finalize outside it fails in an ordinary single-caller test.

`execution_trace` and `row_trace` run inside a statement that already holds the mutex, so they use `Statement._iterateRowsNestedWithTrace`, which takes no mutex. If an implicit transaction was already open when it started, it leaves that transaction to the enclosing statement. Otherwise it finalizes as before.

## Behaviour to expect

- A read issued during a commit waits for it. Callers who do not want to wait have `readConcurrency: 'committed'`, which is unchanged.
- A failing commit rejects the statement that owns it, from `next()` or `return()`. A later statement sees nothing.
- A statement that is aborted before it starts, or an iterator that is never started, touches no transaction. A statement with a syntax error queues for the mutex, fails after the commit, and also touches no transaction.
- On `return()`, the row source now unwinds before the commit. Normal completion already had this order.
- On the `eval`, `all` and `iterateRows` paths, a commit that fails under OR FAIL now replaces the conflict error, matching `exec`, `run` and `get`.
- `_isExecuting()` is now true during these commits.
- `stmt.iterateRows()` on a closed database reports "Database is closed" instead of "Statement finalized"; both are `MisuseError`. A prepared statement run during `close()`, before the statement sweep finalizes it, is refused.
- A module `commit()` or `db.watch` handler that awaits a statement on the same database hangs on every path. This is documented. Making handlers safe is `bug-watch-handler-awaiting-query-hangs-database`.

## Tests

`test/core/overlapping-statement-finalize.spec.ts`: one overlap case per writer path (`db.eval`, `stmt.all`, `stmt.iterateRows`, `stmt.iterateRowsWithTrace`), a failing commit, three statements that must leave a parked commit alone, and both branches of the nested trace method.

## Review findings

Reviewed the `ticket(implement): bug-overlapping-statement-commits-implicit-transaction-twice` diff before the handoff.

**Fixed in this pass:**

- **`_iterateRowsNestedWithTrace` tagged `@internal`.** The implementer left it on the type surface because table-valued functions outside the package need it, and asked for that reading to be confirmed. It is wrong: `createIntegratedTableValuedFunction` is not exported from any of the package's entry points (`.`, `./parser`, `./emit`), and nothing outside `packages/quereus/src` calls the method. The rebuilt `statement.d.ts` no longer declares it; the `iterateRowsWithTrace` comment still names it in a `{@link}`, which does no harm.
- **The nested-trace NOTE was false, and is rewritten.** It said a failed nested statement's partial writes stay in the enclosing transaction. Running it with an enclosing implicit transaction open: under the default action and `or rollback`, `t` is empty, because the failed statement's own savepoints undo its writes; `or fail` keeps its rows, by design. The behaviour the NOTE should have named is that `or rollback` does not end the enclosing transaction (the earlier `u` row survived). The NOTE now says this.
- **`docs/usage.md` did not cover the new behaviour.** Added to the `db.eval` section that a failing commit rejects `next()` or the `return()` that a `break` triggers, and to the watch section that a handler awaiting a statement hangs the database. Both were documented only for module and change-scope readers.
- **Two backlog tickets described the old code.** `bug-close-returns-while-statement-still-running` named the deleted `_iterateRowsGenerator`. `bug-watch-handler-awaiting-query-hangs-database` still said `db.eval` commits outside the mutex; it now records the current result, re-run here: the write did not settle within 1 second and the handler fired once, for `db.exec`, `stmt.run` and `db.eval` writers.

**Tripwires parked:**

- Per-row cost of the extra generator layer, which the handoff left unmeasured. One run of `stmt.iterateRows` over a 300,000-row series gave medians of 490 ns/row with no layers, 616 with the old wrapper shape (rebuilt in a script with a no-op cleanup) and 681 now. This is a single run on one machine, and the later rounds were noisy. NOTE on `Database._iterateFinalizing`.
- OR ROLLBACK inside a trace run under an enclosing implicit transaction. NOTE on `Statement._iterateRowsNestedWithTrace`.

**Checked, nothing found:**

- Finalize on every exit path: normal completion, `break`, a thrown body, `throw()` into the iterator (re-run: rolled back, no open transaction), and a body whose unwinding throws. A commit failing in the `finally` is attempted once, because a failed commit has already cleared the transaction state.
- Mutex release: the inner `finally` runs even if finalize throws, and a failed support check in `_acquireExecMutex` releases its own slot.
- The guard: `_finalizeImplicitTransaction` is called only from `_iterateFinalizing` and the `exec` loop, both under the mutex. `database-external-changes.ts` finalizes through its own path under its own mutex hold.
- Committed reads: they never reach the guard. `_isConcurrentReadEligible` rejects every table-valued function, so a trace cannot run without the mutex.
- Internal callers: nothing in `src` calls `iterateRowsWithTrace` now, so nothing can newly deadlock on it. The internal statement cache uses `_iterateRowsRaw`. `_isExecuting()` being true during more commits affects only the sync layer's `notifyLensDeployment` decision, which already defers.
- The new `checkOpen()`: the only long-lived prepared statements outside the engine are local to a function, in `quoomb-cli`, `quoomb-web` and `planviz`. The plugin `@optimystic/quereus-plugin-optimystic` is outside this repository and remains uninspected, as the handoff said.
- Other commit-time work: assertions, deferred constraints and event flushing already ran under the mutex on `exec`, and `flushBatch` listeners are synchronous and not awaited.
- Docs: `docs/sql-txn.md` § 8.6 already states a read waits for an in-flight commit, which is now true, so it needs no edit. No stale reference to the deleted helpers remains except `docs/review.html`, which is a dated review and stays as written.
- Hygiene: `database.ts` and `statement.ts` grew only slightly, and the comments added state constraints rather than narrate code. Line counts were not taken because no split is proposed.

**Tests:** none cut and none added. The nested no-enclosing-transaction case passed before the fix, but it pins the other branch of real logic, so it stays. There is no test for the guard's throw: it is a one-line check, the handoff's one-off script ran it, and any path that breaks it fails ordinary suites. `stmt.run` and `stmt.get` have no overlap test, as the handoff said; they share `_iterateSerialized` with the tested paths.

**No tickets filed.** The one open defect in this area, the watch handler hang, already has its ticket.

**Validation:** `yarn build`, `yarn lint`, `yarn bench:gate` and `yarn docs:check` pass. `yarn workspace @quereus/quereus run test` gave 10995 passing, 26 pending; the other workspaces ended with `Done`, though I saw only the tail of their output. Those two test runs came before the final edits, which changed only one `@internal` tag, comments, docs and tickets. After those edits, lint and the build passed, and `overlapping-statement-finalize.spec.ts` and `diagnostic-tvfs.spec.ts` passed (28). `yarn test:store` was not re-run here; the handoff reports it passing on this code.
