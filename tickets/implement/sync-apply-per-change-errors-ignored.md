description: change-applicator (and snapshot apply paths) ignore ApplyToStoreResult.errors — CRDT metadata commits for changes whose storage apply failed, so failed data is never re-fetched. Fix: treat any per-change error like the existing whole-batch throw (commit no metadata, throw → whole batch re-resolves and re-applies idempotently).
files:
  - packages/quereus-sync/src/sync/change-applicator.ts      # phase 2 discards applyToStore result; phase 3 commits metadata for ALL resolved changes
  - packages/quereus-sync/src/sync/snapshot.ts                # applySnapshot discards result, then clears+rewrites metadata unconditionally
  - packages/quereus-sync/src/sync/snapshot-stream.ts         # flushDataToStore discards result; metadata batches commit + footer emits 'synced'
  - packages/quereus-sync/src/sync/protocol.ts                # ApplyToStoreResult.errors contract (kept — adapter still needs it to apply other tables idempotently before surfacing)
  - packages/quereus-sync/src/sync/store-adapter.ts           # populates result.errors per table/schema change (NO change needed; read for context)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts # add per-change-error coverage here (mirrors existing 'seam-throw propagation' + 'partial failure' blocks)
  - docs/sync.md                                              # write-ordering invariant (lines ~139-155); note per-change error handling
difficulty: medium
----

# Sync apply: per-change storage errors must not commit their CRDT metadata

## Root cause (confirmed by repro)

`ApplyToStoreCallback` returns `ApplyToStoreResult { dataChangesApplied, schemaChangesApplied, errors }`.
The store adapter (`store-adapter.ts`) deliberately **continues applying other
tables** when one table's storage apply fails, recording each failed change in
`result.errors` per table (and per schema change) rather than throwing — so the
maximal set of resolvable rows reaches committed storage + the seam, and only
the genuinely-failed subset is reported back.

Every consumer of the callback **discards that return value**:

- `change-applicator.ts` phase 2 (`await ctx.applyToStore(...)`) ignores the
  result; phase 3 (`commitChangeMetadata`) + the schema-migration loop then
  commit CRDT metadata (column versions / tombstones / change-log / migration
  records) for **all** resolved changes, including the failed ones.
- `snapshot.ts` `applySnapshot` ignores the result, then unconditionally clears
  and rewrites all CRDT metadata.
- `snapshot-stream.ts` `flushDataToStore` ignores the result; metadata batches
  are written as chunks stream and the footer emits `status: 'synced'`.

**Consequence:** local column-version/HLC metadata claims the failed changes
were applied, so delta sync never re-fetches them — the row data is permanently
missing on this replica until some later change happens to touch the same
columns. This violates the write-ordering invariant documented in
`docs/sync.md` (§ "data first, metadata second" — metadata must NOT be
committed when the corresponding data write did not land).

### Reproduced

A change set carrying a change for an existing table `t` and a change for a
non-existent table `no_such_table`, applied via `SyncManagerImpl.applyChanges`:
the adapter records one error (no_such_table), applies `t` to storage — but
`getChangesSince(otherSite)` then relays **both** `t` and `no_such_table`,
proving `no_such_table`'s metadata was committed despite its storage apply
failing. (Repro built on the `store-adapter-seam.spec.ts` harness; confirmed
failing against current `main`.)

## Chosen fix: per-change error ⇒ whole-batch throw (commit no metadata)

Treat any non-empty `result.errors` **identically to the existing whole-batch
throw path** — emit `status: 'error'` and throw, committing **no** CRDT
metadata for that invocation. Do NOT attempt per-change exclusion (commit the
good subset, skip the bad).

### Why not per-change recovery (commit succeeded, skip failed)?

`applyChanges` does **not** advance any per-peer watermark — peer re-fetch is
governed by a single `lastSyncHLC` watermark per peer (`PeerStateStore`,
advanced separately by the caller via `updatePeerSyncState`). A batch's changes
span multiple HLCs. If we commit some changes from a batch and skip others, the
single watermark cannot express the gap: once the caller advances `lastSyncHLC`
past the batch, the skipped (failed) changes are never re-sent. So selective
commit is unsafe given the current peer-state model.

Throwing keeps the partial-failure path **identical** to the whole-batch throw
that is already proven correct by `store-adapter-seam.spec.ts` §
"seam-throw propagation through the sync layer":

- Storage rows for the resolvable tables stay applied (trust-the-origin
  posture); the adapter already wrote them.
- No CRDT metadata committed ⇒ caller treats it as a failed sync attempt ⇒
  does not advance `lastSyncHLC` ⇒ the whole batch is re-sent next attempt.
- Re-application is idempotent: value-identical upserts are suppressed by
  `applyExternalRowChanges`, so converged tables do no redundant store/seam
  work; only the previously-failed change is genuinely retried, and on success
  the whole batch's metadata commits.

Poison-batch behavior (a change that always fails blocks its whole batch
forever) is already an accepted, documented property of the seam-throw path —
this fix is consistent with it, not a regression.

### Keep `ApplyToStoreResult.errors`

Do **not** drop `errors` / make the adapter throw on first failure. The
adapter's continue-and-collect behavior is intentional: it maximizes idempotent
storage progress (all resolvable tables land before the failure is surfaced),
which means less work on retry. The *consumer* aggregates `errors` into a single
throw; the adapter stays as-is.

