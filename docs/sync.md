# Sync Module - Multi-Master CRDT Replication

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

The architecture of `quereus-sync`, a fully automatic multi-master CRDT replication system for Quereus. It enables offline-first applications where multiple replicas independently modify data and converge to a consistent state.

## Topic documents

| Document | Covers |
| --- | --- |
| [Sync Protocol](sync-protocol.md) | Wire data structures, the `SyncManager` API, and the WebSocket message protocol — versioning, connection lifecycle, delta sync, reconnection, debouncing, snapshot bootstrap. |
| [Sync: Transactions](sync-transactions.md) | Grouping changes by source transaction, and keeping a sync apply and its metadata atomic. |
| [Sync: Unknown Tables](sync-unknown-tables.md) | Changes for a table the receiver does not have: the `unknownTableDisposition` choices, the store-and-forward relay, replay when the table returns, and who drives the maintenance sweeps. |
| [Sync: Schema Replication](sync-schema.md) | Replicating the catalog — tables, columns, indexes — and shipping an initial schema as a syncable seed. |
| [Sync Coordinator](sync-coordinator.md) | The standalone relay server: HTTP and WebSocket surfaces, its hook-based service layer, configuration, logging, security and performance notes. |
| [Schema Migration in a Synced Database](migration.md) | Evolving an app's schema when peers upgrade at different times: the frozen shared basis, the parallel-table pattern, and retiring, diverting, and reviving a table. |

## Design Goals

- **Fully Automatic**: every table in the store is CRDT-enabled; no opt-in.
- **Automatic Schema Evolution**: schema changes are tracked and synchronized without special handling.
- **Transport Agnostic**: exposes sync data structures and APIs, assuming no transport layer.
- **Backend Agnostic**: LevelDB (Node.js) and IndexedDB (browser), via the store plugin.
- **Reactive**: hooks for UI reactivity on local or remote data changes.
- **Transaction-Aware**: changes are grouped by transaction for atomic sync operations.

## Architecture Overview

Three layers:

- **Application** — the Quereus `Database`, the reactive sync hooks, and a user-provided
  transport (WebSocket / HTTP / WebRTC / …).
- **`quereus-sync`** — the HLC clock, the metadata store, the sync protocol and the schema
  tracker, wrapped by `SyncModule`, which intercepts mutations, records CRDT metadata, and
  delegates to the layer below.
- **`quereus-store`** — LevelDB (Node.js) or IndexedDB (browser), holding data *and* CRDT
  metadata in one backend.

## Core Concepts

### Hybrid Logical Clock (HLC)

A Hybrid Logical Clock establishes causal ordering of events across distributed replicas, combining:

- **Physical Time**: Wall clock time in milliseconds for rough ordering
- **Logical Counter**: Disambiguates events within the same millisecond
- **Site ID**: 16-byte UUID identifying each replica
- **opSeq**: Per-transaction sub-order disambiguating facts of the *same* transaction

```typescript
interface HLC {
  wallTime: bigint;      // Physical time (ms since epoch)
  counter: number;       // Logical counter (0-65535)
  siteId: Uint8Array;    // 16-byte replica UUID
  opSeq: number;         // Per-transaction sub-order (0-based uint32)
}
```

HLC ordering: `(wallTime, counter, siteId, opSeq)` compared lexicographically. Higher wall
time is newer; equal wall times order by counter; ties break deterministically by site ID;
and facts of the *same* transaction (same `wallTime`, `counter`, `siteId`) order by `opSeq`.

`opSeq` is the data-model layer for "HLC = transaction" grouping: a contiguous,
0-based sub-order assigned per transaction. Because `siteId` is compared **before**
`opSeq`, two different sites never reach the `opSeq` tiebreak, so `opSeq` only ever
discriminates facts produced by one site at one `(wallTime, counter)` — i.e. within a
single transaction. It is **transaction-local**: it resets every transaction and is
**not** persisted in the `hc:` clock state.

Encoding widths: the comparison key serializes as 30 bytes —
8 (`wallTime`) + 2 (`counter`) + 16 (`siteId`) + 4 (`opSeq`, big-endian uint32) —
both for storage (`serializeHLC`) and as the sortable change-log key component
(`serializeHLCForKey`), where the `opSeq` bytes sit after `siteId` so lexicographic
key order matches `compareHLC`.

