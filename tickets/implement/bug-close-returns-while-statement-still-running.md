description: Closing a database returns before work already running on it has stopped, so a statement can keep reading or writing after the caller believes the database is shut. Make close wait for running work, stop open result iterators, and only then tear the database down.
architecture: docs/usage.md#dbclose
files:
  - packages/quereus/src/core/database.ts # close(), _iterateSerialized, _withMutex, _acquireExecMutex, _executeSingleStatement, concurrentReads
  - packages/quereus/src/core/statement.ts # _iterateRowsRawInternal builds the runtime context (signal); _iterateConcurrent
  - packages/quereus/src/core/database-external-changes.ts # takes the mutex directly (line ~142); needs the closed check after acquiring
  - packages/quereus/test/lifecycle.spec.ts # home for the new tests
  - packages/quereus/test/apply-schema-yields.spec.ts # 'close() rejects the apply…' — re-check against the new behaviour
  - docs/usage.md # § db.close()
  - docs/schema-declarative.md # § Yielding during an apply, the db.close() bullet (line ~207)
  - docs/architecture.md # concurrent committed-read paragraph mentions close()
  - docs/change-scope.md # line ~460 says close() does not wait for handlers — confirm still true
repro: verified
----

## What happens today (reproduced on HEAD)

`Database.close()` sets `isOpen = false`, aborts and awaits the mutex-free committed reads, then tears down shared state (disconnects connections, finalizes statements, clears the schema catalog). It never takes the execution mutex, so whatever holds the mutex keeps running. Ran on HEAD with a throwaway spec:

- **Open row iterator:** `db.eval('select * from t')`, pull one row, `await db.close()` (returns in 0.3 ms), then `it.next()` twice: both return rows (`{id: 2}`, `{id: 3}`).
- **Statement inside a module hook:** a `MemoryTableModule` subclass whose `create()` waits on a gate; `db.exec('create table s … using slow')`, wait until `create()` is entered, `await db.close()`. Order observed: `create entered`, `close resolved`, `create resumed`, `exec resolved`, and afterwards the cleared catalog contains table `s` again.
- **`close()` called from inside a hook** (`await d.close()` in `create()`): completes, and the `create table` then succeeds on the closed database.

Same root cause covers the `apply schema` cases in the old ticket (the apply finishing, or calling `endSchemaBatch`, after `close()` resolved; the misleading `table … not found after migration` seed error, which comes from the catalog being cleared under the running apply), and the GitHub #38 arm (`close()` calling `disconnect()` on a connection whose `commit()` is still awaiting): in every case teardown runs while a mutex holder is still working.

## Fix design

**Rule:** when `close()` resolves, no statement, ingest, or refresh is running, and teardown happened after they stopped. Teardown runs while `close()` itself holds the execution mutex.

`close()` becomes:

1. If a close is already in progress or done, return the same promise (store it, e.g. `closePromise`), so a second `await db.close()` also waits.
2. Synchronously, before the first `await`: `isOpen = false`; abort a database-level `closeController` with reason `new MisuseError('Database is closed')`; abort the committed-read controllers (existing code).
3. Force every live serialized iterator to unwind (below), and await those plus the committed-read `done` promises.
4. `const release = await this._acquireExecMutex()` — this queues behind every current holder and waiter (exec batches, `ingestExternalRowChanges`, the materialized-view refresh sweeps). Waiters queued ahead of close see the closed database right after they acquire and leave at once (see the closed checks below).
5. Run the existing teardown, then `release()` in a `finally`.

**Why not just take the mutex (step 4 alone):** an `eval` iterator that was pulled once and then abandoned holds the mutex until it is pulled again or `return()`ed, so `close()` would hang forever where it returns today. Step 3 removes that.

**Forcing a parked serialized iterator (step 3).** Keep a registry (a `Set` on `Database`) of the generator objects returned by `_iterateSerialized` that currently hold the mutex: add after the mutex is acquired and the closed check passes, remove in `finally`. The generator cannot name itself, so restructure `_iterateSerialized` as a plain function that creates the inner `async *` generator and hands it a reference to itself (or registers it from a closure). In `close()`, call `gen.throw(unwindMarker)` on each. Async generators queue `throw()` behind any pending `next()`, so it is delivered at the next row boundary whether the consumer is still pulling or has abandoned the iterator; it never runs in the middle of a step. Delivered through `yield*`, the throw reaches the innermost row yield, `for await` loops on the way call `return()` on their sources (scan connections disconnect), and `_iterateFinalizing`'s `catch` rolls back the implicit transaction — an interrupted statement rolls back, not commits.

