description: The older whole-database snapshot API used to bring deleted rows back to life; it now carries deletion records (tombstones) so a bootstrapped replica keeps deleted rows deleted. Implemented, reviewed, and complete.
files:
  - packages/quereus-sync/src/sync/protocol.ts        # SnapshotTombstone type + Snapshot.tombstones field
  - packages/quereus-sync/src/sync/snapshot.ts         # getSnapshot global tombstone pass; applySnapshot re-writes them
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts  # non-streaming describe block (+ priorRow round-trip)
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts  # 2 Snapshot literals gained tombstones:[]
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts  # 1 Snapshot literal gained tombstones:[]
  - packages/quereus-sync-client/test/sync-client.spec.ts       # mock getSnapshot() gained tombstones:[]
  - docs/sync.md                                       # Snapshot interface + prose updated
difficulty: medium
----

## What shipped

The non-streaming whole-database snapshot path (`getSnapshot` → in-memory `Snapshot`
→ `applySnapshot`) used to discard deletion records (tombstones) and wipe the
receiver's on apply, so after a bootstrap a deleted row could be resurrected by a
later-but-older straggler write and the two replicas would permanently disagree. The
fix mirrors the already-fixed streaming path exactly:

- `Snapshot` gained a **global** `tombstones: SnapshotTombstone[]` (flat, not nested
  under `TableSnapshot`), so a fully-deleted row — a tombstone with no live
  column-versions, hence no `TableSnapshot` — still travels.
- `getSnapshot` adds a global tombstone scan after the schema-migration pass.
- `applySnapshot` re-writes `snapshot.tombstones` into `applyBatch` via
  `setTombstoneBatch` after the metadata clear (wholesale replace, same as streaming;
  `createdAt` re-bases to bootstrap time — deliberate parity, documented in a code NOTE).

The `Snapshot` type is in-process only — no wire serializer (`sync-coordinator`
serializes the *streaming* `SnapshotChunk`; `sync-client` serializes `ChangeSet`, not
`Snapshot`), so the fix is complete at the type boundary; nothing downstream drops the
new field.

## Review findings

**Checked**

- **Parity with the streaming reference** (`snapshot-stream.ts` producer L201-246,
  consumer L510-528): producer global pass, consumer `setTombstoneBatch` call,
  `priorRow` conditional-spread, and `createdAt` re-base NOTE all match the
  non-streaming implementation exactly. Correct.
- **`setTombstoneBatch` signature** (`tombstones.ts:120`): arg order
  `(batch, schema, table, pk, hlc, priorRow)` matches the call site. Correct.
- **Every other `Snapshot` literal in the tree**: the compiler-required `tombstones`
  field is present on all four Snapshot literals that feed `applySnapshot`
  (2× `snapshot-bootstrap.spec.ts`, 1× `store-adapter-seam.spec.ts:579`, 1× sync-client
  mock). The other `schemaMigrations:` hits are `ChangeSet` literals, not `Snapshot`.
  No literal passed to `applySnapshot` would hit `for...of undefined`.
- **No wire-serialization gap**: confirmed `Snapshot` never crosses a JSON boundary
  (only streaming `SnapshotChunk` and `ChangeSet` are serialized), so tombstones cannot
  be silently dropped in transport.
- **Encoding spot-check** (implementer flagged a reversed PowerShell corruption in three
  files): all three have no BOM (first bytes `2f 2a 2a` = `/**`), zero `â€` mojibake,
  and em-dashes intact. The reversal held.
- **Tests + typecheck**: `@quereus/sync` 443 passing + typecheck clean; `@quereus/sync-client`
  65 passing + typecheck clean.

**Found and fixed inline (minor)**

- **Stale doc.** `docs/sync.md:165` still stated the non-streaming path "does NOT yet
  carry tombstones" and cited this ticket as an open bug — the implementer updated the
  interface listing (L736-742) but missed this prose. Rewritten to describe the landed
  behavior (global `tombstones` field, global scan, apply re-write, same `createdAt`
  re-base caveat).
- **Untested `priorRow` round-trip.** The producer copies the delete before-image
  (`priorRow`, the engine `oldRow`) into the snapshot and `applySnapshot` forwards it to
  `setTombstoneBatch`, but no assertion checked it survived. Added two assertions to the
  non-streaming test: the snapshot tombstone carries `['r1','hello']`, and the receiver's
  reconstructed tombstone still carries it after bootstrap. Confirmed passing — the
  store-backed local delete does populate `oldRow` (`sync-manager-impl.ts:780`), so this
  is a real path, not a no-op assertion.

**Major findings**

- None. No correctness defect found; no new fix/plan/backlog ticket filed.

**Tripwire (parked, no code change)**

- `getSnapshot`'s global tombstone pass loads every tombstone into an in-memory array.
  Fine now — the non-streaming path is "for small databases" per the `snapshot.ts:4`
  file header, and the whole snapshot is already in memory, so tombstones add no new
  order-of-magnitude. A large DB should route through `getSnapshotStream` (already
  batched). The small-DB assumption is already documented at the file header; no new
  comment added.
