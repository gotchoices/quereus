description: Rewrote the LevelDB backend so a whole database lives in one physical store (not a folder per table), enabling crash-safe single-commit writes. Reviewed and accepted.
files:
  - packages/quereus-plugin-leveldb/src/store.ts
  - packages/quereus-plugin-leveldb/src/provider.ts
  - packages/quereus-plugin-leveldb/src/plugin.ts
  - packages/quereus-plugin-leveldb/package.json
  - packages/quereus-plugin-leveldb/README.md
  - packages/quereus-plugin-leveldb/test/atomic-batch.spec.ts
  - packages/quereus-plugin-leveldb/test/sibling-collision.spec.ts
  - packages/quereus-plugin-leveldb/test/shared-root.spec.ts   # NEW (review): encoding + closed-handle eviction + clear isolation
  - packages/quereus-plugin-leveldb/test/store.spec.ts
----

# Complete: LevelDB shared-root layout + atomic batch

## Summary

The LevelDB backend was rewritten from **one `ClassicLevel` per table/index** to
**one physical LevelDB at `basePath` with one sublevel per logical store**. Because
every sublevel shares one physical store, a single chained batch commits across a
table's data + every secondary index atomically and durably — the crash-safe single
commit (`beginAtomicBatch`) that the prior per-directory layout could not provide.
Hard cutover, no on-disk migration (pre-1.0 dev data). `LevelDBStore` is dual-mode:
`open()` still opens a standalone physical DB (used by sync-coordinator / quereus-sync);
the provider uses `overSublevel()`. `syncCommits` (default true) fsyncs each commit.

The implementation was accepted. Review made minor fixes inline, added test coverage
for the two genuinely-new code paths, and filed one follow-up for unrelated engine
changes that rode in on the implement commit. Details below.

## Review findings

### Scope / aspect angles checked
Read the full implement diff (store.ts, provider.ts, plugin.ts, package.json, README,
atomic-batch + sibling-collision specs) **and** the four `packages/quereus/src/*`
engine files the commit also touched, plus the follow-on triage commit. Scrutinized
SRP, DRY, type safety, error handling, resource cleanup, performance, name-encoding
injectivity, sublevel-prefix isolation, rename atomicity, and the atomic-batch
lifecycle against the coordinator's per-commit usage.

### Verification run (all green)
- `@quereus/plugin-leveldb` tests: **30 passing** (26 original + 4 new), src typecheck clean.
- `@quereus/store` package tests: **637 passing**.
- `@quereus/quereus` **memory** mode: exit 0 (full suite, runs under `--bail`).
- `yarn lint` (eslint + `tsconfig.test.json` typecheck over quereus): clean.
- `51.7-maintained-table-attach-detach.sqllogic` under **store** mode: now **passing**
  — the prior-flagged failure was resolved by the triage commit `e367380d`
  (`store-module.ts` refreshes a connected `StoreTable`'s cached schema on
  `materialized_view_removed`, so a following structural ALTER no longer spreads the
  stale `derivation`). Confirmed backend-agnostic and outside this ticket's diff, as the
  handoff predicted.

### MINOR — fixed in this pass
- **Test gap for the two genuinely-new code paths.** The rewrite's new behaviors had
  no plugin-level coverage. Added `test/shared-root.spec.ts` (4 tests):
  - a table whose name needs sublevel-name encoding (spaces + non-ASCII `é`) round-trips
    data + an index-backed lookup (an unencoded name would throw on sublevel open) —
    this is the `encodeSublevelName` path the old fs layout never needed;
  - a distinct identifier differing only by an escaped byte (`a b` vs literal `a%20b`)
    stays distinct (injectivity, `%` self-escapes);
  - `DROP INDEX` → `CREATE INDEX` on the same name reopens the evicted closed handle
    (`getOrCreateStore` `isClosed()` eviction, design decision #3);
  - `DROP INDEX` clears only the index sublevel, leaving table rows intact
    (sublevel-prefix clear isolation).
- **Stale setting help text.** `package.json` `basePath` setting still read "Base
  directory for all LevelDB stores" (old per-directory framing). Updated to "Directory
  of the single shared LevelDB database" to match README/plugin docs.

### MINOR — documented, not fixed (low severity, acceptable)
- **`LevelDBAtomicBatch` chained-batch cleanup on the error path.** The chained batch is
  created in the constructor; if `put`/`delete` throws `MISUSE` (a handle not produced
  by this provider) before `write()`, the chained batch is neither written nor closed,
  so it leaks until GC. The `AtomicBatch` interface has no `close()`/abort, so the
  coordinator cannot release it either. Triggers **only** on a programming error
  (foreign/other-provider handle), which the new tests already prove throws `MISUSE`.
  Left as-is; flag for a future interface tidy if `AtomicBatch` ever grows an abort.
- **Rename destination-empty guard is incomplete on its own.** `renameTableStores`
  rejects a destination only when `sublevelHasAnyKey(dest)` is true, so an
  *empty-but-existing* sibling destination would not be caught by the provider alone.
  In practice the engine's `StoreModule` name-collision guard fires first (the rewritten
  sibling-collision RENAME test asserts the `main.u_idx_x` rejection). Defense-in-depth
  only — acceptable given the engine guard is authoritative.

### MAJOR — filed follow-up ticket (`mv-attach-discard-followup`, backlog)
The implement commit (`45619c26`) also committed four **unrelated** engine
materialized-view files — `core/database-materialized-views.ts`,
`runtime/emit/alter-table.ts`, `runtime/emit/materialized-view-helpers.ts`,
`vtab/module.ts` — which the handoff itself described as edits from a "concurrent
process." Two distinct changes ride in there:
  1. `tryResolveBackingHost` — a **live behavior change**: the MV replicable-derivation
     gate now resolves the backing host *leniently* (skips the gate when no host yet)
     instead of throwing. Exercised by the memory MV suite (passes), but it weakens a
     gate and was never reviewed under its own plan/implement cycle.
  2. `discardBackingForAttach` — a new optional `VirtualTableModule` method plus
     attach-failure wiring, with **no in-repo implementor** (the doc references lamina, a
     downstream module). Currently dead/no-op everywhere in this repo, untested here.
These compile, lint clean, and pass memory + store + store-package suites, so they are
**not reverted** (and reverting committed work is not this stage's job). Tracked in
backlog for proper review + in-repo test coverage of the lenient-gate change.

### Known gaps carried forward (from handoff — not regressions)
- No real crash / fault-injection test for the durability guarantee (validated for
  correctness — atomic multi-store landing + single `write()` — not by simulating power
  loss; not unit-testable here).
- `ALTER … RENAME TO` is **O(n)** in row count (one in-memory chained batch) vs the old
  O(1) fs-rename; inherent to sublevels (a prefix can't be renamed in place). Fine for
  tests; revisit with a streamed/chunked rewrite if large-table renames become a problem.
- `getStore` `options.path` override is silently dropped (no per-table path under one
  shared root); the engine never passed it, so engine behavior is unchanged.

## End
