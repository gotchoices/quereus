description: The memory-table scan path used to stack five async generators over an already-in-memory BTree, paying a promise round-trip per row per layer; the inner layers were made synchronous so the async boundary is introduced only once. Reviewed and completed.
files: packages/quereus/src/vtab/memory/layer/safe-iterate.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/src/runtime/emit/scan.ts, packages/quereus/test/exec-eval-abort-signal.spec.ts
----

## What shipped

Collapsed the memory-scan async-generator stack from **five** async layers to
**two**. `safeIterate`, `scanLayer`, and the `manager.scanLayerSync` hot path are
now synchronous generators over the (synchronous) `inheritree` BTree; the single
remaining async boundary is `table.query()`, which must `await ensureConnection()`
once before scanning. Per-row cancellation still crosses that boundary via the
`emitSeqScan` checkpoint, so a memory query still aborts promptly mid-stream.

See the implement commit (`git show 5e750b8e`) for the full edit rationale.

## Review findings

**Overall: change is sound.** Async→sync collapse is behavior-preserving; all
async consumers retained; no correctness or type-safety regression. lint EXIT=0,
`yarn test` EXIT=0 (quereus 6500 passing; every workspace green).

### Checked — correctness
- **Consumer audit of the retained async `manager.scanLayer`.** Callers:
  `module.ts` `scanEffective` (backing-host, returns `AsyncIterable<Row>`) and
  the `maintenance-prefix-delete` / `maintenance-replace-all` / `scan-layer-descending`
  spec files. All still consume it as an async iterable — correctly retained, not
  dead code. Nothing external imported the now-sync free `scanLayer`/`safeIterate`
  expecting async.
- **No stray `await`/`async`** left in `scan-layer.ts` or `safe-iterate.ts` (grep
  clean). Multi-seek recursion, both `safeIterate` loops, and the multi-range
  `yield*` are all sync→sync.
- **Early-break / cleanup.** The sync generators carry no `try/finally` or held
  resources; consumer `break` triggers plain generator `return()` — no leak. The
  async adapter's `yield*` propagates return to the sync iterator correctly.
- **Interleaving semantics.** `table.query()` remains `async*` and `yield*`s the
  sync scan, so every row still crosses one microtask boundary at the query
  level — the per-row scheduling window is preserved (only the redundant *inner*
  hops were removed). `module.ts` already documents that writes must not
  interleave with reads on one connection, so no isolation regression.
- **Docs.** `docs/materialized-views.md` references `scanLayer`'s `equalityPrefix`
  seek/early-termination semantics only — unchanged by async→sync. No doc update
  needed. `docs/review.html` is generated; ignored.

### Checked — cancellation (the invariant this change rests on)
The implement handoff flagged that no test asserts a memory scan aborts
mid-stream *after* the inner layers went sync. Investigated: the existing
`exec-eval-abort-signal.spec.ts` mid-stream test uses `select ... order by id`,
which buffers through a **Sort** — the scan leaf drains fully before the abort
fires, so it does **not** exercise `scan.ts:111` (the now-sole per-row scan
checkpoint) directly.

- **Fixed inline (minor — test coverage):** added
  `'interrupts an unbuffered memory scan mid-stream (scan-leaf checkpoint, no Sort)'`
  to `exec-eval-abort-signal.spec.ts` — a Sort-free `select id from t` that aborts
  after 2 rows and asserts `seen === [1, 2]` + `AbortError`/`StatusCode.ABORT`.
  This pins the exact checkpoint the async→sync collapse depends on, guarding
  against a future "remove the checkpoint" or "make query sync" regression.
  Test passes; lint (incl. tsc test typecheck) green.

### Tripwire (parked, not a ticket)
- `scan.ts:108-111` carries the implementer's `// NOTE:` that this is the only
  per-row cancellation checkpoint on the memory-scan path (inner layers went
  sync) — must not be removed, and `table.query` must not be made synchronous
  without relocating cancellation. Recorded at the site per tripwire policy; the
  new test above now also enforces it.

### Not addressed (deliberately out of scope)
- **No micro-benchmark run.** The perf claim (~3 fewer promise microtasks/row on
  the select path) is argued structurally, not measured. Not a defect — the
  correctness suite is green. If someone wants the number substantiated, that
  measurement is still open. Left as-is; not worth blocking completion.
- **~60 duplicated lines in `scan-layer.ts`** (near-identical early-termination
  blocks in the primary vs secondary branches) are per-row *filter* logic,
  orthogonal to this async→sync change, and tracked by a separate cleanups
  ticket. Untouched here.
- **`for await` over now-sync generators in specs** (`scan-layer-descending.spec.ts`)
  is intentionally left unchurned — compiles and runs (async-iteration falls back
  to the sync iterator), lint accepts it. Reads slightly oddly but is not a defect.