## Implementation shape

### change-applicator.ts (`applyChanges`)

Phase 2 currently:

```ts
if (ctx.applyToStore && (dataChangesToApply.length > 0 || schemaChangesToApply.length > 0)) {
  try {
    await ctx.applyToStore(dataChangesToApply, schemaChangesToApply, { remote: true });
  } catch (error) {
    ctx.syncEvents.emitSyncStateChange({ status: 'error', error: toError(error) });
    throw error;
  }
}
```

Capture the result and, after a clean (non-throwing) return, treat a non-empty
`errors` array the same way as the catch: emit `status: 'error'` and throw
before phase 3 runs. Factor the error-emit-and-throw into a small local helper so
the thrown-error and per-change-error paths share it. The thrown error should
carry the failed-change details (e.g. aggregate `result.errors` into the error
message / cause) so the UI/log is actionable. Phase 3 (`commitChangeMetadata`),
the schema-migration record loop, remote-change event emission, and
`persistHLCState` must all be skipped when this fires — i.e. throw before
reaching line ~127.

### snapshot.ts (`applySnapshot`)

After the phase-2 `await ctx.applyToStore(...)` call (line ~162) and **before**
the clear/rewrite metadata batches (line ~166 onward), check the returned
`result.errors`; if non-empty, emit `status: 'error'` and throw. This leaves the
prior metadata intact and the snapshot retries wholesale (idempotent on the
store side). `applyToStore` is currently called as a bare statement — capture
its return.

### snapshot-stream.ts (`applySnapshotStream`)

`flushDataToStore` (line ~255) is called repeatedly as chunks stream. Capture
each `applyToStore` return and throw on non-empty `errors` from inside
`flushDataToStore`, so the stream aborts before the `footer` case emits
`status: 'synced'` / clears the checkpoint. (Aborting mid-stream leaves the
checkpoint in place and sync state not `synced`, so the transfer resumes/retries
— consistent with any other mid-stream failure.) Consider emitting
`status: 'error'` on the throw for parity with the other paths.

### Shared helper (optional, DRY)

The three sites all need "if `result.errors.length`, emit error + throw with the
failed changes attached." A tiny shared helper in `sync-context.ts` (alongside
`toError`) — e.g. `throwIfApplyErrors(ctx, result)` — keeps them DRY. Use
judgement; inline is acceptable if a helper feels forced.

## Tests

Add to `packages/quereus-sync/test/sync/store-adapter-seam.spec.ts` (it already
has the `SyncManagerImpl` + in-memory provider harness and both a "partial
failure" adapter test and a "seam-throw propagation" sync-layer test to mirror):

- **change-applicator per-change error ⇒ no metadata committed.** Apply a change
  set with a change to an existing table `t` and a change to `no_such_table`
  via `syncManager.applyChanges`; expect it to **throw** (carrying the failed
  change), and `getChangesSince(generateSiteId())` to relay **nothing**
  (neither `t` nor `no_such_table`) — the whole batch is uncommitted. Then
  create `no_such_table`, re-apply the same change set, expect success and both
  changes now relayable (convergence on retry). This is the direct analogue of
  the existing seam-throw test and the inverse of the adapter-level "partial
  failure" test (which asserts the adapter itself does NOT throw).
- **snapshot.ts:** `applySnapshot` with a snapshot whose data targets an
  unresolvable table throws and leaves no committed column-version metadata
  (e.g. `getChangesSince` empty / pre-existing metadata untouched).
- **snapshot-stream.ts:** `applySnapshotStream` over a chunk stream whose data
  fails to apply throws and never emits `status: 'synced'` (subscribe to
  `syncEvents` and assert no `synced` state; assert checkpoint not cleared if
  convenient).

## Docs

Update `docs/sync.md` § write-ordering (around lines 139-155): the invariant
"metadata must not be committed when the data write did not land" now explicitly
covers **per-change** storage failures, not just whole-batch throws — any
`ApplyToStoreResult.errors` aborts the apply with no metadata committed, and the
batch re-resolves on the next sync. (Note: the stale "⚠️ current implementation
writes metadata first" status line at ~155 contradicts the actual data-first /
metadata-second code — correct it while editing if low-cost, otherwise leave a
focused note.)

## TODO

- change-applicator.ts: capture phase-2 `ApplyToStoreResult`; on non-empty
  `errors`, emit `status: 'error'` and throw (with failed-change detail) before
  phase 3 / schema-migration records / remote-change events / `persistHLCState`.
- snapshot.ts: capture `applySnapshot`'s phase-2 result; throw on non-empty
  `errors` before clearing/rewriting metadata.
- snapshot-stream.ts: capture each `flushDataToStore` result; throw on non-empty
  `errors` before the footer emits `synced`.
- Optional: extract a shared `throwIfApplyErrors(ctx, result)` helper in
  sync-context.ts; otherwise inline consistently.
- Add the three tests above to store-adapter-seam.spec.ts.
- Update docs/sync.md write-ordering section.
- Run `yarn workspace @quereus/sync test` (and `yarn workspace @quereus/sync typecheck`); fix regressions.
