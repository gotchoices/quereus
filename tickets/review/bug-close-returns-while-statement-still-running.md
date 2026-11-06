description: Closing a database used to return while work was still running on it, so a statement could keep reading or writing after the caller believed the database was shut. Close now stops running work, waits for it, and only then tears the database down; this ticket reviews that change.
architecture: docs/usage.md#dbclose
files:
  - packages/quereus/src/core/interruptible-iteration.ts # new: the iterator wrapper close() can stop
  - packages/quereus/src/core/database.ts # close(), closeAfterRunningWork, tearDown, _acquireExecMutex / takeExecMutex, _iterateSerialized / serializedIteration, _beginCommittedRead / _endCommittedRead, _statementSignal, _executeSingleStatement
  - packages/quereus/src/core/statement.ts # _iterateRowsRawInternal (runtime signal), _iterateConcurrent / concurrentIteration
  - packages/quereus/test/lifecycle.spec.ts # three new tests under 'while work is running'
  - packages/quereus/test/core/concurrent-committed-reads.spec.ts # rewrote the close() test
  - docs/usage.md # § db.close(), committed-read paragraph
  - docs/schema-declarative.md # § Yielding during an apply, db.close() bullet
  - docs/architecture.md # concurrent committed-read paragraph
repro: verified
----

## What changed

**Rule now enforced:** when `close()` resolves, no statement, ingest or refresh is running, and teardown happened after they stopped. Teardown runs while `close()` holds the execution mutex.

`close()` (`database.ts`):

- Stores its promise in `closing`; repeat calls return it.
- Synchronously, before any `await`: `isOpen = false`, aborts `closeController` with `MisuseError('Database is closed')`, and interrupts every live iterator.
- Awaits the interrupted committed reads (they hold no mutex), then `takeExecMutex()` (queues behind every holder and waiter), then `tearDown()` (the old teardown body, unchanged), then releases.
- Serialized iterators are interrupted but **not awaited**: the mutex wait covers their unwinding, and their own promise also waits for the watch handlers of their hold. Awaiting it deadlocked a watch handler doing `await db.close()` on the `eval` / `stmt.run` paths (`exec` was fine). Checked by a scratch script: all three paths now resolve.

**Post-acquire closed check** lives in `_acquireExecMutex()` itself, so `_withMutex`, `_iterateSerialized`, `ingestExternalRowChanges` and the MV refresh sweep all get it from one site (the ticket listed three separate sites). `close()` uses the split-out `takeExecMutex()`, which skips that check and the async-generator support probe.

