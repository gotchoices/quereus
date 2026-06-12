description: Review the fix that makes sync consumers honor ApplyToStoreResult.errors — per-change storage failures now abort the apply (emit error + throw) with NO CRDT metadata committed, instead of being silently ignored while metadata committed for the failed change.
files:
  - packages/quereus-sync/src/sync/sync-context.ts             # NEW throwIfApplyErrors helper (alongside toError)
  - packages/quereus-sync/src/sync/change-applicator.ts        # phase 2 captures result; throwIfApplyErrors before phase 3
  - packages/quereus-sync/src/sync/snapshot.ts                 # applySnapshot captures result; throws before clear/rewrite metadata
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # flushDataToStore captures result; throws before footer emits 'synced'
  - packages/quereus-sync/src/sync/store-adapter.ts            # UNCHANGED (read for context — still collects per-change errors)
  - packages/quereus-sync/src/sync/protocol.ts                 # UNCHANGED (ApplyToStoreResult.errors contract kept)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts # NEW describe block: 3 tests (applyChanges / applySnapshot / applySnapshotStream)
  - docs/sync.md                                               # write-ordering invariant updated; stale "metadata-first" status corrected
difficulty: medium
----

# Review: sync apply must not commit CRDT metadata for per-change storage failures

## What changed and why

`ApplyToStoreCallback` returns `ApplyToStoreResult { dataChangesApplied, schemaChangesApplied, errors }`.
The store adapter deliberately **continues applying other tables** when one fails,
recording each failed change in `result.errors` (it does not throw) — so the maximal
set of resolvable rows reaches committed storage, and only the genuinely-failed subset
is reported back.

Before this fix, all three consumers **discarded that return value** and committed CRDT
metadata (column versions / tombstones / change-log) for *all* resolved changes — including
the failed ones. Result: local HLC/column-version metadata claimed the failed change was
applied, so delta sync never re-fetched it → row data permanently missing on that replica.
This violated the write-ordering invariant in `docs/sync.md` (metadata must not be committed
when the data write did not land).

**Chosen fix (per the implement ticket):** treat any non-empty `result.errors` **identically
to the existing whole-batch throw path** — emit `status: 'error'` and throw, committing **no**
CRDT metadata. NOT per-change exclusion (commit good subset, skip bad), because peer re-fetch
is governed by a single `lastSyncHLC` watermark that cannot express a per-change gap.

### Shape of the change

- **`sync-context.ts`** — new `throwIfApplyErrors(ctx, result)` helper (next to `toError`):
  no-op when `result.errors` is empty; otherwise aggregates the failed changes into one
  `Error` (message lists `schema.table (type): <error>` for each; `cause` = first error),
  emits `{ status: 'error', error }`, and throws.
- **`change-applicator.ts`** — phase 2 now captures the `ApplyToStoreResult` (typed, not
  evolving-any) and calls `throwIfApplyErrors` after a clean return, **before** phase 3
  (`commitChangeMetadata`), the schema-migration record loop, remote-change events, and
  `persistHLCState`. The pre-existing thrown-error catch path is unchanged.
- **`snapshot.ts`** — `applySnapshot` captures the phase-2 result and throws **before** the
  clear/rewrite metadata batches, leaving prior metadata intact (snapshot retries wholesale).
- **`snapshot-stream.ts`** — `flushDataToStore` captures each result and throws, aborting the
  stream **before** the `footer` case emits `status: 'synced'` / clears the checkpoint.

The adapter (`store-adapter.ts`) and the `ApplyToStoreResult.errors` contract (`protocol.ts`)
are intentionally unchanged — the adapter's continue-and-collect behavior maximizes idempotent
storage progress; the *consumer* aggregates into a single throw.

## Validation performed

- `yarn workspace @quereus/sync typecheck` → clean (EXIT 0).
- `yarn workspace @quereus/sync test` → **183 passing** (was passing before + 3 new). The
  `[Sync] Error handling data change: ... batch write failed` / `iterate failed` lines in the
  log are deliberate fault-injection from the pre-existing `sync-manager.spec.ts`, not failures.
