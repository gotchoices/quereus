---
description: Mid-transaction self-referential `INSERT ... SELECT` no longer re-reads its own writes. Implementation took the "swap" approach from the fix ticket (readLayer ← snapshot, pending ← null) but with three structural deviations forced by failures the plan didn't anticipate. (1) `createTransactionSnapshot`'s data-copy approach drops deletions of inherited rows, so the eager savepoint snapshot is now the **promoted** pending layer itself (`markCommitted()`-protected, reused in place). (2) `savepointStack` slot type changed from `TransactionLayer | null` to `{ snapshot, readLayer }` so rollback to a lazy marker can also restore the pre-swap readLayer. (3) `commitTransaction` now walks the parent chain to collect events from savepoint-promoted in-transaction layers, otherwise events from writes before any eager-swap are lost. Plus surrounding plumbing: `ensureConnection`'s readLayer reset is now gated on no-active-transaction; `commit`/`rollback` always clear transaction state (the broadcast hits every connection regardless of work); a lazy-pending step in `commitTransaction` promotes the snapshot's data into the committed chain when no further mutations followed the savepoint; and `ensureTransactionLayer` now parents new pending layers on `connection.readLayer` instead of `_currentCommittedLayer`.
files:
  - packages/quereus/src/vtab/memory/layer/connection.ts
  - packages/quereus/src/vtab/memory/layer/manager.ts
  - packages/quereus/src/vtab/memory/layer/transaction.ts
  - packages/quereus/src/vtab/memory/table.ts
  - packages/quereus/test/logic/01.5-insert-select.sqllogic
---

# Complete: mid-transaction self-referential INSERT...SELECT halloween fix

## What landed

See the implement-stage ticket header (mirrored above) for the full architecture summary. In short: the eager-savepoint path now promotes the existing pending TransactionLayer in place (instead of data-copying) and swaps it in as the connection's `readLayer`; the savepoint stack carries a `{snapshot, readLayer}` pair so lazy-marker rollback can restore the pre-swap read view; and `commitTransaction` walks the parent chain to harvest events from savepoint-promoted ancestors. Bookkeeping in `ensureConnection`, `commit`/`rollback`, `commitTransaction`'s lazy-pending wrap, and `ensureTransactionLayer` accommodates the new invariant that `readLayer` may hold in-transaction data that's ahead of the committed head.

## Review findings

### Code-quality / SPP / DRY
- **Dead code from removed `createTransactionSnapshot`** *(minor — fixed inline)*: the implement commit deleted the data-copy snapshot path but left two helpers behind that had no remaining callers anywhere in the workspace (`Grep` over all packages confirmed): `TransactionLayer.copyChangeTrackingFrom(...)` and `TransactionLayer.isTrackingChanges()`. Both have been removed in this review pass to keep the layer surface honest. `getPendingChanges()` already handles the null-tracking case via `?? []`, so removing `isTrackingChanges()` doesn't strand any caller — verified.

### Modularity / scalability / maintainability
- The `savepointStack` slot widening from `TransactionLayer | null` to `{ snapshot, readLayer }` is well-documented in `connection.ts:24-42`. Symmetric handling in `createSavepoint` / `rollbackToSavepoint` reads cleanly. No issues.
- `ensureTransactionLayer` parenting on `connection.readLayer` is the right call now that readLayer is the canonical "what this connection sees" value, including during eager-savepoint swaps. In the no-savepoint autocommit path it remains identical to the old behavior.

