description: When one device reconnects and uploads changes it made offline, another device that is offline at that moment may never receive them, because it has already caught up past their timestamps. The server now hands out changes in the order they reached it, so every device that catches up gets them.
architecture: docs/sync-protocol.md#delta-sync-optimization
files:
  - packages/quereus-sync/src/metadata/filing-position.ts      # FiledAt, filingPosition, positionsFrom, compact encoding
  - packages/quereus-sync/src/metadata/change-log.ts           # key = position, value = origin HLC when different
  - packages/quereus-sync/src/metadata/column-version.ts       # optional position (`fp`)
  - packages/quereus-sync/src/metadata/tombstones.ts           # optional position (`fp`)
  - packages/quereus-sync/src/metadata/schema-migration.ts     # optional position, announced by the high bit of the type-length byte
  - packages/quereus-sync/src/sync/change-applicator.ts        # commitChangeMetadata -> fileAtNextTick on the commit chain
  - packages/quereus-sync/src/sync/change-grouping.ts          # groups by (transaction, filing tick), emits cursor
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # onCommitChain, nextFilingTick, getChangesSince/getChangesToPush, resolveLogEntry, pruneTombstones
  - packages/quereus-sync/src/sync/snapshot.ts                 # header = fresh tick; positions carried; tombstones get change-log entries
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # same, streaming
  - packages/quereus-sync/src/sync/protocol.ts                 # ChangeSet.cursor, replyWatermark
  - packages/quereus-sync/src/sync/wire.ts                     # PROTOCOL_VERSION 3
  - packages/quereus-sync-client/src/sync-client.ts            # advanceReceivedWatermark uses replyWatermark
  - packages/quereus-sync/test/sync/late-arrival-delta.spec.ts # reproduction and behaviours
  - docs/sync-protocol.md
  - docs/sync-transactions.md
  - docs/sync.md
repro: verified
----

## What was built

Every change now has two timestamps. Its **origin timestamp** (`hlc`) is when it was written and by whom: it decides which write wins, names the transaction, and is what the sent watermark counts. Its **filing position** is where a replica put it in its own change log. A replica files what it writes at the change's own HLC, and what it receives at a tick of its own clock taken when the change is committed, so positions rise in the order changes reach the replica. The received watermark, the `sinceHLC` of `get_changes`, the delta floor and a snapshot's header HLC are positions.

A `getChangesSince` reply lists its sets in filing order. Each set carries `cursor`, its greatest position, left off when it equals the set's `hlc`. The reader's next watermark is `replyWatermark(reply)`, exported from `@quereus/sync`. Pushes are unchanged: `getChangesToPush` and the sent watermark stay on write time.

`PROTOCOL_VERSION` is 3; clients and the coordinator must be upgraded together. Stored data needs no migration: an absent position means "filed at its HLC". Changes a device already missed before upgrading stay missed until that device takes a snapshot.

Where the build departed from the fix-stage design (facts within one tick are filed in origin order; the `sm:` position is announced by a spare bit rather than a format bump; stale change-log entries are skipped; snapshot apply writes a change-log entry per tombstone; a transaction partly applied and partly held is served as two sets) is described in `ticket(implement): bug-sync-late-push-skipped-by-newer-watermark` and in the docs listed above.

## Review findings

### What was checked

