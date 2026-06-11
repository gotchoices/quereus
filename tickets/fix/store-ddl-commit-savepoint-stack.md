----
description: Store DDL-commits posture (replaceContents, renameTable) clears the coordinator's savepoint stack; a later `rollback to <savepoint>` on the still-registered connection throws "Savepoint depth N not found" (NOTFOUND) where the memory module warns and continues.
files:
  - packages/quereus-store/src/common/transaction.ts          # TransactionCoordinator.rollbackToSavepoint throws on out-of-range depth
  - packages/quereus-store/src/common/backing-host.ts          # StoreBackingHost.replaceContents commit-first
  - packages/quereus-store/src/common/store-module.ts          # renameTable commit-first (pre-existing, same posture)
  - packages/quereus/src/vtab/memory/layer/connection.ts       # memory reference: warn-and-return on out-of-range depth
----

# Store DDL-commits × savepoint stack: NOTFOUND on rollback-to-savepoint

## Symptom (reproduced during the store-backing-host review)

```sql
-- store-backed MV (or any store DDL-commits operation)
begin;
savepoint s1;
insert into src values (2, 20);          -- backing connection registers, savepoint stack replayed
refresh materialized view mv;            -- replaceContents commits the coordinator txn (DDL-commits)
rollback to s1;                          -- THROWS: "Savepoint depth 0 not found" (NOTFOUND)
```

Observed behavior (probe run against `IsolationModule(StoreModule)`):

- **Store arm**: `rollback to s1` throws NOTFOUND from
  `TransactionCoordinator.rollbackToSavepoint` — the commit inside
  `replaceContents` ran `clearTransaction()`, emptying the savepoint stack
  while the engine still believes savepoint `s1` is open on the registered
  `StoreConnection`. The error surfaces mid-way through the engine's
  per-connection rollback fan-out, so sibling connections (the source table)
  may already have rolled back — partial state plus a user-visible error.
- **Memory arm**: the same scenario succeeds — `MemoryTableConnection.rollbackToSavepoint`
  logs a warning and returns when the depth is out of range (comment there
  cites "failed savepoint replay" as the anticipated cause). Memory has its
  own quirk in this corner (the restored read layer can briefly show
  pre-refresh contents until commit), but it never throws.
- **Final post-commit state converges** in both arms (refresh persists,
  source insert rolled back) — when the store error is swallowed.

## Scope

NOT introduced by the backing host. `renameTable` has taken the identical
commit-first posture all along (its comment claims "Subsequent commit() calls
… are no-ops, which keeps the enclosing transaction safe" — true for
commit/rollback, which no-op gracefully when not in a transaction, but NOT for
`rollbackToSavepoint`/`releaseSavepoint`, which assume the stack survived).
`StoreBackingHost.replaceContents` (refresh / create-fill) inherits the
posture and widens exposure: `alter table rename` inside a savepoint was
obscure; `refresh materialized view` inside a savepoint is plausible.

## Expected behavior (to decide)

Options, roughly in order of fidelity:

1. **Memory parity (cheapest)**: make `TransactionCoordinator.rollbackToSavepoint`
   (and `releaseSavepoint`, which already truncates harmlessly) warn-and-return
   when the target depth no longer exists — mirroring the memory connection's
   posture and rationale. A post-DDL-commit `rollback to savepoint` then
   degrades to "the DDL and everything before it stays committed", which is
   exactly what DDL-commits means.
2. **Re-seed the stack**: after a DDL-commit, begin a fresh implicit
   transaction and re-push empty savepoint snapshots to the engine's current
   depth so later partial rollbacks discard only post-DDL ops. More faithful,
   but the coordinator doesn't know the engine's savepoint depth — would need
   the connection to track it.
3. **Reject DDL inside savepoints** for store-backed objects (sited error at
   the refresh/rename, before any side effect).

Whatever is chosen, pin it with a store-vs-memory parity test mirroring the
existing `refresh inside an explicit transaction` parity test in
`packages/quereus-store/test/mv-store-backing.spec.ts` but with a savepoint +
`rollback to savepoint` after the refresh, and a plain-table
`alter table rename`-in-savepoint case for the pre-existing posture.
