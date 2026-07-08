description: Snapshots now carry deletion records so deleted rows can't come back after a replica rebuilds from a snapshot, and a peer with a badly-wrong clock is rejected before its data is written instead of after.
files:
  - packages/quereus-sync/src/sync/protocol.ts                     # SnapshotTombstoneChunk + union/type additions
  - packages/quereus-sync/src/sync/snapshot-stream.ts              # producer global tombstone pass; consumer tombstone case; header drift check; flushMetadataBatch helper
  - packages/quereus-sync/src/sync/change-applicator.ts            # pre-commit drift at top of applyChanges (reuses watermarkHLC)
  - packages/quereus-sync/src/sync/snapshot.ts                     # pre-commit drift in non-streaming applySnapshot (+ NOTE on remaining tombstone gap)
  - packages/quereus-sync/src/clock/hlc.ts                         # assertWithinDrift + MAX_DRIFT_MS exports; receive() delegates
  - packages/sync-coordinator/src/common/serialization.ts         # tombstone chunk serialize/deserialize (S3/wire round-trip)
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts   # 3 reproduction tests
  - packages/sync-coordinator/test/serialization.spec.ts          # tombstone chunk round-trip test
  - docs/sync.md
  - tickets/fix/bug-nonstreaming-snapshot-tombstones.md            # follow-up (non-streaming tombstone gap)
----

Phase-1 robustness work on the snapshot/apply path. Two independent defects, each
able to permanently de-converge two replicas, were fixed for the **streaming**
snapshot path and the wire-apply path. Build + tests green. Reviewed and completed.

## What shipped

### Defect 1 — streaming snapshots omitted tombstones → deleted rows resurrect
Producer (`streamSnapshotChunks`) now emits a **global** `tombstone` chunk pass
over `buildAllTombstonesScanBounds()`, batched by `(schema, table)`. Global (not
per-table) so a fully-deleted row — a tombstone with no live column-versions,
hence a table absent from the column-version pass — still travels. Consumer
(`applySnapshotStream`) has a `case 'tombstone'` writing each entry via
`setTombstoneBatch` into the shared metadata batch (extracted `flushMetadataBatch`
helper reused by the column-version handler). Coordinator serialization gained a
tombstone case (bigint HLC via `serializeHLC`, blob-capable `pk`/`priorRow` via
`encodeSqlValue`) so the S3 `JSON.stringify` upload path survives.

### Defect 2 — clock-drift rejection ran AFTER data committed → poison winners
Extracted side-effect-free `assertWithinDrift(remoteWallTime, now)` (+ exported
`MAX_DRIFT_MS`) in `hlc.ts`; `receive` delegates. Wire path validates the batch-max
fact HLC at the top of `applyChanges` (reuses the merge `watermarkHLC`); streaming
snapshot validates the header HLC **before** `clearExistingMetadata`; non-streaming
`applySnapshot` validates at the top. All emit `status:'error'` then throw, exiting
before any data/metadata commit.

## Review findings

**Verdict: implementation is correct and complete for its declared (streaming +
wire) scope. One minor doc inaccuracy found and fixed inline; no new defects.**

### Checked — mechanism / correctness
- **Producer tombstone batching** (`snapshot-stream.ts`): key-sorted scan, table
  boundary flush, chunk-fill flush. Verified no array-aliasing bug — every `yield`
  is followed by `tsEntries = []` (fresh array), so emitted chunks never share the
  accumulator. Correct.
- **Consumer tombstone write path**: writes into the same `batch` as
  column-versions; footer flushes remaining batch (`if (batchSize > 0) batch.write()`).
  Verified tombstone entries land. `clearExistingMetadata` runs at `header`
  (before any tombstone chunk), so clear-then-repopulate ordering is correct.
- **Fully-deleted-row table on resume**: such a table never gets table-start/end,
  so it is never in `completedTables`; on resume its tombstones ARE cleared at the
  header — but the producer re-emits **all** tombstones wholesale, so they are
  rewritten before completion. Self-consistent (correctness rests on wholesale
  re-emit, which is the deliberate design). No loss on a completed transfer.