- **The implement diff, read before the handoff**: all 27 source files, the new spec, and the specs whose assertions changed.
- **Position order equals commit order.** The three places a clock tick is taken (`recordCommitBatch` for a local transaction, `fileAtNextTick` for a remote apply, `nextFilingTick` for a snapshot header) each run as one entry on the commit chain and write in that entry. No caller of `commitChangeMetadata` runs inside a chain entry (the wire apply, the held-change drain and the lens-redeploy drain all run outside one), so the new `onCommitChain` call cannot wait on itself.
- **Every change-log writer and deleter** (26 call sites outside the stores themselves, listed by grep) passes the record itself, not a bare HLC, so each addresses the entry by position. The local-capture, apply, re-key, snapshot, prune and repair paths were each read.
- **Reply cutting.** A cut lands between (transaction, tick) groups; a schema migration filed past the cut is dropped by the grouper and picked up by the next request; a migration-only group costs no batch budget. Read, and exercised by the committed batch-cut test.
- **Other consumers of a reply.** The coordinator's `push_changes` broadcast never moves the received watermark; `SyncClient.handleRequestChanges` and `isReplicaEmpty` call `getChangesSince` but track no watermark from it. No other package derives a watermark from `ChangeSet.hlc`.
- **Scenarios the handoff listed as untried**, run as a throwaway spec against real engines and then deleted: an offline `alter table add column` plus an update of the new column; an offline `drop table`; an offline backlog of 13 transactions pushed in more than two batches with the reader pulling between batches; two servers in a chain with a reader behind the second. All four delivered the late changes.
- **Changed assertions** in `delta-floor.spec.ts`, `store-and-forward-relay.spec.ts`, `websocket.spec.ts` and `sync-client.spec.ts`: each new expectation follows from the new rule, and none loosens a check to get a pass. No test was cut: the new tests each pin a distinct behaviour (the reproduction table, batch cut, restored replica, no re-push after restore, overlapping applies), and the client test exercises the real `SyncClient` against a stub manager it does not own.
- **Docs**: `docs/sync-protocol.md`, `docs/sync-transactions.md`, `docs/sync.md` and `packages/quereus-sync/README.md` read against the code. `docs/sync-coordinator.md` and `docs/sync-schema.md` needed no change.
- **Validation**: `yarn build`, `yarn typecheck`, `yarn lint` clean. `yarn test`: no failures (quereus-sync 869, quereus-sync-client 118, sync-coordinator 141, engine 11048 with 26 pending). No pre-existing failures seen.

### Found and fixed in this pass (minor)

- `protocol.ts`: the `ChangeSet` and `ChangeSet.hlc` doc comments still said a transaction is never split and that a reader resumes from `ChangeSet.hlc`. Both are now wrong for a `getChangesSince` reply; rewritten to say when a transaction is split and to point at `replyWatermark`.
- `sync-coordinator/test/websocket.spec.ts`: `TEST_SITE_ID_2` (`…AAB`) decoded to the same 16 bytes as `TEST_SITE_ID_1`, as the handoff noted, so the "two different sites" in that file were one. Changed to `…AAQ` (last byte `0x01`), and the delta-floor test uses it instead of a generated id. All 141 coordinator tests still pass.
- `snapshot-stream.ts`, the note on the footer clock merge: it said a copied position can exceed the merged header only on a resumed transfer. The sender reads its records after issuing the header on every transfer, so any change it files during one is copied above the header. Note reworded to say so and to cover the non-streaming apply.

### Found and filed (major)

- **A held change that arrives late is not relayed to a caught-up reader.** Under the non-default `store-and-forward` setting, a change the relay holds (for a table it has retired) is still offered by write time, not by arrival order. Reproduced: a held insert written before the reader's last pull and pushed after it is absent from the reader's next reply and present in a from-nothing reply. This is the defect this ticket fixed, on the one path left on write time. The site carried an "accepted limitation" note whose stated reason was that applied changes had the same limit; that reason no longer holds, which is why it is filed rather than left alone. Filed as `backlog/bug-sync-held-change-late-arrival-not-relayed` (no open ticket claimed `collectForwardableChanges` or the quarantine store). The code comment and the `docs/sync.md` bullet now call it a known gap and name the ticket.

### Tripwires (parked at the site, not ticketed)

- `sync-manager-impl.ts`, `getChangesToPush`: the scan cuts in filing order while the sent watermark moves in write order; they can disagree only for a replica restored from one server's snapshot that pushes to a different server. Parked by the implementer; confirmed still accurate.
- `snapshot-stream.ts`, footer clock merge: a position copied from the sender can sit above the header merged into the receiver's clock; matters only if the receiver's clock is behind the sender's and the receiver then serves deltas. Reworded in this pass (above).

### Not done, and why

- **No crash test.** The clock is written in the same batch as the positions taken from it, and a snapshot header persists the clock before it is handed out. Verified by reading only; the in-memory store has no partial-write mode to test against.
- **Storage growth and apply throughput were not measured** (about 30 bytes per received change-log entry and about 47 per received cell or tombstone record; one serialized write per apply). No benchmark suite covers sync yet (`backlog/feat-bench-isolation-and-sync-suites`).
- **`quoomb-web` was built but not run.**
- **Empty categories.** No resource-cleanup, error-handling or type-safety defect was found: the change adds no handles or timers, `onCommitChain` passes a failure to its caller and keeps the chain usable, and the `FiledAt` parameter type makes passing a bare HLC to a change-log writer a compile error.
