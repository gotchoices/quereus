description: When one device reconnects and uploads changes it made offline, another device that is offline at that moment may never receive them, because it has already caught up past their timestamps. The server now hands out changes in the order they reached it, so every device that catches up gets them.
architecture: docs/sync-protocol.md#delta-sync-optimization
files:
  - packages/quereus-sync/src/metadata/filing-position.ts      # NEW: FiledAt, filingPosition, positionsFrom, compact encoding
  - packages/quereus-sync/src/metadata/change-log.ts           # key = position, value = origin HLC when different; writers/deleters take FiledAt
  - packages/quereus-sync/src/metadata/keys.ts                 # change-log key builders/parsers renamed to positions
  - packages/quereus-sync/src/metadata/column-version.ts       # optional position (`fp` in the JSON payload)
  - packages/quereus-sync/src/metadata/tombstones.ts           # optional position (`fp`); setTombstone* take FiledAt
  - packages/quereus-sync/src/metadata/schema-migration.ts     # optional position, announced by the high bit of the type-length byte
  - packages/quereus-sync/src/sync/change-applicator.ts        # commitChangeMetadata -> fileAtNextTick on the commit chain; migrations and clock in the same write
  - packages/quereus-sync/src/sync/change-grouping.ts          # groups by (transaction, filing tick), orders and cuts by position, emits cursor
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # onCommitChain, nextFilingTick, getChangesSince/getChangesToPush/collect*, resolveLogEntry, pruneTombstones
  - packages/quereus-sync/src/sync/sync-context.ts             # SyncContext.onCommitChain / nextFilingTick; deleteRowVersionsAndLogEntries
  - packages/quereus-sync/src/sync/staged-transaction-metadata.ts
  - packages/quereus-sync/src/sync/rekey-on-pk-change.ts       # re-filing keeps positions
  - packages/quereus-sync/src/sync/snapshot.ts                 # header = fresh tick; positions carried; tombstones get change-log entries
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # same, streaming
  - packages/quereus-sync/src/sync/snapshot-identity.ts
  - packages/quereus-sync/src/sync/protocol.ts                 # ChangeSet.cursor, replyWatermark, position on snapshot entries and migrations
  - packages/quereus-sync/src/sync/wire.ts                     # codec for cursor and positions; PROTOCOL_VERSION 3
  - packages/quereus-sync/src/sync/manager.ts                  # interface docs only
  - packages/quereus-sync-client/src/sync-client.ts            # advanceReceivedWatermark uses replyWatermark
  - packages/quereus-sync/test/sync/late-arrival-delta.spec.ts # NEW: reproduction and the behaviours listed below
  - docs/sync-protocol.md
  - docs/sync-transactions.md
  - docs/sync.md
  - tickets/backlog/bug-sync-local-edit-during-apply-diverges.md  # description updated, see below
difficulty: hard
repro: verified
----

## What changed

Every change now has two timestamps. Its **origin timestamp** (`hlc`) is when it was written and by whom, as before: it decides which write wins, names the transaction, and is what the sent watermark counts. Its **filing position** is where a replica put it in its own change log. A replica files what it writes at the change's own HLC, and what it receives at a tick of its own clock taken when the change is committed. So positions rise in the order changes reach the replica, whatever their write times. The received watermark, the `sinceHLC` of `get_changes`, the delta floor and a snapshot's header HLC are now positions. A position is an HLC value, so no type or encoding changed, but it only means something to the replica that issued it.

A `getChangesSince` reply lists its sets in filing order. Each set carries `cursor`, its greatest position, left off when it equals the set's `hlc`. The reader's next watermark is `replyWatermark(reply)` (exported from `@quereus/sync`): the greatest `cursor ?? hlc`. `SyncClient` uses it. Pushes are unchanged: `getChangesToPush` and the sent watermark stay on write time and carry no cursor.

`PROTOCOL_VERSION` is 3. Stored data needs no migration: an absent position, or an empty change-log value, means "filed at its HLC", which is what every existing record is.

## How to exercise it

The scenario, at the `SyncManagerImpl` layer (`late-arrival-delta.spec.ts` has `push`, `pull` and `bootstrap` helpers that mirror what a client does):

