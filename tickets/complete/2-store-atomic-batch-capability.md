description: Reviewed and accepted the new storage capability that saves a table's rows and indexes to disk in one all-or-nothing commit, so a crash can't leave them out of sync. Implemented for IndexedDB; other providers fall back to the prior per-store behavior unchanged.
prereq:
files:
  - packages/quereus-store/src/common/kv-store.ts                 # AtomicBatch interface + KVStoreProvider.beginAtomicBatch
  - packages/quereus-store/src/common/index.ts                    # exports AtomicBatch
  - packages/quereus-store/src/common/transaction.ts             # commit() atomic/fallback branch; atomicBatchFactory ctor param
  - packages/quereus-store/src/common/store-module.ts            # getCoordinator (~1840) injects the factory
  - packages/quereus-plugin-indexeddb/src/provider.ts            # beginAtomicBatch + IndexedDBAtomicBatch + resolveStoreName
  - packages/quereus-plugin-indexeddb/src/store.ts              # MultiStoreWriteBatch (reused unchanged)
  - packages/quereus-store/test/transaction.spec.ts             # coordinator atomic-path tests
  - packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts  # IDB cache coherence + foreign-handle MISUSE
  - packages/quereus-store/README.md                            # § Atomic multi-store commit + Core Exports row
  - docs/materialized-views.md                                  # § Cross-module atomicity reference
----

# Review (complete): atomic multi-store batch capability (within-table)

## Outcome

**Accepted.** The implementation is correct, well-scoped, and honestly
documented. The capability is opt-in per provider; absent the capability every
provider is byte-identical to the prior per-store loop. Shipped for IndexedDB,
exercised in the coordinator via an in-memory test batch. Validation re-run
green; one backlog ticket filed for the one genuine coverage gap; no code defects
found.

## What was built (recap)

`KVStoreProvider.beginAtomicBatch?(): AtomicBatch | undefined` — present iff the
provider's stores share one durable commit domain. The coordinator's `commit()`
takes an `atomicBatchFactory` (injected by `StoreModule.getCoordinator` as
`() => provider.beginAtomicBatch?.()`, re-evaluated per commit): when it yields a
batch, every grouped op (data store + secondary-index stores) is queued into one
`AtomicBatch` and committed with a single `write()`; otherwise the original
per-store loop runs. IndexedDB implements it over `MultiStoreWriteBatch` (one
`db.transaction(...,'readwrite')`), invalidating each touched store's read cache
after a successful write to preserve read-your-own-writes across `CachedKVStore`.

## Review findings

### Validation re-run (all green at review HEAD)
- `yarn workspace @quereus/store run test` → **637 passing**.
- `yarn workspace @quereus/plugin-indexeddb run test` → **68 passing**.
- `yarn workspace @quereus/store run typecheck` → clean.
- `yarn workspace @quereus/plugin-indexeddb run typecheck` → clean.
- `yarn workspace @quereus/quereus run typecheck` → clean (matters because the
  commit also carries unrelated quereus-core edits — see "Commit provenance").
- Lint: the store and indexeddb packages have no lint script (only `@quereus/quereus`
  does); the atomic-batch change touches neither linted source nor the quereus
  test typecheck set, so `yarn lint` is not applicable to this diff. Typecheck
  stands in as the static gate and is clean across all three packages.
- `yarn test:store` (LevelDB store-mode) NOT run — slow / not agent-runnable;
  LevelDB exposes no `beginAtomicBatch`, so it only exercises the unchanged
  fallback path. Deferred to human/CI, consistent with the implement handoff.

### Correctness — verified, no defects
- **Op addressing.** `bucketKey` yields either `null` (default) or a real
  provider-issued `KVStore` handle for explicit (index) stores; the atomic path's
  `target ?? defaultStore!` therefore always hands `IndexedDBAtomicBatch.put/delete`
  a genuine provider handle, which `resolveStoreName` unwraps (`CachedKVStore →
  getUnderlying()`) and validates (`IndexedDBStore` bound to `this.manager`, else
  `QuereusError(MISUSE)`). The `defaultStore!` assertion is sound — it is only
  reached for the `null` bucket, which is resolved under the `opsByStore.has(null)`
  guard before any batch opens.
