description: Make database snapshots carry deletion records so deleted rows can't come back after a replica rebuilds from a snapshot, and reject a peer with a badly-wrong clock before its data is written instead of after.
files:
  - packages/quereus-sync/src/sync/protocol.ts            # add tombstone snapshot chunk type
  - packages/quereus-sync/src/sync/snapshot-stream.ts     # emit + consume tombstone chunks; move snapshot drift check to header
  - packages/quereus-sync/src/sync/change-applicator.ts   # validate drift in phase 1, before admitGroup
  - packages/quereus-sync/src/sync/admission.ts           # receive(watermarkHLC) currently runs post-commit
  - packages/quereus-sync/src/clock/hlc.ts                # extract reusable drift check from receive()
  - packages/quereus-sync/src/metadata/tombstones.ts      # setTombstoneBatch / getAllTombstones (producer/consumer helpers)
  - packages/quereus-sync/src/metadata/keys.ts            # buildAllTombstonesScanBounds / parseTombstoneKey / encodePK
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts   # existing stream-apply test patterns + cvEntry/toStream helpers
  - packages/quereus-sync/test/sync/_peer-harness.js      # createInMemoryProvider / collect harness
  - docs/sync.md
difficulty: hard
----

Two independent robustness defects in the snapshot/apply path, both able to
permanently de-converge two replicas. Both verified by reading current code (line
refs below). Fix as two phases in this one ticket — same subsystem, overlapping
edits in `snapshot-stream.ts` and `docs/sync.md`, one reviewer.

## Background (for a reader without context)

The sync engine is a CRDT: each cell carries a Hybrid Logical Clock (HLC)
timestamp and Last-Writer-Wins (LWW) picks the higher HLC. A **tombstone** is the
record that says "row R was deleted at HLC h" — it exists so a later-arriving
*older* write for R is suppressed instead of resurrecting the row. A **snapshot**
is a wholesale dump of a replica's state used to bootstrap a fresh replica (and on
every S3 restore).

### Defect 1 — snapshots omit tombstones, so deleted rows resurrect

`streamSnapshotChunks` (`snapshot-stream.ts:72`) emits header → per-table
column-versions → schema-migrations → footer. It **never emits tombstones**. On
apply, `clearExistingMetadata` (`snapshot-stream.ts:261`) deletes the receiver's
existing tombstones (`buildAllTombstonesScanBounds`, ~:272) and nothing streams
them back. So after bootstrap the receiver has no record that R was deleted; a
straggler/older write for R (already in flight, or delivered later) is applied as
if R were merely absent → R resurrects → the two replicas permanently disagree.

Note the table-enumeration gap: `tableKeys` is derived **from column-version
keys** (:80-85). A row all of whose columns were deleted has a tombstone but no
live column-versions, so its table may not appear in `tableKeys` at all. A
per-table tombstone emit keyed off `tableKeys` would silently miss fully-deleted
tables. Use a **global tombstone pass** over `buildAllTombstonesScanBounds()`
(mirroring the schema-migration pass at :170) so every tombstone travels
regardless of whether the table still has live rows.

### Defect 2 — clock-drift rejection runs after the data is committed

`admitGroup` (`admission.ts:127`) runs, in order: `applyDataToStore` (data →
store) → `commitMetadata` (CRDT metadata) → `receive(watermarkHLC)`. The drift
check lives **inside** `HLCManager.receive` (`hlc.ts:325-333`): it throws when
`remote.wallTime > now + MAX_DRIFT_MS` (60 s). Because `receive` is the **last**
step, a peer 60 s+ ahead has already had its far-future LWW winners durably
written to data + column-versions before the batch throws. Those far-future
values then beat every legitimate future write — permanent poison. The wire path
(`applyChanges` → `admitGroup`, `change-applicator.ts:206`) and the snapshot path
(footer `ctx.hlcManager.receive(snapshotHLC)`, `snapshot-stream.ts:490`, after all
flushes) both have this ordering.

The `change-applicator.ts:513` reference in the source fix ticket points at
`resolveChange`'s start; the actual post-commit `receive` is reached via
`admitGroup`. Fix at the applicator/admission layer, not inside `resolveChange`.

## Expected behavior

- A snapshot carries tombstones; a fresh apply ends with the sender's tombstones,
  not an empty set. A straggler older write for a deleted row stays suppressed.
