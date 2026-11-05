description: A change watcher whose callback waits on a query against the same database used to hang that database permanently. The commit no longer waits for an asynchronous callback, so this now works, but later statements can run before such a callback finishes.
architecture: docs/change-scope.md#handler-ordering
files:
  - packages/quereus/src/runtime/delta-executor.ts # `fire` returns the handler's promise; `apply` defers it
  - packages/quereus/src/core/database-watchers.ts # routes promises to the database; external path awaits serially; fireWithTxnId
  - packages/quereus/src/core/database.ts # per-hold promise list, release function returns a promise, deferWatchHandler
  - packages/quereus/src/core/database-external-changes.ts # third mutex holder awaits the release
  - packages/quereus/src/planner/analysis/change-scope.ts # WatchHandler doc
  - packages/quereus/test/core/watch-handler-reentrant.spec.ts # new regression spec
  - docs/change-scope.md # section renamed "Handler ordering"
  - docs/usage.md
  - docs/incremental-maintenance.md
repro: verified
----

## Release-note callout (required by the maintainer)

Hosts outside this repository were not inspected, so this behaviour change must reach the release notes. `.release-notes.pending.md` was left untouched for the maintainer to curate; suggested text:

> **`Database.watch`: asynchronous handlers no longer block later statements.** A handler that awaits a statement on the same database used to hang that database permanently, and now works. The commit no longer waits for a handler's promise. After its first `await`, an async handler no longer runs ahead of later statements, and it can overlap other handlers and itself for a later commit. A handler that needs its events in order must queue them itself. `await db.exec(...)` still means the handlers that statement fired have finished, and synchronous handlers are unaffected.

## What changed

The commit calls every handler but no longer waits for a promise one returns. Each hold of the execution mutex (the lock that makes statements on one database run one at a time) keeps its own list of those promises. The statement releases the mutex, then waits for its list. The list is per hold because a shared one would make a handler's write wait on the handler that is waiting for that write.

`_acquireExecMutex` now returns a release function that frees the mutex synchronously and returns a promise for that hold's handlers. That promise never rejects, because each handler's rejection is logged as soon as it happens, so awaiting it in a `finally` cannot replace a statement's error. `_withMutex`, `_iterateSerialized` and `ingestExternalRowChangeBatch` all await it. `notifyExternalChange` holds no mutex and still awaits handlers one at a time.

## How to use and validate it

```ts
db.watch(scope, async () => {
	for await (const row of db.eval('select count(*) from t')) { /* sees the committed row */ }
});
await db.exec("insert into t values (1, 'a')"); // settles, and the handler has finished
```

Cases worth checking by hand or by adversarial test:

- A handler awaiting a query or a write, fired by `db.exec`, `stmt.run`, `db.eval`, an explicit `commit`, `db.commit()`, or `ingestExternalRowChanges`.
- A statement issued while an async handler is parked: it runs, and the writer's own promise stays pending until the handler finishes.
- A batch such as `exec('insert ...; insert ...')`, or the materialized-view refresh sweep, which commits several times in one hold: the writer waits for all of those handlers.
- A commit that fails after an earlier commit in the same hold fired a handler: the statement should wait for the handler, then reject with the original error. This case has no test.

## Validation run

- `yarn build`: succeeds. `yarn test`: all workspaces pass, with no failures. `yarn workspace @quereus/quereus run lint` (eslint plus test-file type check): exit 0.
- Before the fix, 9 of the 12 new tests failed: 8 timed out at a 1500 ms limit, and the external-path test got `txnId: ''`. The other 3 passed before the fix and guard behaviour that must not regress. All 12 pass now.
- `yarn test:store` was not run, because nothing here is specific to the store path.

## Tests added

All in `packages/quereus/test/core/watch-handler-reentrant.spec.ts`:

| Test | Verifies |
| --- | --- |
| a handler awaiting a query sees the committed row when fired by `db.exec`, `stmt.run`, `db.eval`, an explicit commit (4 cases) | The reported hang is gone on each writer path |
| a committed read awaited by a handler settles after an explicit commit | The `readConcurrency: 'committed'` row from the original measurements, which fell back to the mutex and hung |
| a handler awaiting a query settles when fired by an external row ingest | The third mutex holder |
| a handler awaiting a write settles through the async watcher on that table | Promises are per hold; a shared list would deadlock here |
| handlers run up to their first await before a statement queued behind the writer | Commit-order guarantee for sync handlers and for the part of an async handler before its first `await` |
| later statements run while an async handler is pending, and its writer waits for it | Both halves of the new contract |
| a writer waits for the handlers of every commit it made while holding the mutex | Promises accumulate across commits in one hold |
| a rejecting async handler does not fail its writer | Rejections are logged and do not reach the statement |
| a handler writing during an external notification leaves later handlers their txnId | Reproduction of the `txnId` defect below |

Existing tests edited only to fit the new signatures: `exec-mutex-reentrancy.spec.ts` (`void release()`, required by the floating-promise lint rule) and `delta-executor-watch.spec.ts` (new required `deferHandler` context member).

## Beyond the ticket, for the reviewer to accept or push back on

- **`txnId` fix on the external path, not requested.** A handler that awaited a write during `notifyExternalChange` caused the commit pass to clear the shared id, so the next handler in that pass received `txnId: ''`. Reproduced before the fix. `fireWithTxnId` now sets the id only for the synchronous call. It was fixed here because the new docs tell handlers they may await writes and that `txnId` identifies the event.
- **One added docs paragraph.** The accepted replacement text is in `docs/change-scope.md` word for word. A fourth paragraph was added after it: a handler that never settles, or that awaits the promise of the statement that fired it, stalls only that statement's promise, and the database keeps running. Remove it if the accepted text should stand alone. The never-settling part follows from the "later statements run while an async handler is pending" test; awaiting the firing statement's own promise was not run.
- **Docs beyond the listed files.** `docs/incremental-maintenance.md` called handlers "fire-and-forget", and the doc comments on `Database.watch` and `WatchHandler` repeated the old rule. All are updated.

## Known gaps, from reading the code and not run

- **A handler's statement can land inside a later explicit transaction.** After its first `await`, a handler's statement queues like any other caller's. If the host has since run `begin`, that statement joins the transaction and is rolled back with it. This fits "no ordering against other work", but the docs do not spell it out, and hosts may not expect it.
- **An abort signal does not interrupt the wait.** `db.exec(sql, params, { signal })` keeps waiting for its handlers after an abort, because the wait happens after the statement has finished.
- **A commit outside a mutex hold.** `deferWatchHandler` ignores the promise when no hold is active, so nothing waits for that handler. All in-tree commit paths were read and hold the mutex, but no assertion enforces it.
- **No benchmark was run.** Every statement release now does one `await Promise.all(...)` on a usually empty list. It is expected to be small next to statement cost, but it was not measured.
- **Hosts outside this repository** were not inspected, as the ticket already noted; hence the callout above.
