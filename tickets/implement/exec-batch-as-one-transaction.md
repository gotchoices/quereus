description: Give callers that share one database connection a way to run a group of statements as a single all-or-nothing transaction that nobody else's statements can slip into, and fix a related error where asking to start a transaction fails if another caller's write happens to be in flight.
architecture: docs/usage.md#transactions
files: packages/quereus/src/core/database.ts (`exec` ~1022, `_withMutex` ~804, `beginTransaction`/`commit`/`rollback` ~1315-1348), packages/quereus/src/core/database-transaction.ts (`beginTransaction` ~199), packages/quereus/src/common/types.ts (`StatementOptions` ~55), packages/quereus/src/common/errors.ts, packages/quereus/src/index.ts, packages/quereus/test/core-api-transactions.spec.ts, docs/usage.md, docs/sql-txn.md, docs/errors.md
difficulty: medium
----
# Transactional `exec` batch, and transaction-state checks taken under the mutex

Filed from Sereus, a consumer, on 2026-09-18 (Sereus ticket `strand-writer-transactions-indivisible`). Planned 2026-09-24.

## Root cause

Both arms below are the same defect at the same site: a decision about transaction state is taken **outside** the execution mutex, so by the time the decision is acted on the state has moved.

- `Database.exec` holds the mutex for the whole batch, but its transaction bookkeeping is per statement and only covers *implicit* transactions. When a batch spells its own transaction (`begin; …; commit;`) and a middle statement throws, `exec` rethrows with the explicit transaction still open and then releases the mutex. The next queued caller runs inside that stranded transaction, and its writes are discarded when the batch's owner eventually rolls back.
- `Database.beginTransaction` / `commit` / `rollback` test `transactionManager.isInTransaction()` *before* taking the mutex. That predicate is also true while another caller's autocommit statement is mid-flight (every write opens an implicit transaction for its duration), so `beginTransaction()` throws "Transaction already active" against a database that will be perfectly free a moment later.

## Arm 1 — `exec(sql, params, { transaction: true })`

Runs the whole batch as one explicit transaction under a single hold of the execution mutex. No other caller's statement can run inside it, and no other caller's statement is ever rolled back by it.

New option type in `packages/quereus/src/common/types.ts`, beside `StatementOptions`:

```ts
/** Options accepted by {@link Database.exec}. Extends {@link StatementOptions}; `readConcurrency` is ignored here as it always has been. */
export interface ExecOptions extends StatementOptions {
	/**
	 * Run the entire batch as one explicit transaction, begun and committed
	 * under a single hold of the execution mutex. On any failure the
	 * transaction is rolled back BEFORE the mutex is released and the original
	 * error is rethrown, so no other caller's statement ever runs inside it.
	 * Refuses with a `TransactionActiveError` if any transaction is already
	 * open when the batch acquires the mutex.
	 */
	transaction?: boolean;
}
```

`Database.exec`'s `options` parameter widens from `StatementOptions` to `ExecOptions`. That is source-compatible for every existing caller, and for the structural `exec(sql: string): Promise<void>` interfaces in `database-auto-analyze.ts` and two `quereus-store` test files.

Control flow when `transaction: true`:

