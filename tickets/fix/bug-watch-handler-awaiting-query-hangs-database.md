description: A change watcher whose callback waits on a query against the same database hangs that database permanently, even though re-querying after a change is an obvious thing for a watcher to do.
files:
  - packages/quereus/src/runtime/delta-executor.ts # subscriptionFromChangeScope awaits the handler's promise
  - packages/quereus/src/core/database-watchers.ts # runPostCommit awaits the whole dispatch
  - packages/quereus/src/core/database-transaction.ts # commitTransaction awaits runPostCommitWatchers
  - docs/change-scope.md # firing semantics; "Handlers run under the execution mutex" documents this hang as a rule for handlers
repro: verified
severity: edge-case
likelihood: normal-use
tradeoffs: A handler can avoid the hang by not awaiting its query, and dispatching handlers after the mutex is released would let the next statement run before they do, which weakens the ordering handlers get today.
----

`db.watch` handlers run inside the commit, and the commit awaits any promise a handler returns. Every statement holds the execution mutex through its commit, so a handler that does this never finishes:

```ts
db.watch(scope, async () => {
	for await (const row of db.eval('select count(*) from t')) { /* ... */ }
});
await db.exec("insert into t values (1, 'a')");
```

The query queues for the mutex, the commit waits for the handler, and the mutex is released only when the commit finishes. Every later statement on that database queues behind them.

**Observed with `db.exec`, `stmt.run` and `db.eval` as the writer**, each on its own database in one process, with a 1 second limit: the write did not complete, and the handler fired once.

`bug-overlapping-statement-commits-implicit-transaction-twice` moved the `db.eval` commit inside the mutex, which is why that path now hangs like the others; before it, the nested query committed the same transaction again and the handler fired repeatedly. That ticket also documented the rule for handlers. This ticket is about removing the trap.

**Expected:** a handler can await a query on the same database, and it sees the committed state. Failing that, the misuse produces an error rather than a permanent hang. The engine cannot currently tell a re-entrant statement from an unrelated caller who should queue, so a useful error is not straightforward.

A connection's `commit()` that awaits a statement has the same hang, but that one is inherent to a commit being serialized and is covered by documentation. Handlers differ because they run after the connections have committed, so they do not need to run under the mutex for the commit to be correct.

No `db.watch` call site in this repository passes an inline async handler, so this has not been hit here; it would hit a host application.

The maintainer decided on 2026-11-04 to ship v4.26.0 with this as a known issue and fix it next. If the fix has to weaken the ordering handlers get today, route that choice to `blocked/` with a proposal.
