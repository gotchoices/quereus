description: When one device reconnects and uploads changes it made offline, another device that is offline at that moment may never receive them, because it has already caught up past their timestamps. The server should hand out changes in the order they reached it, so every device that catches up gets them.
architecture: docs/sync-protocol.md#delta-sync-optimization
files:
  - packages/quereus-sync/src/metadata/change-log.ts           # entry gains a filing position (the key) distinct from the origin timestamp (the value)
  - packages/quereus-sync/src/metadata/keys.ts                 # buildChangeLogKey / parseChangeLogKey / buildChangeLogScanBoundsAfter now address positions
  - packages/quereus-sync/src/metadata/column-version.ts       # record gains optional filing position
  - packages/quereus-sync/src/metadata/tombstones.ts           # record gains optional filing position
  - packages/quereus-sync/src/metadata/schema-migration.ts     # record gains optional filing position; recordMigrationBatch already exists
  - packages/quereus-sync/src/sync/change-applicator.ts        # commitChangeMetadata (~1305) assigns positions; applyChanges (~504) files migrations separately today
  - packages/quereus-sync/src/sync/change-grouping.ts          # order and cut by position; emit the cursor
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # getChangesSince, getChangesToPush, collectChangesSince, collectAllChanges, collectSchemaMigrations, pruneTombstones, repairChangeLog, commit chain
  - packages/quereus-sync/src/sync/sync-context.ts             # deleteRowVersionsAndLogEntries (~234)
  - packages/quereus-sync/src/sync/rekey-on-pk-change.ts       # re-files log entries (~447-583); must keep positions
  - packages/quereus-sync/src/sync/snapshot.ts                 # header HLC (~171), cell and tombstone transfer
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # header HLC (~325), cell and tombstone transfer, (~812)
  - packages/quereus-sync/src/sync/protocol.ts                 # ChangeSet.cursor, snapshot entry shapes
  - packages/quereus-sync/src/sync/wire.ts                     # serializeChangeSet / deserializeChangeSet, snapshot codec, PROTOCOL_VERSION
  - packages/quereus-sync-client/src/sync-client.ts            # advanceReceivedWatermark (~699) follows the cursor; the push path (~1521) does not change
  - docs/sync-protocol.md
  - docs/sync-transactions.md
  - docs/sync.md
difficulty: hard
repro: verified
----

## The defect

A device asks a server for "everything after watermark W", where W is the highest write timestamp it has received. The server's change log (`cl:` keys) is sorted by each change's original write timestamp. So a change written before W that reaches the server after the device read past W sits below W, and no later request returns it. Any `get_changes` reply is documented as "contiguous, gap-free" (`docs/sync-protocol.md`), and this breaks that.

Root cause, one decision: **the received watermark measures write time, but what a device needs to know is how far through the server's arrival order it has read.** Those two orders differ whenever changes arrive out of write order. That happens after any offline period, and between two devices pushing at about the same time.

## Reproduction

Run with a throwaway spec (deleted) using `makePeer`, `settle` and `collect` from `packages/quereus-sync/test/sync/_peer-harness.ts`, driving `getChangesToPush`, `applyChanges` and `getChangesSince` directly. Peers: device B, a server stand-in S, device C. Allow a few milliseconds between B's offline write and the newer write, so their timestamps differ.

1. B inserts row 1 and pushes it to S. C pulls from S.
2. B makes an offline change.
3. A newer change reaches S. C pulls, and its watermark moves past B's offline change.
4. B pushes the offline change. S applies it.
5. C pulls from its watermark. The reply is empty.

| Offline change | Newer change comes from | Result on C |
|---|---|---|
| delete row 1 | a local write on S | still has row 1 |
| `update` of row 1 | a local write on S | old value |
| insert row 3 | a local write on S | no row 3 |
| `create table extra` plus an insert | a local write on S | no table `extra` |
| delete row 1 | a third device pushing to S | still has row 1 |
| delete row 1 | a local write on S, then C bootstraps from S's snapshot instead of pulling | still has row 1 |

Control: an offline change newer than C's watermark arrives normally.

The last row matters most: a fresh snapshot does not protect a device, because the snapshot's timestamp is a watermark too. The fourth row shows the defect also covers table definitions, not only rows, since `collectSchemaMigrations` filters on the same timestamp.

All of this ran at the `SyncManagerImpl` layer. It was not run through a real `SyncClient` and coordinator. By reading: the coordinator's `get_changes` handling calls `getChangesSince` after the delta floor check, and the client's `advanceReceivedWatermark` takes the maximum `ChangeSet.hlc`, so neither would change the outcome.

