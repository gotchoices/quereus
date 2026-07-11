description: Building or rebuilding a table index in the persistent store currently holds the whole index in memory before writing it; change it to flush in bounded chunks so a large table does not spike memory, and make a failed CREATE INDEX clean up after itself.
prereq: store-altertable-decompose
files:
  - packages/quereus-store/src/common/store-module.ts   # buildIndexEntries (~1022-1100), createIndex (~828-919), rebuildSecondaryIndexes (~1119-1143), parseConfig (~3202)
  - packages/quereus-store/src/common/kv-store.ts        # WriteBatch, StoreModuleConfig shape
  - packages/quereus-store/test/                         # new spec(s)
difficulty: medium
----

# Store: stream index builds in bounded chunks + clean up a failed CREATE INDEX

`StoreModule.buildIndexEntries` (`store-module.ts` ~1022) accumulates **every**
computed index entry into one `indexStore.batch()` and only calls
`batch.write()` after the last data row. For a table larger than memory this is
an unbounded heap spike. Two callers drive it:

- **`createIndex`** (~828) — writes into a *freshly created* index store
  (`getIndexStore`, ~870), from the table's EFFECTIVE row stream.
- **`rebuildSecondaryIndexes`** (~1119) — clears then repopulates an *existing*
  index store, from the committed data stream. Runs on `ALTER PRIMARY KEY` and
  `ALTER COLUMN … SET COLLATE` on a PK member (the secondary-index keys embed the
  PK suffix, so they must be rebuilt when the PK key bytes change).

## Why chunking is safe for BOTH index-build callers

A secondary index is **derived state**: it can always be dropped and rebuilt
from the data store. Neither caller is crash-atomic today, so chunked flushing
introduces no new correctness hazard:

- **`rebuildSecondaryIndexes` is already non-atomic.** It commits a *separate*
  `clearBatch.write()` (~1133) and *then* a separate `buildIndexEntries` batch. A
  crash between the two already leaves an emptied index; a chunked build is no
  worse — a partial index is recoverable by re-running the rebuild (clear +
  rebuild is idempotent).
- **`createIndex` writes a fresh store**, so the correct recovery on any failure
  is to tear the whole store down — provided that teardown actually happens.
  **It does not today** (see below); adding it is part of this ticket and is what
  makes chunked CREATE INDEX safe.

The in-place data-store rewrites (`mapRowsAtIndex` / `rekeyRows` / `migrateRows`)
are a *different* story and are **out of scope here** — they stay single-batch
atomic. `rekeyRows` peak reduction is `store-rekey-peak-reduction`; the residual
single-batch peak on the data rewrites is `debt-store-atomic-batch-bounded-memory`.

## Confirmed: `createIndex` leaks its index store on failure

`createIndex` (~828-919) has **no** `try/catch` around `getIndexStore` +
`buildIndexEntries`. If `buildIndexEntries` throws — a UNIQUE violation, an IO
error, or (once chunked) a mid-stream flush failure — the index-store directory
created at ~870 is left behind, empty or half-written. `SchemaManager.createIndex`
wraps the error but does no teardown. So even *before* this ticket, a failed
`CREATE UNIQUE INDEX` over duplicated data leaks an empty index-store directory
(the in-pass dup check throws before `batch.write()`, so no content, but the
directory exists). Chunking would upgrade that to a half-written directory.

**Fix as part of this ticket:** wrap the build in `createIndex` so that on any
throw it releases and deletes the new index store, then rethrows. Mirror
`dropIndex`'s teardown (~979-988):

```
await table.releaseIndexStore(indexSchema.name);
if (this.provider.deleteIndexStore) {
    await this.provider.deleteIndexStore(schemaName, tableName, indexSchema.name);
} else {
    await this.provider.closeIndexStore(schemaName, tableName, indexSchema.name);
}
```

Guard the teardown itself against its own throw (best-effort, log) so it never
masks the original error.

## The batch-size knob

There is no batch-size config today — `parseConfig` (~3202) returns only
`{ collation }`. Add a **serialized-byte budget** (bounds heap directly; index
entries vary in size, so a byte budget bounds memory better than a fixed entry
count):

- New module constant `DEFAULT_MAX_BATCH_BYTES` (start `8 * 1024 * 1024` — 8 MiB;
  pick a value, document it inline).
- Optional override on `StoreModuleConfig` (e.g. `maxBatchBytes`), parsed from
  `vtabArgs` in `parseConfig` alongside `collation`. Keep it module-wide config,
  not per-index.
- In `buildIndexEntries`: after each `batch.put`, add `indexKey.length +
  dataKey.length` to a running counter; when it reaches the budget, `await
  batch.write()`, start a fresh `batch = indexStore.batch()`, reset the counter.
  Always do a final `batch.write()` for the residual (may be empty — providers
  accept an empty write).