1. `checkOpen()`, pre-flight `throwIfAborted(signal)`, parse — exactly as today.
2. **Before taking the mutex**, reject a batch that spells its own transaction control: any statement whose AST `type` is `'begin'` or `'commit'`, or is `'rollback'` with no `savepoint` (see `BeginStmt` / `CommitStmt` / `RollbackStmt` in `packages/quereus/src/parser/ast.ts` ~548-561). Throw a `MisuseError` naming the offending keyword. `savepoint`, `release`, and `rollback to savepoint` stay allowed — they nest inside the batch's transaction and cannot end it. Rationale: a `commit` inside the batch would end the transaction mid-way, leave the remaining statements in autocommit, and make the batch's closing commit a silent no-op — atomicity lost with no error. Refusing up front is cheaper and honest.
3. Empty batch → return before taking the mutex, as today. No transaction is opened; there is nothing to make atomic.
4. Under `_withMutex`:
   - If `transactionManager.isInTransaction()`, throw `TransactionActiveError` and touch nothing. This refuses unconditionally, including when the open transaction is one this same caller opened with `beginTransaction()` — the batch cannot tell whose it is, and must never roll back a transaction it does not own.
   - `await this._beginTransaction('explicit')`.
   - Run every statement through `_executeSingleStatement(ast, params, signal)` in order, with **no** per-statement commit or rollback.
   - `throwIfAborted(signal)` once more after the last statement, before committing, so an abort that landed during the final statement's tail rolls the batch back instead of committing it.
   - Guard: if `!transactionManager.isInTransaction()` at this point, something closed the transaction out from under the batch. Throw a `QuereusError` with `StatusCode.INTERNAL` rather than calling `_commitTransaction()`, which would silently no-op and report a success that was not atomic. Not believed reachable once step 2 is in place; it exists so a future path that force-commits mid-batch fails loudly instead of quietly.
   - `await this._commitTransaction()`.
   - On any throw from the above: if `transactionManager.isInTransaction()`, `await this._rollbackTransaction()`, then rethrow the **original** error. The guard matters because `TransactionManager.commitTransaction` already rolls every connection back and clears its own state when a deferred constraint or global assertion fails, so an unguarded rollback would be a double rollback. If the rollback itself throws, let that error propagate with the original attached as its `cause` — never swallow either.

The whole thing still runs inside the one `_withMutex` call, so the rollback completes before the mutex is released.

## Arm 2 — move the state checks under the mutex

`beginTransaction()`, `commit()` and `rollback()` currently pre-check and then delegate to `this.exec("BEGIN TRANSACTION" | "COMMIT" | "ROLLBACK")`. Replace both halves: take the mutex directly via `_withMutex`, check inside it, and call `_beginTransaction('explicit')` / `_commitTransaction()` / `_rollbackTransaction()`. The emitter in `packages/quereus/src/runtime/emit/transaction.ts` does exactly those three calls and nothing else, so routing directly is equivalent and skips a parse, plan, optimize and emit of a three-word statement.

```ts
async beginTransaction(): Promise<void> {
	this.checkOpen();
	await this._withMutex(async () => {
		if (this.transactionManager.isInTransaction()) {
			throw new TransactionActiveError('Cannot begin transaction: a transaction is already active');
		}
		await this._beginTransaction('explicit');
	});
}
```

`commit()` and `rollback()` follow the same shape, keeping their existing `No transaction active` `QuereusError` for the empty case — note that error stays reachable and now means what it says, because the check runs at the moment the work would happen.

`TransactionManager.beginTransaction` should throw the same `TransactionActiveError` in place of its current bare `QuereusError('Cannot begin transaction: already in a transaction')`, so a SQL `begin` and the JS `beginTransaction()` are distinguishable the same way. Its implicit-to-explicit *upgrade* branch is unchanged.

Existing test `packages/quereus/test/core-api-transactions.spec.ts:24` asserts the message includes `already active` and the error is `instanceof QuereusError`; both still hold with the wording and class above. Check the suite for any other assertion on these messages before changing wording.

## New error class

In `packages/quereus/src/common/errors.ts`, following the file's existing subclass shape (set `name`, call `Object.setPrototypeOf`):

```ts
/**
 * A transaction is already open on this Database, so the requested operation —
 * beginning a transaction, or running an `exec` batch with `transaction: true` —
 * cannot proceed. Distinct from a plain QuereusError so a caller can positively
 * recognise "someone else owns a transaction here" and back off, rather than
 * matching message text. Carries StatusCode.BUSY.
 */
export class TransactionActiveError extends QuereusError { … }
```