- **Drift pre-commit checks**: wire (`applyChanges`), streaming header, and
  non-streaming (`applySnapshot`) all validate before any write; empty batch →
  `maxHLC` undefined → skipped. Correct.
- **Helpers exist and resolve**: `buildAllTombstonesScanBounds`, `parseTombstoneKey`
  (returns `pk`), `deserializeTombstone`, `setTombstoneBatch` — all present; three
  `tsc` builds (sync / sync-coordinator / sync-client) exit 0 (signature-drift guard).

### Found & fixed inline (minor)
- **`docs/sync.md` overstated coverage.** The new "Tombstones travel in snapshots"
  bullet claimed "A snapshot **(streamed or whole)** carries its tombstones" — but
  the whole/non-streaming path is still broken (the implementer's own known gap).
  A reader relying on `applySnapshot` would wrongly believe deletes are preserved.
  Rewrote the bullet to scope the guarantee to the streaming path and explicitly
  flag the non-streaming gap + its follow-up ticket. (Fixed in this pass.)

### Checked — clean, no action
- **Blob in tombstone `pk` serialization** is untested (round-trip test covers blob
  only in `priorRow`, and bigint in `pk`). Not a defect: `pk` maps through the same
  `encodeSqlValue`/`decodeSqlValue` as `priorRow` and column-versions, which the
  test exercises for blobs. Redundant coverage only — no ticket.
- **README** (`packages/quereus-sync/README.md`) shows `getSnapshot`/`applySnapshot`
  as API usage only; it makes no tombstone-preservation claim, so no inaccuracy to
  correct here (the non-streaming semantics belong to the follow-up ticket).

### Major → filed as ticket (not fixed here)
- **Non-streaming snapshot still omits tombstones.** `getSnapshot`/`applySnapshot`
  share Defect 1; fixing it needs a `Snapshot`/`TableSnapshot` interface change, so
  it was correctly carved out. Filed as `tickets/fix/bug-nonstreaming-snapshot-tombstones`
  (a `NOTE:` at the `applySnapshot` site points to it). The *drift* half of the fix
  was already applied to `applySnapshot`; only the tombstone half remains. Reachable
  (public, README-documented API) → correctly a ticket, not a tripwire. Confirmed
  well-formed.

### Tripwires (recorded, not ticketed) — all pre-existing from implement, verified appropriate
- **Tombstone `createdAt` re-based on bootstrap** — `setTombstoneBatch` stamps
  `Date.now()`, ignoring the sender's value; TTL horizon restarts at bootstrap.
  Safe direction (tombstone lives *longer*, never prematurely pruned). `NOTE:` at
  the consumer call site + `docs/sync.md`.
- **Resume re-emits ALL tombstones** — idempotent rewrite, mildly wasteful,
  deliberately simple. `NOTE:` at the producer pass.
- **Tombstones not counted** in `totalEntries` / table counts / S3 `x-entry-count`
  — intentional; counts are advisory telemetry, no functional impact.
- **Test transport is in-process** `getSnapshotStream → applySnapshotStream`, not
  the coordinator/S3 hop. The two halves are each covered (streaming mechanism +
  serialization round-trip); a single end-to-end-through-S3 test would add
  confidence but is not required for correctness.

### Tests / validation run this pass
- `yarn workspace @quereus/sync test` — **436 passing**.
- `yarn workspace @quereus/sync-coordinator test` — **126 passing**.
- `yarn workspace @quereus/sync build` / `... sync-coordinator build` /
  `... sync-client build` — all exit 0.
- Test coverage assessed: happy path (tombstone survives bootstrap, fully-deleted
  row), error paths (drifted wire batch → nothing committed; drifted snapshot header
  → pre-existing metadata survives), and serialization round-trip with
  bigint/string/blob/null cells. Adequate for the streaming + wire scope; the
  non-streaming path stays intentionally untested until its follow-up ticket lands.
