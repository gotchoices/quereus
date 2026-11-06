description: Closing a database used to return while work was still running on it, so a statement could keep reading or writing after the caller believed the database was shut. Close now stops running work, waits for it, and only then tears the database down.
architecture: docs/usage.md#dbclose
files:
  - packages/quereus/src/core/interruptible-iteration.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/util/async-generator-support.ts
  - packages/quereus/test/lifecycle.spec.ts
  - packages/quereus/test/core/concurrent-committed-reads.spec.ts
  - docs/usage.md
  - docs/schema-declarative.md
  - docs/architecture.md
repro: verified
----

## What landed

When `db.close()` resolves, no statement, ingest or refresh is running, and teardown ran after they stopped, holding the execution mutex (`ticket(implement): bug-close-returns-while-statement-still-running`).

- `close()` caches its promise. Synchronously it marks the database closed, aborts a close signal that every statement's runtime signal includes (`Database._statementSignal`), and interrupts every live row iterator. It then awaits interrupted committed reads, takes the execution mutex behind every holder and waiter, and runs the old teardown body (`tearDown()`).
- `_acquireExecMutex()` refuses a closed database after acquiring, so every waiter queued before close leaves with `Database is closed`.
- `InterruptibleIteration` (`core/interruptible-iteration.ts`) wraps serialized and committed-read row iterators. `interrupt()` throws into the generator, which lands at a row boundary; afterwards `next()` rejects with `Database is closed`, and `return()` does too when the statement was interrupted before it.
- The committed-read scope (`ConcurrentReadScope`, `_beginConcurrentRead`) is replaced by `_beginCommittedRead` / `_endCommittedRead` registering the wrapper; an abandoned committed read no longer hangs close.

Behaviour changes are documented in `docs/usage.md` § `db.close()` and `docs/schema-declarative.md` § Yielding during an apply: queued work always gets `Database is closed` (no longer `Statement finalized`); work that reaches no row boundary after close completes and commits; code inside a statement must use `void db.close()`.

## Review findings

Read the implement diff first, then the handoff; ran the probes below with throwaway specs (deleted).

**Fixed in this pass**

- **`return()` misreported a real commit as a failure.** `InterruptibleIteration.return()` checked the interrupted flag *after* awaiting the generator's `return()`. When close() landed while an early `return()` was committing (e.g. `db.get('insert … returning …')` racing close), the interrupt queued behind the return, the commit completed, and the caller still got `Database is closed`. Reproduced with a gated-commit connection (events `commit returned`, `disconnect`; result `err Database is closed`). Fix: snapshot the flag before awaiting, so only a statement interrupted before the call (which rolled back) rejects. Regression test added: `lifecycle.spec.ts` › *an iterator whose return() is committing when close() lands reports the commit*.
- **Registration window in `serializedIteration`.** The closed check ran inside `_acquireExecMutex()` and the iteration registered itself only after the generator resumed from that await, a later microtask. A close() running between the two would miss the iteration; a statement with no scan check (e.g. `select 1`) would then yield a row and, with its consumer parked, hold the mutex close() waits on. A probe stepping close() across 0–24 microtasks after the first `next()` did not hit the window on Node, so this was not observed; the fix is to register and then `checkOpen()` in one synchronous step (the same pattern `_beginCommittedRead` already uses), which removes the dependency on tick ordering. No test: the window is not reproducible deterministically.

**Tripwire recorded**

- `ensureAsyncGeneratorCleanupSupported()` probes `return()` only, while close() also relies on `throw()` delivered through `yield*`. Parked as a `NOTE:` on `probeAsyncGeneratorCleanup` in `src/util/async-generator-support.ts`.

**Checked, no change**

- Deviation from the fix ticket's design (wrapper object instead of a park-yield in the generator): agreed. The park-yield would answer a pending consumer pull with `{done: false, value: undefined}`; the wrapper does not, and costs one method call per row.
- Deadlocks: a watch handler awaiting close() (serialized iterations are interrupted but not awaited, and the mutex is released before handlers are awaited); a committed read interrupted while a serialized statement waits on it; queued waiters after close. Reasoned through each; the implementer's scratch runs and the existing tests cover the watch-handler case.
- Teardown now runs while close() holds the mutex: nothing in `tearDown()` acquires the mutex or consults `_isExecuting()` (the only consumers are module re-entrancy checks and `quereus-sync`'s deferral, neither on the teardown path).
- Row sources that `throw()` passes through are engine async generators; the plan output is iterated with `for await` or `yield*` over emitter generators, so the "source lacks `throw()`" log line named in the handoff is not reachable from engine code today.
- `_iterateRowsRawInternal` still logs the interrupt marker on its debug error channel: debug-only noise, left as is.
- `_statementSignal` allocates a small combined-signal object per statement execution; the implementer's full-scan benchmark showed no regression, and I found nothing per-row.
- A rejected teardown now stays cached in `closing`, so a second close() also rejects instead of resolving silently; that is more accurate, no change.
- Docs: read `usage.md` § `db.close()` and § Concurrent committed reads, `schema-declarative.md` § Yielding during an apply, `architecture.md` committed-read paragraph, `change-scope.md` line ~460 (still true), `sql-txn.md` and `module-committed-reads.md` (no close() wording). No stale references to `ConcurrentReadScope` / `_beginConcurrentRead` remain. The usage.md `return()` sentence ("a loop that breaks out after the close reports that its statement did not commit") remains accurate after the fix.
- Tests: the implementer's three lifecycle tests and the rewritten committed-read test each pin a distinct contract (abandoned iterator, commit-before-disconnect ordering, close started from a hook, abandoned committed read); kept all.
- Size: `src/core/database.ts` is 3456 lines (`wc -l`), pre-existing; this change added ~30 net. No ticket filed — no current anchor, and the change did not cause it.

**Validation**

- `yarn workspace @quereus/quereus run lint`: clean.
- `yarn workspace @quereus/quereus test`: 11097 passing, 26 pending, 0 failing.
- Other workspaces were not re-run: the review edits change only the `return()` result timing and add one closed check, neither of which alters close() sequencing that the implementer validated across isolation, store and sync.