- A peer whose `wallTime` exceeds the drift bound is rejected **in the validation
  phase, before any data or CRDT metadata is written** — nothing lands.

## Design

### Phase A — tombstones in the snapshot stream

New chunk type in `protocol.ts`. Mirror `SnapshotColumnVersionsChunk`, but a
tombstone needs `pk`, `hlc`, `createdAt`, and optional `priorRow` (see
`Tombstone` in `metadata/tombstones.ts`). Prefer an explicit entry object over a
positional tuple because of the optional field:

```ts
export interface SnapshotTombstoneChunk {
  readonly type: 'tombstone';
  readonly schema: string;
  readonly table: string;
  readonly entries: ReadonlyArray<{
    readonly pk: SqlValue[];
    readonly hlc: HLC;
    readonly createdAt: number;
    readonly priorRow?: Row;   // Row from '@quereus/quereus'
  }>;
}
```

Add `'tombstone'` to `SnapshotChunkType` and to the `SnapshotChunk` union.

Producer (`streamSnapshotChunks`): after the tables loop, before or after the
schema-migration pass, add a **global** tombstone pass over
`buildAllTombstonesScanBounds()`. Parse each key with `parseTombstoneKey` (gives
`{schema, table, pk}`), deserialize the value with `deserializeTombstone`, batch
into `chunkSize`-sized `tombstone` chunks grouped by `(schema, table)` (a fresh
chunk when schema/table changes or the batch fills). Do not fold tombstone counts
into `totalEntries`/table counts unless you also teach the footer/progress about
them — simplest is to leave the existing counters as column-version counts and add
tombstones as their own stream section.

Consumer (`applySnapshotStream`): a `case 'tombstone':` that writes each entry via
`ctx.tombstones.setTombstoneBatch(batch, schema, table, pk, hlc, priorRow)` into
the existing metadata `batch`, incrementing `batchSize` and honoring the same
`BATCH_FLUSH_SIZE` / checkpoint-save path as `column-versions`. Tombstones are
pure metadata — there is **no** store data to flush for a deleted row (do **not**
push a `DataChangeToApply`). `clearExistingMetadata` already ran at `header`, so
these writes repopulate the just-cleared tombstone space.

`createdAt`: `setTombstoneBatch` currently stamps `Date.now()` internally and
ignores any incoming createdAt. That resets the TTL horizon on every
bootstrap/restore. For phase 1 that is acceptable (a bootstrapped tombstone simply
lives a full horizon from bootstrap). **Add a `NOTE:` at the setTombstoneBatch
call site** in the consumer that the sender's `createdAt` is not preserved, so a
future reader knows the horizon is re-based on bootstrap. Do not expand
`setTombstoneBatch`'s signature in this ticket unless preserving createdAt is
trivial and you also cover it with a test.

Resume interaction: `resumeSnapshotStream` skips already-completed tables'
column-versions but a global tombstone pass re-emits **all** tombstones. On resume
the consumer re-writes them idempotently (same key, same bytes) — correct, just
mildly wasteful, and may double-count if you added tombstones into
`entriesProcessed`. Keep them out of `entriesProcessed`. **Add a `NOTE:`** at the
producer's tombstone pass documenting the resume re-emit as a deliberate
simplification, not a bug.

### Phase B — validate drift before committing

Extract the drift check from `HLCManager.receive` into a reusable, side-effect-free
export in `hlc.ts`, e.g.:

```ts
/** Throws when `remoteWallTime` exceeds `now` by more than MAX_DRIFT_MS. */
export function assertWithinDrift(remoteWallTime: bigint, now: bigint): void {
  if (remoteWallTime > now + MAX_DRIFT_MS) {
    throw new Error(`Remote clock too far in future: ${remoteWallTime - now}ms ahead (max ${MAX_DRIFT_MS}ms)`);
  }
}
```

Have `receive` call it (single source of truth; keeps `receive`'s own late check
as harmless defense). `now` is `BigInt(Date.now())` at the call site — pass it in
so it stays testable and so validation and the later merge see one clock read.

