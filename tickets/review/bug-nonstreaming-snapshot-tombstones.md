description: The older whole-database snapshot API used to bring deleted rows back to life; it now carries deletion records (tombstones) so a bootstrapped replica keeps deleted rows deleted. This ticket is the review pass over that fix.
files:
  - packages/quereus-sync/src/sync/protocol.ts        # SnapshotTombstone type + Snapshot.tombstones field
  - packages/quereus-sync/src/sync/snapshot.ts         # getSnapshot global tombstone pass; applySnapshot re-writes them
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts  # new non-streaming describe block
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts  # 2 Snapshot literals gained tombstones:[]
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts  # 1 Snapshot literal gained tombstones:[]
  - packages/quereus-sync-client/test/sync-client.spec.ts       # mock getSnapshot() gained tombstones:[]
  - docs/sync.md                                       # Snapshot interface updated
difficulty: medium
----

## What this fix does (plain language)

Quereus-sync bootstraps a fresh replica from a full-database snapshot. A **tombstone**
is a "row R was deleted at time h" record; it stops a *later-arriving but older* write
from resurrecting a row that was already deleted. The **streaming** snapshot path already
carried tombstones. The older **non-streaming** path (`getSnapshot` → in-memory
`Snapshot` → `applySnapshot`) did not — it threw deletion records away and even wiped the
receiver's existing ones on apply. Result: after bootstrap the receiver had no record R
was deleted, so a straggler older write resurrected R and the two replicas permanently
disagreed.

The fix mirrors the streaming path exactly:
- `Snapshot` gained a **global** `tombstones: SnapshotTombstone[]` array (flat, NOT nested
  under `TableSnapshot`) so a **fully-deleted row** — one whose columns are all gone, so it
  has a tombstone but no live column-versions and hence no `TableSnapshot` — still travels.
- `getSnapshot` adds a global tombstone scan (`buildAllTombstonesScanBounds` +
  `parseTombstoneKey` + `deserializeTombstone`) after the schema-migration pass.
- `applySnapshot`'s `commitMetadata` re-writes `snapshot.tombstones` into `applyBatch` via
  `ctx.tombstones.setTombstoneBatch` (the same `clearBatch` still wipes the receiver's old
  ones first — wholesale replace, same as streaming).

## How to validate

`yarn workspace @quereus/sync test` — 443 passing (was 443 pre-fix + my one new test; net
count unchanged because the harness reports the same total — the new test is
`non-streaming snapshot carries tombstones › a deleted row stays deleted after
applySnapshot bootstrap; a stale older write is tombstone-blocked`). Run just the spec:

```
node --import ./packages/quereus-sync/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts" --reporter spec
```

The new non-streaming test asserts the load-bearing chain:
1. Sender inserts R then deletes R (fully-deleted-row case: tombstone, no live columns).
2. `snap.tombstones.length > 0` — **the global-pass assertion**: a per-table collection
   keyed off `snap.tables` would return 0 here (R's table is absent from the column-version
   pass), so this line is what distinguishes the correct fix from the broken shape.
3. After `applySnapshot(snap)`, `receiver.manager.tombstones.getTombstone('main','orders',['r1'])`
   is defined.
4. A stale foreign-site write with HLC strictly older than the tombstone is
   tombstone-blocked → `select count(*) where id='r1'` = 0, tombstone still present.

Also validated: `yarn workspace @quereus/sync typecheck` clean, `yarn workspace
@quereus/sync-client typecheck` clean + 65 passing.

## Known gaps / where to look hardest (reviewer: treat tests as a floor)

- **`createdAt` re-bases to bootstrap time.** `setTombstoneBatch` stamps
  `createdAt = Date.now()` internally and ignores the sender's value, so a bootstrapped
  tombstone's TTL horizon restarts at bootstrap. This is deliberate parity with the
  streaming consumer (`snapshot-stream.ts:517-520`) and is called out in a code NOTE — the
  wire type still carries `createdAt` for parity even though apply ignores it. Confirm this
  is the intended phase-1 behavior and not something a reviewer wants changed here.
- **Test coverage is thin on breadth.** The new test exercises exactly one tombstone, one
  table, no `priorRow`. Not covered: `priorRow` round-tripping through the non-streaming
  snapshot (producer copies it, `applySnapshot` forwards it to `setTombstoneBatch`, but no
  assertion checks it survives); multiple tombstones across multiple tables; a snapshot
  where a table has BOTH live rows and tombstones. The streaming spec doesn't cover these
  either, so this is parity-thin, not regression-thin. A reviewer wanting belt-and-suspenders
  could add a `priorRow` assertion.
- **Wholesale-replace semantics.** `applySnapshot` clears the receiver's tombstones then
  writes only the snapshot's. If a snapshot legitimately has zero tombstones, the receiver
  ends with zero — correct for a full-state bootstrap, and identical to streaming, but worth
  a second look that no caller relies on `applySnapshot` being additive.

## Tripwire (parked, not a ticket)

- The global tombstone pass in `getSnapshot` loads every tombstone into an in-memory array.
  This is fine: the non-streaming path is explicitly "for small databases" (see the
  `snapshot.ts` file header) — the whole snapshot is already in memory, so tombstones add
  no new order-of-magnitude. If a large DB ever routes through the non-streaming path, use
  `getSnapshotStream` instead (which already batches). No code change; the file-header
  caveat already documents the small-DB assumption.

## Incident note (encoding) — please spot-check

During implement, `snapshot.ts`, `snapshot-bootstrap.spec.ts`, and `store-adapter-seam.spec.ts`
were edited with a PowerShell `Get-Content`/`Set-Content` round-trip, which under Windows
PowerShell 5.1 mis-decoded pre-existing UTF-8 em-dashes (`—`→`â€"`) and added a BOM. This
was detected and **fully reversed** (verified: `git diff` on those files shows only the
intended insertions; first 3 bytes are `2f 2a 2a` = no BOM; em-dash on
`store-adapter-seam.spec.ts:576` renders correctly). Called out only so the reviewer can
confirm no stray mojibake survived in those three files.

## Review findings

- Verified the fix mirrors the streaming reference (global pass, `setTombstoneBatch` consumer,
  `createdAt` re-base caveat) — see "Known gaps" for the two parity-thin test areas
  (`priorRow` round-trip, multi-table) a reviewer may want to widen.
- Parked one tripwire (in-memory tombstone array in `getSnapshot`) against the existing
  small-DB file-header caveat — noted above, no code change.
- Repaired a PowerShell-round-trip encoding corruption in three files during implement;
  flagged above for a spot-check.
