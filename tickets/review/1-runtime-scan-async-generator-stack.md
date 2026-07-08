description: The memory-table scan path used to stack five async generators over an already-in-memory BTree, paying a promise round-trip per row per layer; the inner layers were made synchronous so the async boundary is introduced only once.
files: packages/quereus/src/vtab/memory/layer/safe-iterate.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/runtime/emit/scan.ts
difficulty: medium
----

## What changed

Collapsed the memory-scan async-generator stack from **five** async layers to
**two**. The BTree (`inheritree`) and every per-row filter/early-term operation
below `table.query()` are fully synchronous, so four of the five async
boundaries existed only because generators were declared `async function*` out
of habit — each forced a resolved-promise microtask per row per layer.

Stack before:

```
emitSeqScan.run (async*) → table.query (async*) → manager.scanLayer (async*)
  → scanLayerImpl (async*) → safeIterate (async*) → BTree (sync)
```

Stack after:

```
emitSeqScan.run (async*) → table.query (async*)
  → manager.scanLayerSync (sync*) → scanLayer (sync*) → safeIterate (sync*) → BTree (sync)
```

The single async boundary that remains is `table.query()`, which is
unavoidably async because it must `await this.ensureConnection()` once before
scanning. Per-row cancellation still crosses that boundary, so it still yields
to the event loop between rows (see cancellation note below).

### Edits made

- **`safe-iterate.ts`** — `safeIterate` `async function* … AsyncIterable<TValue>`
  → `function* … Iterable<TValue>`. Body byte-for-byte unchanged (all BTree ops
  already sync). `moveNearest` untouched.
- **`scan-layer.ts`** — `scanLayer` `async function* … AsyncIterable<Row>` →
  `function* … Iterable<Row>`. Three `for await` → `for` (multi-seek recursion,
  primary `safeIterate`, secondary `safeIterate`). Multi-range `yield*` left as-is
  (already delegation, now sync→sync). All filter/early-term logic unchanged.
- **`manager.ts`** — added `scanLayerSync(layer, plan): Iterable<Row>` (the hot
  path); kept `async* scanLayer(...): AsyncIterable<Row>` delegating to it via
  `yield*` for external `AsyncIterable<Row>` callers. Two internal
  `scanLayerImpl` consumers (`delete-by-prefix`, `replace-all`) switched
  `for await` → `for`.
- **`table.ts`** — `query()` now `yield* this.manager.scanLayerSync(startLayer, plan)`
  instead of the `for await … scanLayer` loop. `query` stays `async*` (still
  awaits `ensureConnection`). Added a comment marking this the sole sync→async
  boundary on the path.
- **`scan.ts`** — no structural change. Added a `// NOTE:` at the per-row
  `throwIfAborted(runtimeCtx.signal)` checkpoint recording that it is now the
  *only* per-row cancellation checkpoint on the memory-scan path (inner layers
  went sync), so it must not be removed.

`manager.scanLayer` (async) is **retained deliberately** — `module.scanEffective`
(the backing-host) and several `test/vtab/*.spec.ts` files consume its
`AsyncIterable<Row>`. Not dead code.

## Validation done

- `yarn workspace @quereus/quereus run lint` → **EXIT 0** (eslint + `tsc -p
  tsconfig.test.json --noEmit`). The tsc pass type-checks the spec call sites,
  so the `AsyncIterable → Iterable` signature drift would have surfaced at every
  direct `scanLayer` caller including specs — it did not.
- `yarn test` → **EXIT 0**. Main quereus logic suite **6500 passing**, all
  workspaces green. No new failures.
  - The `failingKv.iterate` stack in the log at
    `quereus-sync/test/sync/sync-manager.spec.ts:1694` is a deliberate
    failing-KV mock inside a passing negative-path test — that suite reports 679
    passing, 0 failing. Not related to this change.

### Use cases the reviewer should exercise as the floor (not the ceiling)

- **Seek-start correctness** — `test/vtab/scan-layer-descending.spec.ts`. Imports
  the now-sync `scanLayer` directly and iterates it with `for await` (which
  accepts sync iterables). Covers the four `{isAscending}×{isDescFirstColumn}`
  combinations on both primary and secondary branches. Left unchurned per ticket.
- **Internal `scanLayerImpl` consumers** — `test/vtab/maintenance-prefix-delete.spec.ts`
  (integer + NOCASE-leading base PK) and `test/vtab/maintenance-replace-all.spec.ts`.
  These drive `delete-by-prefix` / `replace-all` which now iterate the sync impl.
- **Multi-seek dedup / NOCASE prefix early-termination** —
  `test/optimizer/secondary-index-access.spec.ts`.
- **Cancellation / timeout** — verify a per-row abort still interrupts a memory
  scan mid-stream (the sole remaining checkpoint is `scan.ts:111`).

## Known gaps / where to look hardest

- **No micro-benchmark was run.** The ticket flagged a sanity-measure
  (microtask count or wall time over a ~100k-row scan) as "note before/after,
  not required to land." I did **not** run it — the win is argued structurally
  (4 async hops → 1 on the select path, so ~3 fewer promise microtasks/row) and
  verified only by the passing correctness suite. If the reviewer wants the
  perf claim substantiated rather than reasoned, that measurement is still open.
- **Cancellation reasoning is by inspection, not by a targeted new test.** The
  claim "per-row abort still fires because every row still crosses the one
  remaining async boundary" rests on `scan.ts` yielding between rows. Existing
  cancellation/timeout tests pass, but none was added specifically to assert a
  memory scan aborts mid-stream *after* the inner layers went sync. If you want
  a regression guard against a future "restore the inner checkpoint" or "make
  query sync" change, that test is the gap.
- **`for await` over sync iterables in specs** — `scan-layer-descending.spec.ts`
  keeps `for await (const row of scanLayer(...))` against a now-sync generator.
  This compiles and runs (async-iteration protocol falls back to the sync
  iterator), and lint's tsc pass accepted it. It is intentionally left
  unchurned, but it now reads slightly oddly (a `for await` over something sync).
  Not a defect — flagging so it isn't mistaken for one.

## Review findings

- **Tripwire (parked as a code NOTE, not a ticket):** `scan.ts:108-111` now
  carries a `// NOTE:` that the per-row `throwIfAborted` is the *only* per-row
  cancellation checkpoint on the memory-scan path — a future reader must not
  delete it expecting an inner-layer checkpoint to cover the scan, and must not
  make `table.query` synchronous without relocating cancellation. Recorded at
  the exact site per tripwire policy.
- **Out of scope (do not fold in):** the ~60 duplicated lines in `scan-layer.ts`
  (near-identical early-termination blocks in the primary vs secondary branches,
  ~lines 134-168 and ~231-271) are per-row *filter* logic, orthogonal to this
  async→sync change, and tracked by a separate smaller-cleanups ticket. This
  ticket deliberately did not touch them.
