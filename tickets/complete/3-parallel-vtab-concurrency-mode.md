description: Declarative `concurrencyMode` contract on `VirtualTableModule`, the `vtab/concurrency.ts` helper (mode getter + per-connection promise-chain lock), the `'reentrant-reads'` declaration on `MemoryTableModule`, and the `vtab/concurrency-mode.spec.ts` (7 cases). Plugins and store/isolation wrappers intentionally untouched (default `'serial'`).
files: packages/quereus/src/vtab/module.ts, packages/quereus/src/vtab/concurrency.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/src/index.ts, packages/quereus/test/vtab/concurrency-mode.spec.ts, docs/architecture.md, docs/module-authoring.md, docs/runtime.md
----

## Summary

Landed the contract surface (`VtabConcurrencyMode` union + optional `concurrencyMode` member on `VirtualTableModule`), the `getModuleConcurrencyMode` getter, and the `acquireConnectionLock` per-connection promise-chain mutex (WeakMap-keyed on `VirtualTableConnection` identity). Memory vtab now declares `'reentrant-reads'` (downgraded from the implement-stage `'fully-reentrant'` — see review findings).

The lock is not enforced inside `ParallelDriver`; enforcement belongs to the consumer (FanOutLookupJoin, gather, …). Those consumers and the plugin upgrades are separate follow-ups.

## Review findings

**Reviewed** (with the implement-stage diff first, before the handoff):

- The `VtabConcurrencyMode` JSDoc and the `concurrencyMode?` member contract in `src/vtab/module.ts`.
- The lock primitive (`acquireConnectionLock`) and mode getter in `src/vtab/concurrency.ts`.
- The `MemoryTableModule.concurrencyMode` declaration *against the actual `MemoryTable.query()` / `MemoryTableManager.performMutation` / `ensureTransactionLayer` / `recordUpsert` paths*.
- The 7 spec cases in `test/vtab/concurrency-mode.spec.ts`.
- The docs touched (`docs/architecture.md`, `docs/module-authoring.md`, `docs/runtime.md`) plus the upstream JSDoc that should have stayed in sync with the module change.
- Re-ran `yarn run lint`, `yarn run typecheck`, the spec file, and `yarn workspace @quereus/quereus test`.

### Major — fixed inline

**Memory vtab was declared `'fully-reentrant'` but the safety argument only covers reads.** The implement-stage JSDoc justified the declaration with *"writes always go through a fresh transient layer that is atomically published on the connection"*. That is true **only for the first write in an autocommit transaction**: `ensureTransactionLayer` (`layer/manager.ts:577`) creates a fresh `TransactionLayer` only when `pendingTransactionLayer` is null. Once a transaction is open, every subsequent write reuses the same pending layer — `performInsert/Update/Delete` call `recordUpsert` (`layer/transaction.ts:171`), which does `this.primaryModifications.upsert(newRowData)` directly on the existing BTree. Meanwhile `MemoryTable.query()` (`memory/table.ts:242`) captures `startLayer = conn.pendingTransactionLayer ?? conn.readLayer` and iterates that BTree. A `query()` interleaved with an `update()` inside an explicit transaction therefore iterates a BTree whose node graph is being mutated under it — a torn-read regardless of JS's single-thread invariant, because each `await` between iterator steps gives the writer an opportunity to split/rebalance nodes in the same tree.

`'fully-reentrant'` by the type-system definition says "any operation is safe to interleave with any other on the same connection," but only the read+read interleave was audited. The implementer's own caveat (*"Writer concurrency is explicitly out of scope … A module that wants 'fully-reentrant' for writes must independently justify the property"*) confirms the over-claim.

**Disposition**: downgraded the declaration to `'reentrant-reads'` (which *is* fully justified — concurrent `query()` calls on a single connection iterate the same captured layer's BTree with no mutations), rewrote the JSDoc on `MemoryTableModule.concurrencyMode` to spell out why, and updated `docs/architecture.md` and `docs/module-authoring.md` to match. Updated the spec test `reports MemoryTableModule as fully-reentrant` → `reports MemoryTableModule as reentrant-reads` with a comment explaining the reasoning.

### Minor — left as documented gaps

- **The memory-vtab "concurrent scan smoke" test doesn't actually exercise concurrent vtab calls** because `db.eval()` acquires the engine's per-database exec mutex per call (`Database._acquireExecMutex` in `core/database.ts:361`). The implementer disclosed this in the handoff. I rewrote the in-test comment to reflect the `'reentrant-reads'` declaration and to be explicit that a direct-`table.query()` concurrent test belongs alongside the first FanOutLookupJoin consumer. Not worth fabricating here since constructing a direct `FilterInfo` + connection in test code reproduces a fair chunk of planner machinery and the deeper test would have nothing real to defend against until there's a consumer.
- **`acquireConnectionLock` does not support `AbortSignal`-style cancellation.** The parallel-driver path advertises abort throughout; a sibling that's awaiting the lock when its branch is aborted will continue waiting until the lock holder releases. This is correctness-preserving (the abort eventually propagates) but ergonomically lossy under long critical sections. The current critical-section is one `query()` call, so the worst case is "wait for one scan to complete" — acceptable for now. Worth a doc/JSDoc note if cancellation becomes a perf bottleneck.
- **Layer-collapse interaction with in-flight readers is a pre-existing risk, not introduced here.** `MemoryTableManager.tryCollapseLayers` calls `clearBase()` on a promoted layer and uses `isLayerInUse` (checks `conn.readLayer === layer`) to gate the collapse. An in-flight iterator that captured `startLayer` *before* a transition that moved `conn.readLayer` away would be invisible to `isLayerInUse`, and the captured layer could then be `clearBase()`-d. In single-threaded JS this only matters if a `readLayer` reassignment + collapse can fire between async iteration steps; under `'reentrant-reads'` (reads-only on a single connection) it doesn't. Calling out so it's tracked.

### Empty-category disposition

- **No SPP / DRY / modularity concerns**: the new module is ~55 LOC with a single responsibility (mode getter + per-connection lock); no duplication with the existing `Latches` utility because the semantic is different (FIFO promise-chain mutex keyed on object identity vs. named-resource latch).
- **No resource-cleanup leaks**: the WeakMap holds at most one resolved promise per live connection; entries vanish on GC.
- **No type-safety regressions**: `VtabConcurrencyMode` is a string literal union; `getModuleConcurrencyMode` narrows correctly to that union; the optional `concurrencyMode?` on `VirtualTableModule` flows through `AnyVirtualTableModule = VirtualTableModule<any, any>` because the field is part of the interface.
- **No new error-handling paths**: the lock's `try/finally release()` pattern is documented in the JSDoc usage example. The "lock survives critical-section exception" test confirms it.
- **No security / boundary concerns**: pure in-process synchronization primitive on engine-internal objects; no external attack surface.

## Validation

- `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js --reporter spec packages/quereus/test/vtab/concurrency-mode.spec.ts` → 7 passing, 0 failing (35 ms).
- `yarn workspace @quereus/quereus test` → 3334 passing, 6 pending, 0 failing.
- `yarn workspace @quereus/quereus run lint` → clean (exit 0).
- `yarn workspace @quereus/quereus run typecheck` → clean (exit 0).
