description: When statements overlap on one database, a statement can commit or roll back another statement's automatic transaction. This causes double commits and can silently lose a write that was reported as successful, so each statement must finish its transaction before the next one is allowed to start.
architecture: docs/sql-txn.md
files:
  - packages/quereus/src/core/database.ts # _finalizeImplicitTransaction, eval, _evalRoutedGenerator, _evalGenerator, _acquireExecMutex, _runWithMutex
  - packages/quereus/src/core/statement.ts # iterateRows, _iterateRowsGenerator, iterateRowsWithTrace, all, _allGenerator, run, get
  - packages/quereus/src/util/async-iterator.ts # wrapAsyncIterator: runs the finalize outside the mutex; can be deleted once nothing uses it
  - packages/quereus/src/func/builtins/explain.ts # execution_trace and row_trace run a statement nested inside the calling statement
  - packages/quereus/src/func/registration.ts # NOTE tells table-valued function authors to call iterateRowsWithTrace
  - packages/quereus/src/vtab/test-support/commit-stall.ts # installCommitStall, settleMacrotasks: gates for the new test
  - docs/module-authoring-transactions.md # add the rule about commit() and the execution mutex
  - docs/change-scope.md # add the rule about watch handlers and the execution mutex
repro: verified
----

Reported in GitHub issue #38.

## Cause

Statements are serialized by the execution mutex. `db.exec`, `stmt.run`, `stmt.get` and `db.commit` finish their transaction while holding it. `db.eval`, `stmt.iterateRows` and `stmt.all` do not: they go through `wrapAsyncIterator`, whose cleanup callback calls `_finalizeImplicitTransaction` from outside the generator that holds the mutex. On normal completion and on failure, that call runs after the mutex is released. On `return()` of an iterator that was never started, the mutex was never taken at all.

`_finalizeImplicitTransaction` then acts on whatever implicit transaction is open, with no way to tell whose it is. Any statement finalizing outside the mutex can therefore end another statement's transaction.

## Observed behaviour

Measured on the current build, with a memory table and one registered connection whose `commit()` takes 50 ms. The second statement starts 10 ms into the first one's commit.

| First statement | Second statement | Calls | Result |
|---|---|---|---|
| `db.eval` insert | `select` | begin 1, commit 2 | The issue's double commit |
| `stmt.all` insert | `select` | begin 1, commit 2 | Same |
| `stmt.iterateRows` insert | `select` | begin 1, commit 2 | Same |
| `stmt.run` insert | `select` | begin 1, commit 1 | Correct |
| `db.exec` insert | `select` | begin 1, commit 1 | Correct |
| `db.eval` insert | `insert` | begin 1, commit 2 | The second write joins a transaction that is already committing |
| `db.eval` insert | `eval` iterator, `return()` before the first `next()` | begin 1, commit 2 | A statement that never ran commits the transaction |
| `db.eval` insert, commit fails | `select` | begin 1, commit 2, rollback 2 | The bystander `select` also rejects with "commit failed" |
| `db.eval` insert | `eval` with an already-aborted signal | commit 1, rollback 1 | **The insert resolves as success and its row is gone** |
| `db.eval` insert | `eval` with a syntax error | commit 1, rollback 1 | **The insert resolves as success and its row is gone** |

The last two rows are worse than the issue describes: an unrelated statement that fails before it does any work rolls back a write that then reports success.

## Decision: finalize inside the mutex, on every path

The issue offers two approaches. Finalizing inside the mutex is the one to build.

Tracking which statement opened the transaction is not enough. It would stop the second `commit()`, but the `select` would still read through a transaction that is partway through committing, and a second write would still join it. Those requirements need the next statement to wait, which is what the mutex does. `docs/sql-txn.md` § 8.6 already promises this: "a read waits for any in-flight write (including its commit) to finish". Callers that do not want to wait have `readConcurrency: 'committed'`, which never touches the implicit-transaction lifecycle and is unaffected.

Once every statement finalizes before releasing the mutex, an implicit transaction seen by the mutex holder can only be its own. That also settles the other requirements:

- **Failed commits.** The commit runs inside the owning statement's iterator, so the failure rejects that statement's `next()` or `return()`. A later statement starts after the state is cleared and sees nothing.
- **OR ROLLBACK.** The branch that rolls back any active transaction becomes safe for the same reason: it can no longer run during another statement's work. Ending an explicit transaction stays as documented.
- **Failures before the statement starts.** An aborted signal or closed database is raised before the mutex is taken and before any finalize, so it touches no transaction. A never-started iterator runs no code at all.

### Deadlock analysis

Holding the mutex across every commit removes no working configuration. A `commit()` or watch handler that awaits a statement on the same database already fails on every path:

| Waiting on `db.eval` from | Writer `db.exec` or `stmt.run` | Writer `db.eval` |
|---|---|---|
| Module `commit()` | Hangs | Finishes, with `commit()` called twice |
| `db.watch` handler | Hangs | Handler re-fires without limit; without a stop, Node ran out of memory |

After this change the `db.eval` column hangs too, so the behaviour is consistent. Two consequences:

- The engine cannot detect this case and throw. A re-entrant statement looks the same as an unrelated caller who should simply queue, and the cross-platform requirement rules out `AsyncLocalStorage`.
- No connection `commit()` in this repository (memory, isolation, store) runs a statement, and no `db.watch` call site in the repository passes an inline async handler. The sync manager's `onTransactionCommit` listener only enqueues, and its one re-entrant path already defers through `_isExecuting()`. `@optimystic/quereus-plugin-optimystic` is outside this repository and was not inspected; `exec` writes through it would already hang if it re-entered.