## This is not the documented accepted limit

`docs/sync.md` § Store-and-forward relay calls this "the same scalar-watermark limitation the base delta layer has" and says such a change "arrives by direct sync / snapshot instead". That sentence was written about relaying held changes. For an ordinary device and server there is no direct sync, and the last reproduction row shows a snapshot does not help either. The maintainer queued this ticket from backlog, and `docs/sync.md` § Tombstones and Deletions already lists it as an open defect. So the correct behaviour is settled: **once a change has reached the server, every device that catches up with the server receives it, however old its write timestamp is.** Relaying held changes stays out of scope, and the limit keeps applying there (see TODO).

## Design

### Two axes

- **Origin timestamp (`hlc`).** When the change was written and by whom. Unchanged. Last-writer-wins, transaction identity, `priorHlc`, the sent watermark (`pt:`) and `isUndeliveredOwnDelete` all stay on this axis.
- **Filing position.** Where this replica filed the change in its own log. New. The received watermark (`ps:`), the `get_changes` argument, the delta floor and the snapshot header all move to this axis.

A filing position is an HLC value from the replica's own clock, so the wire format, `ps:`, `df:` and the snapshot header keep their types. It only means something to the replica that issued it. `ps:` is already kept per server.

### Filing rule

```
local write:   position = hlc                  (the clock tick that stamped it)
remote change: position = (T, opSeq i)         T = one clock tick per admitted batch, taken after
                                               merging the batch's maximum HLC into the clock
```

So positions strictly increase in the order changes are filed, and a position is never below its origin timestamp. Every remote change takes this path. There is no separate "late" case to get wrong.

Storage:

```
cl:<position>  ->  empty when origin == position (local facts, and entries written before this change)
                   otherwise the origin HLC
cv: / tb: / sm: record  ->  optional position; absent means position == hlc
```

The stored position on `cv:` and `tb:` is needed because writers delete a superseded log entry by computing its key, and that key is now the position. Every site below must use it. To make a mix-up hard to write, have the `ChangeLogStore` delete methods take the record (`{ hlc, position? }`) or the parsed entry rather than a bare HLC:

- `sync-manager-impl.ts` ~1330, ~1403, ~2045, ~2129
- `change-applicator.ts` ~1415, ~1437
- `sync-context.ts` ~234
- `rekey-on-pk-change.ts` ~447, ~463, ~519, ~561, and the re-filing at ~469 and ~583, which must keep the existing position (a key redefinition is not a new arrival)
- `tombstones.ts` ~191 (its comment names the old form)

### Commit order must equal position order

Today nothing serializes applies on one manager. If apply P takes position 100, apply Q takes 101 and commits first, and a device reads through 101, then P commits below that device's watermark. That is this same bug, and today's log has it too. So assigning the tick and writing the batch must be one critical section, shared with local capture:

- Run "merge the clock, tick, assign positions, write the batch" as an entry on the existing commit chain (`commitChain`, `enqueueTransactionCommit`). Do only this step on the chain, not the whole apply: an apply writes its data earlier, and `adoptOnCommitChain` already documents the deadlock that holding the chain across an apply would cause.
- Persist the clock in the same batch (`persistHLCStateBatch`, as local capture does at `sync-manager-impl.ts` ~991). Today the apply path persists it afterwards in `admitGroup`. After a crash between the two, the restarted clock could issue positions below ones already on disk.
- File a batch's migrations in the same batch and tick as its data, with the lower `opSeq`s, using `recordMigrationBatch`. Today `recordMigration` runs after `commitChangeMetadata` in separate writes (`change-applicator.ts` ~504-524). Otherwise a data change could be read before the migration that creates its table.
- Within one tick, give each source transaction contiguous `opSeq`s.

The cleanup batches in `commitChangeMetadata` (~1348-1356) only delete, so they need no position.

`drainTableGroup` reaches the same `commitChangeMetadata`, so drained changes are filed the same way.

### Reading

`ChangeSet` gains:

```ts
/**
 * Where a consumer that received this set resumes from on the replica that served it: the
 * set's greatest filing position. Absent when it equals `hlc`. Means nothing to any other
 * replica, and applying a set ignores it.
 */
readonly cursor?: HLC;
```

Export one helper from `@quereus/sync` that computes a reply's watermark as the maximum of `cs.cursor ?? cs.hlc`, and use it in `advanceReceivedWatermark`. Never forward a received cursor: `applyChanges` drops it, and the receiver files the change at its own position.

