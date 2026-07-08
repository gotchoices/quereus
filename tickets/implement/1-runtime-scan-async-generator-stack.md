----
description: Reading rows from an in-memory table wraps the already-in-memory data in several stacked background-task layers, so every row pays a promise round-trip per layer for no reason; make the scan run synchronously and add the async wrapper only once.
files: packages/quereus/src/vtab/memory/layer/safe-iterate.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/runtime/emit/scan.ts
difficulty: medium
----

## Problem (confirmed by reading the code)

A sequential scan of a memory table currently stacks **five** async generators
between the backing BTree and the row consumer. The BTree (`inheritree`) is
**fully synchronous**, yet each async layer forces a resolved-promise microtask
per row per layer:

```
emitSeqScan.run   (async*)   scan.ts:57      ← genuinely async (cancellation, rowSlot, connect/disconnect)
  → table.query   (async*)   table.ts:232    ← async only because of `await ensureConnection()` at entry
    → manager.scanLayer (async*) manager.ts:2626  ← `yield* scanLayerImpl(...)`, no async work of its own
      → scanLayerImpl (async*) scan-layer.ts:25   ← all per-row work (filter, early-term) is SYNC
        → safeIterate (async*) safe-iterate.ts:7  ← iterates a SYNC BTree
          → BTree              (sync)
```

Everything from `scanLayerImpl` down is synchronous: `tree.get`, `tree.find`,
`tree.at`, `tree.moveNext`, `compareSqlValues`, `planAppliesToKey`,
`primaryKeyExtractorFromRow`, `encodePk`, `getSortedPrimaryKeys` — no `await`
anywhere. Proof the BTree is sync: `runtime/emit/async-gather.ts:193` walks it
with a plain `first()` / `moveNext()` loop (no `safeIterate`, no await).

So four of the five async boundaries exist only because a generator was declared
`async function*` out of habit. On a large scan that is 3-4 extra promise
microtasks **per row** buying nothing.

## Fix direction

Make the sync part of the stack sync, and introduce the async boundary exactly
once — at `table.query()`, which is unavoidably async because it must
`await this.ensureConnection()` before scanning.

Target stack after the fix:

```
emitSeqScan.run   (async*)   ← unchanged; per-row cancel checkpoint + rowSlot live here
  → table.query   (async*)   ← awaits connection ONCE, then `yield*` a sync generator
    → scanLayerSync (sync*)  ← sync
      → safeIterate (sync*)  ← sync
        → BTree     (sync)
```

Two async layers instead of five. `manager.scanLayer` stays as an `async*`
wrapper for its **external** callers (tests, `module.scanEffective`,
backing-host) so their `AsyncIterable<Row>` contract is unchanged — it just
delegates to the sync impl.

### Why correctness is preserved

- **Mutation-safety** (`safeIterate` path-reopen on `!tree.isValid`): logic is
  byte-for-byte unchanged, only the `async` keyword drops. All BTree ops it
  calls are already sync.
- **MVCC layer stack:** `scanLayerImpl` operates on a *single* `Layer`; data
  inheritance across base/transaction layers is handled inside the inherited
  BTree, not by async recursion here. The `table.ts:248` comment "handles layer
  recursion" is about that BTree inheritance, not about async fan-out — nothing
  is lost by going sync.
