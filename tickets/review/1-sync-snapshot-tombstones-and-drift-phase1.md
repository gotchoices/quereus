description: Snapshots now carry deletion records so deleted rows can't come back after a replica rebuilds from a snapshot, and a peer with a badly-wrong clock is rejected before its data is written instead of after.
files:
  - packages/quereus-sync/src/sync/protocol.ts                     # SnapshotTombstoneChunk + union/type additions
  - packages/quereus-sync/src/sync/snapshot-stream.ts              # producer global tombstone pass; consumer tombstone case; header drift check; flushMetadataBatch helper
  - packages/quereus-sync/src/sync/change-applicator.ts            # pre-commit drift at top of applyChanges (reuses watermarkHLC)
  - packages/quereus-sync/src/sync/snapshot.ts                     # pre-commit drift in non-streaming applySnapshot (+ NOTE on remaining tombstone gap)
  - packages/quereus-sync/src/clock/hlc.ts                         # assertWithinDrift + MAX_DRIFT_MS exports; receive() delegates
  - packages/sync-coordinator/src/common/serialization.ts         # tombstone chunk serialize/deserialize (S3/wire round-trip)
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts   # new: 3 reproduction tests
  - packages/sync-coordinator/test/serialization.spec.ts          # new: tombstone chunk round-trip test
  - docs/sync.md
  - bug-nonstreaming-snapshot-tombstones (follow-up ticket for the non-streaming tombstone gap)
----

Two independent robustness defects in the snapshot/apply path, both able to
permanently de-converge two replicas. Both fixed. Build + tests green.

## Background (for a reader without context)

The sync engine is a CRDT: each cell carries a Hybrid Logical Clock (HLC)
timestamp; Last-Writer-Wins picks the higher HLC. A **tombstone** records "row R
was deleted at HLC h" so a later-arriving *older* write for R is suppressed
instead of resurrecting the row. A **snapshot** is a wholesale dump of a replica's
state used to bootstrap a fresh replica (and on every S3 restore).

## What was wrong, and what changed

### Defect 1 — snapshots omitted tombstones → deleted rows resurrect

The streaming snapshot producer (`streamSnapshotChunks`) emitted header →
per-table column-versions → schema-migrations → footer, but **never tombstones**.
On apply, `clearExistingMetadata` wiped the receiver's tombstones and nothing put
them back — so after bootstrap a straggler older write for a deleted row resurrected it.

Fix (streaming path):
- New `SnapshotTombstoneChunk` type (`protocol.ts`) — an explicit entry object
  (`pk`, `hlc`, `createdAt`, optional `priorRow`) because `priorRow` is optional.
- Producer: a **global** tombstone pass over `buildAllTombstonesScanBounds()`
  (mirrors the schema-migration pass), batched by `(schema, table)` into
  `chunkSize` chunks. Global — not per-table — so a fully-deleted row (a tombstone
  with no live column-versions, hence a table absent from the column-version pass)
  still travels.
- Consumer: a `case 'tombstone'` writing each entry via `setTombstoneBatch` into
  the existing metadata batch (no store data), honoring the shared
  `BATCH_FLUSH_SIZE` / checkpoint path (extracted into a `flushMetadataBatch`
  helper reused by the column-version handler).
- Coordinator serialization (`serialization.ts`): tombstone chunks carry a bigint
  HLC + blob-capable `pk`/`priorRow`, so they MUST go through `serializeHLC` /
  `encodeSqlValue`. Without this the S3 snapshot upload (`JSON.stringify`) would
  throw on the bigint. Added both serialize + deserialize cases.

### Defect 2 — clock-drift rejection ran AFTER the data committed

The drift check lived inside `HLCManager.receive`, which runs LAST in `admitGroup`
(data → metadata → receive). A peer 60 s+ ahead had its far-future LWW winners
durably written before the batch threw — permanent poison.

Fix:
- Extracted a side-effect-free `assertWithinDrift(remoteWallTime, now)` in
  `hlc.ts` (exported, plus `MAX_DRIFT_MS`); `receive` delegates to it (its own late
  check stays as harmless defense).
- Wire path (`applyChanges`): validate the batch-max fact HLC at the **top of
  Phase 1**, before any resolution/write. Emits `status:'error'` then throws — exits
  before `admitGroup`, so nothing lands. Reuses the same `maxHLC` as the merge
  watermark (one computation).