- `getChangesSince`: scan the log after `sinceHLC` in key order, using the origin stored in the entry's value for the `notFromPeer` filter. Filter migrations by position too.
- `buildTransactionChangeSets`: order groups by position and cut at the bound on that order. Today it sorts by origin base HLC, so with positions a cut could leave the cursor above an unsent group. This is the likeliest place for a subtle bug.
- **A source transaction filed in two ticks** must become two `ChangeSet`s, grouped by (transaction, tick). This happens when part of a transaction is filed later, for example a held change drained after the rest applied. A single group with one cursor could carry the cursor past facts it does not hold if the cut falls between them. This relaxes "a transaction is never split across ChangeSets" for this one case: `applyChanges` works on flat facts and is order-independent, so nothing should depend on it, but check this and update `docs/sync-transactions.md`.
- `collectAllChanges` (from-zero): same ordering, using the positions in the `cv:` and `tb:` records.
- `collectChangesSince`'s LOAD-BEARING INVARIANT comment and the "facts of one transaction are contiguous" reasoning are now about positions. The boundary test has to treat a change of tick or a change of source transaction as a boundary. Rewrite the comment rather than patching it.

### Pushing stays on the origin axis

`getChangesToPush` keeps its origin-axis `sinceHLC`. A position is never below its origin, so scanning keys after `sinceHLC` still covers every fact with origin above it. Add one filter: keep own facts whose **origin** is above `sinceHLC`. Without it, own facts restored from a snapshot, which sit at the server's higher positions, would be re-pushed on every handshake, because `pt:` never passes those positions. Group these sets by origin as today, and do not emit a cursor. The push path in `sync-client.ts` (~1521) keeps `cs.hlc`.

### Delta floor

`pruneTombstones` raises the floor to the greatest pruned **position** (`tombstone.position ?? tombstone.hlc`), not the greatest origin. A late delete has a low origin and a high position, so with an origin floor, a device that has not yet read that position would be admitted and would miss the delete. `canDeltaSync` and the coordinator do not otherwise change. `pruneEntriesBefore` (unwired) works on keys, so it stays consistent. Its comment in `change-log.ts` should say position.

### Snapshots

- **Header HLC must be a fresh tick taken on the commit chain**, in both producers (`snapshot.ts` ~171, `snapshot-stream.ts` ~325). Today it is `getCurrentHLC()`, which does not tick and has `opSeq` 0. Two consequences if left alone. The floor can now be `(w, c, site, k)` while the header is `(w, c, site, 0)`, so the header sorts below the floor, the device's follow-up `get_changes` is refused, and it loops through snapshots. And a batch that took its tick before the header but commits after the cell scan would be missed. A resumed stream keeps its original header HLC, which is conservative as documented.
- **Positions travel with cells and tombstones.** Add optional `position` to `ColumnVersionEntry`, `SnapshotTombstone` and the `SnapshotTombstoneChunk` entries, and to migrations, and write them through on apply (`snapshot.ts` ~331, `snapshot-stream.ts` ~810). Otherwise a coordinator restored from S3 would re-file a late change at its low origin and a device between the two would skip it. Receivers already merge the header HLC into their clock, so their later ticks stay above every copied position.

### Compatibility

Bump `PROTOCOL_VERSION` to 3 and add a version-history line in `docs/sync-protocol.md`, plus a line in the gitignored `.release-notes.pending.md`. A client that ignores `cursor` would re-request the same range. Stored data needs no migration: an absent value or field means position equals origin, which is what existing entries are. Existing `ps:` watermarks are lower than any new tick, so they stay valid. Changes that were already skipped before this lands stay skipped until a snapshot.

## Costs

- Each remote fact stores an origin HLC in its log value and a position on its record: 30 bytes each in `serializeHLC` form (`hlc.ts` ~154), more if the record's JSON payload uses `hlcToJson`. Total storage impact was not measured. Measure a coordinator workload if this looks significant.
- Metadata filing now waits its turn on the commit chain, so overlapping applies on one server serialize their final write. Their data writes do not. The effect on throughput was not measured.
- A device can receive a change twice, for example when it arrived by broadcast and again through the log, because broadcasts never advance the watermark. This exists today and is idempotent.

## Alternatives considered