The rule to document for module authors: `commit()` runs under the execution mutex, must not await a statement on the same database, and should schedule that work without awaiting it. `_isExecuting()` is the existing test for this. Watch handlers get the same note; making them safe is filed separately as `bug-watch-handler-awaiting-query-hangs-database`.

## Design

Add one generator on `Database`. It becomes the single place a serialized iteration takes the mutex and finalizes:

```ts
/** @internal Runs `body` under the exec mutex and finalizes its implicit transaction before releasing it. */
async *_iterateSerialized<T>(body: () => AsyncIterable<T>, signal?: AbortSignal): AsyncGenerator<T> {
	throwIfAborted(signal);
	const releaseMutex = await this._acquireExecMutex();
	let failed = false;
	let failure: unknown;
	try {
		yield* body();
	} catch (e) {
		failed = true;
		failure = e;
		throw e;
	} finally {
		try {
			await this._finalizeImplicitTransaction(!failed, failure);
		} finally {
			releaseMutex();
		}
	}
}
```

An early `break` reaches the `finally` with `failed` false and commits, matching today's rule that early exit commits.

Behaviour changes to expect, all intended:

- On `return()`, the row source now unwinds before the commit instead of after it. Normal completion already has this order.
- On the `eval`, `all` and `iterateRows` paths, a commit that fails under OR FAIL now replaces the conflict error. Today that path discards the commit error without logging it, while `exec`, `run` and `get` already replace. Reporting the conflict alone would imply the earlier rows were committed.
- `_isExecuting()` is now true during these commits, where it was false before.

### The trace functions

`iterateRowsWithTrace` currently takes no mutex and finalizes, and it has two kinds of caller that need different treatment:

- **Direct callers at the top level** have the same overlap bug. The public method should use `_iterateSerialized`.
- **`execution_trace` and `row_trace`** run nested inside a statement that already holds the mutex, so they would hang if they took it. They need a separate internal method that takes no mutex.

The nested path has its own bug, verified: its finalize closes the enclosing statement's implicit transaction partway through. `insert into u select 1 from execution_trace('select 1')` fails on a duplicate key, as it should, but leaves row 1 in the table. The same duplicate without a trace function leaves the table empty.

The rule for the nested method: if an implicit transaction was already open when it started, that transaction belongs to the enclosing statement, so do not finalize it. Otherwise, finalize as today. `select * from execution_trace('insert ...')` depends on that second case, and today commits its row.

Tripwire to record as a `NOTE:` on the nested method: when an enclosing implicit transaction is open and the nested statement fails, the trace function swallows the error, so the nested statement's partial writes stay in the enclosing transaction. This is rare and diagnostic-only. If it matters, wrap the nested run in a savepoint.

### Guard against regressions

Make `_finalizeImplicitTransaction` throw an internal `QuereusError` when `execMutexDepth === 0`. Every remaining caller holds the mutex, so a future finalize outside it fails in ordinary single-caller tests, without needing an overlap to expose it.

## Tests

Add `packages/quereus/test/core/overlapping-statement-finalize.spec.ts`. Use `installCommitStall` and `settleMacrotasks` rather than timers, as the concurrency tests do (`docs/architecture.md`). Register a connection that counts `begin`, `commit` and `rollback`, as the issue's script does. Write SQL in lowercase.

- For each of `db.eval`, `stmt.all` and `stmt.iterateRows` as the writer: park the commit and start a `select`. After settling, the `select` has not resolved and `commit` was called once. After release, both resolve, the counts are begin 1 and commit 1, and the `select` sees the row. This is the issue's reproduction.
- A failing commit rejects the writer only. The overlapping `select` resolves, and `commit` was called once.
- With the commit parked, an already-aborted `eval`, a syntax-error `eval`, and `return()` on a never-started `eval` iterator cause no rollback and no second commit. After release, the writer's row is present.
- `insert into u select 1 from execution_trace('select 1')` fails and leaves `u` empty.

No test is needed for the hang cases, which are documentation only.

## TODO

- Add the spec above and confirm its cases fail on the current code
- Add `_iterateSerialized` to `Database`
- Route `eval` and the fallback branch of `_evalRoutedGenerator` through it; `_evalGenerator` keeps preparing and finalizing the statement but no longer takes the mutex
- Route `stmt.iterateRows` and `stmt.all` through it, and remove `_iterateRowsGenerator`, `_allGenerator` and the NOTE that says the commit lands outside the mutex
- Route `stmt.run` and `stmt.get` through it too, so there is one finalize path, and remove `_runWithMutex` if nothing else uses it
- Split `iterateRowsWithTrace` into the serialized public method and the nested internal method; move the calls in `explain.ts` to the internal one and update the NOTEs in `explain.ts` and `registration.ts`
- Delete `util/async-iterator.ts` if nothing still imports it; `docs/review.html` also mentions it, so check whether that needs updating
- Add the mutex-held guard to `_finalizeImplicitTransaction` and state the rule in its doc comment
- Document the `commit()` rule in `docs/module-authoring-transactions.md` under Connection Registration
- Document the handler rule in `docs/change-scope.md` near the handler-errors section
- Run `yarn build`, `yarn lint` and `yarn test`, including the sync, store and isolation packages, because a hang there would show that something re-enters during a commit
