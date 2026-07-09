description: Added the end-to-end test that writes a very large integer primary key and reads it back through a range query against the store module's SQL path — the test was deferred until large-integer keys could be written at all, which was fixed earlier.
files:
  - packages/quereus-store/test/pushdown.spec.ts   # new describe block: "bigint primary key range seek (debt-bigint-pk-store-range-seek-test)"
  - packages/quereus-store/test/encoding.spec.ts   # unchanged; unit-level proof this test builds on
  - packages/quereus/src/util/key-tuple-codec.ts   # unchanged; the change-log codec that unblocked bigint PKs
difficulty: easy
----

## What was done

Replaced the deferred-test `NOTE` comment in
`packages/quereus-store/test/pushdown.spec.ts` (inside the "numeric primary key
mixed int/real range seek" describe block) with a new sibling describe block:
**`bigint primary key range seek (debt-bigint-pk-store-range-seek-test)`**,
containing two tests:

1. **`range seek over a bigint PK matches the memory-vtab oracle, in order, with
   exact values`** — creates a table with an `integer primary key` twice: once
   `using store`, once with the default in-memory vtab (the existing
   memory-vtab-as-oracle pattern already used elsewhere in this file for the
   blob-PK and numeric-PK regression tests). Inserts four rows: `id` = 1, 2,
   `2^53+1` (`9007199254740993n`), and `2^53+2`. Runs
   `select id, v from <table> where id >= 9007199254740993 order by id` against
   both tables and asserts the store's rows deep-equal the oracle's, and that
   `typeof storeRows[0].id === 'bigint'` (a lossy `number` cast would have
   collapsed `2^53+1` and `2^53+2` to the same double).
2. **`the range seek uses the index-seek path, not a full scan`** — same seed,
   asserts via `query_plan(...)` that the plan op is `INDEXSEEK` (not a
   full-scan + residual filter), consistent with the `planOps` pattern already
   used by the sibling PK-range describe blocks in this file.

## Why this closes the ticket

The write-side crash (`serializeKeyTuple` → `canonicalJsonString` →
`JSON.stringify` throwing on a bigint PK) was already fixed under
`txn-changelog-bigint-key`, proven at the unit level in
`packages/quereus/test/incremental/txn-bigint-key.spec.ts`. The store's
byte-level encoding of large integers (sort order + exact round-trip across the
2^53 boundary) was already proven at the unit level in `encoding.spec.ts`. This
ticket adds the missing link: an actual `INSERT` → range-`SELECT` through
`StoreModule`/`StoreTable`'s real code path (predicate pushdown, PK range-bound
construction, KV iteration, row decode) for a bigint PK — exercising the same
`buildPKRangeBounds` / index-seek machinery the neighboring collation/DESC/blob/
numeric regression tests in this file already cover for other PK shapes.

## Validation for the reviewer

- `cd packages/quereus-store && yarn test --grep "bigint primary key range seek"`
  → 2 passing.
- Full package suite: `cd packages/quereus-store && yarn test` → 797 passing, 0
  failing (pre-existing stderr noise in the run — `[StoreModule] Failed to
  rehydrate DDL entry...`, `[TransactionCoordinator] rollback-to savepoint...`,
  etc. — comes from *other, unrelated* tests in the suite that deliberately
  exercise error/warning paths; verified by grep that none reference this
  ticket's new table names (`bigstore`, `bigstore2`, `bigmem`) or describe
  block).
- `npx tsc --noEmit` against the edited file directly (the package's own
  `tsconfig.json` excludes `test/` from its `typecheck` script, so the normal
  `yarn typecheck` does not type-check spec files) — clean, no errors.

## Known gaps / things the reviewer may want to weigh

- **Not run against a real LevelDB backing.** Like every other `using store`
  test in this file, the "store" path here uses the in-memory `KVStoreProvider`
  wired up at the top of the spec (`InMemoryKVStore` / `createInMemoryProvider`)
  — it exercises `StoreModule`/`StoreTable`'s real encoding, planning, and
  seek logic, but not the LevelDB storage plugin itself. That matches the
  existing convention for every sibling PK-shape test in this file (blob PK,
  numeric mixed int/real PK, collation PK, DESC PK), so it is consistent, not a
  new gap — flagging in case the reviewer expected a literal
  `quereus-plugin-leveldb`-backed run per the ticket's "persistent (LevelDB)
  storage path" wording.
- Only one large value pair (`2^53+1`, `2^53+2`) is exercised, seeded alongside
  two small ordinary values (1, 2) per the ticket's ask ("plus a couple of
  ordinary small values"). Negative bigints, and a bigint PK on a DESC or
  composite (multi-column) key, are not covered here — out of scope per the
  ticket, which asked specifically for the single-column ASC boundary case.
- No new tripwires identified; this was a pure gap-closing test, no production
  code changed.