**Reporting the close to the consumer.** A generator that simply finishes would make the consumer's next `next()` return `{done: true}`, which is indistinguishable from a complete result. Instead, in the outer generator, catch the error when this iteration was forced by close (check a per-iteration flag set by close rather than the error's identity, because a failing rollback replaces the thrown error), release the mutex right there, then `yield` once more. That yield answers close's own `throw()` call, never the consumer, and leaves the generator parked holding nothing. The consumer's next pull resumes it and it throws `MisuseError('Database is closed')`. An abandoned iterator stays parked at that yield, holds no mutex and no transaction, and is garbage-collected. Keep release idempotent (it already is) since the `finally` will call it again.

**Closed checks after acquiring the mutex.** `_iterateSerialized` checks `isOpen` before taking the mutex only; a call queued behind a running statement acquires after close began and would run its body. Add `checkOpen()` right after acquiring in `_iterateSerialized`, in `_withMutex`, and in `database-external-changes.ts` after its `_acquireExecMutex()`. (`_executeSingleStatement` already checks.)

**Stopping long work promptly (step 2's `closeController`).** A forced throw lands only at an output row boundary, and an `exec` statement has none. Put the close signal into the runtime context so the scan leaves (`runtime/emit/scan.ts` checks `runtimeCtx.signal` per row) and the DML executor stop at their next row: in `_executeSingleStatement` and in `Statement._iterateRowsRawInternal`, use `combineAbortSignals(callerSignal, closeSignal)` when the caller passed a signal, and the close signal itself when not (no allocation on the common path). In the statement path, keep passing only the caller's signal to `_iterateWithSignal` so its no-signal fast path survives — the forced throw already covers the output boundary. The resulting error is `AbortError('Database is closed')`, which names the close.

**Close called from inside running work.** `close()` called from a module hook, a user function, or a watch handler that the running statement awaits must not deadlock. Calling it is safe: step 2 runs synchronously, so the statement fails at its next check and teardown follows once it unwinds. Awaiting it from there cannot work under the rule above (close would wait for the work that is waiting for close), and no portable way exists to tell that caller from an outside one (no `AsyncLocalStorage` in browsers or React Native). Document it: such code calls `void db.close()`. Searched the repo: no module calls `Database.close()` from a hook today (the `db.close()` hits in the IndexedDB, LevelDB and SQLite plugins are their own native handles).

**Committed reads.** The same forcing applies to `_iterateConcurrent` generators: an abandoned committed read currently hangs `close()` forever (documented in the comment in `close()` and on `ConcurrentReadScope`). Register those generators in the same registry and force them the same way, then delete the "abandoned iterator delays close" wording. If this turns out to tangle with the scope's `done` bookkeeping, it can be left out and stays as it is today — note that in the handoff.

## Tests (lifecycle.spec.ts)

Three, each the reproduction of an observed symptom:

- An `eval` iterator pulled once: `await db.close()` resolves (does not hang), and the next `it.next()` rejects with `Database is closed`. Covers both the abandoned case and the keeps-producing-rows case.
- A statement parked in a module `commit()` hook behind a gate: `close()` does not resolve until the gate opens, the connection's `disconnect()` is called only after `commit()` returned (the #38 arm), and the catalog is empty afterwards.
- `void db.close()` from inside a module hook: the statement rejects with the close error and the close promise resolves (no deadlock).

Re-run `test/apply-schema-yields.spec.ts` ('close() rejects the apply…'); it should still pass since undo statements are still refused by the closed check, but its assumptions changed (the catalog is now cleared after the apply stops, not under it).

## TODO

- Store the close promise; make `close()` return it on repeat calls.
- Add `closeController` (database-level `AbortController`), aborted synchronously in `close()` with `MisuseError('Database is closed')`.
- Restructure `_iterateSerialized` into a registering wrapper plus inner generator; add the post-acquire `checkOpen()`; implement the forced-unwind catch / release / park / throw-on-next-pull sequence.
- Add post-acquire `checkOpen()` in `_withMutex` and in `database-external-changes.ts`.
- Combine the close signal into the runtime-context signal in `_executeSingleStatement` and `Statement._iterateRowsRawInternal` (close signal alone when the caller passed none).
- Rewrite `close()`: force registered iterators, await them and the committed reads, acquire the mutex, tear down, release.
- Apply the same forcing to `_iterateConcurrent`; update the `ConcurrentReadScope` and `close()` comments.
- Write the three tests above; run `yarn workspace @quereus/quereus test` and `yarn lint` (from the repo root).
- Run the `scan` benchmarks in `docs/benchmarking.md` (or a 300k-row `select` loop, before/after) to confirm the extra wrapper and the signal in the runtime context do not cost measurable per-row time; record numbers in the handoff.
- Update docs: `docs/usage.md` § `db.close()` (waits for running work; open iterators then reject with `Database is closed`; interrupted implicit transactions roll back; call `void db.close()` from inside a statement), `docs/schema-declarative.md` db.close() bullet (re-derive each outcome by running it — the "not found after migration" case should be gone), `docs/architecture.md` committed-read paragraph, and confirm `docs/change-scope.md` line ~460 still holds.
