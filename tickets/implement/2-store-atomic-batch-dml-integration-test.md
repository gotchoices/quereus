description: Add a browser-storage test proving that inserting, updating, and deleting a row in an indexed table saves the row data and its index together in a single atomic save, rather than one save per store.
prereq:
files:
  - packages/quereus-plugin-indexeddb/test/atomic-batch.spec.ts        # provider-level atomic tests (sibling; cleanup/cache idioms to reuse)
  - packages/quereus-plugin-indexeddb/test/rename-persistence.spec.ts  # MODEL FOR SETUP: Database + StoreModule + provider over fake-indexeddb/auto, rows()/objectStores() helpers
  - packages/quereus-plugin-indexeddb/src/store.ts                     # IndexedDBStore (readonly tx), MultiStoreWriteBatch (one rw tx over [data,index]), per-store IndexedDBWriteBatch (fallback)
  - packages/quereus-plugin-indexeddb/src/manager.ts                   # ensureOpen()/getManager(); db instance is REPLACED on version upgrade (doUpgrade/doDeleteObjectStore)
  - packages/quereus-plugin-indexeddb/src/provider.ts                  # beginAtomicBatch → IndexedDBAtomicBatch → MultiStoreWriteBatch
  - packages/quereus-store/src/common/transaction.ts                  # commit(): atomicBatchFactory?.() chooses atomic vs per-store-batch fallback
  - packages/quereus-store/src/common/store-module.ts                 # getCoordinator (~1953) wires () => this.provider.beginAtomicBatch?.() — THE SEAM UNDER TEST
  - packages/quereus-store/src/common/store-table.ts                  # STATS_FLUSH_INTERVAL = 100; stats flush is a deferred __stats__-only rw tx
difficulty: medium
----

# E2E DML integration test for the within-table atomic commit path

## Goal

Close the last unverified link in the atomic multi-store commit feature: prove
that real DML (`insert`/`update`/`delete`) driven through the **store module's
public SQL surface** on an `IndexedDBProvider`-backed indexed table routes the
table's data store + its secondary-index store through **one** native IDB
`readwrite` transaction, not a per-store loop.

Both halves are already unit-covered (coordinator's atomic-vs-fallback branch in
`quereus-store/test/transaction.spec.ts`; provider's `beginAtomicBatch` in
`quereus-plugin-indexeddb/test/atomic-batch.spec.ts`). The seam between them —
`StoreModule.getCoordinator` passing `() => this.provider.beginAtomicBatch?.()`
into the coordinator — is covered only by typecheck. This test executes it.

## Where it lives

New file: `packages/quereus-plugin-indexeddb/test/atomic-dml.spec.ts`, run by the
package's existing Mocha harness (`yarn workspace @quereus/plugin-indexeddb test`,
or the repo-root `yarn test`). Use `chai` + `import 'fake-indexeddb/auto'`.

Set up exactly like `rename-persistence.spec.ts`: a real `Database`, a plain
`new StoreModule(provider)` (NOT the isolated module — we want the direct
coordinator path), `createIndexedDBProvider({ databaseName })`, registered as
`store`. Reuse its `rows()` / `objectStores()` helpers and its `afterEach`
teardown (`mod.closeAll()` + `IndexedDBManager.resetInstance(name)` +
`indexedDB.deleteDatabase(name)`). Compute store names with `buildDataStoreName` /
`buildIndexStoreName` from `@quereus/store` rather than hardcoding
`main.t` / `main.t_idx_ix_b`.

## The load-bearing assertion: one transaction, spanning both stores

A test that only checks final visibility would pass on the fallback path too, so
it would not exercise the new code. The real assertion is the **shape of the
commit**: exactly one `readwrite` transaction whose object-store set contains
**both** the data store and the index store.

### Spy seam — patch `IDBDatabase.prototype.transaction`

Do NOT capture a single `db` instance and patch its `transaction`: the manager
**replaces** `this.db` on every version upgrade (`doUpgrade` /
`doDeleteObjectStore` / `doRenameObjectStores` close and reopen), so an
instance-level patch goes stale the moment a new object store is created. Patch
the **prototype** instead — one patch point that survives every reopen:

```ts
// Obtain a live db to reach the fake-indexeddb FDBDatabase prototype.
const db = await provider.getManager().ensureOpen();
const proto = Object.getPrototypeOf(db) as IDBDatabase;
const orig = proto.transaction;

interface TxRecord { mode: IDBTransactionMode; stores: string[]; }
let recording = false;
const log: TxRecord[] = [];

proto.transaction = function (this: IDBDatabase, names: string | string[], mode?: IDBTransactionMode, opts?: IDBTransactionOptions) {
  const resolvedMode = mode ?? 'readonly';
  if (recording && resolvedMode === 'readwrite') {
    log.push({ mode: resolvedMode, stores: Array.isArray(names) ? [...names] : [names] });
  }
  // Forward verbatim — preserve the optional durability options bag (store.ts openWriteTx).
  return opts === undefined ? orig.call(this, names, resolvedMode) : orig.call(this, names, resolvedMode, opts);
} as typeof proto.transaction;
```

Restore `proto.transaction = orig` in `afterEach` (wrap the body so a failing
assertion still restores). `recording` is flipped on only around the single
`db.exec(...)` under test, so DDL/catalog/warmup traffic outside the window is
ignored.

### Determinism — warm up the stores OUTSIDE the recording window

Object stores are created lazily, and creating one triggers a version-upgrade
reopen (`ensureObjectStore` → `doUpgrade`). Those upgrades are `indexedDB.open`
calls, **not** `db.transaction` calls, so they never appear in the spy — but to
keep the recorded window to just the commit, materialize both stores first:

```
create table t (id integer primary key, b integer) using store;
create index ix_b on t (b);
insert into t values (1, 10);   -- warmup: materializes main.t AND main.t_idx_ix_b
```

Run all of the above with `recording = false`. By the time recording starts, both
object stores exist and the commit under test is a pure
`db.transaction([main.t, main.t_idx_ix_b], 'readwrite')`.

### Robust assertion (tolerant of incidental noise)

Filter the recorded `readwrite` txns to those touching the data store and/or the
index store (drop any `__stats__`-only / `__catalog__`-only tx), then assert:

```ts
const data = buildDataStoreName('main', 't');
const index = buildIndexStoreName('main', 't', 'ix_b');
const relevant = log.filter(t => t.stores.includes(data) || t.stores.includes(index));

expect(relevant, 'exactly one rw tx for the data+index commit').to.have.length(1);
expect(relevant[0].stores).to.include.members([data, index]); // atomic: both in ONE tx
```

On the fallback path this would instead record two single-store rw txns, failing
the length check — that is precisely the discrimination we need.

## Cases to cover (one recording window each)

- **insert** new indexed row (`insert into t values (2, 20)`) → one rw tx over
  `{data, index}`. Visibility: `select id from t where b = 20` returns `[{id:2}]`
  (data + index both committed and the index is usable).
- **update that moves the indexed value** (`update t set b = 11 where id = 1`) →
  old index entry deleted + new inserted + data row rewritten, all in one rw tx
  over `{data, index}`. Visibility: `where b = 11` returns the row; `where b = 10`
  returns none.
- **delete** (`delete from t where id = 1`) → data delete + index delete in one rw
  tx over `{data, index}`. Visibility: row gone from both a full scan and an
  index-backed `where b = …`.

## Fallback control (proves the spy actually discriminates)

Add one test that forces the fallback path and asserts the OPPOSITE shape, so the
suite fails loudly if the spy ever stops distinguishing the paths (e.g. someone
makes the assertion vacuous). Force fallback by stubbing the factory to yield
nothing — temporarily replace `provider.beginAtomicBatch` with `() => undefined`
for that test (restore after), or stand up a second provider/db whose
`beginAtomicBatch` is overridden. Then assert: **two** rw txns, each single-store
(`{data}` and `{index}` separately). Final visibility must still hold (fallback is
correct, just not atomic) — which is exactly why visibility alone is insufficient.

## Edge cases & interactions

- **db instance replacement on upgrade** — covered by prototype-level patching;
  do not patch a captured instance. A regression here would make the spy silently
  miss the commit tx (recording `length === 0`), so keep the warmup that ensures
  no upgrade occurs inside the window, and the `length === 1` assertion will catch
  a stale/missed patch.
- **Stats flush noise** — `STATS_FLUSH_INTERVAL = 100` and the flush is a deferred
  `queueMicrotask` writing only `__stats__`. With <100 mutations no flush fires;
  even if one did, the store-name filter drops a `__stats__`-only tx. Keep row
  counts small (single-digit) so this never approaches the threshold.
- **Catalog writes** — happen on DDL (`create table` / `create index`), all done
  before recording starts. No DDL inside a recording window ⇒ no `__catalog__` tx
  to filter, but the filter handles it regardless.
- **Readonly traffic** — constraint checks, `select`, `approximateCount`, and RYOW
  scans open `readonly` transactions; the `mode === 'readwrite'` guard excludes
  them. (A non-unique `ix_b` avoids extra uniqueness reads anyway.)
- **Durability options bag** — `IndexedDBStore.openWriteTx` may pass a third
  `{ durability: 'strict' }` arg; the spy must forward `opts` verbatim (see
  snippet) or those writes throw under fake-indexeddb.
- **CachedKVStore wrapper** — the atomic write bypasses the cache and the batch
  invalidates it (`IndexedDBAtomicBatch.write`). The post-commit visibility checks
  read through the same cached handles, so they also exercise RYOW-across-cache;
  no separate assertion needed, but don't disable caching (default on).
- **Restore on failure** — restore `proto.transaction` in `afterEach`
  unconditionally; a thrown assertion mid-test must not leave the global prototype
  patched for sibling specs.
- **Naming** — `buildIndexStoreName('main','t','ix_b')` ⇒ `main.t_idx_ix_b`; derive
  names, don't hardcode, so a convention change can't make the test silently pass.

## Out of scope

LevelDB has no `beginAtomicBatch` yet (`store-leveldb-shared-root`), so this test
targets IndexedDB only; the LevelDB fallback is already exercised by `test:store`.

## TODO

- Create `packages/quereus-plugin-indexeddb/test/atomic-dml.spec.ts`; copy the
  `Database` + `StoreModule` + provider setup, `rows()`/`objectStores()` helpers,
  and `afterEach` teardown from `rename-persistence.spec.ts`.
- Implement the prototype-level `transaction` spy with the `recording` flag and
  `afterEach` restore.
- Add the warmup (create table + index + first insert) before any recording.
- Write the three atomic cases (insert / update-moves-index / delete), each
  asserting one rw tx over `{data, index}` plus its visibility check.
- Add the fallback-control test asserting two single-store rw txns with
  `beginAtomicBatch` stubbed to `() => undefined`.
- Run `yarn workspace @quereus/plugin-indexeddb test` (and `yarn lint` in
  `packages/quereus` is unaffected — this file is outside it). Ensure the new spec
  passes and the existing `atomic-batch` / `rename-persistence` specs still pass.