**Clock-drift bound — rejected pre-commit.** A remote HLC whose `wallTime` exceeds
the local wall time by more than `MAX_DRIFT_MS` (60 s) is rejected: a peer with a
badly-wrong clock would otherwise land far-future LWW winners that permanently beat
every legitimate future write. The check (`assertWithinDrift` in `clock/hlc.ts`) is a
side-effect-free bound shared by the apply paths and `HLCManager.receive`, and runs as
**pre-commit validation** — the wire path on the batch's maximum fact HLC at the top of
`applyChanges`, the snapshot path on the header HLC before `clearExistingMetadata`,
both **before any data or CRDT metadata is written**. A rejected drifted batch/snapshot
therefore lands **nothing** (the receiver's existing metadata is not even cleared);
`receive`'s own late check is a last-line defense.

### Conflict Resolution: Column-Level Last-Write-Wins (LWW)

Each column of each row is tracked independently; when the same column is modified on multiple replicas, the highest-HLC write wins.

```
Replica A: UPDATE users SET name = 'Alice' WHERE id = 1  @ HLC(1000, 1, A)
Replica B: UPDATE users SET email = 'b@x.com' WHERE id = 1  @ HLC(1000, 2, B)

After merge: Row has name='Alice' (from A) AND email='b@x.com' (from B)
```

This is more fine-grained than row-level LWW, preserving more user intent.

#### Pluggable Conflict Resolution

Setting `conflictResolver` on `SyncConfig` replaces the default LWW strategy. The resolver is called for every column-level conflict where a local version already exists.

```typescript
import { createSyncModule, localWinsResolver, remoteWinsResolver } from '@quereus/sync';
import type { ConflictResolver } from '@quereus/sync';

// Custom: per-column policy. Built-ins: localWinsResolver (target-wins),
// remoteWinsResolver (source-wins).
const resolver: ConflictResolver = (ctx) => {
  if (ctx.column === 'counter') return 'remote';  // max-wins simulation
  return 'local';                                  // default: keep local
};
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: resolver,
});
```

When no `conflictResolver` is configured, the fast-path HLC comparison is used directly (no extra KV read per column). Schema conflicts remain non-pluggable.

The `ctx` (`ConflictContext`) also carries the incoming change's optional before-image as
`ctx.remotePriorValue` / `ctx.remotePriorHlc` — the value (and its HLC) the remote write
overwrote at its origin (see § Data Structures → per-cell before-image) — so a resolver or
transition validator can see what the source changed *from* (e.g. accept the remote only if
it transitioned from the value the receiver still holds). Both are absent when the incoming
change carried no prior. Neither affects last-writer-wins resolution. Whether a change carries
a before-image at all does decide one default outcome: an edit of a row the replica has
forgotten is refused (§ Tombstones and Deletions).

> **Future Work**: The architecture supports extending to other CRDT types (counters, sets, RGA for text) by tracking different metadata per column type.

### Tombstones and Deletions

Deletions are recorded as "tombstones" with an HLC timestamp, preventing deleted rows from being resurrected by older writes arriving later.

**Resurrection Policy** (configurable):
- **Default: Delete Wins** (`allowResurrection: false`) - once a row is tombstoned, **all** subsequent column writes for it are blocked — regardless of the write's HLC — until the tombstone is pruned (see **Tombstone TTL** below)
- **Optional: Resurrection Allowed** (`allowResurrection: true`) - an insert/update with HLC > the tombstone's T1 resurrects the row; writes with HLC ≤ T1 stay blocked

**A delete still holds against an edit after its tombstone is pruned.** Pruning is a storage limit and does not change who wins. Under the default policy, a replica that has pruned at least one tombstone (its delta floor is set) refuses a column change that carries a before-image when it holds no cell and no tombstone for that row: the writer saw an earlier version, and this replica cannot tell a row it forgot from one it never heard of. The change counts as `skipped` and fires no event, so the writer's edit is lost as it would be while the tombstone exists; its application sees the row leave through the snapshot's ordinary remote delete. Replicas that have never pruned have forgotten nothing and accept the edit, and the before-image is not compared with the floor, because the edit can be concurrent with the pruned delete.

A row with a first write in the same batch, in either order, is accepted: a primary-key cell never carries a before-image, even rewritten to a new spelling under `NOCASE`, and a relay never adds one, so a new row inserted then edited offline always has one such cell to show. So is a row with cells here from an earlier batch, which a device's timestamp-ordered pushes guarantee. So is any row of a table the same batch renames, because the records still answer to the old name while the rule reads. This rule does not cover:

- **A re-sent insert.** It carries no before-image, so a whole row returns on the server and the writer while a replica holding the tombstone stays without it (`bug-sync-resent-insert-returns-pruned-row`).
- **A row sync never recorded.** Its first edit records the whole row with no before-image, so it behaves as a re-sent insert: the row returns on the server and the writer while a replica holding the tombstone stays without it (see [Rows sync has never recorded](#rows-sync-has-never-recorded)).
- **A row of a table whose key the same batch redefines.** The rule reads by the new key before the batch's re-filing pass runs (below), so it accepts the edit, and a fragment can return in that one batch. A key redefined by an earlier batch exempts nothing: its pass re-filed the records, on a relay too.
- **A key rewritten to a new spelling.** An offline edit of a forgotten row that also rewrites its key's spelling counts as a first write and brings a fragment back.
- **`allowResurrection: true`**, whose own fragment bug is `bug-sync-allow-resurrection-update-returns-partial-row`.
- **Fragments already stored** on a server, which are not repaired.

**The rule applies within one apply batch too**: a delete carried in an `applyChanges` batch blocks that same batch's column changes for its row exactly as an already-stored tombstone would (the row's max-HLC in-batch delete is the blocker; under `allowResurrection` a column change with a later HLC survives it). One batch therefore leaves the same **state** as the same changes applied across separate batches, and re-emits identical changes onward. The *event stream* is not identical: `onConflictResolved` fires before the in-batch reconciliation runs, so a change that ends up blocked can still have emitted one, and a delete + re-creation collapses to a single net store event rather than a delete followed by an insert.

**`applyChanges` is order-independent.** A batch may arrive in any order and produces the same committed state as the HLC-ordered array. This is a contract callers can rely on rather than re-derive: `getChangesSince` returns transactions in the order the serving replica filed them, which is not write order once any change reached it late, and `applyChanges` takes whatever array its caller hands it — the coordinator's `onBeforeApplyChanges` approval hook returns a caller-supplied array, the REST/WebSocket ingress accepts an arbitrary array from any client, and a caller merging two senders' changesets produces an interleaving neither sender emitted. Resolution and the in-batch delete reconciliation already decide by HLC; the three lists that reach the store as plain arrays are sorted by HLC in `change-applicator.ts` before they leave it — the data ops (`orderDataChangesByHLC`), the DDL (`orderMigrationsByHLC`), and the `onRemoteChange` payload. Without that, the two layers answer "which write survives" by two different rules: the store adapter replays each row group in **list** order (`DataChangeToApply` carries no timestamp), so a reordered batch could delete a row from the table while the metadata recorded it as resurrected — leaving the replica advertising a row it does not have. Everything else in an apply (the `ApplyResult` counters, quarantine holds, the clock watermark max) is order-insensitive by construction. The guarantee covers committed **state**, not the event stream: `onConflictResolved` fires in arrival order, and an `onUnknownTable` event names the first changeset that referenced the table as the straggler origin, so a reordered batch can attribute it to a different relayer — telemetry only, never a stored fact.

**A primary-key change tombstones the old identity.** Sync sees the engine's data events, and
those split a key change that *moves* a row into a `delete` at the old key followed by an
`insert` at the new one ([usage § Subscribing to Data Changes](usage.md#subscribing-to-data-changes)).
So `update t set id = 2 where id = 1` records a tombstone at `pk [1]` and a full cell set — every
column, not just `id` — at `pk [2]`. That is what stops the receiving peer from ending up holding
both rows, and it means a table that re-keys rows routinely accrues tombstones at the same rate,
each held to the TTL below. A key rewrite that does *not* move the row (a case-only change under
a `NOCASE` key) stays one update and tombstones nothing.

**A primary-key *redefinition* re-files the bookkeeping.** `alter table t alter primary key (…)` changes which columns make the key, not which rows exist: the engine re-keys the table in place and emits one `alter`/`table` event, with no per-row events. Every `cv:`/`tb:`/`cl:` record is filed under the row's identity *under the key in force when it was written* and carries that key's values, so sync re-files them itself (`sync/rekey-on-pk-change.ts`), with the post-change schema in force, wherever a key change becomes known: the local commit capture (into the transaction's own batch, ahead of its data records, which the engine already re-keyed) and the replicated apply (Phase 3, from the DDL that actually executed, before the batch's own metadata is filed) — so in both the batch's own records win over re-filed ones. The pass re-files exactly the transition the statement made, old key → new key, and reads neither from the catalog: the engine's event names the retired key as `oldKeyColumns` (the replicated path reads it from the schema before the DDL runs), and the statement's own `alter primary key (…)` list names the new one — the catalog's *current* key is not the target, because a later key change may already have moved it on by the time an earlier change's capture runs, and the later change's pass then expects the records under the key the earlier one installed. On a peer with an engine, a live row's new key is read from the table: one scan matches rows to records by their *old* identity under the retired key's keying, and a cell record whose row the table no longer holds is dropped. On a relay — a peer with sync records but no catalog and no table, the shape of the coordinator — the new key is read from the records themselves: every cell record carries its column name and value, so a row's new key comes from its own cells under the statement's column list (matched case-insensitively), and the old identity is the record's key, so the relay never needs the old key. A relay row group with no cell for a key column cannot be moved and stays where it is, counted (`rowsStranded`) and warned about rather than deleted, because the relay may hold the only copy; a key built on a column added after the rows were written is the open case `bug-sync-key-on-column-without-cells-through-relay`. A record moving in never overwrites a newer record at its target — a relay's rows are not checked for uniqueness, so two old rows can land on one new key, and a duplicate push of the same key change can apply alongside — and the loser's change-log entry goes with it. A deleted row's new key comes from its tombstone's `priorRow`, when present and of the table's column layout: the catalog's on an engine peer, and on a relay the `columns` list the `alter primary key` migration carries from the engine's event, since the image is positional and the relay has no other way to read it. A tombstone whose new key cannot be determined — no usable before-image, or a key a *different* live row now owns — is dropped; two tombstones the new key no longer separates keep the newer. The counts land on `onPrimaryKeyRekeyed` and, when anything was dropped or stranded, in a warning: a dropped deletion no longer protects against a stale write from a peer, the honest cost of redefining a key.

**What a key redefinition does not cover.** A change already on the wire, or recorded by a peer that has not yet applied the key change, carries pk values under the *old* definition; a re-keyed receiver cannot address a row by them and cannot tell which definition the sender used (the `NOTE:` at the pk-projection site in `store-adapter.ts`). That is the concurrent-DDL-versus-data race — the same class as a write to a table a peer has concurrently dropped and re-created (*Table identity* below) — and a change that carried the sender's schema version for the table (the `sm:` version counters exist) would make it detectable. Within one inbound batch the receiver resolves the batch's data changes *before* its DDL runs, under the old keying, so it sees no local prior for a row the batch's own key change re-files; Phase 3 re-reads those priors after the pass so the change log stays consistent, but the last-writer decision for a cell both sides edited across the key change is not revisited (the data is already written). Quiesce writes to a table around a key change. Nothing serializes applies on one manager either, so another device's data write can interleave with a relay's pass — the same race; a duplicate push of the same key change is safe, because the pass reads each record's key from the record.

**Tombstone TTL**: retained for a configurable duration (default 30 days); sync attempts after expiry should fall back to full snapshot transfer.

**A delete the replica has not delivered does not expire.** A tombstone is also the only way a local delete reaches the server: `getChangesToPush` reads the change log past the sent watermark and resolves each delete entry through its tombstone. So `pruneTombstones` keeps a tombstone, whatever its age, when this replica wrote it (`tombstone.hlc.siteId` is this site) and either no `pt:` record exists or its HLC is above the lowest sent watermark across all `pt:` records. Everything else expires by age. Without this rule, a device offline past the horizon would forget its own deletes, and the rows would come back when it reconnected.

- **Only the replica's own deletes.** `getChangesToPush` sends only what this replica wrote, and a replica that only receives never gets a sent watermark, so other devices' deletes still expire on it. The coordinator wires no transaction source, so it has no tombstones of its own and the rule never matches there.
- **The lowest watermark, because a replica can push to more than one server.** A server that has not acknowledged anything yet has no `pt:` record and is not counted.
- **Acknowledged, not sent.** The watermark advances on the server's acknowledgement, so a push in flight during a sweep does not count as delivered.
- **The delta floor** rises only when a tombstone is actually pruned, on the sweep after the watermark reaches it.
- **A late delete gets a full retention period on the server**, because applying it stamps `createdAt` with the current time.
- **A late delete reaches every device that catches up with the server**, including one that had already received changes written after it. The server files the delete at the position it arrived at, and a device's received watermark counts positions in the server's change log, not write times ([sync-protocol.md § Delta Sync Optimization](sync-protocol.md#delta-sync-optimization)).

What this costs and leaves open:

- A replica that writes locally but never pushes (a `readOnly` client, a peer others only pull from, a device that never connects) keeps its own tombstones forever.
- A server the device no longer talks to keeps its `pt:` record, which holds the minimum down, so own tombstones stop expiring. The cost is storage only.

**Tombstones travel in snapshots**, on **both** paths, so a fresh replica ends with the sender's tombstones — a row deleted before the snapshot stays deleted, and a later stale write for it stays tombstone-blocked. The streaming path (`getSnapshotStream` / `applySnapshotStream`) carries them as a global `tombstone`-chunk pass; the non-streaming path as `Snapshot.tombstones: SnapshotTombstone[]`, filled from a global tombstone scan and re-written after the metadata clear. Both forms are **global**, not nested under `TableSnapshot`, so a fully-deleted row with no live column-versions still travels. Caveat on both: `createdAt` is re-based to bootstrap time on the receiver, so a bootstrapped tombstone lives a full TTL horizon from the bootstrap, not from the original deletion.

### Snapshots replace rows

A snapshot apply replaces what the replica holds, one table at a time: afterwards a table the snapshot **covers** holds exactly the snapshot's rows, and a table it does not mention is untouched. Absence is the signal. A row deleted and pruned on the sender appears nowhere in the snapshot, so only its absence can remove it from a replica that fell behind, which is the replica `snapshot_required` recovery exists for.

- **What is covered.** The sender gives a section to every table it has a cell for, plus every table with a live `tg:` name → generation record in its local basis (`tablesToAnnounce`). The record outlives the rows and is retired by a drop, so an emptied table gets a section with no cells while a table the sender never hosted, or dropped, gets none. The basis check stops a stale record (a table dropped while sync was detached) from wiping a receiver's table.
- **How rows leave.** For each covered table the receiver reads its live keys through the engine and deletes each row whose derived identity is not among the snapshot's, in `DATA_FLUSH_SIZE` chunks through the same data seam as the snapshot's other writes (`removeRowsAbsentFromSnapshot`): indexes and stats follow, events are `remote: true`, and materialized views and watchers converge at `bootstrapFinalize`. A tombstoned row has no live cell, so it leaves the same way.
- **Streaming** does this once, in the footer, after the last flush. The set of rows to keep is the table's `cv:` records: the header's clear left only this snapshot's own work there, so that set survives mid-table flushes and an interrupted transfer's resume with no extra state, and a failure leaves the checkpoint in place for a retry that runs the pass again. **Non-streaming** does it inside the metadata commit, ahead of the clear, so a failure leaves the prior metadata intact and the snapshot retries wholesale.
- **Rows with no sync metadata are deleted too, once the snapshot is under way.** In a covered table that includes unpushed local inserts under an explicit `requestSnapshot()` (`snapshot_required` recovery pushes all of them first, so it is unaffected). It also includes rows sync has never recorded, but `SyncClient` checks for those before an automatic snapshot starts; see [Rows sync has never recorded](#rows-sync-has-never-recorded).
- **A materialized view is never replaced.** Its rows are derived and never carry cells, so its section is always empty. A catalog peer and a relay both announce it, so the receiver skips it and `bootstrapFinalize` rebuilds it from the replaced rows.
- **A section for a table the receiver does not have**, with no migration creating it, is skipped if it has no cells. One with cells still fails as described under [Unknown-Table Disposition](sync-unknown-tables.md#unknown-table-disposition).
- **Where the pass cannot run.** A relay-only peer (no `applyToStore`) holds no row data, so it skips silently. A peer with `applyToStore` but no engine or schema to read the table through logs a warning naming the table and leaves its rows in place.
- **No wire-format bump.** No chunk shape changed and an empty section was already legal. A snapshot stored by an older build still applies; it only fails to announce emptied tables, so their rows stay until a newer snapshot arrives.

#### Rows sync has never recorded

Sync keeps a `cv:` cell record for each cell it knows about. A row written before sync attached has none, so no sync path can see it, and a snapshot covering its table deletes it without any error. A device holding only such rows also counts as empty for `bootstrapOnEmpty`, which is on by default. What happens to these rows is therefore a client choice, `SyncClientOptions.unrecordedRows`, and the default never deletes them:

| Value | What happens to rows sync has never recorded |
|---|---|
| `'refuse'` (default) | An automatic snapshot stops before deleting anything. The error names the affected tables and this option. |
| `'replace'` | The snapshot deletes them. |
| `'adopt'` | The rows are recorded as local changes on first attach, then pushed and merged by last-writer-wins. Scans each table on first contact and on `snapshot_required`. |

- **Which snapshots are checked.** The automatic ones: the `bootstrapOnEmpty` bootstrap and `snapshot_required` recovery. On `snapshot_required` the check runs before the recovery's push, so a refused device does not drain its work to the server first; the handshake's ordinary first push has already gone by then. An explicit `requestSnapshot()` is a full replace with no check, because the caller asked for it. One started while a check is scanning wins too: the check's answer is dropped and the automatic path joins that transfer.
- **Resuming is not checked.** The header's clear already wiped the metadata, so every row would look unrecorded, and a false refusal would strand a partial database. The decision was made when the transfer started. The header saves its checkpoint *before* that clear, so a crash between the two leaves a checkpoint over intact metadata (the resume clears again), never rows that merely look unrecorded.
- **What refusing does.** The client stops the way a protocol version mismatch does: a lasting `error` status, an `UnrecordedRowsError` through `onError`, the socket closed, no reconnect until the next explicit `connect()`, which checks again. `connect()` has already resolved by then, so apps learn of it through `onError` or the status. To choose, create a new `SyncClient` with a different value and connect; the `SyncManager` and its data carry over. A check that throws is not a refusal: no snapshot follows, and the client retries through the normal reconnect.
- **What counts.** `SyncManager.findTablesWithUnrecordedRows()` reads every table in the basis, stopping each at its first row with no cell record, and writes nothing. It skips materialized views, whose rows are derived, and `memory` tables, which a snapshot cannot delete from. A custom virtual table module with rows does refuse: the exclusion is by name, so a wrapped store module is still checked and a wrong guess costs a refusal rather than data.
- **Rows that only look unrecorded.** A local commit is recorded just after it lands, and a remote apply writes rows before their records. So the check waits for commits and applies under way, and reports a table only when two scans with that wait between them name the same row.
- **Broader than what the snapshot would delete.** A table the server does not have is left alone by a snapshot, but the client cannot know the server's tables until the stream starts, and by then the header has cleared the metadata the check needs. So a table only this device has, with unrecorded rows, also refuses.
- **Only never-recorded rows count.** A row with any cell record counts as recorded, so its first edit takes a row out of the check, and a row already holding only some of its cells is not repaired. An update made while sync was detached, to a row that has records, is still a silent divergence and is not detected.
- **The first edit records the whole row.** An update that changes a value in such a row records every column with no before-image, as an insert does, so other devices receive the whole row rather than one with its other columns empty.
  - Its cells take the time of the edit, so like adopted rows they win over older server values for the same key, untouched columns included. Two devices seeded with the same row that each edit a different column therefore keep only the later edit: the earlier device's column returns to its seeded value.
  - An update that changes no value records nothing, so the row stays unrecorded and the check still finds it.
  - The device's other unrecorded rows stay local. A device with any recorded change is not empty, so no bootstrap or check runs for them until a `snapshot_required`, which refuses under the default. `'adopt'` still records them on first contact.
- **The first recorded fact announces the table.** A table created before sync attached has no migration bringing it into existence, and the coordinator keeps no table definitions, so its cells alone would be quarantined by other devices and would abort any new device's snapshot. The first insert, edit or delete sync records for such a table therefore also records a *baseline*: a `create_table` at schema version 0, and an `add_index` at version 0 per index, meaning "here is the definition, for any device that has none" (see [sync-schema.md § Baselines](sync-schema.md#baselines)). A device that already has the table keeps its own shape, so a baseline can never conflict; a device lacking it creates it; a new device's snapshot carries it. The announcement happens once per table while the manager runs: a later write reads no migrations, and the first write after a restart finds the baseline in the table's own migrations. An edit that changes no value records nothing and so announces nothing. A table whose own migrations end on a `drop_table` (dropped under sync, re-created while detached) is a real new table and gets an ordinary next-version `create_table` instead, with the usual conflict rule.
  - A `memory` table is never announced, and sync records nothing for it at all: receivers have no way to write such a table, so one of its cells would fail every receiver's batch and strand every new device, and no definition could help. The skip is logged once per table. Rows in such a table stay on the device.

##### Adopting rows

Under `'adopt'`, `SyncManager.adoptUnrecordedRows()` records every such row as an ordinary local change, using the tables `findTablesWithUnrecordedRows()` reads. Each batch of up to `DATA_FLUSH_SIZE` rows goes through local capture as one transaction, so it gets its own HLC, change-log entries and local-change event. It is idempotent: a row that has a record is skipped, so an interrupted run is finished by running it again.

- **When it runs.** On first contact with a server, meaning no received or sent state for it, whatever `bootstrapOnEmpty` says. The sent state is written on the first ack, so a reconnect before that rescans and finds nothing new. A device that adopted rows does not bootstrap, because a snapshot would delete them before they were pushed. It also runs on every `snapshot_required`, whatever the peer state, ahead of the recovery's push, so the rows are on the server when the snapshot is taken and come back in it. A row written while detached, after this server's first ack, therefore stays unrecorded and local until a `snapshot_required`.
- **The schema goes too.** Adoption is local capture, so a table's definition travels with its first batch exactly as with any first write to a table nobody announced (see *The first recorded fact announces the table* above): a baseline, unless its migrations already bring the table into existence and leave it there, or end on a `drop_table`, which gets an ordinary create. So a table with no migrations gets a baseline, and so does one with only an `alter_column` (created before sync attached, altered since). Every index is announced with its table, because a receiver replaying an older `add_index` finds no table yet and converges without the index. A table with no unrecorded rows sends nothing. A foreign key may name a table that was not sent: `create table` accepts a parent that does not exist yet. Views and assertions created before sync attached are not adopted.
- **Only store tables.** A table using another module is skipped with a warning and its rows stay on this device, as they do under plain writes. Receivers write only to store tables, so one such row would fail the receiver's whole batch, stopping other devices from syncing and new devices from bootstrapping.
- **Ordering.** Applies in flight finish first, because an apply writes rows before their records and adoption would otherwise stamp a remote row as local. The run is then one entry on the commit chain, so local commits and new applies queue behind it and overwrite it by the usual rules. A snapshot apply started during a run waits for it. Under `SyncClient`, a transfer that has already started, or a pending checkpoint, skips adoption: its header cleared the metadata, so every row would be stamped as new.
- **When it stops.** It rejects while a checkpoint exists or an explicit transaction is open, because an uncommitted row looks unrecorded and recording one that then rolls back would send other devices a row this one does not have. `SyncClient` treats any failure as a failed check: no snapshot, an error through `onError`, and a retry through the reconnect. Rows already recorded stay recorded.
- **`readOnly` cannot adopt.** The client constructor throws on the combination: nothing could ever be pushed, so the next snapshot would delete the rows.

What adoption costs, none of which can be undone once the rows are pushed:

- **Adopted rows win against older server edits.** They have no real timestamp, so they get the time of adoption. A row with the same key on the server, edited before that moment, loses.
- **Two devices adopting the same seeded data** both push every row. They converge, at the cost of the duplicate traffic.
- **Two devices adopting tables with the same name and different shapes each keep their own.** A baseline never conflicts: the receiver keeps its shape and logs the difference, and the rows then get the usual drift handling, with sender-only columns dropped and receiver-only columns left null. The same happens under plain writes to such tables.
- **A row the server deleted and pruned comes back** if a device still holds it unrecorded. Nothing on the device can tell it was ever deleted. A row whose tombstone still exists behaves as a local reinsert does: the device keeps it, and under the default `allowResurrection: false` a peer holding the tombstone stays deleted.
- **Rows a server hook rejects** stay recorded locally and are reported through the `rejected` event, like any local write. A later `snapshot_required` deletes them, as it does any local write the server refused.

### Unknown-Table Disposition

Moved to [Sync: Unknown Tables](sync-unknown-tables.md#unknown-table-disposition).

### Transaction-Based Change Grouping

Moved to [Sync: Transactions](sync-transactions.md#transaction-based-change-grouping).

### Transactional Integrity During Sync

Moved to [Sync: Transactions](sync-transactions.md#transactional-integrity-during-sync).

### Single-Database Architecture (Store Phase 7) ✓

The `UnifiedIndexedDBModule` uses a single IndexedDB database with multiple object stores (one per table), which buys native cross-table IDB transactions — sync metadata and data commit together, with no WAL needed for crash recovery, at the same storage quota. The legacy `IndexedDBModule` has none of that: separate databases per table, sequential commits, and it needs a WAL.

With `UnifiedIndexedDBModule`, sync can use `MultiStoreWriteBatch`:
```typescript
const batch = module.createMultiStoreBatch();
batch.putToStore('main.users', userKey, userData);
batch.putToStore('main.orders', orderKey, orderData);
batch.putToStore('__catalog__', metaKey, syncMetadata);
await batch.write();  // Native atomicity across all stores
```

### Store Isolation (Store Phase 8 - Future)

Store-level transaction isolation (a TransactionLayer/copy-on-write model like the memory vtab's) would let sync stage data and CRDT metadata invisibly and reveal them atomically on commit, closing the isolation gap. Unimplemented; tracked as Phase 8 in store.md and in [`docs/todo.md` § Sync Engine Remaining Work](todo.md#sync-engine-remaining-work).

## Storage Layout

CRDT metadata is stored alongside data in the same KV store using distinct key prefixes:

| Prefix | Purpose | Format |
|--------|---------|--------|
| `tg:⟨schema⟩⟨table⟩` | Table generation — the per-peer identity this name's records are filed under (see *Table identity*) | `{generation (16 bytes), mintedAt}` |
| `cv:⟨generation⟩⟨pkIdentity⟩⟨col⟩` | Column version | `{hlc, value, pk, position?}` |
| `tb:⟨generation⟩⟨pkIdentity⟩` | Tombstone | `{hlc, createdAt, pk, priorRow?, position?}` |
| `cl:{position}{type}⟨generation⟩⟨pkIdentity⟩[⟨col⟩]` | Change-log index over `cv:`/`tb:`, in the order this replica filed each fact. `position` is the fact's filing position (see [sync-transactions.md § Filing position](sync-transactions.md#filing-position-the-order-of-the-change-log)): its own HLC for a fact written here, a tick of this replica's clock for one received | the fact's HLC when it differs from the position, else empty |
| `tx:{txId}` | *Reserved — not persisted.* The transaction id is **derived** from the base HLC (see *Deterministic transaction id*); the prefix and `buildTransactionKey` are reserved for a future durable txn log. | — |
| `ps:{siteId}` | Peer sync state (received watermark: a filing position in that peer's change log) | `{lastSyncHlc}` |
| `pt:{siteId}` | Peer sent state (highest HLC pushed to a peer and acked). The lowest across peers holds back expiry of this replica's own tombstones (see [Tombstones and Deletions](#tombstones-and-deletions)) | `{lastSyncHlc}` |
| `sm:⟨schema⟩⟨kind⟩⟨object⟩{version:010}` | Schema migration (`kind`: `table`\|`index`) | `{ddl, hlc, position?}` |
| `si:` | Site identity | `{siteId, createdAt}` |
| `hc:` | HLC state | `{wallTime, counter}` |
| `fv:` | Sync-metadata format version | decimal string (see *Metadata format version*) |
| `sc:{snapshotId}` | Snapshot checkpoint — resume position of an interrupted streaming apply (see *Checkpoint presence means partial data*) | `{snapshotId, siteId, hlc, completedTables, entriesProcessed, …}` |
| `df:` | Delta floor — greatest filing position of any tombstone this replica has pruned; below it no incremental delta is complete (see *The delta floor*) | serialized HLC |

`⟨part⟩` above is a **length-prefixed component**: `{len}:{part}`, `len` being the part's
length in string code units (`joinKeyParts`, `metadata/keys.ts`). Schema, table and column
names and pk identities are all arbitrary text — `create table "a:b"` is legal SQL, and a
pk identity freely contains `:` (type tags) and `\0` (member separator) — so no character
can be reserved as a delimiter. Carrying each part's length makes every split exact and
every key prefix unambiguous: a scan over table `a` cannot pick up table `a:b`. The
tradeoff is length-major-then-text sort order rather than alphabetical; per-table and
per-row *contiguity* — the only ordering the streaming snapshot relies on — is unaffected
(the per-row families are contiguous per *generation*, and the snapshot producer sorts the
tables it streams by name, since generation order is random per peer). Fixed-width
components (the 30-byte HLC, the 1-byte change type, `sm:`'s zero-padded version) carry no
prefix; the generation (22 base64url characters) is length-prefixed anyway so every parser
reads one encoding.

Co-location buys atomic data+metadata updates within a transaction, one storage backend for both LevelDB and IndexedDB, and no additional database connections.

### Row identity vs. address

Every per-row record splits the primary key into two roles:

- **Identity** — what the record is *filed under* (the pk component of its key).
  Derived by `encodePkIdentity` (`metadata/keys.ts`): each pk column is run
  through its logical type's semantic key transform (TIMESPAN → total seconds,
  so `'PT1H'` ≡ `'PT60M'`) and then its **key collation** normalizer (`'apple'`
  ≡ `'APPLE'` under `collate nocase`), producing the engine's type-tagged
  `serializeKeyNullGrouping` string. That matches how the store and the
  isolation overlay decide "same row?", so one row files under exactly one
  identity no matter which spelling a write used. The encoding is numeric-class
  aware (`5n` and `5` key alike), which also makes bigint pks safe. The identity
  is **lossy and never decoded back**.
- **Address** — what goes on the wire and into record *values* (`ColumnVersion.pk`,
  `Tombstone.pk`): a real, type-valid `SqlValue[]`. Any spelling from the row's
  equivalence class is acceptable; the receiver's store collapses spellings too.

The identity is one of the length-prefixed key components described above, so it needs no
separator to be absent from it. Keying is resolved per
table from its schema (key collations + semantic transforms) via
`metadata/pk-identity.ts`, a thin wrapper over the engine's `resolvePkIdentityKeying`
(`@quereus/quereus`, `util/key-serializer.ts`) — one implementation, shared with the
isolation overlay's row-alignment key, so the layers cannot drift. A wired
`keyNormalizerResolver` (`db.getKeyNormalizerResolver()`) keeps custom collations keying
exactly as the database compares them. A relay-only deployment with no `getTableSchema`
oracle keys raw values — stable for life, since no oracle (hence no identity flip) can
appear later.
Quarantine (`qt:`) keys always use the raw encoding: a quarantined table is out of the
local basis, so no schema exists for it, and its `(hlc, type)` component already makes the
key unique. Snapshot transfers carry **only each entry's raw pk** — no identity travels on
the wire, and the receiver always **derives its own** identity from the pk, exactly as the
delta path does. This is what makes bootstrapping from a differently-keyed sender sound: a
relay-only coordinator keys raw, so it can hold several records for what a schema-holding
receiver considers one row (`'Apple'`/`'APPLE'` under `nocase`); the receiver collapses
them onto its own identity, keeping the greatest-HLC entry per cell (and per tombstone) so
the collapse resolves by last-writer-wins rather than by chunk order. Mid-bootstrap
ordering is guaranteed by the stream itself: all schema migrations precede all table data,
so a table exists by the time its entries need keying.

Both roles are relative to the key definition in force when the record was written.
Redefining the key (`alter table … alter primary key`) re-files every record of the table
under the new one, on the peer that ran the statement and on every peer that replays it —
see *Tombstones and Deletions* above for the pass and what it cannot recover.

### Table identity

A table's **name is not its identity**: `alter table t rename to u` keeps the table and
changes the name, while `drop table t; create table t (…)` keeps the name and changes the
table. The per-row records are therefore filed under a **table generation** rather than
the name (`metadata/table-identity.ts`):

- Each peer mints a random 128-bit generation for a `(schema, table)` the first time it
  files anything for that name — lazily, inside the same write batch as the first record,
  so a table that existed before sync attached, or one created by replicated DDL, gets its
  generation with its first cell version or tombstone. The mapping is the `tg:` record;
  the whole set (bounded by the table count) is held in memory and loaded at open.
- A **rename moves the mapping** to the new name and touches no record. A **drop retires**
  the generation and reclaims its bookkeeping in two steps. The `cv:` and `tb:` records go
  with the drop, in the same batch as the `tg:` removal; that is an exact prefix scan,
  bounded by the dropped table's size. The `cl:` entries go with the next `repairChangeLog`
  sweep, because the change log is HLC-first and finding one generation's entries takes a
  full scan. Until then a retired generation resolves to no name, so every scan (the delta
  extractors, the snapshot producers, the change-log resolver) skips what it still has on
  disk. A relay-only peer retires on the admitted `drop_table` migration, so it reclaims
  the same way. A **same-name re-create mints a fresh generation** and so inherits nothing:
  the dropped incarnation's tombstones cannot block the new table's rows.
- Who drives the three transitions: local DDL through the transaction-commit capture
  (`create`/`drop`/`alter`-with-`oldObjectName` table events, staged ahead of the same
  transaction's data records so `drop t; create t; insert into t` files its rows under the
  new generation), and replicated DDL through the list of schema changes the store adapter
  reports it actually **executed** (`ApplyToStoreResult.executedSchemaChanges`) — a
  migration found already applied moves nothing, because the receiver's own local DDL
  already did. A deployment with no `applyToStore` at all (a relay-only coordinator, no
  catalog) treats every admitted `create_table`/`drop_table`/`rename_table` as executed.
- The generation is **local to each peer and never travels.** On the wire a change is
  addressed by the table's *current* name at extraction time (the record's generation
  resolves to its name), and the receiver resolves that name to its own current
  generation — the same name-based convergence rule replicated DDL already uses
  (`rename_table` carries old and new names; `decideRenameTable` decides against the
  catalog). Two peers that independently create the same table (the usual app-startup
  pattern) mint two unrelated generations and still converge by name, which is why a
  creator-minted identity carried on the wire was rejected.
- The apply path drains the local commit chain before resolving an inbound batch and
  again before filing its metadata (`applyChanges`, `drainHeldChanges`): a local rename
  whose `move` had not landed yet would otherwise let the inbound batch mint a second
  generation for the new name.
- The in-memory index is updated when a transition is **staged**, not when its batch
  commits, so the rest of the same batch resolves the new state. A batch that then fails
  to commit leaves the index ahead of disk, and nothing re-persists a mapping the index
  already holds — so every site that stages transitions re-reads the index from disk on
  failure (`withIdentityRecovery`: the admission unit's metadata commit, the streaming
  snapshot apply, the stores' standalone writers, and the local commit capture's catch).

**What this does not solve.** A change recorded against one incarnation on peer X and
applied to a different same-named incarnation on peer Y — X writes to `orders` while Y
has already dropped and re-created it — lands in Y's new table. The receiver cannot tell
which incarnation the sender addressed; that is a concurrent-DDL-versus-data race, the
same class as the rename collision `decideRenameTable` refuses, and pre-existing. Two
narrower gaps share the crash/detached class already noted under *Write Order* and
*Known Limitations*: a crash between a replicated rename's engine commit and its identity
transition strands the generation at the old name (the retry decides `already-applied`
and moves nothing — the one step of the apply that is not idempotent), and DDL run while
sync is detached leaves a `tg:` record whose table is gone, which a later same-name
create inherits (its migration is lost the same way).

### Metadata format version

The `fv:` record stores the sync-metadata storage format version
(`SYNC_METADATA_FORMAT_VERSION`, currently **7**: each `sm:` VALUE carries a second
length-prefixed slot, between `fromTable` and the DDL, holding an `alter primary key`
migration's column layout as a JSON string array (`columns`), so a relay with no catalog
can project a deleted row's new key from its tombstone's before-image. Version 6 keyed the
per-row records `cv:`/`tb:`/`cl:` by the table's *generation* through the `tg:` record
(see *Table identity*) instead of by the table name, so a rename moves one record without
touching a row record and a drop retires one generation — retained. Version 5 keyed those
records by `(schema, table)`, which a rename stranded and a same-name re-create inherited;
it also introduced
pk-identity keying, raw pk in record values, every variable-length key component
length-prefixed, `sm:` keyed by object kind, and each `sm:` VALUE carrying a
length-prefixed `fromTable` slot between the migration type and the DDL so a
`rename_table` can name the table it renamed — all retained. Version 4 ended its
records with the DDL as "rest of buffer", leaving nowhere to append that slot; version 3
lacked the object kind, so a table and a same-named index shared one version counter,
silently suppressing each other's migrations; version 2 also lacked the length
prefixes). `SyncManagerImpl.create` writes it on a fresh replica and refuses to open one
whose stored version is missing (pre-versioning) or different: old keys are unreadable
under the new layout and mixing the two would corrupt both. Recovery is to clear the
replica's sync metadata and re-bootstrap from a peer snapshot — no in-place rewrite pass.
**Release note for 7:** a replica on version 6 refuses to open under this build; recover as
the note for 6 describes.
**Release note for 6:** every existing replica's sync metadata is on version 5 and refuses
to open under this build; each must be cleared and re-bootstrapped from a peer snapshot (the
data in the store is untouched — only the `cv:`/`tb:`/`cl:` bookkeeping is rebuilt).
Across a mixed 3/4 fleet an index migration is numbered differently at each
end, so it duplicates rather than suppresses; `decideSchemaChange` no-ops the duplicate.

### Snapshot wire-format version

Snapshots carry their own format stamp, separate from the storage format above:
`SNAPSHOT_WIRE_FORMAT_VERSION` (currently **1** — explicit `{column, hlc, value, pk}`
entry records, no identity on the wire), stamped into the streaming header chunk
(`snapshotFormat`) and the non-streaming `Snapshot`. Both apply paths
(`applySnapshotStream`, `applySnapshot`) refuse a snapshot whose stamp is missing or
different **before touching any local state** — the same posture as the `fv:` gate.
The stamp matters because serialized snapshots outlive the sender process: the
coordinator's S3 store (`s3-snapshot-store.ts`) persists serialized chunk arrays at
rest, and an old stored snapshot deserialized by newer code would otherwise silently
mis-parse entry shapes. Recovery is to regenerate the snapshot from a live peer.

Operator note for the coordinator's S3 restore path: the refusal throws out of
`onStoreCreated`, and `StoreManager.openAndRestore` closes the store and rethrows — so a
coordinator holding a stale-format S3 snapshot **cannot open that database at all** until
the stale snapshot objects are removed from the bucket. Delete (or move aside) the
`…/snapshots/` objects for that database; the coordinator then opens empty and
re-accumulates from the clients that reconnect, and the next snapshot it writes carries
the current stamp. Whether an unreadable stored snapshot should instead be logged and
skipped (starting empty, as a missing snapshot already does) is open — see
`tickets/backlog/bug-coordinator-stale-snapshot-blocks-store-open.md`.

## Sync Protocol

Moved to [Sync Protocol](sync-protocol.md#sync-protocol).

## Reactive Hooks

The sync module exposes reactive hooks for UI integration:

```typescript
interface SyncEventEmitter {
  /** Remote changes applied locally */
  onRemoteChange(listener: (event: RemoteChangeEvent) => void): () => void;

  /** Local changes ready to sync */
  onLocalChange(listener: (event: LocalChangeEvent) => void): () => void;

  /** Sync state changed (connected, syncing, error) */
  onSyncStateChange(listener: (state: SyncState) => void): () => void;

  /** A conflict was resolved */
  onConflictResolved(listener: (event: ConflictEvent) => void): () => void;

  /**
   * Inbound changes reference a table outside the local basis (an out-of-basis
   * straggler delta), whatever the disposition. See § Unknown-Table Disposition.
   */
  onUnknownTable(listener: (event: UnknownTableEvent) => void): () => void;

  /**
   * An inbound batch's merged row state tripped a local commit-time global
   * assertion. Detect-and-notify: the data has already converged, so this is
   * informational and the host decides policy. See sync-transactions.md § Apply-time validation.
   */
  onAssertionViolation(listener: (event: AssertionViolationEvent) => void): () => void;
}

interface RemoteChangeEvent {
  siteId: SiteId;                    // Origin replica
  transactionId: string;
  changes: Change[];
  appliedAt: HLC;
}

interface LocalChangeEvent {
  transactionId: string;
  changes: Change[];
  pendingSync: boolean;              // True if not yet synced to master
}

interface ConflictEvent {
  schema: string;
  table: string;
  pk: SqlValue[];
  column: string;
  localValue: SqlValue;
  remoteValue: SqlValue;
  winner: 'local' | 'remote';
  winningHLC: HLC;
  remotePriorValue?: SqlValue;       // incoming change's before-image (what it overwrote at its origin)
  remotePriorHlc?: HLC;              // HLC of that before-image; present iff remotePriorValue is
}

interface UnknownTableEvent {
  schema: string;
  table: string;
  disposition: 'ignore' | 'quarantine';
  changeCount: number;   // Changes diverted for this table in this apply
  siteId: SiteId;        // Straggler origin (from the changeset)
  latestHLC: HLC;        // Max HLC among the diverted changes
}

interface AssertionViolationEvent {
  assertion: string;     // Name of the violated local assertion
  samples: SqlValue[][]; // Sample rows from the violation query (diagnostic; capped)
}

type SyncState =
  | { status: 'disconnected' }
  | { status: 'connecting' }
  | { status: 'syncing'; progress: number }
  | { status: 'synced'; lastSyncHLC: HLC }
  | { status: 'error'; error: Error };
```

### Integration with Store Events

Local-change capture is sourced from the **engine** transaction boundary, not the
per-table store emitter. `createSyncModule(kv, { transactionSource: db, ... })`
subscribes the SyncManager to `db.onTransactionCommit`; each committed transaction
delivers one grouped batch that the write side records under one HLC (see
[Sync: Transactions](sync-transactions.md) § Transaction-Based Change Grouping → *Write side*). A key design goal is that
reactive events fire **exactly once** for each change, whether local or remote.

> **Why the engine emitter, not the per-table store emitter.** The per-table
> `StoreEventEmitter` / `TransactionCoordinator` sits **below** the transaction
> boundary — each table has its own coordinator, so a cross-table commit fires several
> separate bursts that cannot be grouped into one transaction. The grouped batch
> preserves each event's `remote` flag, so the write side still filters remote-origin
> events out (an all-remote group is a pure sync-apply echo and is skipped). A
> relay-only deployment that produces no local DML simply omits `transactionSource`
> and captures nothing.

#### Event Flow

- **Local**: user SQL → engine commits txn → `db.onTransactionCommit` (grouped, `remote=false`) → SyncManager records metadata under one HLC → UI receives the per-event store events.
- **Remote**: SyncManager applies the change via `applyToStore` → store executes and emits with `remote=true` → SyncManager ignores its own echo → UI receives the event.

Either way the UI receives exactly one event from the Store. The `remote` flag decides whether the SyncManager records CRDT metadata (local) or skips (remote).

#### The `remote` Flag

Both `DataChangeEvent` and `SchemaChangeEvent` include a `remote?: boolean` flag:

```typescript
interface DataChangeEvent {
  type: 'insert' | 'update' | 'delete';
  schemaName: string;
  tableName: string;
  key: SqlValue[];
  oldRow?: Row;
  newRow?: Row;
  remote?: boolean;  // True if from sync or cross-tab
}

interface SchemaChangeEvent {
  type: 'create' | 'alter' | 'drop';
  objectType: 'table' | 'index' | 'view' | 'trigger';
  schemaName: string;
  objectName: string;
  ddl?: string;
  remote?: boolean;  // True if from sync
}
```

`oldRow` / `newRow` are positional, and the sync layer pairs value *i* with column *i* of the
table's schema **as read at event time** (see `recordColumnVersions`). The engine guarantees
that pairing: every event a commit delivers describes its rows in the schema current at
delivery, even when the transaction ran `ALTER TABLE ADD/DROP/RENAME COLUMN` (or a retype /
`SET NOT NULL` backfill) *after* recording the write — the recorded events are rewritten to the
post-ALTER shape before delivery, and `changedColumns` never names a dropped or pre-rename
column. (The store path omits `changedColumns` entirely and the sync layer recomputes the diff
from `oldRow`/`newRow`; an ALTER does not change that.)

#### Sync Module Event Handling

The SyncManager subscribes once to `db.onTransactionCommit`, filters out remote-origin
events, returns early on an all-remote echo, records the whole committed transaction
under one HLC in one `kvBatch` (DDL migrations first, then DML facts, then the persisted
clock state), and emits a single local-change event `{ transactionId, changes,
pendingSync: true }` for UI reactivity. See [Sync: Transactions](sync-transactions.md) § Transaction-Based Change Grouping →
*Write side* for the pseudocode.

#### Applying Remote Changes

When the SyncManager applies remote changes, it must execute SQL in a way that the
resulting store events are marked with `remote: true`, so the SyncManager ignores its
own echo. The data write lands first; CRDT metadata is committed only after it succeeds
(see the write-ordering invariant under Transactional Integrity During Sync).

The store plugin provides the mechanism:

```typescript
interface ApplyOptions {
  remote?: boolean;  // Mark resulting events as remote
}

// Store implementation ensures emitted events carry the flag:
//   this.events.emitDataChange({ ...event, remote: options.remote });
```

## Schema Synchronization

How schema (catalog) changes replicate — the CRDT design principles, the `sv:` metadata keys,
"most destructive wins" conflict resolution, DDL-before-DML application order, idempotent DDL
application, and what does and does not replicate — lives in
[sync-schema.md](sync-schema.md). The same doc covers the schema **seed**: shipping an app's
initial schema into each user's database by treating the app provider as a read-only sync
peer.

## Configuration

```typescript
interface SyncConfig {
  /**
   * Retention horizon in milliseconds: changes older than this are not
   * guaranteed deliverable. Bounds tombstone GC, delta-sync eligibility,
   * and retirement timing guidance. A delete this replica wrote and has not
   * yet delivered is kept past it. Default: 30 days.
   */
  retentionHorizonMs: number;

  /** Whether deleted rows can be resurrected by later writes (default: false) */
  allowResurrection: boolean;

  /** Maximum changes per sync batch (default: 1000) */
  batchSize: number;

  /**
   * What to do with inbound changes that reference a table outside the local
   * basis (an out-of-basis straggler delta — see § Unknown-Table Disposition
   * and migration.md § Contract). Default: `'quarantine'`.
   */
  unknownTableDisposition: 'ignore' | 'quarantine' | 'store-and-forward';

  /**
   * Default policy for reclaiming a *detached* basis table's lingering local
   * storage (see migration.md § 4 Contract). `{ mode: 'horizon' }` (default)
   * evicts once the table has been quiet for `horizonMs` (default
   * `retentionHorizonMs`); `'never'` keeps storage forever; `'immediate'`
   * reclaims on the first sweep after detach. A per-table `quereus.sync.evict`
   * reserved tag overrides this. The sweep, `evictExpiredBasisTables(now?)`, is
   * host-driven (no library timer) and a no-op when no `dropLocalTable` reclaim
   * callback is wired.
   */
  basisEviction?: { mode: 'horizon' | 'never' | 'immediate'; horizonMs?: number };

  /** Site ID (auto-generated if not provided) */
  siteId?: Uint8Array;
}
```

See § Usage Example for how the config is passed to `createSyncModule`.

## Usage Example

```typescript
import { Database } from '@quereus/quereus';
import { LevelDBModule, LevelDBStore, StoreEventEmitter } from 'quereus-store';
import { createSyncModule } from '@quereus/sync';

// 1. Store + event emitter
const storeEvents = new StoreEventEmitter();
const store = new LevelDBModule(storeEvents);

// 2. KV store for sync metadata
const kvStore = await LevelDBStore.open({ path: './sync-meta' });

// 3. Sync module
const { syncManager, syncEvents } = await createSyncModule(kvStore, storeEvents, {
  retentionHorizonMs: 30 * 24 * 60 * 60 * 1000,
});

// 4. Register the store module with the database
const db = new Database();
db.registerModule('store', store);

// 5. Create tables (sync tracks changes automatically via storeEvents)
await db.exec(`
  create table users (id integer primary key, name text, email text)
  using store(path='./data')
`);

// 6. Subscribe to sync events for UI (update UI, invalidate caches, …)
syncEvents.onRemoteChange((event) => { /* event.changes */ });
syncEvents.onConflictResolved((event) => { /* event.table/column/winner */ });

// 7. Implement your transport layer
async function syncWithServer(ws: WebSocket) {
  // One batch of at most `batchSize`: read again from this batch's max hlc until
  // the result is empty, or the rest is never sent.
  const localChanges = await syncManager.getChangesToPush(serverSiteId, lastSentHLC);
  ws.send(JSON.stringify({ type: 'changes', data: localChanges }));

  ws.onmessage = async (msg) => {
    const result = await syncManager.applyChanges(JSON.parse(msg.data));
    console.log(`Applied ${result.applied} changes`);
  };
}
```

### Streaming Snapshot Example

For large databases, stream snapshots instead of loading everything into memory:

```typescript
// Server: Stream snapshot to client
async function sendSnapshot(ws: WebSocket) {
  for await (const chunk of syncManager.getSnapshotStream(1000)) {
    ws.send(JSON.stringify(chunk));
  }
}

// Client: Apply streamed snapshot with progress
async function receiveSnapshot(ws: WebSocket) {
  const chunks = receiveChunks(ws); // Your async iterator over WebSocket messages

  await syncManager.applySnapshotStream(chunks, (progress) => {
    console.log(`Progress: ${progress.tablesProcessed}/${progress.totalTables} tables`);
    console.log(`Entries: ${progress.entriesProcessed}/${progress.totalEntries}`);
  });
}

// Client: ask the server to resume an interrupted snapshot. The checkpoint MUST go
// through serializeSnapshotCheckpoint — it holds a Uint8Array siteId and a bigint
// HLC wallTime, and JSON.stringify throws on the bigint.
async function requestResume(ws: WebSocket, snapshotId: string) {
  const checkpoint = await syncManager.getSnapshotCheckpoint(snapshotId);
  if (!checkpoint) return;  // nothing saved — fall back to a fresh get_snapshot
  ws.send(JSON.stringify({
    type: 'resume_snapshot',
    checkpoint: serializeSnapshotCheckpoint(checkpoint),
  }));
  // Chunks come back exactly as for a fresh snapshot — apply them the same way
  await syncManager.applySnapshotStream(receiveChunks(ws));
}

// Server: resume streaming from the client's checkpoint
async function handleResume(ws: WebSocket, message: { checkpoint: SerializedSnapshotCheckpoint }) {
  for await (const chunk of syncManager.resumeSnapshotStream(
    deserializeSnapshotCheckpoint(message.checkpoint))) {
    ws.send(JSON.stringify(chunk));
  }
}
```

### Store Adapter for Remote Changes

`createStoreAdapter` builds a unified adapter for applying remote changes to LevelDB and IndexedDB stores:

```typescript
import { createStoreAdapter } from '@quereus/sync';

const applyToStore = createStoreAdapter(kvStore, storeEvents);
const syncManager = new SyncManagerImpl(metadataKvStore, storeEvents, applyToStore, {
  retentionHorizonMs: 30 * 24 * 60 * 60 * 1000,
});
```

On inbound changes the adapter handles UPSERT semantics, deletes rows by primary key, executes DDL for schema changes, and emits events with `remote=true` so CRDT metadata is not re-recorded.

## Current limitations

The engine core is complete: HLC clocks, column-level LWW, tombstones,
transaction-grouped change extraction, streaming snapshots, schema synchronization,
reactive hooks, the LevelDB/IndexedDB store adapters, and the
[`@quereus/sync-client`](../packages/quereus-sync-client/) WebSocket client.

Known gaps, tracked in [`docs/todo.md` § Sync Engine Remaining Work](todo.md#sync-engine-remaining-work):

- **Per-table write atomicity** — remote changes are written data-first / metadata-second and
  abort with no metadata on any error (see [Transactional Integrity During Sync](#transactional-integrity-during-sync)),
  but do not yet use `WriteBatch` for per-table atomicity.
- **Isolation** — readers may observe partially-applied state mid-sync; true ACID isolation
  awaits Store-level support (see [Future: Store Isolation](#store-isolation-store-phase-8---future)).
- **Transports** — only the WebSocket client ships; HTTP-polling fallback is future work.
- **Test coverage** — tombstone-TTL fallback, large-dataset streaming, network-resume, and
  crash-recovery scenarios are not yet exercised.
