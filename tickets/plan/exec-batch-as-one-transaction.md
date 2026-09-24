description: Callers that share one `Database` have no way to run a group of statements as a transaction that nobody else's statements can slip into, and that is fully rolled back before anyone else runs if one of its statements fails.
files: packages/quereus/src/core/database.ts (`exec` ~1028-1058, `beginTransaction`/`commit`/`rollback` ~1321-1358, `_withMutex` ~805), packages/quereus/src/core/database-transaction.ts (`beginTransaction` ~199)
----
# A statement batch that runs as one transaction, under one hold of the exec mutex

Filed from Sereus, a consumer, on 2026-09-18 (Sereus ticket `strand-writer-transactions-indivisible`).

## The problem

A Sereus strand hands one `Database` to the application and also writes to it from background code (a membership reconciler that redeems an invitation as two inserts that must land together). Today the only way to write a multi-statement transaction is `beginTransaction()`, then separate `exec` calls, then `commit()`. The exec mutex is released between those calls, and any statement another caller issues in that gap runs inside the open explicit transaction (`exec` commits per statement only when the transaction is implicit). Sereus lost application rows this way: the app's `exec` resolved, then the reconciler's commit failed and rolled the app's rows back with its own.

Putting the whole transaction in one `exec` batch (`begin; insert …; insert …; commit;`, named parameters) nearly fixes it, because `exec` holds the mutex for the batch. Verified against 4.19.4 on 2026-09-18:

- Named parameters bind correctly across every statement of a batch.
- A failure at `commit` (a deferred constraint) leaves no transaction open: `getAutocommit()` is `true` afterwards.
- A failure at an earlier statement (e.g. `UNIQUE constraint failed`) leaves the batch's explicit transaction **open** after `exec` rejects, and the mutex is released. Another caller's `exec`, already queued, runs next inside that open transaction. When the batch's owner then calls `rollback()`, that caller's write is discarded even though its `exec` resolved. Reproduced: an insert queued behind a failing batch disappeared.
- The batch's own `begin` fails with `Cannot begin transaction: already in a transaction` when another caller's explicit transaction is open. The owner cannot then tell from outside whether the open transaction is its own (so roll back) or someone else's (so leave it alone), except by matching that message.
- Related, same file (found in Sereus's review, 2026-09-18, by reading the code, not reproduced): `beginTransaction()`, `commit()` and `rollback()` check `transactionManager.isInTransaction()` before taking the exec mutex. `isInTransaction()` is also true while another caller's autocommit statement is running (its implicit transaction), so a `beginTransaction()` that happens to be called during someone else's insert throws `Transaction already active` instead of waiting its turn. On a shared `Database` the app sees that error whenever a background write is in flight. The check belongs under the mutex, where the `BEGIN` statement already makes it.

## What is wanted

A public way to run a statement batch as one transaction that is indivisible with respect to other callers of the same `Database`. For example an `exec` option (`db.exec(sql, params, { transaction: true })`) or a dedicated method. Required behaviour:

- Begins an explicit transaction, runs every statement, and commits, all under a single hold of the exec mutex.
- If any statement or the commit fails, the transaction is rolled back **before** the mutex is released, and the original error is rethrown. No other caller's statement ever runs inside it.
- If a transaction (explicit, or another caller's) is already open when the batch gets the mutex, it refuses with a distinguishable error (a dedicated error class or status code) and touches nothing. This matters because the caller must not roll back a transaction it does not own.
- Parameters work as they do for `exec` (named parameters shared across the batch).

Nice to have, not required: a callback form (`db.transaction(async (tx) => …)`) that lets the body run reads and compute values between statements while still holding the mutex. Sereus can compute everything first, so the batch form is enough for it.

## Use case to test

Two callers on one `Database`: caller A runs a two-insert batch through the new API whose second insert violates a unique constraint; caller B issues an autocommit insert while A's batch is in flight. B's row must survive, A's first insert must not, and `getAutocommit()` must be `true` afterwards. Repeat with A's failure at commit (a deferred check), and with B holding its own explicit transaction open when A starts (A must refuse and B's transaction must be untouched).
