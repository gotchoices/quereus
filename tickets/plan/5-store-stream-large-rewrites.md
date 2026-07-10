description: Large-table maintenance in the persistent store (building an index, changing a primary key, rewriting a column) currently loads the whole table into memory at once; design a streaming approach that bounds memory without losing crash-safety.
prereq: store-altertable-decompose
files:
  - packages/quereus-store/src/common/store-module.ts   # buildIndexEntries (~1013-1081)
  - packages/quereus-store/src/common/store-table.ts     # mapRowsAtIndex (~558-575), rekeyRows (~600-660)
difficulty: hard
----

# Store: stream large table rewrites instead of buffering the whole table

Three maintenance operations in the store package each materialize the entire
table (or its entire index image) in memory before writing a single batch:

- **`StoreModule.buildIndexEntries`** (`store-module.ts` ~1013): iterates the
  data rows with `for await`, but pushes every computed index entry into one
  `indexStore.batch()` and only calls `batch.write()` after the last row. Drives
  `CREATE INDEX` and the post-ALTER index rebuild. Peak memory ≈ the whole index.
- **`StoreTable.mapRowsAtIndex`** (`store-table.ts` ~558): one `store.batch()`
  accumulating every rewritten row before `batch.write()`. Drives ALTER COLUMN
  SET DATA TYPE / SET NOT NULL backfill.
- **`StoreTable.rekeyRows`** (`store-table.ts` ~600): builds a
  `Map<string, {newKey, oldKey, row}>` holding **every row's full payload** for
  two-pass collision detection, then writes one batch. Drives ALTER PRIMARY KEY
  and SET COLLATE on a PK member. Peak memory ≈ the whole table, twice over
  (payload in the map + batch).

For a large table this is an unbounded memory spike. The goal is to bound it.

## The design question this ticket must resolve

Chunked flushing (write every N entries/bytes, then start a fresh batch) bounds
memory **but changes the failure semantics**, and the three operations do not
share the same safety story:

1. **`buildIndexEntries` for `CREATE INDEX`** writes into a *freshly created*
   index store. If the operation throws partway, the correct recovery is to tear
   down the whole new index store — so a partially-written index is not a
   correctness hazard **provided `createIndex` actually cleans up its index store
   on failure**. Confirm that cleanup exists (or add it) before relying on it.
   This is the low-risk, high-value case and likely the bulk of the win.

2. **`buildIndexEntries` for the post-ALTER rebuild** (`rebuildSecondaryIndexes`)
   clears and repopulates an *existing* index. A chunked partial write leaves a
   half-rebuilt index. Need to know whether the surrounding ALTER already runs
   inside a recoverable envelope (it runs after `ddlCommitPendingOps`, outside
   the coordinator) or whether clear-then-stream needs its own guard.

3. **`mapRowsAtIndex` / `rekeyRows`** rewrite the **live data store in place**. A
   chunked partial write here is *silent corruption* — some rows migrated, some
   not, no marker. These cannot be naively chunk-flushed. Options to weigh:
   - keep them single-batch (accept the memory cost) but drop the peak: e.g.
     `rekeyRows` pass 1 can track only new-key *signatures* for collision
     detection instead of full row payloads, then pass 2 re-scans the store to
     write — halving peak, still one atomic batch;
   - lean on a provider-level large-atomic-batch capability if one exists
     (`beginAtomicBatch`?) so a big write stays atomic without holding it all in
     JS heap;
   - a write-ahead / journal recovery path (heavier; probably out of scope).

**The plan's job is to settle which operations get chunked streaming and which
keep atomic single-batch (with a reduced peak), and to specify the batch-size
control and the failure/cleanup path for each.** Do not hand the implementer an
under-specified "make it stream" — the atomicity call per operation is the
substance.

## Likely output shape

Probably one or two implement tickets:
- an implement ticket for the **safe streaming subset** (CREATE-INDEX chunked
  flush + `buildIndexEntries` batch-size control), which is mostly mechanical
  once the cleanup-on-failure guarantee is confirmed; plus
- either a second implement ticket or a `backlog/debt-` item for the **in-place
  rewrite** peak reduction / atomicity story, depending on how heavy the safe
  option turns out to be.

Park anything that needs a provider-capability change or a journal/recovery
mechanism in `backlog/` rather than growing the first implement ticket.

## Research checklist

- Does `createIndex` tear down the new index store when `buildIndexEntries`
  throws? (Determines whether CREATE-INDEX chunking is safe as-is.)
- Do any `KVStore` providers expose a bounded-memory or streaming batch, or a
  large-atomic-batch, beyond `batch()` + `write()`? Check `kv-store.ts`,
  `beginAtomicBatch`, and the LevelDB/IndexedDB providers.
- What batch-size knob fits (entry count vs. serialized byte budget)? Is there an
  existing store config to hang it on, or does it need a new option/constant?
- Confirm the ALTER rewrite envelope: after `ddlCommitPendingOps`, is there any
  rollback path that would recover a partial in-place rewrite, or is single-batch
  atomicity the only thing protecting `rekeyRows` today?

## Key tests a later implement pass should carry

- CREATE INDEX over a table larger than one batch produces a **complete** index
  (every row indexed) and identical query results to the buffered path.
- A CREATE INDEX forced to fail mid-stream leaves **no** partial index store
  (cleanup verified) and the table still queryable.
- ALTER PRIMARY KEY / SET COLLATE on a large table still rejects a collision
  all-or-nothing (no partial re-key) — the current `rekeyRows` guarantee must
  survive whatever peak-reduction is chosen.
- A memory ceiling / batch-count assertion (e.g. spy on `batch.write()` call
  count) proving the streamed path flushes in bounded chunks rather than once.

## Notes

Chained after `store-altertable-decompose` because the `alterColumn` / PK arms
call `rekeyRows` / `mapRowsAtIndex` / `buildIndexEntries`; designing (and later
implementing) against the decomposed arms avoids re-touching the same
`store-module.ts` region twice.