- **Single-write-per-store.** `opsByStore` is folded by `bucketKey`, so each
  physical store appears once. Even if the documented invariant ("the default
  store is never passed as an explicit handle pre-resolution") were violated, two
  buckets resolving to one physical IDB store would still land in the *same*
  `MultiStoreWriteBatch` transaction in op order — no atomicity or correctness
  regression, only a redundant queue entry. Confirmed safe.
- **Failure semantics.** A rejected atomic `write()` propagates out of `commit()`;
  `finally { clearTransaction() }` clears state; events and commit callbacks run
  only *after* a successful write — identical to the fallback path. Cache
  invalidation runs only after `await write()` resolves, so a failed write leaves
  no write applied *and* no cache dropped. The transient `AtomicBatch` is
  discarded (GC), no op leak into the next transaction (coordinator-test covered).
- **Empty transaction.** The atomic/fallback block sits inside
  `if (this.pendingOps.length > 0)`, so an empty commit opens no batch.
- **Cache coherence.** `invalidateStore(name)` looks up `this.stores.get(name)`
  and calls `CachedKVStore.invalidateAll()`; the name comes from the same handle
  the provider stored, so invalidation hits the right wrapper. RYOW after an
  atomic write is asserted by `atomic-batch.spec.ts` (negative cache → write →
  re-read sees the value).

### Robustness observation — minor, no action (not a regression)
`MultiStoreWriteBatch.write()` handles `tx.onerror`/`tx.oncomplete` but not
`tx.onabort`; a transaction that aborts *without* a preceding request error would
leave the returned promise pending. This is **identical to the pre-existing
single-store `IndexedDBWriteBatch.write()`** (the fallback path shipping today),
so the atomic path is no worse, and in practice IDB fires `onerror` (→ reject)
before `onabort` for error-driven aborts; nothing calls `tx.abort()` explicitly.
Reused-unchanged code, consistent with the existing pattern — flagged for
awareness, not fixed, to avoid scope creep and to keep both paths uniform. If the
team wants `onabort` hardening, do it for *both* batch classes in one pass.

### Style / DRY — minor, no action
The atomic and fallback branches duplicate the `put`/`delete` op-dispatch loop.
The duplication is shallow and the two sinks differ (handle-addressed
`AtomicBatch` vs. per-store `WriteBatch`); extracting a shared dispatch helper
would add indirection for little gain. Left as-is.

### Test coverage
- **Coordinator (`transaction.spec.ts`).** Strong: atomic path taken / not taken
  by factory return, byte-identical no-factory fallback, rejected-write
  propagation + state clear + no op leak, events/callbacks fire only post-write,
  default-only / index-only / mixed buckets, resolved-default-by-handle fold =
  one entry, empty txn opens no batch.
- **IndexedDB (`atomic-batch.spec.ts`).** Multi-store commit, RYOW cache
  coherence, `clear()` discards, MISUSE on wrong-type handle and on an
  `IndexedDBStore` bound to a different manager.
- **Gap (filed, not fixed): no executing end-to-end DML test.** The seam
  `StoreModule.getCoordinator → beginAtomicBatch` is verified only by typecheck;
  no test drives real `insert`/`update`/`delete` over a live `IndexedDBProvider`
  and asserts a *single* IDB transaction. Writing a meaningful version (spying on
  `IDBDatabase.transaction` to distinguish atomic from fallback) is more than an
  inline review fix, and risk is low (both halves unit-covered, wiring is a
  one-liner), so filed as backlog **`store-atomic-batch-dml-integration-test`**
  rather than done here. A visibility-only test would pass on the fallback path
  too and so would not exercise the new code — the single-transaction assertion is
  the load-bearing one.
- **Atomicity-rollback test.** No test asserts that a *failed* atomic write leaves
  no partial cross-store state. Hard to simulate deterministically with
  `fake-indexeddb`; the coordinator-level "rejected write clears state" test is
  the achievable proxy and is present. Acceptable; noted.

### Docs — verified accurate
`packages/quereus-store/README.md` § "Atomic multi-store commit" and the
Core-Exports `AtomicBatch` row, plus the `docs/materialized-views.md`
cross-module-atomicity paragraph, were read in full and match the shipped code:
IndexedDB-only, fallback byte-identical, handle-addressing, capability surface
deliberately spanning multiple stores of one provider. No over-claiming (no
implication that LevelDB or module-wide cross-table commit exists yet).

### Pre-existing test-file typecheck noise — not this ticket
The package tsconfigs exclude `test/`. An ad-hoc test typecheck (per the implement
handoff) surfaced pre-existing issues in files this ticket never touched
(`transaction.spec.ts:6` unused import, `unique-constraints.spec.ts:296`
`number`/`void`, `store.spec.ts:10` unused `Row`). None break any project gate
(`yarn test` is transpile-only and green; package `typecheck` excludes `test/`),
so no `.pre-existing-error.md` was filed. Left untouched.

### Commit provenance — flag, nothing to fix
The implement commit `a4409b29` **also carries unrelated quereus-core changes**:
`packages/quereus/src/runtime/emit/alter-table.ts`,
`.../materialized-view-helpers.ts`, and `packages/quereus/src/vtab/module.ts`
(adding optional `ensureBackingForAttach` / `retireBackingForAttach` module hooks
for maintained-table backing migration — a *different* work stream on the
`view-updates-lens` branch). The implement handoff disclosed these as "concurrent
in-flight edits, NOT mine," left untouched per the no-sanitize rule; the runner's
commit then swept them in. These are **not** atomic-batch work and are reviewed
only for non-breakage: the added module methods are optional and invoked via
`?.`, so they are pure no-ops for modules that omit them, and `@quereus/quereus`
typechecks clean with them present. No action taken (cannot un-commit; no-sanitize
rule; the changes are self-consistent and belong to their own ticket's ownership
on this branch). Flagged so the provenance is on record and the reviewer of that
other work stream isn't surprised to find its code already committed here.

## Follow-ons (already chained in the parent plan — NOT refiled)
- `store-leveldb-shared-root` (implement) — LevelDB shared commit domain so it can
  expose `beginAtomicBatch`.
- `store-module-wide-atomic-commit` (backlog) — module-wide cross-table commit
  reusing this batch with no interface change; subsumes the MV adopt clean-shutdown
  gate.

## Follow-on filed by this review
- `store-atomic-batch-dml-integration-test` (backlog) — executing end-to-end DML
  test asserting single-IDB-transaction routing through the wiring seam.
