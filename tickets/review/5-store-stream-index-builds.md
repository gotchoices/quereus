description: Building a table index in the persistent store now flushes to disk in bounded chunks instead of holding the whole index in memory, and a failed CREATE INDEX now cleans up the half-built index instead of leaving an orphan directory behind.
files:
  - packages/quereus-store/src/common/store-module.ts        # DEFAULT_MAX_BATCH_BYTES + resolveMaxBatchBytes (~117-155), StoreModuleConfig.maxBatchBytes (~110), parseConfig (~3240), connect vtabArgs (~615), createIndex try/catch teardown (~905-951), buildIndexEntries chunked flush + seen NOTE (~1084-1186), rebuildSecondaryIndexes clear-loop NOTE + budget (~1211-1229)
  - packages/quereus-store/src/common/store-table.ts         # StoreTableConfig.maxBatchBytes (~260)
  - packages/quereus-store/test/stream-index-build.spec.ts   # new spec (6 tests)
----

# Review: stream index builds in bounded chunks + clean up a failed CREATE INDEX

## What changed (and why it's safe)

`StoreModule.buildIndexEntries` previously accumulated **every** computed index
entry into one `indexStore.batch()` and wrote it once at the end — an unbounded
heap spike for a table larger than memory. It now flushes the batch and starts a
fresh one whenever the accumulated serialized key bytes cross a byte budget, with
a guaranteed final flush.

A secondary index is **derived state** (droppable + rebuildable from the data
store) and neither build caller was crash-atomic before, so chunked flushing adds
no new correctness hazard:

- **`createIndex`** writes a *freshly created* index store. Any build failure now
  tears the whole store down (new try/catch) — which also fixes a **pre-existing
  leak**: before this change a rejected `CREATE UNIQUE INDEX` over duplicated data
  (or any build throw) left the empty index-store directory behind, because
  `SchemaManager.createIndex` wraps the error but does no teardown.
- **`rebuildSecondaryIndexes`** (ALTER PRIMARY KEY / SET COLLATE on a PK member)
  was already non-atomic (separate clear-batch commit, then separate build). A
  chunked build leaves at worst a partial-but-recoverable index; re-running the
  rebuild (clear + rebuild is idempotent) restores it.

Both callers ITERATE the data store and WRITE the index store — different stores —
so a mid-stream flush to the index store never mutates the stream being read.
Safe on every provider.

### The knob

- `DEFAULT_MAX_BATCH_BYTES = 8 * 1024 * 1024` (8 MiB) module constant.
- Optional `max_batch_bytes` module arg → `StoreModuleConfig.maxBatchBytes` /
  `StoreTableConfig.maxBatchBytes`, parsed in `parseConfig` via
  `resolveMaxBatchBytes` (missing / non-numeric / **zero or negative** all clamp
  to the default — a bad arg must never *disable* flushing). A byte budget (not an
  entry count) is used because index entries vary in size.
- Threaded into `buildIndexEntries` as a new trailing param; both callers pass
  `table.getConfig().maxBatchBytes ?? DEFAULT_MAX_BATCH_BYTES`.
- Persists across close→reopen for free: it rides the ordinary `vtabArgs → DDL`
  path (`ddl-generator.formatUsingClause` emits every vtab arg), exactly like
  `collation`, so a rebuild after reopen uses the configured budget. (`connect`'s
  minimal-fallback path also copies it into `vtabArgs` for symmetry.)

## Use cases to validate / how to exercise

New spec: `packages/quereus-store/test/stream-index-build.spec.ts`. Run:

```
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-store/test/stream-index-build.spec.ts" --reporter spec
```

The spec uses a persistent in-memory provider that (a) traces each index store's
`WriteBatch.write()` — counting total flushes, value-bearing flushes, and total
puts — and (b) can inject a `write()` failure on the Nth flush of a named index
store. Cases:

1. **Chunked vs single-batch equivalence + bounded-memory proof** — same 40-row
   table built once with a tiny `max_batch_bytes` (many flushes) and once with a
   huge one (one flush). Asserts both index stores hold every row, the chunked
   build flushed **>1** value-bearing chunk while the single-batch build flushed
   exactly once, total puts == row count, and identical seek/range query results.