Wire path — `applyChanges` (`change-applicator.ts`): at the **top of Phase 1**,
before any resolution/writes, compute the batch max HLC (already computed later as
`watermarkHLC = maxHLC(changes.map(cs => cs.hlc))`) and call `assertWithinDrift`
on its `wallTime`. `cs.hlc` is each transaction's maximum fact HLC, so its
`wallTime` bounds every fact in that changeset; the batch max bounds the whole
batch. Throwing here exits before `admitGroup`, so no data and no metadata commit.
Decide and document: emit `syncEvents.emitSyncStateChange({status:'error', ...})`
before throwing for parity with the `applyDataToStore` failure path — recommended,
so the UI reacts identically to a rejected drifted batch.

Snapshot path — `applySnapshotStream`: in the `header` case, once `chunk.hlc` is
known and **before** `clearExistingMetadata`, call `assertWithinDrift(chunk.hlc.wallTime,
BigInt(Date.now()))`. The footer `receive(snapshotHLC)` then merges a
known-in-bound clock. This protects the receiver before it wipes its own metadata
or applies any chunk.

## docs/sync.md

Update the snapshot-format section to list the tombstone chunk as part of the
stream, and the "Transactional Integrity During Sync" / drift text to state that
clock-drift rejection is a **pre-commit validation** (nothing lands on rejection),
not a post-commit failure.

## Reproducing tests (write these; they fail before the fix)

Use `packages/quereus-sync/test/sync/_peer-harness.js` (`createInMemoryProvider`,
`collect`) and the `toStream` / `cvEntry` helpers in
`test/sync/snapshot-bootstrap.spec.ts` as models. Suggested new file:
`test/sync/snapshot-tombstones-and-drift.spec.ts`.

- **Tombstone survives snapshot bootstrap.** On sender: write row R, then delete R
  (creates a tombstone at HLC h_del). Stream a snapshot (`getSnapshotStream`) and
  apply it to a fresh receiver (`applySnapshotStream`). Then deliver a stale write
  for R with HLC < h_del. Assert: R is **not** present on the receiver (the write
  is tombstone-blocked). Assert the receiver has a tombstone for R after apply
  (e.g. via `ctx.tombstones.getTombstone`). Before the fix R resurrects.

- **Drift rejected in validation, nothing committed.** Build a `ChangeSet[]` whose
  `hlc.wallTime` is `Date.now() + MAX_DRIFT_MS + 1000`. Call `applyChanges`; assert
  it rejects (throws or surfaces error state) **and** that no data landed and no
  CRDT metadata was written (store row absent AND `columnVersions.getColumnVersion`
  returns undefined for the pk/column). Before the fix, data + column-versions are
  committed, then it throws. Add the snapshot-path analogue: a snapshot `header`
  whose `hlc.wallTime` is beyond drift → `applySnapshotStream` rejects at header,
  and the receiver's pre-existing metadata was **not** cleared.

## Validation

- `yarn workspace @quereus/quereus-sync test 2>&1 | tee /tmp/sync-test.log; tail -n 80 /tmp/sync-test.log`
- `yarn lint` (only `packages/quereus` has a real lint; type-checks catch signature drift)
- New tests must fail on current `main` and pass after the fix.

## TODO

Phase A — tombstones
- [ ] Add `SnapshotTombstoneChunk` to `protocol.ts`; extend `SnapshotChunkType` + `SnapshotChunk` union.
- [ ] Producer: global tombstone pass in `streamSnapshotChunks`, batched by `(schema,table)` into `chunkSize` chunks; `NOTE:` on resume re-emit.
- [ ] Consumer: `case 'tombstone'` in `applySnapshotStream` writing via `setTombstoneBatch` into the metadata batch (no store data); `NOTE:` that sender `createdAt` is not preserved.
- [ ] Test: tombstone survives snapshot bootstrap; stale write for deleted row stays suppressed.

Phase B — drift validation
- [ ] Extract `assertWithinDrift(remoteWallTime, now)` in `hlc.ts`; `receive` delegates to it.
- [ ] `applyChanges`: assert drift on batch-max wallTime at top of Phase 1, before `admitGroup`; emit error state before throwing (document the choice).
- [ ] `applySnapshotStream` header: assert drift on `chunk.hlc.wallTime` before `clearExistingMetadata`.
- [ ] Test: drifted wire batch rejected with nothing committed; drifted snapshot header rejected before clear.

Cross-cutting
- [ ] Update `docs/sync.md` (snapshot format includes tombstones; drift is pre-commit validation).
- [ ] `yarn workspace @quereus/quereus-sync test` green; `yarn lint` clean.
