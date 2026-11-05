description: A change watcher whose callback waited on a query against the same database used to hang that database permanently. The commit no longer waits for an asynchronous callback, so this now works, but later statements can run before such a callback finishes.
architecture: docs/change-scope.md#handler-ordering
files:
  - packages/quereus/src/runtime/delta-executor.ts # `fire` returns the handler's promise; `apply` defers it
  - packages/quereus/src/core/database-watchers.ts # routes promises to the database; external path awaits serially; fireWithTxnId
  - packages/quereus/src/core/database.ts # per-hold promise list, release function returns a promise, deferWatchHandler
  - packages/quereus/src/core/database-external-changes.ts # third mutex holder awaits the release
  - packages/quereus/src/planner/analysis/change-scope.ts # WatchHandler doc
  - packages/quereus/test/core/watch-handler-reentrant.spec.ts # regression spec
  - docs/change-scope.md # section renamed "Handler ordering"
  - docs/usage.md
  - docs/incremental-maintenance.md
repro: verified
----

## Release-note callout (required by the maintainer)

Hosts outside this repository were not inspected, so this behaviour change must reach the release notes. `.release-notes.pending.md` was left untouched for the maintainer to curate; suggested text:

> **`Database.watch`: asynchronous handlers no longer block later statements.** A handler that awaits a statement on the same database used to hang that database permanently, and now works. The commit no longer waits for a handler's promise. After its first `await`, an async handler no longer runs ahead of later statements, and it can overlap other handlers and itself for a later commit. A handler that needs its events in order must queue them itself. `await db.exec(...)` still means the handlers that statement fired have finished, and synchronous handlers are unaffected.

A host that queues its handlers should also read the stall described in `docs/change-scope.md` § Handler ordering before returning the queue's promise from a handler.

## What was built

The commit calls every handler but no longer waits for a promise one returns. Each hold of the execution mutex (the lock that makes statements on one database run one at a time) keeps its own list of those promises. The statement releases the mutex, then waits for its list. The list is per hold because a shared one would make a handler's write wait on the handler that is waiting for that write.

`_acquireExecMutex` returns a release function that frees the mutex synchronously and returns a promise for that hold's handlers. That promise never rejects, because each handler's rejection is logged as soon as it happens, so awaiting it in a `finally` cannot replace a statement's error. `_withMutex`, `_iterateSerialized` and `ingestExternalRowChangeBatch` all await it. `notifyExternalChange` holds no mutex and still awaits handlers one at a time.

```ts
db.watch(scope, async () => {
	for await (const row of db.eval('select count(*) from t')) { /* sees the committed row */ }
});
await db.exec("insert into t values (1, 'a')"); // settles, and the handler has finished
```

Beyond the original ask, the implement stage also fixed a `txnId` defect on the external-notification path: a handler that awaited a write made the next handler in that pass receive `txnId: ''`. `fireWithTxnId` now sets the id only for the synchronous call. The review accepts this: the new docs tell handlers they may await writes and that `txnId` identifies the event, so the defect was reachable through documented use.

## Review findings

Read the diff of `ticket(implement): bug-watch-handler-awaiting-query-hangs-database` before the handoff, then ran the handoff's unverified cases in a throwaway script against the build (kept outside the repository).

**Fixed in this pass**

- Docs trap, reproduced: the docs tell a handler that needs order to queue its events, but a queue whose handlers return its promise stalls for good when a queued job awaits a write whose handlers also enqueue. The write waited on the new job, which waited behind the job awaiting the write. The writer's promise never settled and the queue never drained; a later statement still ran. The same queue with handlers returning nothing completed both jobs. `docs/change-scope.md` § Handler ordering now says so and gives the safe form. The accepted replacement text is unchanged; this extends the implementer's added paragraph.
- Docs gap, reproduced: a handler's statement issued after its first `await` joined a later explicit transaction from another caller and was rolled back with it (0 rows in the handler's table after the host's `rollback`). Now documented, with a link to `docs/sql-txn.md`.
- Docs gap, reproduced: `close()` does not wait for handlers. A handler parked across `close()` got `Database is closed` from its next statement, and its writer still settled. Now documented in the same paragraph.
- Unverified contract, test added: a statement that fails after an earlier commit in the same hold waits for that commit's handler, then rejects with its own error even when the handler also rejects. The behaviour was already correct. One test added to `watch-handler-reentrant.spec.ts`.

**Handoff gaps closed**

- Awaiting the firing statement's own promise was not run by the implementer. Run here: that statement's promise stays pending and a later statement completes, as the docs paragraph says.
- No benchmark was run. Measured here on the build, one run each on this machine: `await Promise.all([])` costs about 194 ns, and `await db.exec('select 1')` about 71 µs, so the added wait is under 0.3% of the cheapest statement. No change.
- Commit outside a mutex hold: listed every `_commitTransaction` and `commitTransaction` call site with grep, in `database.ts`, `database-external-changes.ts`, `runtime/emit/transaction.ts` and `runtime/emit/alter-table.ts`. From their locations, each runs inside a statement, batch, ingest or refresh-sweep hold; this was not asserted at runtime. The other route, `_autocommitIfNeeded`, has no callers in `packages/quereus/src`. `deferWatchHandler` silently keeps nothing if a hold-less commit ever appears; its doc comment says so, and the handler still runs and logs its own failure. No assertion added, because `vtab/test-support/connection-lifecycle-check.ts` already reports a connection commit made without the mutex under its test harness.

**Tripwires**

- An abort signal does not end the wait for handlers: `exec` with an aborted signal stayed pending until its handler finished (reproduced). Parked as a `NOTE:` in `Database._acquireExecMutex`.

**Checked, nothing found**

- Release function: the double-release guard cannot clear a later hold's list; the mutex is freed before the first `await`, so a caller that does not await the release still frees it.
- Hold list: nothing can add to a list after its release, because every commit happens inside the hold, so `Promise.all` sees the complete list.
- Error handling: a handler's synchronous throw and its rejection both reach the log, a thenable is wrapped by `Promise.resolve`, and an error thrown while computing matches on the external path is caught by the existing `try`.
- `txnId`: the commit pass and external pass can interleave at microtask boundaries, and `fire` reads the id synchronously in both, so neither sees the other's id.
- Handlers and the change log: `hits` are computed before the handler is called, so a handler resuming after the log is cleared reads nothing stale.
- In-repository consumers: `db.watch` is called only from tests and docs outside the engine, so no in-tree host relies on the old ordering. `quereus-sync`'s `_isExecuting` check is about a lens-deployment hook, not a watch handler.
- Types and hygiene: no `any` added; the `fire`/`apply` split is the smallest shape that lets the external path wait and the commit path not; comments state constraints rather than narrate. Stale references to the old section heading: none remain in `docs/`.
- Tests: all earlier tests in the new spec kept. Each either failed before the fix or pins a stated contract, per the implementer's before-and-after run, which this review did not repeat. None was cut.
- Major findings and new tickets: none. Every finding above was resolved in this pass or recorded as a tripwire, so nothing met the filing bar.

**Accepted as is**

- The implementer's added docs paragraph on stalled handlers stays, now verified.
- Hosts outside this repository remain uninspected, which is why the release-note callout above is required.

## Validation

- `yarn workspace @quereus/quereus run lint`: exit 0.
- `yarn build`: succeeds.
- `yarn test`: exit 0 across all workspaces, 11093 passing and 26 pending in `@quereus/quereus`.
- `watch-handler-reentrant.spec.ts` run on its own with the spec reporter: 13 passing, including the test added in this pass.
- `yarn test:store` was not run, because nothing here is specific to the store path.