2. **Empty table** → the index store exists, holds zero entries, and the build
   still ran one final (empty) flush (`nonEmptyFlushes === 0`, `totalFlushes > 0`).
3. **Mid-stream build failure** (inject a throw on the 2nd flush) → the fresh
   index store is deleted (no orphan), the error surfaces, and the base table is
   untouched + queryable.
4. **Rejected `CREATE UNIQUE INDEX` over duplicated data** → the in-pass dup check
   throws, the index-store directory is gone (the leak fix), and the table is
   unchanged and still writable.
5. **ALTER COLUMN SET COLLATE on a text PK** (drives `rebuildSecondaryIndexes`)
   over a table larger than one batch → the rebuilt index returns identical
   results to the pre-ALTER index, entry count preserved, and the rebuild itself
   chunked (>1 value-bearing flush — trace reset in place before the ALTER).
6. **Malformed `max_batch_bytes = 0`** → clamped to the default, index still
   complete and correct.

Existing coverage that continues to pass: `index-persistence.spec.ts` (build vs
maintenance encoding agreement, partial/UNIQUE/desc/collate builds, rebuild after
SET COLLATE). Full `@quereus/store` suite: **944 passing**. `yarn lint`: clean.
Store `tsc --noEmit` (src): clean.

## Reviewer scrutiny / known gaps (this work is a floor, not a ceiling)

- **The new spec's provider is in-memory.** It proves flush *cadence* and cleanup
  *bookkeeping* (store present/absent in a map), not real per-provider durability
  or iterate-while-mutate behavior. It does **not** exercise LevelDB/IndexedDB.
  A reviewer wanting stronger evidence could add a store-path (`yarn test:store`)
  or LevelDB-provider case, but that is out of scope of a single implement pass.
- **`nonEmptyFlushes > 1` is an indirect memory proof.** It shows the batch was
  flushed and reset multiple times; it does not *measure* heap. That's the best a
  unit test can do without a memory probe — treat it as the intended signal, not
  a literal RSS assertion.
- **Two tripwires recorded as `NOTE:` code comments (not tickets):**
  - At the UNIQUE `seen` Set in `buildIndexEntries` — chunking bounds only the
    write batch, **not** this set, which holds one signature per distinct indexed
    key for the whole build. A very large UNIQUE index still spikes on it.
    Bounding it needs a sort- or store-probe-based dedup (separate design).
  - At the clear loop in `rebuildSecondaryIndexes` — the clear pass still buffers
    every existing index KEY into one batch (keys only, no values, so far smaller
    peak than the build). Left unbounded because chunking it safely is harder: it
    deletes from the same store it iterates, and mid-iteration flush semantics
    differ per provider (LevelDB snapshots its iterator; IndexedDB may not).
- **Pre-existing partial-ALTER hazard (NOT introduced here).** In
  `rebuildSecondaryIndexes`, by the time the rebuild runs the ALTER has already
  atomically re-keyed the data store and the schema is not yet updated. A crash
  mid-rebuild leaves a partial index; this window existed before this ticket (the
  clear + build were already two separate commits). Chunking does not widen it in
  kind — a partial index is recoverable by re-running the rebuild. Flagged so it
  is not mistaken for new breakage. Out of scope here.
- **Teardown is best-effort.** On a build failure the cleanup (`releaseIndexStore`
  + `deleteIndexStore`/`closeIndexStore`) is itself wrapped so a teardown throw
  logs (`console.warn`, matching the file's convention) rather than masking the
  original build error. Confirm the log/rethrow ordering reads correctly.
- **`getIndexStore` success is assumed before the try.** The try wraps only
  `buildIndexEntries`; if `getIndexStore` itself throws there is nothing this
  module created to tear down (that failure is the provider's to clean up). Worth
  a glance to confirm that's the intended boundary.

## Related tickets (no prereq/overlap issues)

- `store-rekey-peak-reduction` (rekeyRows peak halving) — different file
  (`store-table.ts`), independent.
- `debt-store-atomic-batch-bounded-memory` (backlog) — the irreducible
  single-batch peak on the in-place data rewrites, explicitly out of scope here.
