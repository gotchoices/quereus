description: A change watcher whose callback waits on a query against the same database hangs that database permanently. Any real fix must let later statements run before an asynchronous callback finishes, so a maintainer needs to accept that ordering change.
architecture: docs/change-scope.md#handlers-run-under-the-execution-mutex
files:
  - packages/quereus/src/runtime/delta-executor.ts # apply in subscriptionFromChangeScope awaits the handler's promise
  - packages/quereus/src/core/database-watchers.ts # runPostCommit, notifyExternalTableChange
  - packages/quereus/src/core/database-transaction.ts # commitTransaction awaits runPostCommitWatchers
  - packages/quereus/src/core/database.ts # _withMutex, _iterateSerialized, _acquireExecMutex
  - packages/quereus/src/core/database-external-changes.ts # third mutex holder
  - docs/change-scope.md # firing semantics and the handler rule
  - docs/usage.md # watch section repeats the handler rule
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: A handler can avoid the hang by not awaiting its query, and the fix gives up the guarantee that no later statement runs until an asynchronous handler has finished.
----

**Blocked: the specification choice below needs a maintainer decision. Unblock by accepting or editing the proposed firing semantics; the ticket then moves to `implement/`.** On 2026-11-04 the maintainer asked that any fix weakening handler ordering be routed here. This one has to weaken it, for the reason given under "Why ordering must change".

## The problem

`db.watch` handlers run inside the commit, and the commit awaits any promise a handler returns. Every statement holds the execution mutex (the lock that makes statements on one database run one at a time) through its commit, so this never finishes:

```ts
db.watch(scope, async () => {
	for await (const row of db.eval('select count(*) from t')) { /* ... */ }
});
await db.exec("insert into t values (1, 'a')");
```

The query queues for the mutex, the commit waits for the handler, and the mutex is released only when the commit finishes. Every later statement on that database queues behind them.

## What was measured

One-off script against the built engine (`dist` newer than the source, HEAD `f941f867e`), with a 1 second limit:

| Case | Result |
| --- | --- |
| Handler awaits a query; the writer is `db.exec`, `stmt.run` or `db.eval` | Write does not settle in any of the three; handler fired once |
| Handler awaits a `readConcurrency: 'committed'` read, implicit transaction | Settles; handler sees the new row |
| Same read, after an explicit `begin` ... `commit` | **Does not settle**, and the handler got no row. The transaction still counts as explicit while handlers run, so the read silently falls back to the mutex |
| Handler awaits a query, fired by `db.notifyExternalChange` | Settles; handler sees the row. This path takes no mutex |
| Async handler that only awaits a timer, with three overlapping writes | `start txn:1, end txn:1, write 1 resolves, write 2 resolves, start txn:3, end txn:3, write 3 resolves`. This is the ordering today |
| Handler that starts its query but returns nothing to the commit, two overlapping writes | No hang. The handler for commit 1 sees 2 rows, because commit 2 ran first |

So the `committed` read is not a general workaround, and `notifyExternalChange` already delivers handlers with no ordering against statements. The two paths disagree today.

The only `db.watch` call whose line contains an inline `async` handler is `packages/quereus/test/external-change-watch.spec.ts:137`, on the external path. Nothing in `packages/*/src` outside the engine calls `db.watch`. That search does not catch a named async function or a handler on a later line, and hosts outside this repository were not inspected.

## Why ordering must change

For a handler's awaited query to finish, that query has to run before the handler settles. The mutex queue is first-come, first-served, so every statement queued ahead of the query also runs before the handler settles. There are only two ways around that, and both are worse:

- Let the handler's query jump the queue. The engine cannot tell a handler's statement from an unrelated caller's, so unrelated statements would jump too and run out of the order they were issued.
- Identify the handler's statement by tracking its asynchronous context. `AsyncLocalStorage` exists only on Node, and this engine also targets browsers and React Native.

So "later statements wait for the handler" cannot hold for a handler that awaits a statement. The decision is how narrowly to give that guarantee up.