- **Halloween protection / cancellation:** `throwIfAborted(runtimeCtx.signal)`
  stays in `emitSeqScan.run` and still fires **per row**, because every row
  still crosses the one remaining async boundary (`query` → `emitSeqScan`),
  which yields to the event loop between rows. A sync `scanLayerImpl` does *not*
  starve the loop — it produces one row per outer `next()`, and the outer
  consumer is still async. (NOTE this in a comment at the cancel checkpoint so a
  future reader doesn't "restore" a redundant inner checkpoint.)
- **Multi-seek dedup, multi-range, descending seek-start, NOCASE prefix
  early-termination:** all pure-sync logic, unchanged.

## TODO

- **`safe-iterate.ts`** — change `export async function* safeIterate(...):
  AsyncIterable<TValue>` → `export function* safeIterate(...):
  Iterable<TValue>`. Body unchanged (all ops already sync). `moveNearest`
  untouched.

- **`scan-layer.ts`** — change `export async function* scanLayer(...):
  AsyncIterable<Row>` → `export function* scanLayer(...): Iterable<Row>`.
  - Multi-seek branch: `for await (const row of scanLayer(layer, singlePlan))`
    → `for (const row of ...)`.
  - Multi-range branch: `yield* scanLayer(layer, singlePlan)` — already
    delegation, leave as-is (now sync→sync).
  - Primary branch: `for await (const value of safeIterate(...))` →
    `for (const value of ...)`.
  - Secondary branch: `for await (const indexEntry of safeIterate(...))` →
    `for (const indexEntry of ...)`.

- **`manager.ts`** — two internal consumers of `scanLayerImpl` become sync
  iteration:
  - `delete-by-prefix` arm (~line 1461): `for await (const row of
    scanLayerImpl(layer, scanPlan))` → `for (const row of ...)`.
  - `replace-all` arm (~line 1487): `for await (const row of
    scanLayerImpl(layer, { indexName: 'primary', descending: false }))` →
    `for (const row of ...)`.
  - Add a sync accessor and keep the async wrapper delegating to it:
    ```ts
    /** Sync scan — the hot path (query()/internal maintenance) avoids the async hop. */
    public scanLayerSync(layer: Layer, plan: ScanPlan): Iterable<Row> {
        return scanLayerImpl(layer, plan);
    }
    /** Async adapter for external AsyncIterable<Row> callers (tests, module.scanEffective). */
    public async* scanLayer(layer: Layer, plan: ScanPlan): AsyncIterable<Row> {
        yield* this.scanLayerSync(layer, plan);
    }
    ```

- **`table.ts`** — in `query()`, replace
  `for await (const row of this.manager.scanLayer(startLayer, plan)) { yield row; }`
  with `yield* this.manager.scanLayerSync(startLayer, plan);`. `query` remains
  `async*` (it still awaits `ensureConnection`) — this is the sole sync→async
  boundary in the select hot path.

- **`scan.ts`** — no structural change. Confirm the per-row
  `throwIfAborted(runtimeCtx.signal)` stays. Add a one-line `// NOTE:` that this
  is now the *only* per-row cancellation checkpoint on the memory-scan path (the
  inner layers went sync), so it must not be removed.

- **Type ripple:** `for await` over the now-sync iterables in the two `.spec`
  files that call `scanLayer` directly (`scan-layer-descending.spec.ts`,
  `maintenance-prefix-delete.spec.ts`, `maintenance-replace-all.spec.ts`) still
  compiles — `for await` accepts sync iterables and those tests go through the
  async `manager.scanLayer` wrapper anyway. Leave them; do not churn.

## Validation

- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p
  tsconfig.test.json` — catches the AsyncIterable→Iterable signature drift at
  every call site, including specs).
- `yarn test` — full memory-backed logic suite. Pay attention to:
  - `test/vtab/scan-layer-descending.spec.ts` (seek-start correctness),
  - `test/vtab/maintenance-prefix-delete.spec.ts` and
    `maintenance-replace-all.spec.ts` (internal `scanLayerImpl` consumers),
  - `test/optimizer/secondary-index-access.spec.ts` (multi-seek dedup / NOCASE),
  - cancellation/timeout tests (verify per-row abort still interrupts a scan).
- Sanity-measure the win: a large single-table `select *` should drop from ~4
  promise microtasks/row to ~1. A quick micro-bench (count microtasks or wall
  time over a 100k-row memory table scan) is enough to confirm the round-trips
  fell; not required to land, but note the before/after in the review handoff.

## Notes for the reviewer

- The ~60 duplicated lines flagged in `scan-layer.ts` (the near-identical
  early-termination blocks in the primary vs secondary branches, lines
  ~134-168 and ~231-271) are tracked by a separate smaller-cleanups ticket.
  Collapsing the wrappers here does **not** subsume that — the duplication is in
  the per-row filter logic, orthogonal to the sync/async change. Keep this
  ticket's scope to the async→sync collapse; do not fold in the dedup unless it
  falls out naturally.
- `manager.scanLayer` (async) is retained deliberately for external callers —
  do not delete it thinking it is now dead; `module.scanEffective`, the
  backing-host, and several `test/vtab/*.spec.ts` files consume its
  `AsyncIterable<Row>`.
