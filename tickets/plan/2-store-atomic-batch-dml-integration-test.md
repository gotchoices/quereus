description: Add an end-to-end test proving that inserting into a table with an index, when backed by the browser IndexedDB store, really saves the row and the index together in one save — the last unverified link in the new atomic-save feature.
prereq:
files:
  - packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts   # existing provider-level atomic tests (sibling to add to / model after)
  - packages/quereus-store/src/common/store-module.ts             # getCoordinator (~1840) wires () => provider.beginAtomicBatch?.()
  - packages/quereus-store/src/common/transaction.ts              # commit() atomic vs. fallback path
  - packages/quereus-plugin-indexeddb/src/provider.ts             # beginAtomicBatch + IndexedDBAtomicBatch
difficulty: medium
----

# E2E DML integration test for the within-table atomic commit path

## Why

The atomic multi-store commit capability (`store-atomic-batch-capability`,
implemented) is verified at the **unit** level on both ends:

- the coordinator's atomic-vs-fallback branch (`transaction.spec.ts` → "atomic
  batch path", in-memory spy batch), and
- the IndexedDB provider's `beginAtomicBatch` / cache coherence / foreign-handle
  MISUSE (`atomic-batch.spec.ts`, real `fake-indexeddb`).

The **seam between them** — `StoreModule.getCoordinator` passing
`() => this.provider.beginAtomicBatch?.()` into the coordinator so that real DML
(`insert`/`update`/`delete` on a table carrying a secondary index) routes the
whole change through one `db.transaction(...,'readwrite')` — is covered only by
typecheck, never by an executing test. The implement handoff flagged this
explicitly as the recommended remaining add.

The risk is low (the wiring is a one-liner and both halves are unit-covered), so
this is backlog, not a blocker — but the loop should be closed.

## What to build

An integration test, driven through the **store module's public table surface**
(not by calling `beginAtomicBatch` directly), that:

- creates a `using store` table with at least one secondary index over a real
  `IndexedDBProvider` (`fake-indexeddb/auto`, as `atomic-batch.spec.ts` does);
- performs an `insert` (and ideally an `update` that moves an indexed value, plus
  a `delete`);
- asserts the data row and the index entry are both visible post-commit (atomic
  visibility), and — the key assertion — that the commit went through the atomic
  path, i.e. exactly **one** IDB `readwrite` transaction spanning the data + index
  object stores rather than a per-store loop.

The single-transaction assertion is the load-bearing one; spy on
`IDBDatabase.transaction` (or on `MultiStoreWriteBatch` vs. per-store
`IndexedDBWriteBatch`) to distinguish the atomic path from the fallback. A test
that only checks final visibility would pass on the fallback path too and so
would not actually exercise the new code.

## Out of scope

LevelDB has no `beginAtomicBatch` yet (its shared-root restructure is
`store-leveldb-shared-root`), so this test targets IndexedDB only; the LevelDB
fallback path is already exercised by the existing `test:store` runs.