## Proposed semantics (recommended)

**The commit no longer waits for a handler's promise. It still runs every handler's synchronous part, and the statement that committed waits for the promises after it has released the mutex.**

Replacement text for `docs/change-scope.md` § "Handlers run under the execution mutex", with the section renamed "Handler ordering":

> A handler is called during the commit, before the change log is cleared and before any later statement can start. Until its first `await`, a handler therefore runs in commit order, ahead of every later statement. A handler that returns nothing keeps this guarantee in full.
>
> The commit does not wait for a promise a handler returns. The execution mutex is released first, then the statement that committed waits for its own handlers' promises, so `await db.exec(...)` still means those handlers have finished. A handler can therefore await a statement on the same database, including a write.
>
> After its first `await`, an asynchronous handler has no ordering against other work on the database: later statements may run, a query it awaits may see commits later than the one that fired it, and other handlers may run alongside it, including itself for a later commit. A handler that needs its own events in order must queue them itself. `event.txnId` identifies the commit and `hits` still describes it.

What changes for each kind of handler:

| Guarantee | Sync handler | Async handler, before first `await` | Async handler, after first `await` |
| --- | --- | --- | --- |
| Runs before any later statement starts | kept | kept | **lost** |
| Finished before the next handler starts | kept | n/a | **lost** |
| Finished before its own statement's promise resolves | kept | kept | kept |
| Finished before batched data-change events flush | kept | n/a | **lost** |

## Alternatives rejected

- **Run all handlers after the mutex is released, one at a time.** This keeps handlers from overlapping each other, but sync handlers lose their ordering too, the change-log tuples must be copied out before the log is cleared, and it adds a dispatch queue. It also deadlocks unless statements stop waiting for handlers: a handler awaiting a write waits for that write, whose own handlers are queued behind the handler still running.
- **Give handlers a statement API on the event, such as `event.eval(...)`, running under the held mutex.** No ordering is lost, but `db.eval` still hangs, so the trap stays. It also adds public API, and nested statements would run while the transaction is half torn down.
- **Throw an error when a handler starts a statement.** A flag set during the handler's synchronous part misses everything after its first `await`, and it would reject the unawaited query the docs recommend today.
- **Move only the `committed` read path out of the explicit-transaction state.** This fixes one row of the table, and an ineligible read still hangs silently.

## If nothing changes

The documented rule stays and the hang remains for host applications. Workarounds are to start the query without awaiting it, or to return nothing from the handler. The first error a host sees is a stalled database with no message.

## Reversibility

No data format or API signature changes. Later statements will start overlapping async handlers, and hosts may come to rely on awaiting statements in handlers, so going back after release would reintroduce the hang for them. Sync handlers are unaffected either way.

## Implementation notes, if accepted

- `apply` in `subscriptionFromChangeScope` hands a pending promise to the caller instead of awaiting it, with its rejection logged at once. `notifyExternalTableChange` holds no mutex and keeps awaiting serially, as documented.
- Only three places take the mutex: `_withMutex`, `_iterateSerialized`, and `ingestExternalRowChanges` in `database-external-changes.ts`. Each waits for handler promises after its release.
- **Promises must be collected per mutex hold, not in one shared list.** With a shared list, a handler's write would wait on the handler that is waiting for that write, which is a new deadlock. One hold may produce several commits (the materialized-view refresh sweep, the alter-table rebuild), and its promises accumulate.
- Update `docs/usage.md`, which repeats the old rule, and the file header of `database-watchers.ts`.

Regression spec, new file `packages/quereus/test/core/watch-handler-reentrant.spec.ts`:

- A handler awaiting a query settles and sees the committed row, for `db.exec`, `stmt.run`, `db.eval`, and an explicit `commit`.
- A handler awaiting a write on another table settles, including when that table has its own async watcher.
- A sync handler still runs before a statement already queued behind the writer.
- The writer's promise resolves only after its own async handler has finished.
