description: Review a new browser-storage test that proves inserting, updating, or deleting an indexed row writes the row and its index together in a single all-or-nothing save.
prereq:
files:
  - packages/quereus-plugin-indexeddb/test/atomic-dml.spec.ts          # NEW — the test under review
  - packages/quereus-plugin-indexeddb/test/rename-persistence.spec.ts  # setup model it was copied from
  - packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts        # sibling provider-level atomic tests
  - packages/quereus-plugin-indexeddb/src/store.ts                     # MultiStoreWriteBatch (one rw tx), IndexedDBWriteBatch (per-store fallback), openWriteTx durability bag
  - packages/quereus-plugin-indexeddb/src/manager.ts                   # db instance REPLACED on every version upgrade (doUpgrade/doDelete/doRename)
  - packages/quereus-plugin-indexeddb/src/provider.ts                  # beginAtomicBatch → IndexedDBAtomicBatch → MultiStoreWriteBatch
  - packages/quereus-store/src/common/transaction.ts                   # commit(): atomicBatchFactory?.() chooses atomic vs per-store fallback
  - packages/quereus-store/src/common/store-module.ts                  # getCoordinator (~1951) wires () => provider.beginAtomicBatch?.() — THE SEAM UNDER TEST
difficulty: medium
----

# Review: E2E DML test for the within-table atomic commit path

## What landed

One new test file: `packages/quereus-plugin-indexeddb/test/atomic-dml.spec.ts`
(4 tests). No production code changed — this ticket only adds coverage. It closes
the last unverified link in the atomic multi-store commit feature: real
`insert`/`update`/`delete` driven through the store module's public SQL surface on
an `IndexedDBProvider`-backed indexed table, asserting the table's data store and
its secondary-index store ride **one** native IDB `readwrite` transaction rather
than a per-store loop.

Both halves of the feature were already unit-covered in isolation (the
coordinator's atomic-vs-fallback branch in `quereus-store`'s `transaction.spec.ts`;
the provider's `beginAtomicBatch` in `atomic-batch.spec.ts`). The seam between them
— `StoreModule.getCoordinator` passing `() => this.provider.beginAtomicBatch?.()`
into the coordinator — was previously only typecheck-covered. This test executes it.

## How it works (what to scrutinize)

- **Spy seam.** Patches `IDBDatabase.prototype.transaction` (the fake-indexeddb
  `FDBDatabase` prototype, reached via `Object.getPrototypeOf(await
  manager.ensureOpen())`) — NOT a captured `db` instance, because the manager
  *replaces* `this.db` on every version upgrade. A `recording` flag, flipped on
  only around the single statement under test, gates capture; the spy records the
  store set of each `readwrite` tx and forwards the call verbatim (preserving the
  optional `{ durability }` options bag, or fake-indexeddb throws).
- **Determinism.** A `warmup()` (create table + index + first insert, all with
  recording off) materializes both object stores *before* the window, so the
  commit under test is a pure `db.transaction([main.t, main.t_idx_ix_b],
  'readwrite')` with no version-upgrade reopen inside the window. `warmup()`
  asserts both stores exist, so a missed/stale patch surfaces as a clear failure
  rather than a silent `length === 0`.
- **Load-bearing assertion.** Filter recorded rw txns to those touching the data
  and/or index store (drops `__stats__`/`__catalog__`-only noise), then assert
  exactly one rw tx whose store set includes BOTH `buildDataStoreName('main','t')`
  and `buildIndexStoreName('main','t','ix_b')`. Names are derived from the engine's
  own builders, never hardcoded.
- **Fallback control.** One test stubs `provider.beginAtomicBatch` to `() =>
  undefined` (instance property shadowing the prototype method, restored in a
  `finally`) and asserts the OPPOSITE shape: **two** single-store rw txns
  (`{data}` and `{index}` separately). This is what proves the spy actually
  discriminates the paths — and the suite passing with both the atomic
  (length 1, both stores) and fallback (length 2, separate) variants of the *same*
  `insert` statement is the strongest evidence the assertion is non-vacuous.

## Cases covered (each its own recording window, each with a visibility check)

- **insert** new indexed row → 1 rw tx over `{data, index}`; `where b = 20` → `[{id:2}]`.
- **update that moves the indexed value** → old index entry delete + new insert +
  data rewrite in 1 rw tx; `where b = 11` returns the row, `where b = 10` none.
- **delete** → data delete + index delete in 1 rw tx; gone from full scan and
  index-backed predicate.
- **fallback** (atomic batch stubbed off) → 2 single-store rw txns; final
  visibility still correct (fallback is correct, just not atomic).

## Validation performed

- `yarn workspace @quereus/plugin-indexeddb test` → **72 passing** (the new 4 plus
  all pre-existing rename/atomic-batch specs). Verified the 4 new tests run and
  pass individually via the `spec` reporter (not silently skipped).
- `tsc -p tsconfig.test.json --noEmit` → the new file type-checks clean. (One
  *pre-existing*, unrelated error remains: `test/store.spec.ts:10` imports an
  unused `type Row` — present at HEAD, untouched by this ticket, flagged in
  `tickets/.pre-existing-error.md` for the runner's triage pass. The package's
  required `test` command runs via ts-node type-stripping, so it passes regardless.)

## Known gaps / honest limitations (treat the tests as a floor)

- **Single index only.** Covers one non-unique secondary index (`ix_b`). A
  multi-index table (two+ secondary indexes) committing all index stores in one rw
  tx is NOT covered — a worthwhile extension to confirm the atomic batch spans
  *every* index store, not just one. A UNIQUE index is also not exercised here (it
  would add readonly uniqueness-check traffic, excluded by the `mode === 'readwrite'`
  guard, but the atomic-commit shape with a UNIQUE index is unverified).
- **Autocommit single statements only.** No explicit `begin … commit` spanning
  multiple rows/tables in one transaction; the cross-table atomicity the feature
  ultimately enables is not directly asserted here.
- **Fallback is forced by a test stub**, not a real capability-less provider. The
  real no-`beginAtomicBatch` provider (LevelDB) is out of scope (it has no atomic
  batch yet — see `store-leveldb-shared-root`) and its per-store path is exercised
  by `test:store`.
- **Global-prototype patch.** The spy mutates a process-global prototype; restore
  is unconditional and runs FIRST in `afterEach`, and the full 72-test run shows no
  cross-spec contamination — but a reviewer should sanity-check that no future
  parallelization of these specs would race on the shared `recording` flag / `log`.
- **Stats-flush assumption.** Relies on `STATS_FLUSH_INTERVAL = 100` not being hit
  (single-digit row counts) so no in-window `__stats__` rw tx appears; the filter
  would drop a `__stats__`-only tx anyway, but an extra rw tx that *also* touched
  data/index would break the `length === 1` assertion. Worth confirming no future
  code path writes data+stats in a combined rw tx inside a commit.

## Suggested reviewer actions

- Sanity-check the non-vacuousness argument (atomic vs fallback on the same
  `insert`). If unconvinced, temporarily make the atomic assertion expect 2 and
  confirm it fails.
- Consider whether a multi-index and/or explicit-transaction case should be added
  now (minor → add inline) or spun out (file a follow-up `fix`/`plan` ticket).