1. Device B writes row 1 and pushes to server S. Device C pulls from S.
2. B makes a change offline.
3. A newer change reaches S (S writes locally, or a third device pushes). C pulls, or bootstraps from S's snapshot.
4. B pushes its offline change.
5. C pulls from its watermark and must now have B's change.

Things worth trying by hand or adding to: an offline change that is a `drop table` or `alter table`; a long offline backlog that needs several push batches; two servers; a coordinator restart between steps 4 and 5 (the clock is persisted in the same write as the positions, but nothing tests a crash).

## Tests added

`packages/quereus-sync/test/sync/late-arrival-delta.spec.ts` (new):

- The reproduction, as one table-driven test over six cases (offline delete, update, insert, new table with a row; newer change from the server or from a third device; catch-up by pull or by snapshot) plus the control (a change written after the device caught up). All six failed before the fix; the control passed.
- "is delivered when replies are cut between late and on-time transactions, each transaction once": a server with `batchSize` equal to one insert, late and on-time inserts interleaved; every row arrives and no transaction is delivered twice.
- "is still served by a replica restored from the server's stored snapshot": the server's streaming snapshot is serialized through the wire codec and JSON, applied to a fresh replica with the same site id, and a device whose watermark was taken on the original server pulls a late insert and a late delete from the restored one.
- "does not make a device restored from the server's snapshot push its own earlier writes again".
- "applies that overlap on one replica are filed in the order they commit": the apply that starts first and carries the older write is held in its data write; a reader that reads between the two commits still receives the later-committed one.

Elsewhere:

- `change-grouping.spec.ts`: ordering and cutting by position with the cursor emitted for a late change; one transaction filed at two ticks becomes two sets with their own cursors; a migration's stored position is stripped and a late migration is grouped with its transaction's data.
- `delta-floor.spec.ts` (rewritten, see below): floor equals the pruned delete's position; a late delete raises the floor to where it was filed, refusing a watermark between its write time and that position and admitting one at it; the floor only moves forward.
- `relay-rekey-on-pk-change.spec.ts`: after a key change a record keeps where it was filed, so a reader past it is not sent it again and a reader behind it still is.
- `wire.spec.ts`: `cursor` round-trips and is omitted when absent.
- `sync-client.spec.ts`: the client resumes from a reply's cursor, not from the write time of a late change.

Five of these were checked by breaking the code and seeing exactly that test fail: the origin filter in `getChangesToPush`, the tombstone change-log entry on snapshot apply, the cell position in the streaming producer, the position kept by the re-key pass, and the client's use of `replyWatermark`.

## Existing tests whose assertions changed

Please look at these rather than take them on trust.

- `delta-floor.spec.ts`: the old second test asserted that a straggler delete with an older HLC, pruned later, leaves the floor where it was. That is now the opposite of the required behaviour, so it was replaced by the late-delete test above. The forward-only property is kept by a new test that prunes another site's delete first and the replica's own, earlier-filed delete second.
- `store-and-forward-relay.spec.ts`: two tests expected a held (forwarded) change to interleave with applied changes "in global HLC order". A held change now sits at its own HLC and applied ones at the relay's filing ticks, so the expected order changed, and the held part of a transaction no longer joins the applied part in one set. The "bound" test still proves each change is delivered exactly once across rounds.
- `sync-coordinator/test/websocket.spec.ts`: the delta-floor test took the reader's watermark from the writer's HLCs. It now reads it from a `changes` reply. It also needed a reader site id of its own: the file's `TEST_SITE_ID_2` decodes to the same 16 bytes as `TEST_SITE_ID_1`, so a reply to it is always empty. Other tests in that file still use that pair.
- `apply-order-independence.spec.ts`, `changelog-orphan-cleanup.spec.ts`: three tests compare stored cell records between replicas, or between one apply and several. They now leave out `position` (`withoutPosition` in `_peer-harness.ts`), because each replica files a fact at its own position.
- Watermark walks in `sync-manager.spec.ts`, `schema-alter-replication.spec.ts`, `sync-protocol-e2e.spec.ts` and `store-and-forward-relay.spec.ts` moved from `cs.hlc` to `replyWatermark`. One of them (`sync-manager.spec.ts`, the multi-round walk after collapsed same-pk deletes) failed until it did.
- Signature-only updates: `change-log.spec.ts`, `keys.spec.ts`, `tombstones.spec.ts`, `staged-transaction-metadata.spec.ts`, `store-adapter-seam.spec.ts`.

