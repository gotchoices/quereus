description: A resumed snapshot apply now preserves CRDT metadata for tables the persisted checkpoint lists as completed, instead of blanket-clearing all column-versions/tombstones/change-log up front. Reviewed and completed.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts            # clearExistingMetadata helper; header-driven resume-aware clear
  - packages/quereus-sync/src/metadata/keys.ts                   # parseTombstoneKey / parseChangeLogKey used by the helper
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts   # resume-preservation regression test (extended in review)
  - docs/sync.md                                                 # applySnapshotStream doc comment: fresh-vs-resumed clear semantics
difficulty: medium
----

# Resumed snapshot stream no longer wipes completed-table metadata

## What shipped

`applySnapshotStream` previously cleared **all** CRDT metadata (`cv:` column
versions, `tb:` tombstones, `cl:` change log) in one blanket batch at the top of
every apply. On a *resumed* transfer the sender skips already-completed tables
(`resumeSnapshotStream` → `streamSnapshotChunks` with `completedTables`) and never
re-emits their metadata, so the blanket clear wiped completed tables' CRDT state and
never rewrote it — leaving metadata/data divergence (the rows survived in the store
but delta sync saw the table as empty).

The fix:

- New private helper `clearExistingMetadata(ctx, preserveTables)` runs the same
  three scans, but parses each key (`parseColumnVersionKey` / `parseTombstoneKey` /
  `parseChangeLogKey`) and skips deletion when `schema.table` ∈ `preserveTables`. An
  empty set deletes everything — byte-identical to the old fresh-apply behaviour.
- The clear moved from the pre-loop body into `case 'header'`, where `snapshotId` is
  known. It looks up the receiver's persisted checkpoint
  (`getSnapshotCheckpoint(ctx, snapshotId)`), seeds `completedTables` /
  `tablesProcessed` / `entriesProcessed` from it, then clears while preserving
  `new Set(completedTables)`.
- `parseTombstoneKey` / `parseChangeLogKey` added to the keys import; `docs/sync.md`
  documents the fresh-vs-resumed semantics.

No public API change: `applySnapshotStream(chunks, onProgress?)` signature is
unchanged; coordinator and sync-client are untouched.

## Review findings

### Scope checked
Read the full implement diff with fresh eyes before the handoff summary: the
`clearExistingMetadata` helper and its three parse-and-filter scans, the relocated
header-time clear + counter seeding, the `keys.ts` parsers it depends on, the
footer/`flushDataToStore`/`throwIfApplyErrors` path it must not disturb, and the
real resume call chain across `quereus-sync` and `sync-coordinator`.

### Correctness — no defects found
- **Resume invariant verified against the live call path, not just the handoff
  claim.** The coordinator's `resumeSnapshotStream` is fed the client's checkpoint
  over the wire (`packages/sync-coordinator/src/server/websocket.ts:268` →
  `msg.checkpoint`), which drives the sender's skip set
  (`resumeSnapshotStream(checkpoint)` → `new Set(checkpoint.completedTables)`). The
  receiver's `applySnapshotStream` reads *its own persisted copy* of that same
  checkpoint (`getSnapshotCheckpoint(snapshotId)`) and preserves
  `new Set(completedTables)`. Both sides read `checkpoint.completedTables`, so the
  tables the sender omits are exactly the tables the receiver preserves — no over-
  or under-preservation.
- **Partial-table state cannot leak.** Mid-stream checkpoints are saved with
  `completedTables: [...completedTables]`, which only contains tables that emitted
  `table-end`. A table interrupted mid-stream is absent from the preserve set, so its
  partial metadata is wiped and the sender re-streams it in full. Correct.
- **Counter seeding is monotonic.** `tablesProcessed = completedTables.length` then
  `++` per `table-end`; `entriesProcessed` seeded from the checkpoint then `++` per
  entry. Header `tableCount` is the sender's *full* table set (counted before the
  skip loop in `streamSnapshotChunks`), so seeded `tablesProcessed` + re-streamed
  tables reconcile to `tableCount`.
- **Per-change-error invariant intact.** This change only touches the header/clear
  path; the footer never emits `status: 'synced'` if `flushDataToStore` →
  `throwIfApplyErrors` throws first. Existing test still green.
- **Parse-fail defaults to delete** (`if (parsed && preserveTables.has(...)) continue`
  — a null parse falls through to `clearBatch.delete`). Safe default: an
  unparseable/foreign key is never silently preserved.
- **Performance:** O(metadata) as before, plus a constant per-key parse (TextDecoder).
  Acceptable; per-table lazy clearing was correctly rejected because `cl:` keys are
  HLC-keyed, not table-prefixed, making per-`table-start` clearing quadratic.

### Findings fixed inline (minor)
- **`tb:` and `cl:` preserve branches were untested.** The implementer's regression
  test seeded/asserted only a `cv:` entry; the tombstone and change-log preserve
  branches of `clearExistingMetadata` ran but were never asserted. Extended
  `store-adapter-seam.spec.ts` → "resumed snapshot stream preserves completed-table
  metadata" to also seed a tombstone and a change-log entry for the completed
  `main.tableA` **and** for a non-completed `main.tableC`, then assert tableA's
  `tb:`/`cl:` state survives while tableC's is cleared. This exercises both the
  preserve (`continue`) and delete branches for all three metadata families and
  proves the filter is selective rather than a blanket skip. Verified meaningful:
  under the old `new Set()` blanket clear these assertions fail.

### Findings noted, not actioned (minor / pre-existing — no ticket filed)
- **Synthetic vs. true interrupt→resume.** The regression test hand-builds the
  checkpoint and resumed chunk stream rather than interrupting a real apply and
  feeding `resumeSnapshotStream` output back in. It faithfully reproduces the
  resulting state, and the resume invariant is verified by reading the live call
  chain (above), so an end-to-end test would add fidelity but would not catch a
  distinct defect. Left as-is.
- **Counter/progress values unasserted.** `tablesProcessed`/`entriesProcessed`
  seeding and `onProgress` emissions are reasoned-correct but not pinned by an
  assertion. Low risk; not worth the test brittleness here.
- **`totalEntries` undercounts on resume.** It accumulates from
  `table-start.estimatedEntries`, which the streamer always sets to 0, so on resume
  it reflects only re-streamed tables. Pre-existing (not introduced by this change),
  out of scope.
- **`parse*Key` schema-with-dot limitation.** `parseColumnVersionKey` et al. take the
  *first* `.` as the schema/table boundary, so a schema name containing `.` would
  misparse. Pre-existing across the whole keys module (build and parse are symmetric
  for dot-free schema names), unrelated to this change.

### Validation
- `yarn workspace @quereus/sync run build` — clean (tsc, exit 0).
- `yarn workspace @quereus/sync run test` — **184 passing** (the extended assertions
  live in the existing `it`, so the count is unchanged from the implement pass).
- `quereus-sync` has no lint script (only `packages/quereus` does); the change is
  isolated to `quereus-sync` internals with no signature change, so the two direct
  consumers (`sync-coordinator`, `quereus-sync-client`) are unaffected by the
  test-only review edit and were green at implement time.
