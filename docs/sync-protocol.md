# Sync Protocol

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

The wire-level contract of `quereus-sync`: the data structures a peer exchanges, the
`SyncManager` API a host drives, and the WebSocket message protocol with its versioning,
reconnection and debouncing rules. A satellite of [Sync Module](sync.md).

## Data Structures

```typescript
/** Identifies a specific replica in the network */
type SiteId = Uint8Array;  // 16-byte UUID

/** A transaction's worth of changes */
interface ChangeSet {
  siteId: SiteId;                    // Origin replica
  transactionId: string;             // Unique transaction ID
  hlc: HLC;                          // Transaction commit time
  changes: Change[];                 // Column-level changes
  schemaMigrations: SchemaMigration[]; // Schema changes in this tx
  cursor?: HLC;                      // Where a reader of this set resumes from on the replica
                                     // that served it; absent when equal to `hlc`
                                     // (§ Delta Sync Optimization)
}

/** A single column modification */
interface ColumnChange {
  type: 'column';
  schema: string;
  table: string;
  pk: SqlValue[];                    // Primary key values
  column: string;
  value: SqlValue;
  hlc: HLC;
  priorValue?: SqlValue;             // before-image: the value this write overwrote
  priorHlc?: HLC;                    // HLC of the overwritten cell version
}
```

**Per-cell before-image (`priorValue` / `priorHlc`).** An optional before-image mirroring Lamina's `UpdateCellFact(new_value, prior_value?, prior_hlc?)`.
It carries the cell version this write replaced, so a receiver can see *what changed
from what* (audit trails, undo, conflict debugging) without a separate lookup.

- **Source = the prior tracked cell version**, not the engine's `oldRow[i]`, which has
  no HLC and can diverge from the CRDT cell lineage. The prior `ColumnVersion`
  (`{ hlc, value }`) pairs semantically with `value`/`hlc`.
- **Replica-local lineage.** Stored on each `ColumnVersion` as "what this write replaced
  *here*" (`oldVersion` on the local write path, `oldColumnVersion` on apply). In
  causal-order delivery that equals the origin's prior, so a relaying receiver re-emits
  the origin's chain (the prior's own origin HLC, never reset to the receiver's clock).
  A change that arrived with no prior is stored with none, even over a version the
  receiver holds: its writer saw no earlier version, and the next replica relies on that.