**Close signal in the runtime context:** `_statementSignal(callerSignal)` = `combineAbortSignals(callerSignal, closeSignal)`, used by `_executeSingleStatement` (also for `exec`'s drain loop) and `Statement._iterateRowsRawInternal`. The output boundary (`_iterateWithSignal`) still gets the caller's signal only, so its no-signal fast path is intact. The resulting error is `AbortError('Database is closed')`.

**`InterruptibleIteration` (new file)** wraps the generator that `_iterateSerialized` and `Statement._iterateConcurrent` used to return. `interrupt()` sets a flag and `throw()`s a `MisuseError` into the generator, which async generators queue behind any pull in progress, so it lands at a row boundary. Then, if the generator absorbed the throw and yielded again, it calls `return()`. Once the wrapper is interrupted, `next()` and `return()` reject with `MisuseError('Database is closed')`.

**Deviation from the ticket's design (please scrutinize):** the ticket proposed that the generator catch the forced error, release, `yield` once more and park, so the consumer's next pull would throw. That breaks when the consumer has a pull pending at close time: the scan sees the close signal and throws during the *consumer's* pull, so the park-yield would answer the consumer with a garbage `{done: false, value: undefined}`. A wrapper object that owns the flag avoids this and costs one method call per row, with no extra promise and no extra `yield*` layer.

**Committed reads:** `ConcurrentReadScope`, `_beginConcurrentRead` and the `concurrentReads` map are gone. The per-read scope signal duplicated the close signal, and `done` duplicated awaiting the interrupt. They are replaced by `_beginCommittedRead` / `_endCommittedRead`, which register the wrapper. An abandoned committed read no longer hangs `close()`.

## Behaviour changes a reviewer should weigh

- **`return()` also rejects after an interrupt** (the ticket specified only `next()`). Reason: an early `return()` normally commits, and an interrupted statement rolled back instead. Consequence: `db.get('insert … returning …')` racing `close()` can produce its row and then reject, and so can a `for await` loop that `break`s after the close. Documented in usage.md.
- **Work queued behind running work now always gets `Database is closed`.** A prepared statement or `db.get` used to get `Statement finalized`. Verified with a scratch run against a parked commit: `exec`, `db.get`, `stmt.run` and `eval().next()` all report `MisuseError: Database is closed`.
- **Work that reaches no further row boundary after `close()` was called completes and commits**, e.g. `void db.close()` inside a `create()` hook: the `create table` succeeds, then teardown clears it. There is no commit-time closed check, which was a deliberate scope choice. The ticket's third test is therefore written with a `connect()` hook in a `select`, where the scan's check fires.
- A consumer with a pull pending during close gets `AbortError('Database is closed')` from that pull; a parked consumer gets `MisuseError('Database is closed')` on its next pull. Both messages are the same.
- `apply schema` + `close()`, re-derived by running each case (scratch script): mid-migration → rejects, `Database is closed` + not restored, and `endSchemaBatch` receives the error before `close()` resolves. After the last step with no seed → resolves. Before or during seeding → rejects with the seed error and no not-restored line. The old "table … not found after migration" outcome is gone, since the catalog is no longer cleared under the apply.
- `docs/change-scope.md` line ~460 ("`close()` does not wait for handlers") still holds; not edited.

## Tests

- `lifecycle.spec.ts` › while work is running:
  - *an iterator pulled once does not hold close() up, and rejects its next pull*: `eval` pulled once, `await close()` resolves, next pull rejects `MisuseError('Database is closed')`.
  - *close() waits for a commit in progress before disconnecting and clearing the catalog*: a registered connection whose `commit()` waits on a gate. `close()` stays unresolved until the gate opens, the event order is `commit returned` then `disconnect` (GitHub #38 arm), and the catalog is empty.
  - *a module hook may start close() without awaiting it*: a `connect()` hook starts `db.close()`. `exec('select * from s')` rejects with `Database is closed`, and the close promise resolves.
  - All three were run against HEAD's `database.ts`/`statement.ts` (swapped in temporarily), and all three failed there.
- `concurrent-committed-reads.spec.ts`: the old test *db.close() aborts a mid-iteration concurrent read* asserted an `AbortError` on the pull after close. It is replaced by *db.close() stops a concurrent read nobody pulls again, which then rejects its next pull*: `await close()` with the read parked (hung forever on HEAD), then the next pull rejects with `MisuseError`.
- `apply-schema-yields.spec.ts` 'close() rejects the apply…' passes unchanged.

Validation: `yarn workspace @quereus/quereus test` gives 11096 passing, 26 pending, 0 failing. `yarn workspace @quereus/quereus run lint` (eslint + test type-check) is clean. `tsc -b tsconfig.build.json` succeeds. All other workspaces' tests passed (isolation, store and sync were re-run after the final registry split).

Benchmark (`node bench/run.mjs --filter execution/full-scan`, HEAD core built into `dist` as the baseline, then this change): `full-scan-10k` 13.10 → 11.15 ms (−14.9%, noise ±21.5%, baseline marked unstable); `full-scan-10k@store-mem` 17.38 → 15.32 ms (−11.9%, noise ±14.8%, "no change"); work counters identical. A 300k-row ts-node loop (eval / iterateRows / exec drain) swung ±40% between identical runs on this machine, so it gave no usable signal.

## Known gaps

- `ensureAsyncGeneratorCleanupSupported()` probes `return()` handling only. `close()` now also relies on `throw()` being delivered through `yield*` and on `finally` running after it. No probe covers that; old Babel helpers are already refused for the `return()` defect.
- `_statementSignal` calls `combineAbortSignals` per statement execution. With no caller signal it creates no controller, only two small arrays and the result object, so the ticket's "no allocation" was not met literally. The benchmark shows no cost.
- `InterruptibleIteration.interrupt()` logs any unwind error other than its own marker through `errorLog`. That includes a `TypeError` if a row source lacks `throw()`, which would read as a spurious error line.
- `Statement._iterateRowsRawInternal`'s catch still logs the interrupt marker as "Runtime execution failed" on the debug error channel.