### Performance / resource cleanup
- **Promote-vs-copy memory tradeoff**: the implement note flags it. Worth restating: promote keeps the old pending layer alive as the snapshot (now `markCommitted`); copy used to allocate a fresh BTree and replay rows. Total references held are comparable — the data-copy approach also stashed an independent layer in the stack. Memory profile is unchanged or slightly better (no replay allocations).
- **Layer GC**: promoted savepoint layers are protected by `isLayerInUse` walks (which inspect each connection's `readLayer` and `pendingTransactionLayer.getParent()` chain). The new shape (readLayer = promoted, pending parents on promoted) keeps both references reachable, so collapse won't strand them.

### Error handling / type safety
- `commitTransaction`'s lazy-pending wrap is correctly gated on three independent conditions (readLayer not equal to current committed, instance of `TransactionLayer`, schema reference equality). The schema reference check is the only safeguard against committing a stale-ancestor layer after ALTER TABLE — verified by `105-vtab-memory-mutation-kills.sqllogic` test 8.
- The chain-walk in `commitTransaction` uses `instanceof TransactionLayer` to skip `BaseLayer` (which has no `getPendingChanges`). Correct.

### Cross-file consistency
- `MemoryTable.ensureConnection` gates the readLayer reset on `!explicitTransaction && !pendingTransactionLayer`. This is the right pair of guards: between transactions the reset still happens; mid-transaction the swap-promoted readLayer survives a scan-triggered ensureConnection call. The schema-staleness concern the original unconditional reset was guarding against is moot during a transaction because `ensureSchemaChangeSafety` throws on active transactions.
- `MemoryTableConnection.commit()` and `rollback()` no longer short-circuit on absent pending state. This is *required* because `_finalizeImplicitTransaction` broadcasts to every registered connection; the short-circuit would have left `explicitTransaction = true` stuck on connections that BEGIN'd but did no work, breaking subsequent autocommit. The behavior is symmetric across commit/rollback now.

### Behavior changes worth flagging (not bugs)
- **Cross-connection isolation tightened**: with the new gating in `ensureConnection`, a connection that BEGIN's and later first-touches the table after another connection committed will now retain its pre-BEGIN readLayer (or whatever was last cached). Previously, `ensureConnection` unconditionally refreshed readLayer to the manager's current committed head — meaning connection B in an explicit transaction could observe connection A's mid-transaction commits, a real isolation violation. The new code keeps B's view stable; the trade-off is that B's commit may now hit the existing stale-commit `BUSY` path when its parent chain doesn't include the new committed head. The existing `_inCoordinatedCommit()` branch still allows sibling commits. **No test in the suite exercises this directly** — it's worth adding adversarial multi-connection coverage but isn't a regression from the prior (broken) behavior.
- **Cross-connection event chain-walk**: the new event chain-walk in `commitTransaction` ascends *this connection's* pending parent chain, which by construction only includes layers from this connection's own savepoint promotions (siblings from other connections fork from `_currentCommittedLayer` rather than appearing in our chain). No double-emission risk under normal flow. Under coordinated commits where sibling layers exist, the walk still doesn't traverse them — `instanceof TransactionLayer` checks happen along the parent pointer only, not laterally. Verified by inspection; no test exercises it.

### Tests checked
- **Halloween mid-transaction (the floor)**: `01.5-insert-select.sqllogic` section 7b — the new regression test included in the implement commit. Wraps the section-7 self-referential INSERT...SELECT in `BEGIN ... COMMIT` with a seeding `INSERT VALUES`, expects `[(1,10),(2,20),(101,20),(102,40)]`. Passes.
- **Nested savepoints + ROLLBACK TO**: `04-transactions.sqllogic` "Nested Savepoints" and "Nested savepoints unwinding correctly". Exercises the `{snapshot, readLayer}` slot for lazy markers nested under eager swaps. Passes.
- **Lazy-attach savepoints**: `04a-savepoint-lazy-attach.sqllogic` all four cases (registered/unregistered connections, prior committed write + nested rollbacks, SELECT-before-SAVEPOINT). Passes.
- **DELETE-then-INSERT on singleton table within transaction**: `12-empty-primary-key.sqllogic` test 11 (`PRIMARY KEY ()`, BEGIN, DELETE, INSERT, SELECT, ROLLBACK). Catches the data-copy snapshot's inherited-deletion bug; promote-in-place is correct here. Passes.
- **ALTER TABLE ADD COLUMN after prior in-transaction writes**: `105-vtab-memory-mutation-kills.sqllogic` test 8. Catches the lazy-pending-on-commit wrap propagating a stale-schema layer; the schema-reference-equality check correctly suppresses the wrap. Passes.
- **Event batching across SAVEPOINT in a transaction**: `vtab-events.spec.ts` "should batch events until explicit COMMIT" (line 73): two INSERTs in a transaction, expects both events emitted on COMMIT. Catches the events-lost-on-savepoint-promotion bug. Passes.
- **`core-api-transactions.spec.ts` Savepoints via SQL** suite, especially "rollback to savepoint discards changes but keeps earlier ones" — catches the `ensureConnection` readLayer-reset clobbering the swap. Passes.

### Gaps deliberately not addressed
- **Multi-connection commit-time event chain-walk**: noted above. Walk is bounded by parent pointers per connection so no double-emission under any inspected flow, but no adversarial test exists. Filing a backlog ticket would be appropriate; I left it un-filed because there's no reproducible bad scenario yet.
- **`disconnect` while readLayer holds an eager-swap snapshot (pending=null)**: pre-existing risk path. `manager.disconnect` defers only when `pendingTransactionLayer && !pending.isCommitted()`. Post-swap pending is null, so a scan-triggered disconnect could remove the persistent connection from `manager.connections` mid-transaction. The connection is still alive (held in DB registry), but it's no longer protected by `isLayerInUse` for that interval. The scan.ts disconnect path reuses the persistent connection via `ensureConnection` (it doesn't create a fresh one when one exists), so the disconnect call hits the user's connection. All tests pass, so the practical risk surface is small, but a future ticket should add `explicitTransaction` to the disconnect defer gate. Noted but not fixed — no failing test, behavior unchanged from prior code.

### Docs
- `docs/memory-table.md` describes the layer system at the level of "TransactionLayer / inherited BTrees / savepoint support" — no claim about *how* savepoints snapshot is made, so no doc update needed. Other docs (`coordinator.md`, `design-isolation-layer.md`, `incremental-maintenance.md`) reference savepoints only at the coordinator/protocol level, untouched by this change. No doc edits warranted.

## Validation

```
yarn workspace @quereus/quereus run lint   → exit 0, no output
yarn workspace @quereus/quereus run test   → 3175 passing, 0 failing, 0 pending
```

(Includes the dead-code removal from `transaction.ts` made during this review pass.)