`StatusCode.BUSY` is the right code: `docs/errors.md` already documents it as "Concurrent update conflict. Retry the transaction." Export the class from `packages/quereus/src/index.ts` (line ~22) and `ExecOptions` from the type export on line ~19.

## What deliberately does not change

- Plain `exec` (no option) keeps its per-statement autocommit semantics exactly. This ticket adds a mode; it does not alter the default.
- A batch that spells `begin; …; commit;` itself keeps working exactly as it does today when `transaction: true` is absent — including the stranding described above. Changing that shape's behavior would be a silent semantic change for existing callers; the option is the supported way to get atomicity, and the docs say so.
- DDL inside a transactional batch is only as atomic as the backing module allows, identically to DDL inside a `BEGIN`. `assertDdlTransactionPolicy` in `packages/quereus/src/runtime/emit/ddl-transaction-policy.ts` already governs this, and `pragma ddl_transaction_policy = 'strict'` already refuses DDL whose module does not declare `ddlTransactionality: 'transactional'`. Document the interaction; add no new gate.
- The callback form (`db.transaction(async tx => …)`) is out of scope — parked as backlog `feat-database-transaction-callback-scope`.

## Edge cases & interactions

- **Failure mid-batch, another caller queued behind it.** The queued statement must run *after* the rollback, in autocommit, and its row must survive. This is the motivating loss.
- **Failure at commit** (deferred FK, `deferrable initially deferred`; or a global assertion). `commitTransaction` already rolled back and cleared its state, so the batch's catch must not roll back a second time. `getAutocommit()` must be `true` afterwards and no rollback error may mask the constraint error.
- **A transaction already open when the batch acquires the mutex.** Refuse with `TransactionActiveError`; the other transaction must be entirely untouched — still open, still holding its uncommitted rows, still committable by its owner.
- **The caller's own open transaction.** Same refusal. Confirm no partial work and no rollback.
- **Batch containing `begin` / `commit` / bare `rollback`.** `MisuseError` before the mutex is taken; the database state must be indistinguishable from never having called.
- **Batch containing `savepoint` / `release` / `rollback to savepoint`.** Accepted, and `rollback to savepoint` must leave the batch's transaction open so later statements still run and the closing commit still fires.
- **Abort signal.** An already-aborted signal rejects before the mutex, with no transaction opened. Abort mid-batch rolls the whole batch back, `AbortError` propagates, `getAutocommit()` is `true`. An abort that lands after the last statement rolls back rather than committing.
- **Empty batch / whitespace-only SQL** with `transaction: true`: resolves, opens no transaction, leaves `getAutocommit()` `true`.
- **Named parameters shared across the batch** bind in every statement, as they already do for plain `exec`.
- **Event batching.** The whole batch is one transaction, so `onTransactionCommit` fires exactly once for it, and a failed batch fires zero times (`discardBatch` on rollback). Contrast with a plain multi-statement `exec`, which fires once per statement.
- **Re-entrancy.** Calling `exec(…, { transaction: true })` from inside a context that already holds the mutex deadlocks, exactly as plain `exec` does today. Unchanged; `_isExecuting()` remains the caller's check.
- **Arm 2, `beginTransaction()` racing an in-flight write.** Must queue and succeed, not throw. A deterministic test needs the other statement parked mid-execution — register an async scalar UDF (`ScalarFunc` returns `MaybePromise<SqlValue>`; see `packages/quereus/src/schema/function.ts:23` and the `isAsync` flag on `ScalarFunctionSchema`) that resolves a "started" promise and then awaits a gate the test controls. Without such a gate the pre-check sees `isInTransaction() === false` and the old code passes by luck, because `db.exec(...)` returns to its caller synchronously before the implicit transaction is opened.
- **Arm 2, `commit()` / `rollback()` racing an in-flight write.** Today the pre-check passes (someone else's implicit transaction reads as "in a transaction") and then `commitTransaction()` silently no-ops once the mutex is finally granted. After the change the caller gets `No transaction active`, which is the truth.
- **Mutex ordering is deterministic and testable.** `exec` runs synchronously up to `await this._withMutex(...)`, and `_acquireExecMutex` assigns `this.execMutex` synchronously before its first `await`. So `const a = db.exec(A, …); const b = db.exec(B);` in one tick queues A strictly before B — the concurrency tests need no timers.

## TODO

Phase 1 — plumbing

- Add `TransactionActiveError` to `packages/quereus/src/common/errors.ts`; export from `src/index.ts`.
- Add `ExecOptions` to `packages/quereus/src/common/types.ts`; export the type from `src/index.ts`; widen `Database.exec`'s `options` parameter to it.
- Switch `TransactionManager.beginTransaction`'s already-in-a-transaction throw to `TransactionActiveError`.

Phase 2 — arm 1

- Add the pre-mutex transaction-control rejection helper over the parsed AST batch.
- Add the `transaction: true` branch inside `exec`: begin, run, abort-check, sanity guard, commit, rollback-on-error-then-rethrow — all inside the single `_withMutex` body. Keep the existing per-statement path untouched for the default case, and factor the two bodies into separate private methods rather than threading a boolean through one loop.
- Update `exec`'s doc comment: the new mode, that it is the supported way to get an atomic batch, and that `begin`/`commit`/`rollback` in the SQL are refused under it.

Phase 3 — arm 2

- Rewrite `beginTransaction()` / `commit()` / `rollback()` to take the mutex and check inside it, calling the internal transaction methods directly instead of `this.exec("BEGIN TRANSACTION")` etc.
- Grep the tree for assertions on `Transaction already active` / `No transaction active`, and for any test expecting `beginTransaction()` to produce a traced or planned `BEGIN` statement; adjust, or confirm none exist.

Phase 4 — tests, in `packages/quereus/test/core-api-transactions.spec.ts`

- Two callers, mid-batch unique violation: B's autocommit row survives, A's first insert does not, `getAutocommit()` is `true`, A rejects with the constraint error.
- Same with A failing at commit via a `deferrable initially deferred` FK (pattern: `packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic:15`).
- A refuses with `TransactionActiveError` when B's explicit transaction is open; B's transaction is untouched and commits normally afterwards.
- A refuses the same way when the caller's own `beginTransaction()` is open.
- Happy path: multi-statement batch commits atomically, named parameters bind across statements, `onTransactionCommit` fires exactly once.
- `begin` / `commit` / `rollback` inside a `transaction: true` batch → `MisuseError`, no state change; `savepoint` + `rollback to savepoint` inside one → accepted, batch still commits.
- Abort mid-batch rolls back; an already-aborted signal opens no transaction.
- Empty SQL with `transaction: true` resolves and opens no transaction.
- Arm 2: with an async UDF gating an in-flight insert, `beginTransaction()` queues and succeeds; `commit()` in the same window rejects with `No transaction active`.

Phase 5 — docs

- `docs/usage.md` § Transactions: a subsection for the atomic batch, placed after "Implicit Transactions" and before "Explicit Transactions", replacing the current "Wrap the batch in begin/commit for all-or-nothing" advice with the option — and stating plainly why hand-rolled `begin`/`commit` across separate `exec` calls is not equivalent on a shared connection (another caller's statement can land inside it).
- `docs/sql-txn.md` § 8: note under the `BEGIN`/`COMMIT` sections that on a `Database` shared by more than one caller, hand-rolled `begin`/`commit` across separate `exec` calls is not indivisible, and point at the option.
- `docs/errors.md` § Error Class Hierarchy: add `TransactionActiveError`.

Phase 6 — validation

- `yarn workspace @quereus/quereus run lint`, `yarn build`, and `yarn test` from the repo root, all in the foreground.