- **Best-effort.** Both fields are absent on a cell's first write, on every write of a
  primary-key cell, and on snapshot-reconstructed cells. Producers may omit them; receivers ignore them when
  absent; the no-`conflictResolver` HLC fast path is unchanged. One default outcome reads
  `priorHlc`, and only for its presence: an edit of a row the replica has forgotten by
  pruning is refused ([sync.md § Tombstones and Deletions](sync.md#tombstones-and-deletions)).
  A producer that omits it gets the outcome from before that rule. Repeated local overwrites
  before a pull keep one change-log entry per cell, whose prior is the *immediately*
  overwritten version — "what the winning write overwrote", not "the value at last sync"
  (intended Lamina semantics).
- **Not used to skip the receiver's re-read.** `localValue` still comes from the
  receiver's `getColumnVersion` read; the before-image is exposed only for the
  resolver/validator. Skipping the re-read is intentionally **not** done — it would risk
  regressing the fast path.
```typescript

/** A row deletion */
interface RowDeletion {
  type: 'delete';
  schema: string;
  table: string;
  pk: SqlValue[];
  hlc: HLC;
  priorRow?: Row;                    // last-known row image before deletion (audit/undo)
}

type Change = ColumnChange | RowDeletion;
```

**Row before-image (`priorRow`).** The row-level companion to the per-cell
before-image: an optional, purely additive last-known row image carried on a
deletion, so a receiver can show or undo *what was removed*.

- **Source = the engine's `oldRow`**, captured at delete time (already on the event, no
  extra read) — the column-ordered row the engine deleted, unlike the per-cell
  `priorValue`, which comes from the prior tracked cell version.
- **Persisted on the tombstone.** `getChangesSince` re-resolves deletions from the
  `TombstoneStore`, so the image is stored on the `Tombstone` (the row analog of
  storing the cell prior on the `ColumnVersion`) and survives re-emission/relay.
- **Best-effort.** Absent when the delete carried no `oldRow` (relayed/synthesized
  deletes) and on snapshot-reconstructed tombstones. Producers may omit it; receivers
  ignore it when absent. A tombstone with no `priorRow` serializes to its unchanged
  fixed-size form.
- **Storage cost.** Every tombstone may hold a full row image, retained until
  retention-horizon GC — bounded but non-trivial for wide rows.
```typescript

/** A schema modification */
interface SchemaMigration {
  type: 'create_table' | 'drop_table' | 'rename_table'
      | 'add_column' | 'drop_column' | 'alter_column'
      | 'add_index' | 'drop_index';
  schema: string;
  table: string;                     // The object's name AFTER the migration
  fromTable?: string;                // `rename_table` only: the name before the rename
  columns?: string[];                // `alter primary key` only: the table's column names in
                                     // order, so a relay can read a before-image (sync.md § Tombstones)
  ddl: string;                       // The DDL statement
  hlc: HLC;
  position?: HLC;                    // Snapshots only: where the sender filed it, when not at `hlc`
  schemaVersion: number;             // Monotonic per (object kind, object name) from 1;
                                     // 0 is a baseline (sync-schema.md § Baselines)
}
```

## Sync API

```typescript
interface SyncManager {
  /** Get this replica's site ID */
  getSiteId(): SiteId;

  /** Get current HLC for state comparison */
  getCurrentHLC(): HLC;

  /**
   * Everything this replica filed after `sinceHLC`, in the order it filed it; omit
   * sinceHLC for initial sync. `sinceHLC` is the watermark of the last reply the peer
   * applied (`replyWatermark`): a position in THIS replica's change log, not a write time.
   */
  getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]>;

  /**
   * What to push upstream to a peer: facts and migrations this replica wrote, plus held
   * store-and-forward changes not written by that peer. Same bound as getChangesSince.
   * Here `sinceHLC` is a write time: the greatest `ChangeSet.hlc` the peer acknowledged.
   */
  getChangesToPush(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]>;

  /** Apply changes received from a peer; returns statistics about what was applied. */
  applyChanges(changes: ChangeSet[]): Promise<ApplyResult>;

  /**
   * False once a tombstone filed above sinceHLC has been pruned here — the delete it
   * backed cannot be delivered, so the peer must take a snapshot. Compares
   * against the delta floor only (no peer state, no wall clock).
   */
  canDeltaSync(sinceHLC: HLC): Promise<boolean>;

  /** The delta floor: greatest filing position of a pruned tombstone, or undefined if nothing deliverable was ever pruned. */
  getDeltaFloor(): Promise<HLC | undefined>;

  /** A full snapshot, for initial sync or TTL-expiration recovery. */
  getSnapshot(): Promise<Snapshot>;

  /**
   * Apply a full snapshot. Replaces rows as well as metadata: each table the
   * snapshot has a section for ends up holding exactly the snapshot's rows, and a
   * table with no section is left alone (docs/sync.md § Snapshots replace rows).
   */
  applySnapshot(snapshot: Snapshot): Promise<void>;

  /**
   * The tables holding a live row with no sync record, which a snapshot covering
   * them would delete (docs/sync.md § Rows sync has never recorded). Read-only;
   * empty on a peer with no engine.
   */
  findTablesWithUnrecordedRows(): Promise<Array<{ schema: string; table: string }>>;

  /**
   * Record every unrecorded row as a local change, along with any schema migration its
   * table lacks. Idempotent. Rejects while a snapshot checkpoint exists or an explicit
   * transaction is open; does nothing on a peer with no engine.
   */
  adoptUnrecordedRows(): Promise<{ tables: Array<{ schema: string; table: string }>; rows: number }>;
}

interface ApplyResult {
  applied: number;      // Changes successfully applied
  skipped: number;      // Already present (LWW no-op)
  conflicts: number;    // Conflicts resolved (remote won or lost)
  transactions: number; // Transactions processed
  unknownTable?: number; // Diverted for out-of-basis tables (§ Unknown-Table Disposition)
}

interface Snapshot {
  siteId: SiteId;
  hlc: HLC;                // a position in the sender's change log: the receiver asks for what was filed after it
  snapshotFormat: number;  // wire-format stamp; see § Snapshot wire-format version
  // One section per covered table, including a table with no rows left: it is
  // the table's whole contents, so an empty one empties the receiver's table.
  tables: TableSnapshot[];
  schemaMigrations: SchemaMigration[];
  // Global tombstone pass (table-independent) so a fully-deleted row — a
  // tombstone with no live column-versions — survives an applySnapshot bootstrap.
  tombstones: SnapshotTombstone[];
}

interface TableSnapshot {
  schema: string;
  table: string;
  // One flat record per live cell — the table's ONLY payload; only the raw pk
  // travels, and no pre-grouped row images do. The receiver groups cells into
  // rows under its own DERIVED identity. See § Row identity vs. address.
  // `position` is where the sender filed the cell, when not at `hlc`; the receiver
  // files it at the same position (§ Delta Sync Optimization). Tombstones carry one too.
  columnVersions: ReadonlyArray<{ column: string; hlc: HLC; position?: HLC; value: SqlValue; pk: SqlValue[] }>;
}

// ============================================================================
// Streaming Snapshot API (for large datasets)
// ============================================================================

interface SyncManager {
  // ... existing methods ...

  /** Stream a snapshot as chunks; use instead of getSnapshot() for large databases. */
  getSnapshotStream(chunkSize?: number): AsyncIterable<SnapshotChunk>;

  /**
   * Apply a streamed snapshot with progress tracking, resumable via checkpoint.
   *
   * A fresh apply replaces all local CRDT metadata: the up-front clear wipes
   * column versions, tombstones, and the change log before the chunks rewrite
   * them. Tombstones ARE carried in the stream (a global `tombstone`-chunk pass,
   * separate from the per-table column-version sections), so a deleted row stays
   * deleted after bootstrap. On a *resumed* apply the sender skips already-completed
   * tables and never re-emits their metadata, so the receiver consults the persisted
   * checkpoint (saved under `sc:{snapshotId}`) and preserves those completed tables
   * through the clear — otherwise their CRDT state would be wiped and never
   * rewritten, diverging from the row data still in the store. (Tombstones are
   * re-emitted wholesale on resume and re-written idempotently.)
   *
   * Rows are replaced too: the footer deletes each row of a covered table that the
   * snapshot does not carry, tables completed by an earlier session included, ahead
   * of `bootstrapFinalize` (docs/sync.md § Snapshots replace rows).
   *
   * The header HLC is drift-validated before the clear (see docs/sync.md § Hybrid
   * Logical Clock (HLC)): a far-future snapshot is rejected before any local
   * metadata is touched.
   *
   * A checkpoint exists for the WHOLE duration of an apply: one is saved at header
   * time, immediately before the clear, and the footer clears it on success. So
   * "a checkpoint is present" is the durable answer to "is this replica's data
   * partial?" — see § Checkpoint presence means partial data below.
   */
  applySnapshotStream(
    chunks: AsyncIterable<SnapshotChunk>,
    onProgress?: (progress: SnapshotProgress) => void
  ): Promise<void>;

  /** A resumable checkpoint for an in-progress snapshot, by id. */
  getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined>;

  /**
   * Every saved checkpoint — the discovery path for a caller that does not hold a
   * snapshotId (it only ever arrived in the header chunk, so a restarted client
   * has forgotten it). Ordering is unspecified; pick by `createdAt` when more than
   * one is present. Returns `[]` on a replica that never applied a snapshot.
   */
  listSnapshotCheckpoints(): Promise<SnapshotCheckpoint[]>;

  /**
   * Discard a checkpoint without applying anything — for a transfer the caller
   * will not resume (e.g. superseded checkpoints when several are present).
   * A successful apply already clears its own. Not guarded against an in-flight
   * apply: that apply simply re-saves the record at its next flush.
   */
  clearSnapshotCheckpoint(snapshotId: string): Promise<void>;

  /** Resume a snapshot transfer from a checkpoint. */
  resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk>;
}

/**
 * Snapshot chunk types for streaming.
 *
 * Emission ORDER is load-bearing — DDL precedes table data:
 *
 *   header → schema-migration* → [table-start, column-versions…, table-end]*
 *          → tombstone* → footer
 *
 * The receiver cannot buffer a whole snapshot: `applySnapshotStream` flushes rows to
 * the store every 100 pending changes, and the adapter applies DDL before DML only
 * WITHIN one flush. A `create table` emitted after its rows arrives too late for every
 * flush they already triggered, and on a receiver that lacks the table each of those
 * rows fails with "Table not found for external write". The receiver correspondingly
 * flushes its pending DDL — re-sorted causally — at the first `table-start`.
 *
 * A `table-start` / `table-end` pair with no `column-versions` between them is
 * meaningful: the table is covered and empty, so the receiver empties its copy. A
 * table with no pair at all is unmentioned and left alone.
 */
type SnapshotChunk =
  | SnapshotHeaderChunk      // First; snapshotFormat gated + HLC drift-validated here
  | SnapshotSchemaMigrationChunk  // All DDL, before any table data
  | SnapshotTableStartChunk
  | SnapshotColumnVersionsChunk
  | SnapshotTableEndChunk
  | SnapshotTombstoneChunk   // Global pass; carries fully-deleted rows
  | SnapshotFooterChunk;     // Last; carries stats

/** Progress info during snapshot streaming */
interface SnapshotProgress {
  snapshotId: string;
  tablesProcessed: number;
  totalTables: number;
  entriesProcessed: number;
  totalEntries: number;
  currentTable?: string;
}

/**
 * Checkpoint for resumable snapshot transfers.
 *
 * NOT JSON-safe: `siteId` is raw bytes and `hlc.wallTime` is a bigint, which
 * `JSON.stringify` throws on. Cross the wire via `serializeSnapshotCheckpoint` /
 * `deserializeSnapshotCheckpoint` (`sync/wire.ts`), which encode both as base64
 * into `SerializedSnapshotCheckpoint` — the shape `resume_snapshot` carries.
 *
 * INVARIANT on `completedTables`: a table appears here only after every one of its
 * rows has returned from the store apply. A resumed sender SKIPS these tables and
 * the receiver PRESERVES their metadata through the resume's up-front clear, so a
 * table named prematurely would lose its trailing rows permanently — they are never
 * re-sent, never reconciled, never reported. `applySnapshotStream` upholds this by
 * staging a finished table and graduating it only inside its data flush; being late
 * is safe (the table is merely re-streamed), being early is not.
 */
interface SnapshotCheckpoint {
  snapshotId: string;
  siteId: SiteId;
  hlc: HLC;
  lastTableIndex: number;
  lastEntryIndex: number;
  completedTables: string[];
  entriesProcessed: number;
  createdAt: number;
}
```

### Checkpoint presence means partial data

Checkpoints live under `sc:{snapshotId}` (`SYNC_KEY_PREFIX.SNAPSHOT_CHECKPOINT`).
A checkpoint is present for the *entire* duration of a streaming apply:

- **Saved at the header**, immediately before `clearExistingMetadata`. Both header
  gates — wire format and clock drift — reject *before* that save and touch no
  local state, so a refused snapshot leaves no checkpoint behind. The clear and
  everything after it are covered, including the window before the first
  metadata-batch flush (every 1000 entries) that used to be the earliest save. A
  crash between the save and the clear leaves a checkpoint over intact metadata,
  which the resume clears again; the other order would leave rows with no records
  and nothing to say why.
- **Re-saved at every metadata flush**, advancing `completedTables`.
- **Cleared by the footer**, after `bootstrapFinalize` — deliberately in that order,
  so a failed finalize leaves the checkpoint in place and the transfer retries.

Every *other* snapshot's checkpoint is deleted at that same header point. The clear
just removed the local metadata of every table this apply did not inherit, so another
transfer's `completedTables` no longer has state behind it — resuming from it would
tell the sender to skip exactly the tables that can no longer be rebuilt. Dropping
those records keeps at most one checkpoint alive at a time, so nothing accumulates
and a replica made whole by *any* completed apply reports itself whole.

So on a replica whose data may be mid-bootstrap, `listSnapshotCheckpoints()` is the
single durable answer to "is this data partial?" — no `snapshotId` needed, which
matters because the id only ever arrives in the header chunk and a restarted client
has forgotten it. Feed the discovered checkpoint back to a peer's
`resumeSnapshotStream(checkpoint)` to finish the transfer, or
`clearSnapshotCheckpoint(id)` to abandon it.

`clearExistingMetadata` sweeps `cv:` / `tb:` / `cl:` only — it must never grow to
include `sc:`, or a resumed apply would delete the very resume position it is
running from.

## Sync Flow (Master to Many-Masters)

For the primary use case of a master server syncing to many frontend replicas:

1. Frontend connects, sending `{ mySiteId, lastSyncHLC }`
2. Master checks `canDeltaSync(lastSyncHLC)` — if false it answers `snapshot_required` (the frontend pushes its offline work, takes a full snapshot, then catches up from the snapshot's HLC); if true `getChangesSince()`
3. Master sends `ChangeSet[]`; frontend applies them with `applyChanges(changeSets)`
4. Frontend sends its own local changes (those made while offline)
5. Master applies them, resolving conflicts via LWW, and re-sends any winners

## WebSocket Sync Protocol

The WebSocket protocol gives real-time bidirectional synchronization — the recommended transport for interactive applications.

A session runs `handshake` → `handshake_ack` (both carrying `protocolVersion`), then
`get_changes` → `changes` (or `snapshot_required` when the server can no longer serve
the client's watermark in full); the client pushes its own work as `apply_changes` →
`apply_result` (correlated by `requestId`), the server pushes another peer's as
fire-and-forget `push_changes`, and `ping` / `pong` keep the socket alive.

### Message Types

**Client → Server:**

| Type | Purpose | Payload |
|------|---------|---------|
| `handshake` | Authenticate and establish session | `{ siteId, token?, protocolVersion }` |
| `get_changes` | Request what the server filed after a position in its change log (the client's received watermark) | `{ sinceHLC? }` (base64) |
| `apply_changes` | Push local changes to server | `{ changes: ChangeSet[], requestId? }` |
| `get_snapshot` | Request full snapshot | (none) |
| `resume_snapshot` | Resume an interrupted snapshot from a saved checkpoint | `{ checkpoint }` (via `serializeSnapshotCheckpoint`) |
| `ping` | Heartbeat / keepalive | (none) |

**Server → Client:**

| Type | Purpose | Payload |
|------|---------|---------|
| `handshake_ack` | Confirm authentication | `{ serverSiteId, connectionId, protocolVersion }` |
| `changes` | Ordered response to `get_changes` (gap-free, in the server's filing order; **advances** received watermark to `replyWatermark(changeSets)`) | `{ changeSets: ChangeSet[] }`, each with an optional `cursor` |
| `snapshot_required` | Refusal of a `get_changes` whose `sinceHLC` is below the server's delta floor — a delete the client needs was pruned, so no delta can be complete. A normal outcome, not an `error` | `{ sinceHLC, deltaFloor }` (base64) |
| `push_changes` | Fire-and-forget broadcast from another client (applied, but **never** advances the received watermark) | `{ changeSets: ChangeSet[] }` |
| `apply_result` | Confirm changes applied | `{ requestId?, applied, skipped, conflicts }` |
| `snapshot_chunk` | Streamed snapshot data | `{ chunk: SnapshotChunk }` |
| `snapshot_complete` | Snapshot stream finished | (none) |
| `error` | Error response | `{ code, message }` |
| `pong` | Heartbeat response | (none) |

**Push/ack correlation (`requestId`).** Each `apply_changes` that advances the client's
delta-sync watermark carries a monotonic `requestId` (`apply-1`, `apply-2`, …). The
server keeps no state — it reflects the id back verbatim on the resulting
`apply_result`. The client promotes `lastSentHLC` only for the ack whose `requestId`
matches the batch that produced it, and only ever forward, which makes a stale,
duplicate, or out-of-order ack (e.g. redelivered across a reconnect) inert rather than
crediting the wrong batch. Pushes with no watermark to promote (a peer-relay
`apply_changes`) omit the id; the server then echoes none and the client leaves its
watermark untouched.

### Protocol version

`handshake` and `handshake_ack` both carry `protocolVersion` — the integer
`PROTOCOL_VERSION` exported from `@quereus/sync` (`sync/wire.ts`), the single wire
definition client and coordinator share. The check is **strict integer equality**, at
connect time:

- The coordinator reads the client's `protocolVersion` **before authenticating**. If it
  is absent or `!== PROTOCOL_VERSION`, it replies
  `{ type: "error", code: "PROTOCOL_VERSION_MISMATCH", fatal: true }` and closes the
  socket (code `4003`) without touching the store.
- The coordinator echoes its own `protocolVersion` in `handshake_ack`. The client checks
  it in `handleHandshakeAck`; on mismatch (or absence — an old coordinator) it sets a
  lasting `error` status and stops reconnecting, the same fatal path a `fatal: true`
  server error takes.

A peer predating versioning sends no `protocolVersion`; that is a mismatch, not silently
accepted — silent drift is what this guards against. Because all sync packages are
lockstep-versioned in this monorepo, `PROTOCOL_VERSION` is bumped on any breaking change
to a message shape or the codec, with no min/max range negotiation; `PROTOCOL_VERSION`'s
doc comment in `wire.ts` describes the range-negotiation upgrade path should
mixed-version rolling upgrades ever be required.

Version history: **v2** added `snapshot_required` as a possible reply to `get_changes`.
No v1 message shape moved, but a v1 client would log the new reply as an unknown message
and sit unsynced forever, so it is breaking in effect; coordinator and clients ship
together. **v3** added `cursor` to a change set in a `changes` reply and made `sinceHLC`
on `get_changes` a position in the server's change log rather than a write time
(§ Delta Sync Optimization). A v2 client would resume from a set's `hlc`, which for a
change the server received late is below what the client already holds, and request the
same range without end.

> **NOTE: accepted tradeoff — mixed-version skew is deliberately neither promised nor
> tested.** A version-skew test (pin one peer at release N, the other at N-1, assert they
> still interoperate) was proposed and declined, because it would test a guarantee the
> project has not made: sync is Experimental, and that tier's on-the-wire row already says
> the format may change with no upgrade path in any release. The gate above is what makes
> that honest — a skewed peer is refused with a named error rather than left to
> misinterpret a message. **Revisit when sync leaves Experimental**: the Beta and Stable
> rows in [stability.md](stability.md) both promise a documented upgrade path for a stored
> or on-the-wire format, and neither is dischargeable without this test. Note also that a
> wire-version gate covers only the wire: on-disk sync metadata layout, semantic drift
> under an unchanged message shape, and a peer reading its own older persisted state are
> three separate compatibility axes it does not touch.

### Connection Lifecycle

The client state machine:

- **DISCONNECTED** → `connectSync(url, token)` → **CONNECTING**
- **CONNECTING** → `onopen`, send handshake → **SYNCING**
- **SYNCING** → `handshake_ack` → every unsent local change pushed as `apply_changes`, one acknowledged batch at a time (unless `readOnly`) → `get_changes`; each non-empty `changes` reply → `applyChanges()` → next `get_changes`; an empty `changes` reply → **SYNCED**. Nothing else reports SYNCED, so a `push_changes` applied during the pull leaves the state at SYNCING
- **SYNCED** stays put across `apply_result` / applied `push_changes`, and re-enters itself on a local change → `apply_changes`
- Any of CONNECTING / SYNCING / SYNCED, on a WebSocket error or unintentional close → **RECONNECTING** → exponential backoff (1s, 2s, 4s … 60s) → DISCONNECTED and retry

### Delta Sync Optimization

To minimize data transfer, clients track sync progress with the server, using two
watermarks that measure two different things. Every change has a timestamp on each of
two axes:

- **Origin timestamp** (`hlc`): when the change was written, and by whom. Conflict
  resolution, transaction identity, before-images and the *sent* watermark use it.
- **Filing position**: where a replica filed the change in its own change log. A replica
  files what it writes at the change's own HLC, and what it receives at a tick of its
  own clock taken when the change is committed, so positions rise in the order changes
  *reach* the replica, whatever their write times, and a position is never below its
  change's origin timestamp. The *received* watermark, the `sinceHLC` of `get_changes`,
  the delta floor and a snapshot's header HLC are positions. A position is an HLC value,
  with an HLC's encoding, but it means something only to the replica that issued it;
  the received watermark is kept per server for that reason.

The two orders differ whenever changes arrive out of write order: after any offline
period, and between two devices pushing at about the same time. A device that reconnects
and pushes an hour-old delete has that delete filed at the server's *current* position,
so every device that catches up afterwards receives it, including one that had already
read changes written later. Measured in write time, that device's watermark would already
be past the delete and no request would ever return it.

A `changes` reply lists its sets in filing order, and each set carries a `cursor`: its
greatest position, left off when it equals the set's `hlc` (anything the server wrote
itself). The watermark a reply moves its reader to is the greatest `cursor ?? hlc` among
its sets, computed by `replyWatermark` (exported from `@quereus/sync`); it can only land
*between* whole sets
([sync-transactions.md § Transaction-Based Change Grouping → Read side](sync-transactions.md#read-side-one-changeset-per-transaction)).
A `cursor` is never passed on: a replica applying a set ignores it and files each change
at a position of its own. What a device *pushes* carries none, and is tracked by `hlc`:

1. **Receiving changes**: Only the ordered `changes` reply (contiguous, gap-free) advances `peerSyncState[serverSiteId]` (the *received* watermark), to `replyWatermark` of the reply. A `push_changes` **broadcast** is applied idempotently but must **not** advance it — broadcast delivery is fire-and-forget, so a dropped broadcast is invisible to the coordinator; leaving the watermark below it means the next `get_changes sinceHLC=<watermark>` redelivers (and harmlessly re-applies) it, closing the change-loss hole
2. **Sending changes**: The client tracks `lastSentHLC` (confirmed) and `pendingSentHLC` (awaiting ack), both `ChangeSet.hlc` values — write times of its own transactions, the max over the batch via the shared `maxHLC` helper — persisting `lastSentHLC` per peer on each confirmed ack via `updatePeerSentState` (the *sent* watermark, `pt:` prefix — kept separate from the received `ps:` watermark)
3. **Reconnection / restart**: On reconnect the client re-seeds `lastSentHLC` from the persisted sent watermark (`getPeerSentState`), pushes everything past it one acknowledged batch at a time, and only then sends `get_changes` with `sinceHLC` from the received watermark. The push goes first because the coordinator answers a connection's messages concurrently: a pull answered from the server's pre-push state hands back history the device already has (a broadcast never advances the received watermark), and after an offline key change that history addresses rows by the old key, which the re-keyed table cannot resolve. A push the server rejects, or one that could not be sent on a socket that is still open, is logged and the pull still follows; a socket that drops stops the sequence, and the reconnect runs it again. A fresh process thus resumes delta-push from the last confirmed HLC instead of replaying its entire local history, and a device with a large offline backlog reports `synced` only once its last batch is acknowledged. A manual `disconnect()` clears only the in-memory copy; the persisted watermark is intentionally retained
4. **Server tracking**: The server uses the client's `sinceHLC` to return only what it filed after that position — whole ChangeSets, in filing order, bounded by `batchSize` at ChangeSet granularity — **unless** `sinceHLC` is below its delta floor ([sync.md § Read side → The delta floor](sync-transactions.md#read-side-one-changeset-per-transaction)): a delete the client needs has been pruned, so it answers `snapshot_required` and the client recovers as described under *Client snapshot bootstrap* below. A `get_changes` with no `sinceHLC` is a from-nothing load and is never refused

The push loop, end to end: a local change triggers the debounced send (50 ms window);
the client calls `getChangesToPush(serverSiteId, lastSentHLC)` for per-transaction
ChangeSets, sends `apply_changes { requestId: apply-N, changes }`, and records
`pendingSentHLCs[requestId] = max ChangeSet.hlc of sent txns`; the server replies
`apply_result { requestId, ... }` with the id echoed verbatim; on a matching id the
client sets `lastSentHLC` to that HLC (forward-only) and persists it per peer. One read
returns at most one `batchSize` batch, so when an ack moves the watermark the client reads
and pushes again, ending when nothing is left past it.

The pull loop has the same shape. One `changes` reply holds at most one `batchSize` batch,
rounded up to a whole transaction, so the client applies it, moves the received watermark
(forward-only) and sends `get_changes` again from there, one request at a time. An
interrupted pull therefore resumes from the watermark. Only an empty reply ends the loop and
reports `synced`. The size of a reply cannot serve as the stop signal, because `batchSize` is
the coordinator's setting and a reply can overshoot it. An empty reply is reliable because
every server read starts strictly after `sinceHLC`, so it returns nothing only when nothing
is left. The loop costs one extra round trip per catch-up and leaves the wire format
unchanged. A non-empty reply that does not move the watermark sends nothing further, so a
duplicate reply or a misbehaving server cannot loop. A reply still applying when its socket
is replaced moves the watermark but sends nothing, because the new connection's handshake
starts its own pull. An apply that finishes after the connection is gone does not report
`synced`.

A device pushes only what it wrote (`hlc.siteId` is its own) after its sent watermark,
never what it received. It
assumes one coordinator per database: everything it received came through that server, so
the server has it. So a device that only receives never pushes, and has no sent watermark.
A device restored from the server's snapshot holds its own earlier writes at the server's
positions, above its sent watermark; they are recognized by their write time and not
pushed again.
A [schema seed](sync-schema.md#seeds-and-the-server) is the exception to that assumption: a
device applies it locally, and it never reaches the server.

Pushes therefore do not refill a server restored from an older copy (the coordinator's S3
restore). Such a server gets back only what devices write afterwards and what they have not
yet had acknowledged. Devices once re-uploaded what they had received since their last push,
which refilled part of a restored server by accident; it never covered their own
acknowledged writes, and nothing relied on it.

### Reconnection with Exponential Backoff

When the WebSocket connection drops unexpectedly, the client schedules a reconnect with
`delay = min(1s × 2^attempt, 60s)`, reusing the original connection's URL and token, and
resets the attempt counter to 0 on success. A manual `disconnectSync()` sets
`intentionalDisconnect = true`, preventing auto-reconnect.

### Server Errors: Fatal vs Transient

A server `error` message does **not** by itself stop the client. Reconnect is gated by two
independent flags: `intentionalDisconnect` (set **only** when the client calls
`disconnect()`) and `stopReconnect` (set only by a fatal server error). The coordinator
tags each `error` with a `fatal` boolean:

- **Fatal** (`fatal: true`) — the session is unrecoverable and the coordinator typically
  also closes the socket: `AUTH_FAILED`, `MISSING_DATABASE_ID`, `ALREADY_AUTHENTICATED`.
  The client sets `status: 'error'`, settles any pending `connect()`, and sets
  `stopReconnect` so auto-reconnect halts (a bare retry would just fail again).
- **Transient** (`fatal` absent or false) — one request failed but the session is fine:
  `APPLY_CHANGES_ERROR`, `GET_CHANGES_ERROR`, `SNAPSHOT_ERROR`, `NOT_AUTHENTICATED`,
  `UNKNOWN_MESSAGE`, `MESSAGE_ERROR`. The client surfaces it (`error` sync event +
  `onError`) but keeps the connection **and its auto-reconnect** intact and does not enter
  a lasting `error` status.

For coordinators predating the `fatal` flag, the client falls back to a built-in
known-fatal set (the three codes above); every other code is treated as transient.

### Local Change Debouncing

Rapid local changes are batched to reduce network overhead: each local change event
starts or resets a 50 ms debounce timer, and when it fires the client collects its own
changes since `lastSentHLC` and sends them in one `apply_changes` message — N messages
per edit become 1 per burst.

### Client snapshot bootstrap

A brand-new device cannot catch up incrementally — "changes since nothing" is not the
database. `SyncClient` downloads a full copy instead, on three triggers. The first two are
decided at handshake and finished *before* the incremental path (local-change
subscription, push, `get_changes`) starts:

- `requestSnapshot()`, explicit. Idempotent while a transfer is in flight: a second call
  joins it, and exactly one `get_snapshot` goes on the wire. When the transfer lands, the
  call that started it sends `get_changes` from the snapshot's HLC.
- An empty replica on first connect (`bootstrapOnEmpty`, default `true`). "Empty"
  requires **both** no peer sync state for this server and no change facts, whichever
  device wrote them — the first alone also matches a device holding real local data that
  merely never met this server, and bootstrapping that deletes every row the server's copy
  lacks. A
  locally pre-created schema still counts as empty; replicated DDL applies idempotently.
  So does a device whose rows were written before sync attached, since they have no
  change facts. The `unrecordedRows` check below stands between that device and the
  bootstrap.
- A `snapshot_required` reply to `get_changes`: the device has been away longer than the
  server kept its deletion history, so no delta can be complete. This one runs on a
  device that may hold **unpushed offline work**, and the snapshot apply would destroy it
  (an unpushed local delete undone, an unpushed insert deleted). So the rule is **push
  first**: unless `readOnly`,
  the client pushes everything since `lastSentHLC` one batch at a time, waiting for each
  `apply_result`, until nothing is left past the acknowledged watermark — only then
  `get_snapshot`, then `get_changes` from the snapshot's HLC (at or above the floor by
  construction). A push that fails or cannot be sent, or a socket that drops, stops the
  sequence with no snapshot taken; the reconnect re-sends `get_changes`, is refused
  again, and retries — pushes are idempotent, so this converges. Local writes made
  *during* the transfer remain the gap noted below. The rows such a device holds that the
  server deleted long ago are what the apply removes: nothing else in the sync protocol
  can reach them. That includes a row the device edited offline: the server refuses the
  edit, so the delete holds on every replica and the edit is lost with no event, exactly as
  it is while the tombstone exists
  ([sync.md § Tombstones and Deletions](sync.md#tombstones-and-deletions)). One limit: a
  re-sent insert carries no before-image, so a push that lost its acknowledgement brings
  the whole row back on the server and the writer while a device holding the tombstone
  stays without it (`bug-sync-resent-insert-returns-pruned-row`).

**The two automatic triggers check first.** Under `unrecordedRows: 'refuse'`, the default,
the client asks `findTablesWithUnrecordedRows()` before the bootstrap and before the
`snapshot_required` push, and stops with an `UnrecordedRowsError` if any table holds rows
sync has never recorded. `'replace'` skips the check. So does a pending checkpoint, because
a transfer already under way has cleared the metadata the check reads. `requestSnapshot()`
is never checked. See
[sync.md § Rows sync has never recorded](sync.md#rows-sync-has-never-recorded).

**`'adopt'` records them instead.** The client calls `adoptUnrecordedRows()` at handshake
when it has no received or sent state for this server, before the empty check and whatever
`bootstrapOnEmpty` says, and before the `snapshot_required` push whatever its state. A device
that adopted rows at handshake skips the bootstrap and goes on to the incremental path, whose
push carries them. On `snapshot_required` the push-first rule above carries them to the
server, so they come back in the snapshot. A failed adoption takes no snapshot and retries
through the reconnect. The constructor rejects `'adopt'` with `readOnly`. Adopted rows get
the time of adoption, so they beat older edits of the same key; see
[sync.md § Adopting rows](sync.md#adopting-rows).

Chunks stream through a push-to-pull adapter (`SnapshotStreamReader`) into
`applySnapshotStream`. On success the client records the header's HLC as the received
watermark, so the follow-up `get_changes` starts *after* the snapshot point. The header
HLC is a position: the server takes it as a fresh clock tick, in the same queue that
files incoming changes, before it reads anything, so every change filed below it is in
the snapshot and every later one is filed above it and returned by that `get_changes`.
It is also always above the delta floor, so the follow-up request is never refused. Progress
reaches callers three ways: `onSnapshotProgress` (every tick), the `bootstrapping`
status, and a sync event throttled to table boundaries.

**Do not write locally while a snapshot lands.** The apply clears sync metadata and
rewrites cell records unconditionally, so a concurrent write is silently overwritten and
never pushed, or deleted if it lands just as the footer reconciles its table; the client
cannot block application writes (engine-level barrier:
`backlog/feat-sync-bootstrap-write-gate`). It holds what it does control — local pushes
and the peer-relay `request_changes` wait — and *drops* incoming `changes` /
`push_changes` rather than interleaving them with the rewrite. Nothing is lost: the
watermark stays put, so the post-bootstrap catch-up re-fetches them.

An interrupted apply leaves a checkpoint (`sc:` record) marking the data partial.
`hasPendingSnapshot()` reports one before connecting (e.g. at app startup), and the next
handshake sends `resume_snapshot` with it — newest by `createdAt`, superseded ones
cleared. There is **no dedicated retry machinery**: a failed or stalled transfer (no
chunk within `snapshotChunkTimeoutMs`, default 60 s) closes the socket, and the existing
reconnect backoff paces the retry. A resumed stream's header carries the *original*
snapshot's HLC while its data is read live, so the final watermark is deliberately
conservative — the catch-up re-fetches a little, which is idempotent.
