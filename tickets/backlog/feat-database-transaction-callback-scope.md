description: Let a caller run a block of application code as one transaction — reading a value, deciding what to write, then writing it — without any other caller's statement being able to slip in between those steps.
architecture: docs/usage.md#transactions
files: packages/quereus/src/core/database.ts (`exec`, `_withMutex`, `_execWithinTransaction`), docs/usage.md
tradeoffs: The callback runs while the database's execution mutex is held, so any ordinary `db.get` / `db.eval` / `db.exec` call inside it deadlocks instantly — a footgun sharp enough that a maintainer may prefer callers keep pre-computing their values and using the plain atomic batch, which already covers the known consumer need.
----
# A callback that runs application code inside one transaction

Raised while planning `exec-batch-as-one-transaction` (implement stage, 2026-09-24), which was filed from Sereus, a consumer. That ticket delivers the batch form — a fixed list of statements run as one transaction under one hold of the execution mutex. This is the follow-on the filer explicitly marked "nice to have, not required": Sereus can compute every value first, so the batch form is enough for it.

## What is wanted

A way to interleave *reads and application logic* with the writes, still indivisibly:

```ts
await db.transaction(async tx => {
  const row = await tx.get('select balance from account where id = :id', { ':id': 7 });
  if (row.balance < 100) throw new InsufficientFunds();
  await tx.exec('update account set balance = balance - 100 where id = :id', { ':id': 7 });
});
```

The whole callback runs under one hold of the execution mutex. Nobody else's statement runs between the read and the write; the read sees the transaction's own uncommitted writes; a throw from the callback rolls back before the mutex is released; a normal return commits.

This is what the batch form cannot express, because the batch's statements are all fixed before the first one runs.

## Why it is not obvious

The mutex is held for the callback's whole lifetime, so anything inside it that tries to acquire the mutex again deadlocks. That is every public execution entry point on `Database` — `exec`, `get`, `eval`, and the prepared-statement methods. So the `tx` handle cannot simply be the `Database`: it has to be a separate object whose methods route to the internal, mutex-free execution path (`_execWithinTransaction` and friends), and callers have to be steered onto it.

That leaves real questions for whoever picks this up:

- A caller who closes over `db` and calls `db.get(...)` inside the callback gets a hang, not an error. Is there a cheap way to make that a loud failure instead? `_isExecuting()` already reports that the mutex is held, but it is also true for perfectly legitimate nested engine work, so it cannot simply be made to throw.
- What the `tx` handle should expose — `exec`/`get`/`all` is the obvious minimum; prepared statements and streaming iteration are less clear, since an iterator that outlives the callback would outlive the transaction.
- Whether a callback that itself calls `db.transaction(...)` should be refused or mapped onto a savepoint.
- Holding the mutex across arbitrary user code means an `await` on something slow — a network call, a user prompt — stalls every other caller of the database for as long as it takes. The batch form cannot do this; this form invites it.

## Do nothing

Callers keep pre-computing their values and using `exec(sql, params, { transaction: true })`, which is what the known consumer does. The read-then-decide-then-write shape stays expressible only by holding an explicit `beginTransaction()` open across separate calls — which, on a connection shared with other callers, is exactly the non-indivisibility the batch ticket exists to fix.
