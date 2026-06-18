description: An end-to-end test now proves that inserting, updating, or deleting an indexed row writes the row and its index together in one all-or-nothing browser-storage save; review hardened it to confirm the same holds when a table has more than one index.
prereq:
files:
  - packages/quereus-plugin-indexeddb/test/atomic-dml.spec.ts          # the test under review (+1 test added in review)
  - packages/quereus-plugin-indexeddb/src/store.ts                     # MultiStoreWriteBatch / openWriteTx
  - packages/quereus-plugin-indexeddb/src/manager.ts                   # db replaced on every version upgrade
  - packages/quereus-plugin-indexeddb/src/provider.ts                  # beginAtomicBatch → IndexedDBAtomicBatch
  - packages/quereus-store/src/common/transaction.ts                   # commit(): atomic vs per-store fallback
  - packages/quereus-store/src/common/store-module.ts                  # getCoordinator wires beginAtomicBatch — the seam under test
difficulty: medium
----

# Review: E2E DML test for the within-table atomic commit path

## Outcome

Implementation accepted with one inline strengthening added during review. No
production code changed by the feature or the review — this ticket is pure test
coverage. Final state: `packages/quereus-plugin-indexeddb` **73 passing** (was 72
at handoff; +1 from the review-added multi-index test), test type-check clean.

## What the test proves

Real `insert`/`update`/`delete` driven through the store module's public SQL
surface over a real `IndexedDBProvider`-backed indexed table, asserting the
table's data store and its secondary-index store(s) ride **one** native IDB
`readwrite` transaction rather than a per-store loop. This executes the seam
`StoreModule.getCoordinator` → `() => provider.beginAtomicBatch?.()` →
`IndexedDBAtomicBatch` → `MultiStoreWriteBatch.write()` (one
`db.transaction(storeNames, 'readwrite')`), which was previously only
typecheck-covered (the two halves were unit-covered in isolation by
`transaction.spec.ts` and `atomic-batch.spec.ts`).

## Review findings

### What was checked

- **Diff read first, fresh eyes.** Read the implement commit (`65ccf855`) and the
  full new spec before the handoff summary.
- **Seam wiring verified end-to-end against production code** (not just the
  handoff's claims): `store-module.ts` `getCoordinator` (~1953) passes
  `() => this.provider.beginAtomicBatch?.()`; `transaction.ts` `commit()` chooses
  the atomic batch when the factory returns one, else the per-store loop;
  `provider.ts` `beginAtomicBatch` → `IndexedDBAtomicBatch` →
  `MultiStoreWriteBatch.write()` issues exactly one
  `db.transaction(storeNames, 'readwrite')`. The test's assertion shape matches
  this reality.
- **Non-vacuousness.** Confirmed the atomic (length 1, both stores) vs fallback
  (length 2, separate stores) pair over the *same* `insert` statement makes the
  assertion non-trivial — a visibility-only test would pass on either path.
- **Filter-masking risk.** `relevantRw` drops `__stats__`/`__catalog__`-only txns.
  Verified this cannot hide a double-write: the `length === 1` assertion fails on
  any *extra* rw tx that also touches the data/index stores, and stats flush
  (`store-table.ts`, gated at `STATS_FLUSH_INTERVAL = 100`) writes a separate
  `__stats__`-only tx and never fires at single-digit row counts anyway.
- **Spy correctness.** Patching `IDBDatabase.prototype.transaction` (not a
  captured instance) is the right call given `manager.ts` replaces `this.db` on
  every version upgrade (`doUpgrade`/`doDeleteObjectStore`/`doRenameObjectStores`);
  the new db is still an `FDBDatabase` sharing the patched prototype. Restore runs
  first in `afterEach`, captured `orig` is always the true original.
- **Resource cleanup.** `afterEach` restores spy → resets `recording` → closes
  module → `resetInstance` → deletes the IDB database. Each `beforeEach` builds a
  fresh provider/manager (singleton was reset). No cross-spec leakage.
- **Lint/typecheck + tests.** `tsc -p tsconfig.test.json --noEmit` → exit 0;
  `yarn workspace @quereus/plugin-indexeddb test` → 73 passing.
- **Docs.** The feature is documented in `packages/quereus-store/README.md`
  (§ "Atomic multi-store commit"); it accurately describes the IndexedDB
  single-`db.transaction` implementation and the per-store fallback. Adding a test
  required no doc change; confirmed the doc reflects current reality.

### Minor — fixed inline this pass

- **Multi-index gap closed.** The handoff covered a single secondary index only,
  leaving "does the atomic batch span *every* index store?" unverified. Added one
  test: table `t (id, b, c)` with indexes `ix_b` and `ix_c`, asserting a fresh
  `insert` commits the data store and *both* index stores in ONE rw tx
  (`include.members([data, ix_b, ix_c])`, length 1). Added a `warmupTwoIndexes`
  helper alongside the existing `warmup`. 73 passing.

### Major — none

No correctness, atomicity, or seam-coverage defects found in the implementation
or the test. The spy approach, the non-vacuous atomic-vs-fallback pairing, and the
builder-derived store names are sound.

### Deferred (not filed — judged not worth a ticket)

- **Explicit cross-table `begin … commit`.** The feature's deliberately
  multi-store (not just multi-index-of-one-table) `AtomicBatch` surface is built
  for a future module-wide cross-table commit; no such caller exists yet
  (`kv-store.ts` / README both state this is forward-looking). A multi-table
  atomicity test has nothing to assert against until that caller lands — testing
  it now would only re-exercise the single-table path under a `begin/commit`
  wrapper. Revisit when the cross-table commit path is implemented.
- **Real capability-less provider.** The fallback path is forced by a test stub
  here. The only real no-`beginAtomicBatch` provider was LevelDB, which has since
  gained an atomic batch (`store-leveldb-shared-root`); its per-store path, where
  it still applies, is exercised by `test:store`. No standalone ticket warranted.
- **UNIQUE-index atomic shape.** A UNIQUE secondary index adds readonly
  uniqueness-check traffic (excluded by the spy's `readwrite` guard) but its
  atomic-commit shape is unverified. Low value: the commit path is index-kind
  agnostic (`MultiStoreWriteBatch` treats all index stores identically), so the
  non-unique + multi-index coverage already exercises the same code. Not filed.

### Pre-existing failure (already resolved)

The handoff flagged `packages/quereus/test/store.spec.ts:10` (unused `type Row`)
via `tickets/.pre-existing-error.md`. That was in a different package (untouched by
this ticket) and was already handled by triage commit `c3c5de4f`; the file no
longer exists. This plugin's own test config type-checks clean.

## Validation performed (review)

- `yarn workspace @quereus/plugin-indexeddb test` → **73 passing** (72 pre-existing
  + 1 review-added).
- `npx tsc -p tsconfig.test.json --noEmit` (in `packages/quereus-plugin-indexeddb`)
  → exit 0, clean.