## Where the implementation departs from the ticket's design

- **Order of facts within one filing tick.** The ticket asked for a batch's migrations to take the lowest `opSeq`s of the tick and also for each source transaction to have contiguous `opSeq`s. Those conflict: with transactions W (data only, older) and X (DDL and data), X's migration would sit before W's data and X's data after it, so a reply cut between the two sets could carry the cursor past X's migration without sending it. Facts are instead filed in origin-HLC order. That keeps each transaction's facts side by side with its own migrations first, which is the same relative order the old origin-sorted delta produced. A migration no longer sorts ahead of an older transaction's data in the same tick.
- **`sm:` record layout.** The record is a fixed binary layout ending in "rest of buffer", so a field cannot be appended. The position is announced by the high bit of the type-length byte (type names are short ASCII, so the bit was never set), and `SYNC_METADATA_FORMAT_VERSION` did not move. The alternative was a format bump, which forces every replica to re-bootstrap.
- **Stale change-log entries are skipped.** `resolveLogEntry` returns nothing for an entry whose record is filed at another position. The cursor arithmetic needs this: an entry resolving to a record filed elsewhere could carry a reply's resume position past facts it does not hold. `repairChangeLog` removes such entries. This changes one observable detail of `bug-sync-local-edit-during-apply-diverges` (backlog): the leftover entries of the overwritten local edit are no longer pushed. The core defect there is unchanged. I re-ran its scenario and updated that ticket's table and explanation.
- **Snapshot apply now writes a change-log entry for each tombstone**, in both paths. It wrote none before, so a replica rebuilt from a snapshot could not serve any delete through an incremental read. The restored-replica test needs it. A side effect: the change log after a bootstrap has one more entry per tombstone.
- **Held (store-and-forward) changes** keep their origin HLC as their place in a reply, as the ticket said. The consequence the ticket did not spell out is the split described under the relay tests above.

## Known gaps

- **Not measured:** storage growth (each received fact stores a 30-byte origin in its change-log value and about 47 bytes of position in its cell or tombstone record; a received migration 30 bytes), and the throughput effect of serializing each apply's final write on the commit chain.
- **No crash test.** The clock is written in the same batch as the positions taken from it, and a snapshot header tick persists the clock before it is handed out. Both are by construction only.
- **End-to-end run was a throwaway**, as the ticket allowed. Three scenarios (offline delete, update, insert) ran through three real `SyncClient`s and a live coordinator over WebSocket. They passed, and all three failed when I temporarily made the coordinator file received changes at their write time. It found nothing the lower layers miss, so the spec was deleted. The committed coverage of the client is the one `sync-client.spec.ts` test.
- **Changes already skipped before this lands stay skipped** until the affected device takes a snapshot. Nothing detects them.
- **Snapshot apply still merges the header HLC into the clock after writing the metadata**, not before. A local write in between is the existing "writes during a bootstrap" gap (`feat-sync-bootstrap-write-gate`).
- `quoomb-web` builds against the change but was not run.
- The `relay` / `relayAll` helpers in `_peer-harness.ts` still set the watermark to the sender's current clock value. That is at or above every position the sender has issued, so it remains valid, but it is not what a client does.

## Tripwires parked

- `sync-manager-impl.ts`, `getChangesToPush`: the scan stops at a batch boundary in filing order while the sent watermark moves in write order. They agree for facts written here. A replica restored from one server's snapshot that pushes its own restored facts to a different server could leave an older one behind the watermark. `SyncClient` pushes to one server.
- `snapshot-stream.ts`, footer clock merge: on a resumed transfer a copied position can be above the original header that is merged into the clock.

## Validation

`yarn build`, `yarn typecheck`, `yarn lint` clean. `yarn test`: no failures (quereus-sync 869, quereus-sync-client 118, sync-coordinator 141, engine 11048 with 26 pending as before). No pre-existing failures were seen.

A line for the `PROTOCOL_VERSION` bump was written to the untracked `.release-notes.pending.md`, which did not exist beforehand.