Thread the budget into `buildIndexEntries` (new param, or read from the table
config the callers already hold — `table.getConfig()`).

## Edge cases & interactions

- **UNIQUE dedup `seen` Set is NOT bounded by chunking.** The in-pass uniqueness
  check (~1042) holds a `Set<string>` of every distinct index-key signature for
  the whole build. Chunking bounds the *write batch*, not this set — a huge
  UNIQUE index still spikes on the dedup set. This is inherent to in-pass
  uniqueness; do **not** try to fix it here. Record it as a `NOTE:` tripwire at
  the `seen` site (bounding it needs a sort- or store-probe-based approach, a
  separate design). Mention in the review findings.
- **Rebuild CLEAR pass also buffers** (~1129-1132): it collects every existing
  index key into one `clearBatch`. That holds only KEYS (no values), so its peak
  is far smaller than the value-bearing build pass — leave it buffered for now.
  Chunking it safely is harder: it deletes from the SAME store it iterates, so a
  mid-iteration flush risks iterate-while-mutate semantics that differ per
  provider (LevelDB snapshots its iterator; IndexedDB may not). Leave a `NOTE:`
  tripwire at the clear loop (if the index key set ever dominates memory, chunk
  the clear with a snapshot-safe re-seek). Mention in review findings.
- **Fresh vs. existing store, different iteration source:** both callers ITERATE
  the data store and WRITE the index store — different stores, so mid-iteration
  flushes to the index store never mutate the stream being read. Safe on all
  providers.
- **Mid-stream flush failure in `createIndex`** → the new cleanup tears down the
  whole (partial) index store; the table stays queryable.
- **Mid-stream failure in `rebuildSecondaryIndexes`** → the index is left partial
  but recoverable (re-run the rebuild). Note that the ALTER has *already* rekeyed
  the data store atomically at this point and the schema is not yet updated — a
  pre-existing (not introduced by this ticket) partial-ALTER hazard; do not fix
  here, but note it in review findings so it is not mistaken for new breakage.
- **Empty table:** zero rows → zero mid-stream flushes → one final (empty)
  `batch.write()`. Must still produce a valid empty index.
- **Config parse:** a missing / malformed `maxBatchBytes` in `vtabArgs` falls
  back to the default constant; a zero or negative value must not disable
  flushing (clamp to the default or a sane floor).

## TODO

- Add `DEFAULT_MAX_BATCH_BYTES` constant and `maxBatchBytes` to `StoreModuleConfig`;
  parse it in `parseConfig` (clamp non-positive to the default).
- Rewrite `buildIndexEntries` to flush on the byte budget and reset the batch,
  with a guaranteed final flush. Add the `NOTE:` tripwire at the `seen` Set.
- Wrap `createIndex`'s `getIndexStore` + `buildIndexEntries` in try/catch that
  releases + deletes the new index store on throw (best-effort teardown, rethrow
  original). This also fixes the existing empty-directory leak on a rejected
  `CREATE UNIQUE INDEX`.
- Add the `NOTE:` tripwire at the `rebuildSecondaryIndexes` clear loop.
- Tests (new spec under `packages/quereus-store/test/`):
  - CREATE INDEX over a table larger than one batch → the index is COMPLETE
    (every row indexed) and query results match the single-batch behavior. Set a
    small `maxBatchBytes` (via CREATE TABLE `using store (max_batch_bytes = …)` or
    the config path) so a modest row count crosses several batches.
  - Spy on `WriteBatch.write()` (wrap the provider's `batch()`): assert the build
    flushed in **multiple** bounded chunks, not once — the bounded-memory proof.
  - CREATE INDEX forced to fail mid-stream (inject an error, e.g. a provider whose
    index-store `batch.write()` throws on the 2nd flush, or a value the encoder
    rejects) → **no** index store remains (cleanup verified) and the table is
    still queryable.
  - Rejected `CREATE UNIQUE INDEX` over duplicated data → no leftover index-store
    directory (the leak fix), and the table is unchanged.
  - ALTER PRIMARY KEY on a table larger than one batch → the rebuilt secondary
    index returns identical results to the pre-ALTER index (rebuild completeness
    across chunks).
- Run `yarn workspace @quereus/quereus-store test` (and `yarn lint`), streaming
  output with `tee`.

## Notes

`store-rekey-peak-reduction` (the `rekeyRows` peak halving) and this ticket touch
DIFFERENT files (`store-table.ts` vs `store-module.ts`) and are independent — no
`prereq` between them. `debt-store-atomic-batch-bounded-memory` (backlog) covers
the irreducible single-batch peak on the in-place data rewrites.