- New tests confirmed individually via spec reporter: all 3 pass.

### New tests (`store-adapter-seam.spec.ts` → `describe('per-change apply errors abort …')`)

All three drive a failure via an **unresolvable table** (`no_such_table` not created), which
the adapter records in `result.errors` (the inverse of the existing adapter-level "partial
failure" test, which asserts the adapter itself does NOT throw):

1. **`applyChanges`** — a change set with a change to existing `t` and one to `no_such_table`
   throws (error contains `no_such_table`); `getChangesSince(generateSiteId())` relays **0**
   changes (whole batch uncommitted). Then create `no_such_table`, re-apply the **same** change
   set → succeeds (`applied === 2`), both changes now relayable (convergence on idempotent retry).
2. **`applySnapshot`** — a snapshot whose only table is `no_such_table` throws; no column-version
   metadata committed (`getChangesSince` relays 0).
3. **`applySnapshotStream`** — a chunk stream for `no_such_table` throws; subscribed sync states
   **include `error`** and **exclude `synced`**; no metadata committed.

I confirmed (by reasoning, not by running a reverted build) that each test genuinely fails
without the fix: without `throwIfApplyErrors`, (1) commits metadata for both and returns normally,
(2) clears+rewrites metadata, (3) emits `synced` — each contradicts an assertion.

## Known gaps / things for the reviewer to scrutinize (tests are a floor)

- **Failure mode coverage is narrow.** All three tests trigger the `errors` path via
  *table-not-found*. They do **not** exercise a per-change failure that originates inside a
  table's `applyExternalRowChanges` (the adapter catches per-table and records *all* that
  table's changes as errors — worth a confirming test). The commit-time *seam throw* (whole-batch)
  is already covered by the existing "seam-throw propagation" test; my change does not alter it.
- **snapshot-stream writes metadata before the per-table data flush.** Within a large table,
  column-version metadata is committed during `column-versions` chunk processing (flushed at
  `BATCH_FLUSH_SIZE=1000`), *before* that table's rows are flushed to the store at `table-end`.
  So a data-flush failure can leave **provisional metadata** in the sync KV for an already-streamed
  table. This is tolerated by the existing design: `applySnapshotStream` unconditionally **clears
  all metadata at the start**, `synced` is never emitted, and the checkpoint stays — so a full
  retry re-clears and rewrites. My fix only adds the abort-before-`synced`; it does **not**
  reorder metadata/data within the stream (out of scope per the ticket). My test uses a single
  row, so it flushes at the footer and never exercises a mid-stream metadata flush — **a >1000-row
  table whose data fails is untested.** Reviewer: confirm the "clear-on-retry" recovery is
  actually sound, or flag a fix ticket.
- **Resume + clear interaction (PRE-EXISTING, out of scope).** `resumeSnapshotStream` skips
  `completedTables`, but `applySnapshotStream` clears *all* metadata at the top — so a resumed
  transfer appears to wipe completed-table metadata then skip re-emitting it. This bug exists
  independent of this change (it predates it and is unrelated to error handling). Not touched
  here; mention only so it isn't mistaken for a regression. Consider a separate fix/backlog ticket.
- **Poison batch** (a change that *always* fails blocks its whole batch forever) is an accepted,
  documented property of the throw path — consistent with the pre-existing seam-throw behavior,
  not a regression.
- **Error aggregation detail** is asserted only loosely (`String(thrown)` contains `no_such_table`).
  The `cause` chain and multi-error message format are not directly asserted.

## Docs

`docs/sync.md` § Transactional Integrity / Write Order updated: added an explicit
"metadata follows a landed data write" invariant covering **both** whole-batch throws and
per-change `ApplyToStoreResult.errors` (via `throwIfApplyErrors`), documented why selective
commit is unsafe under the single-watermark peer model, and **corrected the stale
"⚠️ current implementation writes metadata first" status line** (the code is data-first).
Reviewer: sanity-check the prose against the code.
