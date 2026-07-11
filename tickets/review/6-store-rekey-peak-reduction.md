description: A table primary-key change in the persistent store used to hold two full copies of the table in memory; it now holds one copy plus a small set of key fingerprints, while staying all-or-nothing.
files:
  - packages/quereus-store/src/common/store-table.ts   # rekeyRows (~577-660)
  - packages/quereus-store/test/alter-table.spec.ts     # new all-or-nothing + SET COLLATE tests
difficulty: medium
----

# Review: halve `rekeyRows` peak memory, keep single-batch atomic

## What changed

`StoreTable.rekeyRows` (`store-table.ts`) re-keys every row under a new
primary-key definition — it drives `ALTER PRIMARY KEY` and `ALTER COLUMN … SET
COLLATE` on a PK member. It used to be a two-pass design that held the whole
table **twice**: pass 1 filled a `Map<hex, {newKey, oldKey, row}>` (every row's
full payload), pass 2 drained that map into one write batch. Peak ≈ two full
tables.

Now:

- **Pass 1** iterates once, computes each row's new key, and keeps only a
  `Set<string>` of hex key *signatures* for collision detection. No rows, no old
  keys retained. On a repeat signature it throws `CONSTRAINT`
  (`StatusCode.CONSTRAINT`, message unchanged) before pass 2 writes anything.
- **Pass 2** re-scans the same committed store, recomputes each new key via the
  same helper (`computeNewKey`, so a collision judged in pass 1 is byte-identical
  to the key pass 2 writes), and batches `delete(oldKey)` + `put(newKey, row)`
  for rows whose key actually moves. One `batch.write()` at the end — still a
  single atomic batch.

Peak ≈ one full table (the batch) + a set of key-signature strings, instead of
~two full tables. Cost: O(rows) extra CPU for the second iterate + recompute.

**The single `batch.write()` is still the only thing making the re-key
all-or-nothing** — it was not chunk-flushed and must not be. The residual
single-batch peak (the batch still holds every changed row) is out of scope,
tracked in `debt-store-atomic-batch-bounded-memory`.

## Why the re-scan is safe

Pass 1 and pass 2 iterate the SAME `buildFullScanBounds()` over the SAME committed
store and must see identical rows. Nothing writes between them: the ALTER is
single-threaded, runs outside the coordinator, and every caller
(`StoreModule.alterPrimaryKey` arm, and the SET-COLLATE-on-PK arm) already ran
`ddlCommitPendingOps` so "committed" is "everything live". This is an
assumption, not something a test can enforce given the single-threaded ALTER path
— call it out if you disagree with the reasoning.

## How to validate

`cd C:/projects/quereus` then:

- `yarn workspace @quereus/store test` — full store suite (**948 passing**).
  Note the workspace is `@quereus/store`, NOT `@quereus/quereus-store` (the
  ticket's original name was wrong).
- `yarn workspace @quereus/store typecheck` — clean.
- `yarn lint` — clean (store has no real lint; only `packages/quereus` does, and
  this change does not touch it).

Targeted specs exercising the change (`packages/quereus-store/test/`):

- `alter-table.spec.ts` › **ALTER PRIMARY KEY**
  - existing: re-keys empty / populated table, rejects a colliding re-key,
    rebuilds secondary indexes.
  - **new**: *"leaves EVERY row at its original key when a re-key collides (no
    partial re-key)"* — 5 rows, a collision on one new key, asserts the FULL
    ordered row set is byte-for-byte unchanged and still keyed by the original
    PK. This is the guarantee the refactor must not break.
- `alter-table.spec.ts` › **ALTER COLUMN SET COLLATE on a PK member** (new
  describe)
  - **new**: *"rejects all-or-nothing when the coarser collation collapses two
    distinct PKs"* — `'A'`/`'a'` under BINARY→NOCASE collide; both rows survive
    unchanged after rejection.
  - **new**: *"re-keys every row under the new collation when there is no
    collision"* — succeeds, every row present under the new NOCASE key.
- `any-json-pk-binary-key.spec.ts` › *"re-keys an `any` PK to the same BINARY
  bytes across `alter column … set collate`"* — the no-op re-key case (an `any`
  PK pins BINARY regardless of declared collation); still green.

## Known gaps / things to probe

- **No memory assertion.** The peak-halving claim rests on code inspection
  (a `Set<string>` of signatures vs a `Map` of full rows), not on a
  memory-profiling test — there is no such harness in this package. Correctness
  and atomicity are what the tests cover. If you want a guard, a spec that counts
  bytes buffered is possible but was judged out of scope.
- **InMemoryKVStore only.** The suite uses the in-memory provider. `rekeyRows` is
  store-agnostic (only `KVStore.iterate` / `batch`), so the LevelDB path
  (`yarn test:store`, slower) was not run here. Worth a spot-check if you doubt
  the iterate/batch contract holds identically on a real backend.
- **Tripwire (parked, not a ticket):** pass 2 deserializes then re-serializes
  each changed row; the value is unchanged, so `serializeRow(row)` reproduces
  `entry.value` byte-for-byte. Reusing `entry.value` would skip the re-serialize,
  but risks retaining an iterator-owned buffer in the batch. Left as a `NOTE:`
  comment at the exact site in `rekeyRows` pass 2 — revisit only if re-key CPU
  ever shows up hot.

## Review findings

- Refactored `rekeyRows` to signatures-only pass 1 + re-scan pass 2; net peak
  drops from ~two tables to one table + a signature set. Atomicity preserved
  (single `batch.write()` untouched).
- Added the all-or-nothing "no partial re-key" ALTER PRIMARY KEY test and two
  SET-COLLATE-on-PK tests (collision-rejects / no-collision-succeeds). The `any`-PK
  BINARY no-op case stays green.
- Tripwire parked as a `NOTE:` comment in `rekeyRows` pass 2 (re-serialize vs
  reuse `entry.value`); no ticket filed.
- Residual single-batch peak intentionally left; tracked in
  `debt-store-atomic-batch-bounded-memory`.
