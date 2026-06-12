description: Review the resume-aware metadata clear in applySnapshotStream — a resumed snapshot apply now preserves CRDT metadata for tables the persisted checkpoint lists as completed, instead of blanket-clearing everything up front.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts            # clearExistingMetadata helper; header-driven clear + checkpoint lookup
  - packages/quereus-sync/src/metadata/keys.ts                   # parseTombstoneKey / parseChangeLogKey (used by the new helper)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts   # new resume-preservation regression test
  - docs/sync.md                                                 # applySnapshotStream doc comment now describes resume-aware clear
difficulty: medium
----

# Review: resumed snapshot stream no longer wipes completed-table metadata

## What changed

`applySnapshotStream` (`snapshot-stream.ts`) used to clear **all** CRDT metadata
(`cv:` column-versions, `tb:` tombstones, `cl:` change-log) in one blanket batch
at the very top of every apply. On a *resumed* transfer the sender skips
already-completed tables (`resumeSnapshotStream` → `streamSnapshotChunks` with
`completedTables`) and never re-emits their metadata — so the blanket clear wiped
completed tables' CRDT state and never rewrote it. Result: completed tables looked
empty to subsequent delta sync (`getChangesSince`) even though their row data was
still in the store → metadata/data divergence.

The fix makes the up-front clear **resume-aware**:

- **New private helper `clearExistingMetadata(ctx, preserveTables)`** (just above
  `applySnapshotStream`). Same three scans as before, but each entry's key is
  parsed (`parseColumnVersionKey` / `parseTombstoneKey` / `parseChangeLogKey`) and
  skipped from deletion when its `schema.table` is in `preserveTables`. With an
  empty set it deletes everything — byte-identical to the old fresh-apply behaviour.
- **Clear moved out of the pre-loop body into `case 'header'`**, where the
  `snapshotId` is known. It looks up the receiver's persisted checkpoint
  (`getSnapshotCheckpoint(ctx, snapshotId)`, key `sc:{snapshotId}`), and if present
  seeds `completedTables` / `tablesProcessed` / `entriesProcessed` from it, then
  clears while preserving `new Set(completedTables)`.
- `parseTombstoneKey`, `parseChangeLogKey` added to the existing keys import.
- `docs/sync.md` `applySnapshotStream` doc comment now documents the fresh-vs-resumed
  clear semantics.

**Why this is correct (the key invariant):** in the real resume path the *same*
receiver-saved checkpoint drives both sides — the sender's skip set
(`resumeSnapshotStream(checkpoint)`) and now the receiver's preserve set (header
lookup). Both read `checkpoint.completedTables`, so the set of tables the sender
omits is exactly the set the receiver preserves. No over- or under-preservation.

**No public API change.** `applySnapshotStream(chunks, onProgress?)` signature is
unchanged; the coordinator (`coordinator-service.ts:732`, single-arg call) and the
sync client are untouched. Per-table lazy clearing was rejected because `cl:` keys
are HLC-keyed (not table-prefixed), so per-`table-start` clearing would need a full
change-log scan per table (quadratic); the filtered up-front pass is O(metadata) as
before.

## Use cases / behaviours to validate

- **Resumed apply preserves the completed table, applies the re-streamed one.**
  Seed a `cv:` for `main.tableA`, persist a checkpoint listing `main.tableA`
  completed, then `applySnapshotStream` a resumed stream that omits tableA and sends
  only tableB. tableA's column version must survive; tableB's must be applied (both
  metadata and the store row). This is the new regression test
  (`store-adapter-seam.spec.ts` → "resumed snapshot stream preserves completed-table
  metadata"). **Verified it fails before the fix** (`expected undefined to exist`)
  and passes after.
- **Fresh full apply still replaces all local state.** No checkpoint → empty
  preserve set → blanket clear. Covered indirectly by every other snapshot-stream
  test (they use fresh snapshotIds with no prior checkpoint).
- **`sync-apply-per-change-errors-ignored` invariant intact.** An apply failure must
  still abort before the footer emits `status: 'synced'` and must retain the
  checkpoint. This change only touches the header/clear path — the footer /
  `flushDataToStore` / `throwIfApplyErrors` path is unchanged. The existing test
  "applySnapshotStream: an unresolvable table throws and never emits status synced"
  still passes (fresh snapshotId → empty preserve set → clears all → unchanged).

## Validation performed

- `yarn workspace @quereus/sync run build` — clean (tsc, exit 0).
- `yarn workspace @quereus/sync run test` — **184 passing** (was 183; +1 new test).
- Regression proof: temporarily forced the blanket clear (`new Set()`); the new test
  failed with `expected undefined to exist`. Reverted to `new Set(completedTables)`.
- Downstream blast radius (both consume the unchanged API): sync-coordinator
  **121 passing**, quereus-sync-client **45 passing**.
- Did **not** run the entire workspace `yarn test`; the change is isolated to
  quereus-sync internals with no signature change, and the two direct consumers are
  green. quereus-sync has no lint script.

## Known gaps / where to push (reviewer: treat the test as a floor)

- **Only `cv:` preservation is directly asserted.** `clearExistingMetadata` also
  preserves `tb:` (tombstones) and `cl:` (change-log) entries for completed tables,
  but the regression test seeds/asserts only a column version. The divergence
  assertion uses `getChangesSince(freshSite)` with **no `sinceHLC`**, which routes
  through `collectAllChanges` (scans `cv:` directly) — **not** the change-log. So the
  `cl:` and `tb:` preserve branches are implemented but **untested**. To close this,
  seed a tombstone and a change-log entry for `main.tableA` and assert they survive —
  ideally exercising the delta/change-log path via `getChangesSince(freshSite,
  sinceHLC)` so the `cl:` preservation is actually covered.
- **The test is a synthetic reconstruction, not a true interrupt→resume cycle.** It
  hand-builds the checkpoint and the resumed chunk stream rather than interrupting a
  real `applySnapshotStream` mid-flight and resuming with `resumeSnapshotStream`
  output. It faithfully reproduces the resulting state (checkpoint with
  `completedTables` + a stream that omits them) but does not drive the interrupt path
  itself. A higher-fidelity test would interrupt after a `table-end`+checkpoint-save,
  then feed `resumeSnapshotStream(checkpoint)` into `applySnapshotStream`.
- **Counter seeding is unasserted.** `tablesProcessed`/`entriesProcessed` are seeded
  from the checkpoint so mid-stream checkpoint saves stay monotonic and progress
  reflects the full transfer, but the test asserts neither the `onProgress` values
  nor mid-stream checkpoint contents. Low risk; worth a targeted assertion if the
  reviewer wants to lock the progress/monotonicity behaviour.
- **`totalEntries` in progress undercounts on resume.** It accumulates from
  `table-start.estimatedEntries`, which the streamer always sets to 0, and on resume
  only the re-streamed tables contribute. Pre-existing (not introduced here) and out
  of scope — noted for awareness.