- **A separate index for late changes only**, keeping `cl:` on origin order and stamping a change only when it arrives below a persisted high-water mark. Most existing tests would be untouched. Rejected: it needs a durable high-water record that snapshot headers must also advance, a merge of two scans with a shared bound, its own expiry sweep, stale-pointer handling across `alter primary key`, and a floor lookup. The late path would also run rarely, which is the wrong property for the path that carries this fix.
- **A watermark per origin device** (a version vector). Rejected: it assumes each device's changes arrive in write order, which relays and drains can violate; it sends state that grows with every device ever seen; and because a device that stopped writing holds the minimum low, the scan start sits far back.
- **Raising the delta floor whenever a change arrives late**, so devices take a snapshot. Rejected: every reconnect after offline work would force a snapshot on every other device.
- **Periodic snapshots.** Rejected: they hide the symptom, cost a full transfer, and do not close the gap (reproduction, last row).

## Related work, not changed here

- `bug-sync-local-edit-during-apply-diverges` (backlog) touches `commitChangeMetadata` and the same invariant comment, but its cause is a local write between an apply's data and metadata. Moving the metadata write onto the commit chain does not fix it, because the apply's priors are read earlier. Do not expand scope to it. Check that the backlog ticket's description still reads correctly afterwards.
- `feat-sync-changelog-horizon-pruning` (backlog) raises the floor from pruned keys, which are now positions, so the design there still holds.

This design has not been prototyped. The sections above come from reading the code and from the reproduction. If a part proves wrong, say so in the handoff rather than quietly working around it.

## TODO

Reproduce first

- Add `packages/quereus-sync/test/sync/late-arrival-delta.spec.ts` with the reproduction table as one table-driven test, plus the control. Pull using the new reply-watermark helper. Confirm it fails before the fix.

Storage and filing

- Split `ChangeLogEntry` into position and origin hlc; store the origin in the entry value; update `keys.ts` naming and comments, and the file header of `change-log.ts`.
- Add the optional position to `cv:`, `tb:` and `sm:` records and their codecs.
- Change the `ChangeLogStore` delete methods to take the record or entry, and update every site listed under *Filing rule*; keep positions in `rekey-on-pk-change.ts`.
- Add the filing critical section on the commit chain: merge the clock, tick, assign positions, write, persist the clock in the same batch. Move migrations into that batch.

Reading and protocol

- Add `ChangeSet.cursor`, the wire codec, and the exported reply-watermark helper; bump `PROTOCOL_VERSION`.
- Order and cut by position in `buildTransactionChangeSets`, grouped by (transaction, tick); update `collectChangesSince`, `collectAllChanges` and `collectSchemaMigrations`.
- Add the origin filter to `getChangesToPush` and `collectSchemaMigrations`' push path, and keep pushes on the origin axis.
- Make `advanceReceivedWatermark` follow the cursor.
- Keep `collectForwardableChanges` on origin (position = its hlc). Reword its "Accepted limitation" comment (`sync-manager-impl.ts` ~1836) and its `REGRESS` reasoning: the watermark filter is now comparing origin with a position, which over-filters but never regresses, and the limit now belongs to held changes alone.

Floor and snapshots

- Raise the delta floor from positions in `pruneTombstones`.
- Tick the snapshot header on the commit chain in both producers.
- Carry positions through both snapshot paths and the wire codec.

Tests beyond the reproduction (each pins a named behaviour)

- Overlapping `applyChanges` calls on one manager: positions follow commit order, and a reader never passes an uncommitted batch.
- A pruned late delete refuses a watermark below its filing position and admits one at it (extend `delta-floor.spec.ts`).
- A replica restored from a snapshot still serves a late change to a device between its origin and its position.
- A device restored from a snapshot does not re-push its own facts on each handshake.
- A `batchSize` cut between late and on-time transactions loses nothing across rounds.
- One end-to-end run with real `SyncClient`s and a coordinator, as a throwaway spec unless it finds something the lower layers miss, and report the result in the handoff.
- Fix existing specs that use `cs.hlc` as the next watermark against a replica that received changes. A grep found 24 single-line call sites in 7 spec files passing a watermark, and multi-line calls would not match it. Move them to the helper rather than weakening assertions.

Docs

- `docs/sync-protocol.md` § Delta Sync Optimization, the `changes` message row, `ChangeSet` shape and version history: state the two axes.
- `docs/sync-transactions.md` § Read side and § The delta floor: position order, the (transaction, tick) grouping, a floor measured in positions.
- `docs/sync.md`: remove the open-defect bullet in § Tombstones and Deletions; update the `cl:` row of the key-prefix table; reword "Watermark-safe", "Bound + ordering" and "Accepted limitation" in § Store-and-forward relay so the limit is stated for held changes only.

Validation

- `yarn build`, `yarn typecheck`, `yarn lint`, and `yarn test`. This changes `quereus-sync`, `quereus-sync-client` and `sync-coordinator`, and the quoomb-web worker uses all of it.