- Streaming snapshot (`applySnapshotStream`): validate the header HLC **before**
  `clearExistingMetadata` — a drifted snapshot is rejected before it can wipe the
  receiver's own metadata.
- Non-streaming snapshot (`applySnapshot`): same pre-commit check added at the top
  (cheap, reuses `assertWithinDrift`).

## How to validate / exercise

- `yarn workspace @quereus/sync test` — **436 passing** (was 433 + 3 new).
- `yarn workspace @quereus/sync-coordinator test` — **126 passing** (incl. new tombstone round-trip).
- Type-check (signature drift): `yarn workspace @quereus/sync build`,
  `... sync-coordinator build`, `... sync-client build` all exit 0. (Neither sync
  package has a real `yarn lint` — the only real lint is `packages/quereus`, which
  this ticket does not touch; the `tsc` builds above are the signature-drift guard.)

New tests (`test/sync/snapshot-tombstones-and-drift.spec.ts`), each a genuine
reproduction (fails on pre-fix code, passes now):
- **Tombstone survives snapshot bootstrap.** Sender writes then deletes R (leaving
  a tombstone with NO live column-versions), streams a real `getSnapshotStream`,
  applies to a fresh receiver, then delivers a stale older write for R. Asserts R
  does not resurrect and the receiver has a tombstone. (Pre-fix: the producer emits
  no tombstone chunk → assertion fails immediately.)
- **Drifted wire batch rejected, nothing committed.** `applyChanges` with a batch
  HLC beyond drift throws, and asserts no store row AND no column-version metadata.
  (Pre-fix: data + column-versions commit, THEN it throws → the no-data asserts fail.)
- **Drifted snapshot header rejected before clear.** Seeds a pre-existing
  column-version, applies a snapshot whose header HLC is beyond drift, asserts the
  throw AND that the pre-existing metadata survived (the clear never ran).

Coordinator round-trip test (`test/serialization.spec.ts`): a tombstone chunk with
bigint HLC + a `priorRow` of bigint/string/blob/null survives
serialize → `JSON.stringify` → parse → deserialize (the S3 store/download path).

## Known gaps / tripwires for the reviewer

Treat this as a starting point — flagged honestly:

- **Non-streaming snapshot still omits tombstones.** `getSnapshot`/`applySnapshot`
  (`snapshot.ts`) share Defect 1: the `Snapshot`/`TableSnapshot` interface has no
  tombstone field, and `applySnapshot` clears tombstones without restoring them. It
  is a public, README-documented API, so this is a *real reachable defect, not a
  tripwire*. Out of this ticket's scope (needs an interface change), so it is filed
  as follow-up ticket **`bug-nonstreaming-snapshot-tombstones`** (a `NOTE:` at the
  `applySnapshot` site points to it). The *drift* half of the fix WAS applied to
  `applySnapshot`; only the tombstone half remains. There is **no** new test for
  the non-streaming tombstone path (it stays broken until that ticket lands).

- **Tombstone `createdAt` is re-based on bootstrap** (tripwire, not a bug).
  `setTombstoneBatch` stamps `createdAt = Date.now()` internally and ignores the
  sender's value, so a bootstrapped tombstone's TTL horizon restarts from bootstrap
  time rather than the original deletion. Accepted for phase 1 (the tombstone still
  lives a full horizon). Recorded as a `NOTE:` at the consumer `setTombstoneBatch`
  call site (`snapshot-stream.ts`) and in `docs/sync.md` (§ Tombstones and Deletions).

- **Resume re-emits ALL tombstones** (tripwire, not a bug). A resumed transfer
  re-streams every tombstone regardless of the checkpoint's completed tables; the
  consumer re-writes them idempotently (same key, same bytes) — mildly wasteful,
  deliberately simple. Recorded as a `NOTE:` at the producer's tombstone pass.

- **Tombstone chunks are not counted** in `totalEntries` / table counts / the S3
  metadata `x-entry-count`. Intentional (keeps existing counters as column-version
  counts and tombstones out of `entriesProcessed` to avoid double-counting on
  resume). No functional impact; the counts are advisory/telemetry.

- **Test transport uses in-process `getSnapshotStream` → `applySnapshotStream`**,
  not the coordinator/S3 hop. The coordinator serialization is covered separately
  by the unit round-trip test, but there is no single end-to-end test that streams a
  tombstone through S3 serialization into a receiver. A reviewer wanting more
  confidence could add one; the two halves are each covered.
