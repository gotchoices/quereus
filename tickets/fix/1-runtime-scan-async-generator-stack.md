----
description: Reading rows from an in-memory table routes each row through several stacked background-task layers even though the underlying data is already in memory, so scanning pays a heavy per-row cost for no reason.
files: packages/quereus/src/vtab/memory/layer/safe-iterate.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/runtime/emit/scan.ts
difficulty: medium
----
The memory virtual-table scan path stacks 3-5 async generators between the backing BTree and the row consumer, and every layer adds a promise round-trip per row even though the BTree itself is fully synchronous:

- `safe-iterate.ts:7` — `safeIterate` is declared `async function*` while iterating a synchronous BTree, so each `next()` is a resolved-promise hop.
- `scan-layer.ts:26` — `scanLayer` wraps `safeIterate` recursively, adding another layer.
- `table.ts:249` — `query()` re-yields with `for await … yield` instead of `yield*`, so it does not tail-delegate; it interposes its own generator round-trip per row.
- `runtime/emit/scan.ts:107` — `emitSeqScan` wraps the result again.

Expected behavior: a sequential scan over in-memory data should not pay a promise round-trip per row per layer. The synchronous nature of the BTree should be preserved as far up the stack as possible, with the async boundary introduced only once, at the point where the runtime genuinely requires an `AsyncIterable`.

Direction to investigate and validate: make `safeIterate` a synchronous generator (`function*`) over the BTree; adapt sync→async exactly once at the boundary where the scan result must satisfy the runtime's `AsyncIterable<Row>` contract; replace `for await … yield` re-yielding with `yield*` delegation everywhere in between (`scanLayer`, `query`, and any intermediate wrapper). Confirm MVCC layer-stack semantics, Halloween protection, and cancellation still hold, and that per-row allocation/round-trips measurably drop on a large scan. Note the ~60 duplicated lines flagged in `scan-layer.ts` (see the smaller-cleanups ticket) — collapsing the wrappers here may subsume that.
