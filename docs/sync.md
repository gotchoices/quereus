# Sync Module - Multi-Master CRDT Replication

This document describes the architecture for `quereus-sync`, a fully automatic multi-master CRDT replication system for Quereus. It enables offline-first applications where multiple replicas can independently modify data and converge to a consistent state.

## Design Goals

- **Fully Automatic**: All tables in the store are automatically CRDT-enabled. No opt-in required.
- **Automatic Schema Evolution**: Schema changes are tracked and synchronized without special handling.
- **Transport Agnostic**: Exposes sync data structures and APIs without assuming any transport layer.
- **Backend Agnostic**: Works with both LevelDB (Node.js) and IndexedDB (browser) via the store plugin.
- **Reactive**: Exposes hooks for UI reactivity when data changes from local or remote sources.
- **Transaction-Aware**: Changes are grouped by transaction for atomic sync operations.

## Architecture Overview

```
┌────────────────────────────────────────────────────────────────────────────┐
│                         Application Layer                                   │
│  ┌─────────────┐  ┌─────────────┐  ┌─────────────────────────────────────┐ │
│  │   Quereus   │  │ Sync Hooks  │  │     Transport (user-provided)       │ │
│  │  Database   │  │ (reactive)  │  │  WebSocket / HTTP / WebRTC / etc.   │ │
│  └──────┬──────┘  └──────┬──────┘  └─────────────────┬───────────────────┘ │
│         │                │                           │                      │
├─────────┼────────────────┼───────────────────────────┼──────────────────────┤
│         ▼                ▼                           ▼                      │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      quereus-sync                                    │  │
│  │  ┌────────────┐  ┌────────────┐  ┌────────────┐  ┌────────────────┐  │  │
│  │  │    HLC     │  │  Metadata  │  │   Sync     │  │    Schema      │  │  │
│  │  │   Clock    │  │   Store    │  │  Protocol  │  │   Tracker      │  │  │
│  │  └────────────┘  └────────────┘  └────────────┘  └────────────────┘  │  │
│  │                                                                       │  │
│  │  ┌────────────────────────────────────────────────────────────────┐  │  │
│  │  │                    SyncModule (wrapper)                         │  │  │
│  │  │  Intercepts mutations → Records CRDT metadata → Delegates       │  │  │
│  │  └────────────────────────────────────────────────────────────────┘  │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                    │                                        │
├────────────────────────────────────┼────────────────────────────────────────┤
│                                    ▼                                        │
│  ┌──────────────────────────────────────────────────────────────────────┐  │
│  │                      quereus-store                                   │  │
│  │  ┌─────────────────────────┐  ┌─────────────────────────┐            │  │
│  │  │   LevelDB (Node.js)     │  │   IndexedDB (Browser)   │            │  │
│  │  │   Data + CRDT Metadata  │  │   Data + CRDT Metadata  │            │  │
│  │  └─────────────────────────┘  └─────────────────────────┘            │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

## Core Concepts

### Hybrid Logical Clock (HLC)

The sync module uses a Hybrid Logical Clock to establish causal ordering of events across distributed replicas. HLC combines:

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

HLC ordering: `(wallTime, counter, siteId, opSeq)` compared lexicographically. This ensures:
- Events with higher wall time are considered newer
- Events at the same wall time are ordered by counter
- Ties are broken deterministically by site ID
- Facts of the *same* transaction (same `wallTime`, `counter`, `siteId`) are ordered
  by `opSeq`

`opSeq` is the data-model layer for "HLC = transaction" grouping: it is a
contiguous, 0-based sub-order assigned per transaction. Because `siteId` is
compared **before** `opSeq`, two different sites never reach the `opSeq` tiebreak,
so `opSeq` only ever discriminates facts produced by one site at one
`(wallTime, counter)` — i.e. within a single transaction. It is **transaction-local**:
it resets every transaction and is **not** persisted in the `hc:` clock state.

Encoding widths: the comparison key serializes as 30 bytes —
8 (`wallTime`) + 2 (`counter`) + 16 (`siteId`) + 4 (`opSeq`, big-endian uint32) —
both for storage (`serializeHLC`) and as the sortable change-log key component
(`serializeHLCForKey`), where the `opSeq` bytes sit after `siteId` so lexicographic
key order matches `compareHLC`.

### Conflict Resolution: Column-Level Last-Write-Wins (LWW)

Each column of each row is tracked independently. When the same column is modified on multiple replicas, the write with the highest HLC wins.

```
Replica A: UPDATE users SET name = 'Alice' WHERE id = 1  @ HLC(1000, 1, A)
Replica B: UPDATE users SET email = 'b@x.com' WHERE id = 1  @ HLC(1000, 2, B)

After merge: Row has name='Alice' (from A) AND email='b@x.com' (from B)
```

This is more fine-grained than row-level LWW, preserving more user intent.

#### Pluggable Conflict Resolution

The default LWW strategy can be replaced by setting `conflictResolver` on `SyncConfig`. The resolver is called for every column-level conflict where a local version already exists.

```typescript
import { createSyncModule, localWinsResolver, remoteWinsResolver } from '@quereus/sync';
import type { ConflictResolver } from '@quereus/sync';

// Built-in: always keep local value (target-wins)
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: localWinsResolver,
});

// Built-in: always accept remote value (source-wins)
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: remoteWinsResolver,
});

// Custom: per-column policy
const resolver: ConflictResolver = (ctx) => {
  if (ctx.column === 'counter') return 'remote';  // max-wins simulation
  return 'local';                                  // default: keep local
};
const { syncManager } = await createSyncModule(kv, storeEvents, {
  conflictResolver: resolver,
});
```

When no `conflictResolver` is configured, the fast-path HLC comparison is used directly (no extra KV read per column). Schema conflicts remain non-pluggable.

> **Future Work**: The architecture supports extending to other CRDT types (counters, sets, RGA for text) by tracking different metadata per column type.

### Tombstones and Deletions

Deletions are recorded as "tombstones" with an HLC timestamp. Tombstones prevent deleted rows from being resurrected by older writes that arrive later.

**Resurrection Policy** (configurable):
- **Default: Delete Wins** - A deletion with HLC(T1) prevents any column write with HLC < T1
- **Optional: Resurrection Allowed** - An insert/update with HLC > T1 can resurrect a deleted row

**Tombstone TTL**: Tombstones are retained for a configurable duration (default: 30 days). Sync attempts after TTL expiration should fall back to full snapshot transfer.

### Transaction-Based Change Grouping

Changes are grouped by transaction. When syncing:
- All changes within a transaction are sent as a unit
- Applying changes is atomic per transaction
- This preserves referential integrity across related writes

**The grouping boundary is the engine, not the store.** The authoritative
"one logical transaction = one group" anchor is the Quereus engine's
`DatabaseEventEmitter` (`packages/quereus/src/core/database-events.ts`). It hooks
every module's event emitter and **batches all data and schema events of the
whole logical transaction** — `startBatch()` at `beginTransaction`,
`flushBatch()` at `commitTransaction`, `discardBatch()` at `rollbackTransaction`
(`database-transaction.ts`), with savepoint layers discarded on
`ROLLBACK TO SAVEPOINT`. At the commit flush point the complete, ordered,
multi-table fact set of exactly one transaction is known, so the engine exposes
it as a single grouped delivery:

```typescript
interface TransactionCommitBatch {
  readonly dataEvents: ReadonlyArray<DatabaseDataChangeEvent>;   // flush order
  readonly schemaEvents: ReadonlyArray<DatabaseSchemaChangeEvent>;
}

// Fires once per committed transaction (across all tables); dropped on rollback;
// never fires for a transaction that produced no data/schema events.
const off = db.onTransactionCommit((batch) => { /* assign one HLC to the group */ });
```

This is the boundary the sync layer anchors an HLC to: one `onTransactionCommit`
batch ⇒ one transaction ⇒ one HLC. It is purely additive — the per-event
`onDataChange` / `onSchemaChange` channels are untouched.

**Why not the per-table store coordinator.** The store has one
`TransactionCoordinator` *per table* (`store-module.ts` `getCoordinator(tableKey)`),
each with its own `StoreConnection` firing its own event burst. A cross-table
transaction therefore commits several coordinators separately — so a
per-coordinator (per-table) commit would split one logical transaction into
multiple groups and assign it multiple HLCs, breaking the referential-integrity
property above. Only the engine emitter sees the whole transaction at once.

Ordering within a batch is the engine flush order: base batch then each savepoint
layer in push order — i.e. per-module/per-table arrival order at commit, not
global DML-interleave order (store coordinators buffer per-table and fire at their
own commit). This is deterministic and replayable, which is what downstream
`opSeq` assignment needs.

#### Write side: one tick per commit, `opSeq` per fact

The sync layer's local-change capture (`SyncManagerImpl.handleTransactionCommit`)
consumes exactly this grouped batch and records the whole transaction under **one**
base HLC:

```
onTransactionCommit(batch):
  localSchema = batch.schemaEvents where !remote
  localData   = batch.dataEvents   where !remote
  if both empty: return                 // all-remote echo, or empty/idle commit
  base  = hlcManager.tick()             // ONE tick per transaction; opSeq 0
  txnId = deterministicTxnId(base)      // stable over (wallTime, counter, siteId)
  opSeq = 0; kvBatch = kv.batch()
  for each local schema event (DDL before DML):
     record migration with hlc = {...base, opSeq: opSeq++}
  for each local data event, for each fact (per changed column, or the deletion):
     record column-version / tombstone + change-log entry, hlc = {...base, opSeq: opSeq++}
  persist HLC clock state (wallTime/counter only) into kvBatch
  kvBatch.write()                       // all metadata for the transaction, atomically
  emit ONE local-change event { transactionId: txnId, changes, pendingSync: true }
```

Why one tick is correct: `tick()` advances `wallTime`/`counter` once, so the base
`(wallTime, counter, siteId)` is unique among this site's transactions. Every fact
of the transaction shares that triple and differs only in `opSeq` — exactly the
identity the read side groups on. DDL events take the lowest `opSeq`s so they sort
below the same transaction's DML (§ DDL Application Order).

`opSeq` ordering semantics: **intra-table** order is true write order (a coordinator
buffers its table's events in DML order); **cross-table** order is the deterministic
per-coordinator commit order, not the global DML interleave. This is sufficient for
intra-transaction atomicity, intra-table parent-before-child, and full determinism
(same facts ⇒ same `opSeq` on every peer). True cross-table dependency ordering on
*apply* is a separate concern.

Edge cases:
- **Rollback / discard** — the engine fires no group, so `tick()` is never called
  and no HLC/`opSeq` is consumed; a later committed transaction's ordering is never
  polluted by a discarded one.
- **All-remote group (echo)** — a pure sync-apply transaction (every event
  `remote: true`) is skipped entirely; its metadata was already recorded on apply.
- **Mixed group** — local + remote in one transaction records only the local facts,
  assigning `opSeq` only to recorded facts so they stay contiguous.
- **`opSeq` exhaustion** — `opSeq` is a uint32; a transaction whose fact count would
  exceed `MAX_OPSEQ` throws a `QuereusError` (telemetered as an error sync-state)
  rather than wrapping. Practically unreachable.

#### Deterministic transaction id

`transactionId` is derived from the base HLC —
`deterministicTxnId(base) = "${wallTime}:${counter}:${base64(siteId)}"` — rather than
a random UUID. Same transaction ⇒ same id on every peer (the read side reproduces it
from the change-log facts' shared base), so no separate `tx:` record is persisted.

#### Read side: one ChangeSet per transaction

`getChangesSince(peerSiteId, sinceHLC?)` returns **one `ChangeSet` per source
transaction** — never splitting a commit across ChangeSets, never merging two
commits into one (`change-grouping.ts` `buildTransactionChangeSets`):

```
getChangesSince(peerSiteId, sinceHLC):
  facts      = sinceHLC ? changeLog.scan(after sinceHLC) : (all column-versions + tombstones)
               skipping any fact whose hlc.siteId == peerSiteId   // echo filter (whole tx)
  migrations = sm: scan, after sinceHLC, not from peerSiteId
  group facts+migrations by transaction identity (wallTime, counter, siteId):
    each group ⇒ one ChangeSet:
      changes:          group's facts in opSeq order (parent-before-child apply)
      schemaMigrations: group's migrations in opSeq order (DDL below the tx's DML)
      hlc:              group's MAX fact HLC (last opSeq) — the commit boundary
      transactionId:    deterministicTxnId(base)          — same derivation as write side
      siteId:           the group's origin site
  order ChangeSets by base HLC ascending
  bound by batchSize at TRANSACTION granularity (below)
```

The HLC scan is already ordered by `(wallTime, counter, siteId, opSeq)` (the
change-log key, from `sync-hlc-opseq-foundation`), so a transaction's facts are
contiguous and in `opSeq` order. Because a transaction is wholly one site's,
filtering the peer's own facts (echo prevention) drops *whole* transactions — never
a half-empty ChangeSet.

- **Echo filter** — facts/migrations whose `hlc.siteId == peerSiteId` are excluded;
  a transaction wholly from `peerSiteId` yields no ChangeSet.
- **DDL-only transaction** — a `create table` with no DML forms its own ChangeSet
  (`changes: []`, one migration), `hlc` = the migration HLC.
- **DDL + DML in one transaction** — migration and data share the base, so they land
  in one ChangeSet; the migration's lower `opSeq` keeps DDL ahead of DML (the
  applicator processes `schemaMigrations` first regardless).

**Transaction-granularity bounding.** `batchSize` caps the response by accumulating
**whole** transactions: once a completed transaction pushes the cumulative `changes`
count `>= batchSize`, extraction stops and returns — the remaining transactions come
on the next `getChangesSince` call (the consumer advances its watermark to the last
returned `ChangeSet.hlc` and re-fetches). A transaction is **never** split to hit the
bound.

The bound applies at **scan time**, not just response time. On the delta path
(`sinceHLC` given), the change-log scan is HLC-ordered, so `collectChangesSince`
detects each transaction boundary and stops scanning the moment enough whole
transactions accumulate — `batchSize` caps the scan footprint, not only the returned
array. Two scans are *not* bounded this way: the from-zero full scan
(`collectAllChanges`, used when `sinceHLC` is absent) reads `cv:`/`tb:` keyed by
table/pk rather than HLC, so it cannot early-exit (a large initial range is served by
a snapshot instead); and the `sm:` schema-migration scan is not HLC-ordered, so it is
drained in full (migrations are few, and grouping drops any that sort past the bounded
fact watermark — over-scan costs work, never correctness).

> **Known edge case (delete key-reuse).** Scan-time boundary detection keys off the
> *log entry's* HLC, while grouping keys off the *resolved version's* HLC. These match
> for column entries (an overwrite deletes the prior change-log entry) but not for
> delete entries, which are never individually deleted. A `delete → reinsert → delete`
> sequence on the same primary key leaves a stale delete entry that re-attributes to the
> later tombstone's HLC; the scan-time bound can then mis-count and **split** the later
> transaction across two `getChangesSince` rounds (the rest arrives next round). Tracked
> by `sync-stale-delete-entry-reattribution`.

**Oversized transaction.** A single transaction whose fact count exceeds `batchSize`
is returned **whole** as one ChangeSet and telemetered (a `console.warn`), never
silently chunked — splitting it would violate the one-ChangeSet-per-transaction
contract.

**Watermark halts at transaction boundaries.** Because every returned ChangeSet is a
whole transaction whose `hlc` is the commit's max fact HLC, a consumer that sets
`lastSyncHLC = max(applied ChangeSet.hlc)` always lands on a real commit boundary —
`buildChangeLogScanBoundsAfter` then excludes everything `<=` it, so re-fetch resumes
strictly *after* the last whole transaction (no repeats, no gaps, no mid-transaction
resume). A partially applied transaction never advances the watermark: `applyChanges`
applies a ChangeSet atomically and commits metadata only on success (§ Transactional
Integrity During Sync), so a failed ChangeSet leaves the watermark at the prior
boundary.

### Transactional Integrity During Sync

When applying remote changes, the sync system must write to two separate stores:
1. **CRDT metadata** → sync metadata store (column versions, tombstones, peer state)
2. **Actual table data** → each table's data store

**Challenge**: In IndexedDB, each table has its own database, so we cannot have a single atomic transaction spanning both the metadata store and multiple table stores. LevelDB uses a single database with key prefixes, allowing atomic `WriteBatch` commits across tables.

**Write Order**: To ensure crash safety, changes must be applied in this order:
1. **Data first**: Write table data to the data store
2. **Metadata second**: Write CRDT metadata to the sync store

This order is safe because:
- If crash occurs before data: nothing written, re-sync will retry
- If crash occurs after data but before metadata: CRDT state is "dirty" and will re-apply the same changes on next sync. Since CRDT operations are idempotent (same HLC → same LWW outcome), re-applying is safe.
- If crash occurs after metadata: all writes complete, consistent state

The reverse order (metadata first) would be dangerous: if we crash after writing metadata but before data, the CRDT state believes the change is applied but data is missing—and re-sync won't retry.

**Invariant — metadata follows a landed data write**: CRDT metadata must **not** be committed for any change whose data write did not land. This covers two failure shapes, handled identically:
- **Whole-batch throw**: the `applyToStore` callback throws (e.g. a commit-time global-assertion failure over the inbound batch). The exception propagates; no metadata is committed.
- **Per-change failure**: the store adapter does *not* throw on a single change's failure — it keeps applying the other tables (maximizing idempotent storage progress) and records each failure in `ApplyToStoreResult.errors`. The **consumer** treats any non-empty `errors` exactly like a whole-batch throw: it emits `status: 'error'` and throws **before** committing any metadata.

**Unified admission core** (`admission.ts`): both failure shapes — and the data-first/metadata-second/abort-with-no-metadata ordering — are centralized in one seam so every ingress modality behaves identically. `applyDataToStore` is the data-first half: it runs `applyToStore`, emits `status: 'error'` and rethrows on a whole-batch throw, then aborts via `throwIfApplyErrors` on any per-change `errors` (the two are mutually exclusive, so the error state is emitted at most once). `admitGroup` wraps it as a full group-atomic unit — data first, then the caller's `commitMetadata`, then the local HLC clock watermark — used by the wire path (`change-applicator`) and the non-streaming snapshot (`snapshot`). The streaming snapshot (`snapshot-stream`) keeps its own checkpoint-based model (interleaved metadata/data flushes, resume on a saved checkpoint) but reuses `applyDataToStore` for each flush, so a whole-batch flush throw now emits the same `status: 'error'` event the other paths do.

In all cases no metadata is committed, so the caller does not advance its per-peer `lastSyncHLC` watermark and the **whole batch re-resolves and re-applies on the next sync**. Re-application is idempotent: value-identical upserts are suppressed by the adapter, so converged rows do no redundant work and only the previously-failed change is genuinely retried. (A change that *always* fails blocks its whole batch forever — an accepted "poison batch" property of the throw path; detection/recovery is the host's.)

Selective commit (commit the succeeded subset, skip the failed) is intentionally **not** done: a batch spans multiple HLCs but peer re-fetch is governed by a single `lastSyncHLC` watermark, which cannot express "all but the failed change", so a skipped change would never be re-sent. The wire batch is therefore admitted as **one** all-or-nothing `admitGroup` unit, not once per `ChangeSet`.

**Current Status**: ✓ Data is written first (`applyToStore`), then metadata, aborting with no metadata on any whole-batch throw or per-change `ApplyToStoreResult.errors`. The unified admission core (`admitGroup` + `applyDataToStore`, `admission.ts`) centralizes this for the wire and non-streaming snapshot paths; the streaming path reuses the `applyDataToStore` seam for consistent error emission while keeping its checkpoint-based model.

**Per-Table Batching**: Within each table, changes should be applied using `WriteBatch` for atomicity. The `TransactionCoordinator` in the Store module provides this capability.

**Atomicity Gap (IndexedDB)**: The legacy `IndexedDBModule` uses separate databases per table. The new `UnifiedIndexedDBModule` (Store Phase 7) solves this by placing all tables in a single database with object stores, enabling atomic cross-table transactions via `MultiStoreWriteBatch`.

**Isolation Gap**: Even with correct write ordering, readers may see partially-applied state during sync. True isolation would require Store-level support—see [Future: Store Isolation](#future-store-isolation) below.

### Single-Database Architecture (Store Phase 7) ✓

The `UnifiedIndexedDBModule` uses a single IndexedDB database with multiple object stores (one per table). This enables atomic cross-table transactions.

| UnifiedIndexedDBModule | Legacy IndexedDBModule |
|------------------------|------------------------|
| ✅ Native cross-table IDB transactions | ❌ No cross-DB transactions |
| ✅ Sync metadata + data in one transaction | ❌ Sequential commits |
| ✅ No WAL needed for crash recovery | ⚠️ Would need WAL |
| ✅ Same storage quota | ✅ Same storage quota |

With `UnifiedIndexedDBModule`, sync can use `MultiStoreWriteBatch`:
```typescript
const batch = module.createMultiStoreBatch();
batch.putToStore('main.users', userKey, userData);
batch.putToStore('main.orders', orderKey, orderData);
batch.putToStore('__catalog__', metaKey, syncMetadata);
await batch.write();  // Native atomicity across all stores
```

### Store Isolation (Store Phase 8 - Future)

Longer-term, the Store module should provide transaction isolation similar to the memory vtab's layered architecture:

1. **TransactionLayer pattern**: Writers work on an isolated layer; readers see committed snapshot
2. **Copy-on-write semantics**: Inherited from memory vtab's BTree layering
3. **Atomic visibility**: All changes become visible at once on commit

If Store provides this primitive, sync can leverage it:
```
store.beginTransaction()    // Isolated write context
// Apply all data changes   (invisible to readers)
// Apply all CRDT metadata  (invisible to readers)
store.commit()              // Atomically visible
```

This would eliminate the isolation gap, providing true ACID semantics for sync operations across multiple tables. This is tracked in store.md as Phase 8.

## Storage Layout

CRDT metadata is stored alongside data in the same KV store using distinct key prefixes:

| Prefix | Purpose | Format |
|--------|---------|--------|
| `cv:{schema}.{table}:{pk}:{col}` | Column version | `{hlc, value}` |
| `tb:{schema}.{table}:{pk}` | Tombstone | `{hlc}` |
| `tx:{txId}` | *Reserved — not persisted.* The transaction id is **derived** from the base HLC (see *Deterministic transaction id*), so no transaction record is written. The `tx:` prefix and `buildTransactionKey` remain reserved for a future durable txn log. | — |
| `ps:{siteId}` | Peer sync state | `{lastSyncHlc}` |
| `sm:{schema}.{table}:{version}` | Schema migration | `{ddl, hlc}` |
| `si:` | Site identity | `{siteId, createdAt}` |
| `hc:` | HLC state | `{wallTime, counter}` |

This co-location ensures:
- Atomic updates of data and metadata within transactions
- Single storage backend for both LevelDB and IndexedDB
- No additional database connections needed

## Sync Protocol

### Data Structures

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
}

/** A row deletion */
interface RowDeletion {
  type: 'delete';
  schema: string;
  table: string;
  pk: SqlValue[];
  hlc: HLC;
}

type Change = ColumnChange | RowDeletion;

/** A schema modification */
interface SchemaMigration {
  type: 'create_table' | 'drop_table' | 'add_column' | 'drop_column' | 'add_index' | 'drop_index';
  schema: string;
  table: string;
  ddl: string;                       // The DDL statement
  hlc: HLC;
  schemaVersion: number;             // Monotonic per-table version
}
```

### Sync API

```typescript
interface SyncManager {
  /** Get this replica's site ID */
  getSiteId(): SiteId;

  /** Get current HLC for state comparison */
  getCurrentHLC(): HLC;

  /**
   * Get all changes since a peer's last known state.
   * For initial sync, omit sinceHLC to get full snapshot.
   */
  getChangesSince(peerSiteId: SiteId, sinceHLC?: HLC): Promise<ChangeSet[]>;

  /**
   * Apply changes received from a peer.
   * Returns statistics about what was applied.
   */
  applyChanges(changes: ChangeSet[]): Promise<ApplyResult>;

  /**
   * Check if delta sync is possible or if snapshot is required.
   * Returns false if tombstone TTL has expired for relevant data.
   */
  canDeltaSync(peerSiteId: SiteId, sinceHLC: HLC): Promise<boolean>;

  /**
   * Get a full snapshot for initial sync or TTL expiration recovery.
   */
  getSnapshot(): Promise<Snapshot>;

  /**
   * Apply a full snapshot (replaces all local data).
   */
  applySnapshot(snapshot: Snapshot): Promise<void>;
}

interface ApplyResult {
  applied: number;      // Changes successfully applied
  skipped: number;      // Changes already present (no-op due to LWW)
  conflicts: number;    // Conflicts resolved (remote won or lost)
  transactions: number; // Number of transactions processed
}

interface Snapshot {
  siteId: SiteId;
  hlc: HLC;
  tables: TableSnapshot[];
  schema: SchemaMigration[];
}

interface TableSnapshot {
  schema: string;
  table: string;
  rows: Row[];
  columnVersions: Map<string, HLC>;  // Per-column HLC for each row
}

// ============================================================================
// Streaming Snapshot API (for large datasets)
// ============================================================================

interface SyncManager {
  // ... existing methods ...

  /**
   * Stream a snapshot as chunks for memory-efficient transfer.
   * Use this instead of getSnapshot() for large databases.
   */
  getSnapshotStream(chunkSize?: number): AsyncIterable<SnapshotChunk>;

  /**
   * Apply a streamed snapshot with progress tracking.
   * Supports resumption via checkpoint tracking.
   *
   * A fresh apply replaces all local CRDT metadata: the up-front clear wipes
   * column versions, tombstones, and the change log before the chunks rewrite
   * them. On a *resumed* apply the sender skips already-completed tables and
   * never re-emits their metadata, so the receiver consults the persisted
   * checkpoint (saved under `sc:{snapshotId}`) and preserves those completed
   * tables through the clear — otherwise their CRDT state would be wiped and
   * never rewritten, diverging from the row data still in the store.
   */
  applySnapshotStream(
    chunks: AsyncIterable<SnapshotChunk>,
    onProgress?: (progress: SnapshotProgress) => void
  ): Promise<void>;

  /**
   * Get a resumable checkpoint for an in-progress snapshot.
   */
  getSnapshotCheckpoint(snapshotId: string): Promise<SnapshotCheckpoint | undefined>;

  /**
   * Resume a snapshot transfer from a checkpoint.
   */
  resumeSnapshotStream(checkpoint: SnapshotCheckpoint): AsyncIterable<SnapshotChunk>;
}

/** Snapshot chunk types for streaming */
type SnapshotChunk =
  | SnapshotHeaderChunk      // Sent first with metadata
  | SnapshotTableStartChunk  // Marks beginning of a table
  | SnapshotColumnVersionsChunk  // Batch of column versions
  | SnapshotTableEndChunk    // Marks end of a table
  | SnapshotSchemaMigrationChunk  // Schema migration
  | SnapshotFooterChunk;     // Sent last with stats

/** Progress info during snapshot streaming */
interface SnapshotProgress {
  snapshotId: string;
  tablesProcessed: number;
  totalTables: number;
  entriesProcessed: number;
  totalEntries: number;
  currentTable?: string;
}

/** Checkpoint for resumable snapshot transfers */
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

### Sync Flow (Master to Many-Masters)

For the primary use case of a master server syncing to many frontend replicas:

```
┌─────────────┐                              ┌─────────────┐
│   Master    │                              │  Frontend   │
│   Server    │                              │  Replica    │
└──────┬──────┘                              └──────┬──────┘
       │                                            │
       │  1. Frontend connects, sends:              │
       │     { mySiteId, lastSyncHLC }              │
       │◄───────────────────────────────────────────│
       │                                            │
       │  2. Master checks canDeltaSync()           │
       │     If false: send full snapshot           │
       │     If true: getChangesSince()             │
       │                                            │
       │  3. Master sends ChangeSet[]               │
       │────────────────────────────────────────────►
       │                                            │
       │  4. Frontend applies changes               │
       │     applyChanges(changeSets)               │
       │                                            │
       │  5. Frontend sends its local changes       │
       │     (changes made while offline)           │
       │◄───────────────────────────────────────────│
       │                                            │
       │  6. Master applies frontend changes        │
       │     Conflicts resolved via LWW             │
       │                                            │
       │  7. If conflicts, master re-sends winners  │
       │────────────────────────────────────────────►
       │                                            │
```

### WebSocket Sync Protocol

The WebSocket protocol provides real-time bidirectional synchronization. This is the recommended transport for interactive applications.

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        WebSocket Message Flow                               │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│  CLIENT                                            SERVER                  │
│    │                                                  │                    │
│    │──────── { type: "handshake", siteId, token? } ──►│                    │
│    │                                                  │                    │
│    │◄─────── { type: "handshake_ack", serverSiteId } ─│                    │
│    │                                                  │                    │
│    │──────── { type: "get_changes", sinceHLC? } ─────►│                    │
│    │                                                  │                    │
│    │◄─────── { type: "changes", changeSets: [...] } ──│                    │
│    │                                                  │                    │
│    │──────── { type: "apply_changes", changes } ─────►│  (local changes)   │
│    │                                                  │                    │
│    │◄─────── { type: "apply_result", applied, ... } ──│                    │
│    │                                                  │                    │
│    │◄────── { type: "push_changes", changeSets } ─────│  (from other peer) │
│    │                                                  │                    │
│    │──────── { type: "ping" } ───────────────────────►│  (heartbeat)       │
│    │◄─────── { type: "pong" } ────────────────────────│                    │
│    │                                                  │                    │
└────────────────────────────────────────────────────────────────────────────┘
```

#### Message Types

**Client → Server:**

| Type | Purpose | Payload |
|------|---------|---------|
| `handshake` | Authenticate and establish session | `{ siteId, token? }` |
| `get_changes` | Request changes since an HLC | `{ sinceHLC? }` (base64) |
| `apply_changes` | Push local changes to server | `{ changes: ChangeSet[] }` |
| `get_snapshot` | Request full snapshot | (none) |
| `ping` | Heartbeat / keepalive | (none) |

**Server → Client:**

| Type | Purpose | Payload |
|------|---------|---------|
| `handshake_ack` | Confirm authentication | `{ serverSiteId, connectionId }` |
| `changes` | Response to `get_changes` | `{ changeSets: ChangeSet[] }` |
| `push_changes` | Broadcast from another client | `{ changeSets: ChangeSet[] }` |
| `apply_result` | Confirm changes applied | `{ applied, skipped, conflicts }` |
| `snapshot_chunk` | Streamed snapshot data | `{ chunk: SnapshotChunk }` |
| `error` | Error response | `{ code, message }` |
| `pong` | Heartbeat response | (none) |

#### Connection Lifecycle

```
┌────────────────────────────────────────────────────────────────────────────┐
│                        Client Connection State Machine                      │
├────────────────────────────────────────────────────────────────────────────┤
│                                                                            │
│   ┌─────────────┐                                                          │
│   │ DISCONNECTED│◄─────────────────────────────────────────────┐           │
│   └──────┬──────┘                                              │           │
│          │ connectSync(url, token)                             │           │
│          ▼                                                     │           │
│   ┌─────────────┐                                              │           │
│   │ CONNECTING  │──────────────────────────────────────────────┤           │
│   └──────┬──────┘  WebSocket error or close                    │           │
│          │ onopen → send handshake                             │           │
│          ▼                                                     │           │
│   ┌─────────────┐                                              │           │
│   │   SYNCING   │──────────────────────────────────────────────┤           │
│   └──────┬──────┘  handshake_ack → get_changes                 │           │
│          │ changes received → applyChanges()                   │           │
│          ▼                                                     │           │
│   ┌─────────────┐                                              │           │
│   │   SYNCED    │◄─────┐                                       │           │
│   └──────┬──────┘      │ apply_result or push_changes applied  │           │
│          │             │                                       │           │
│          └─────────────┘ local change → apply_changes          │           │
│          │                                                     │           │
│          │ WebSocket close (unintentional)                     │           │
│          ▼                                                     │           │
│   ┌─────────────┐                                              │           │
│   │ RECONNECTING│─── exponential backoff (1s, 2s, 4s... 60s) ──┘           │
│   └─────────────┘                                                          │
│                                                                            │
└────────────────────────────────────────────────────────────────────────────┘
```

#### Delta Sync Optimization

To minimize data transfer, clients track sync progress with the server. Every
watermark is a **`ChangeSet.hlc`** — a transaction commit boundary (the max over
`changeSets[].hlc`, computed by the shared `maxHLC` clock helper), never a per-change max or a
batch-slice boundary — so advancing it can only ever land *between* whole
transactions (§ Transaction-Based Change Grouping → Read side):

1. **Receiving changes**: After applying server changes, client updates `peerSyncState[serverSiteId]` with the max `ChangeSet.hlc` received
2. **Sending changes**: Client tracks `lastSentHLC` (confirmed) and `pendingSentHLC` (awaiting ack), both `ChangeSet.hlc` values
3. **Reconnection**: On reconnect, client sends `get_changes` with `sinceHLC` from peer sync state
4. **Server tracking**: Server uses client's `sinceHLC` to return only new transactions — whole ChangeSets after that boundary, bounded by `batchSize` at transaction granularity

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                        Delta Sync State Tracking                            │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│  Client State:                     Server State:                            │
│  ┌─────────────────────────────┐   ┌─────────────────────────────┐          │
│  │ peerSyncState[serverSiteId] │   │ Change Log (HLC-indexed)    │          │
│  │   └─ lastReceivedHLC        │   │   └─ All changes since T0   │          │
│  │                             │   │                             │          │
│  │ lastSentHLC (confirmed)     │   │ Per-client session:         │          │
│  │ pendingSentHLC (in-flight)  │   │   └─ lastSyncHLC            │          │
│  └─────────────────────────────┘   └─────────────────────────────┘          │
│                                                                             │
│  On reconnect:                                                              │
│  1. Client: get_changes { sinceHLC: peerSyncState[serverSiteId] }           │
│  2. Server: Returns only whole transactions with ChangeSet.hlc > sinceHLC   │
│  3. Client: applyChanges(), updates peerSyncState                           │
│                                                                             │
│  On local change:                                                           │
│  1. Local change triggers debounced send (50ms window)                      │
│  2. Client: getChangesSince(serverSiteId, lastSentHLC) → per-tx ChangeSets  │
│  3. Client: apply_changes { changes }                                       │
│  4. Client: pendingSentHLC = max ChangeSet.hlc of sent transactions         │
│  5. Server: apply_result { applied, ... }                                   │
│  6. Client: lastSentHLC = pendingSentHLC (on success)                       │
│                                                                             │
└─────────────────────────────────────────────────────────────────────────────┘
```

#### Reconnection with Exponential Backoff

When the WebSocket connection drops unexpectedly:

1. Client schedules reconnect with exponential backoff: `delay = min(1s × 2^attempt, 60s)`
2. On successful reconnect, attempt counter resets to 0
3. Manual `disconnectSync()` sets `intentionalDisconnect = true` to prevent auto-reconnect
4. Reconnect attempts use the same URL and token from the original connection

#### Local Change Debouncing

Rapid local changes are batched to reduce network overhead:

1. On local change event, start/reset a 50ms debounce timer
2. When timer fires, collect all changes since `lastSentHLC`
3. Send batched changes in a single `apply_changes` message
4. This reduces WebSocket messages from N per edit to 1 per burst

## Reactive Hooks

The sync module exposes reactive hooks for UI integration:

```typescript
interface SyncEventEmitter {
  /** Fired when remote changes are applied locally */
  onRemoteChange(listener: (event: RemoteChangeEvent) => void): () => void;

  /** Fired when local changes are ready to sync */
  onLocalChange(listener: (event: LocalChangeEvent) => void): () => void;

  /** Fired when sync state changes (connected, syncing, error) */
  onSyncStateChange(listener: (state: SyncState) => void): () => void;

  /** Fired when a conflict is resolved */
  onConflictResolved(listener: (event: ConflictEvent) => void): () => void;
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
§ Transaction-Based Change Grouping → *Write side*). A key design goal is that
reactive events fire **exactly once** for each change, whether local or remote.

> **Why the engine emitter, not the per-table store emitter.** The per-table
> `StoreEventEmitter` / `TransactionCoordinator` sits **below** the transaction
> boundary: each table has its own coordinator, so a cross-table commit fires
> several separate bursts and cannot be grouped into one transaction. The single
> boundary that sees one logical transaction whole — across every table — is the
> engine's `DatabaseEventEmitter.onTransactionCommit`. The grouped batch preserves
> each event's `remote` flag, so the write side still filters remote-origin events
> out of the group (an all-remote group is a pure sync-apply echo and is skipped).
> A relay-only deployment (e.g. a coordinator) that produces no local DML simply
> omits `transactionSource` and captures nothing.

#### Event Flow

**Local Changes:**
```
User SQL → engine commits txn → db.onTransactionCommit (grouped, remote=false)
        → SyncManager records metadata under one HLC → UI receives per-event store events
```

**Remote Changes:**
```
SyncManager receives remote change → Updates metadata → Calls applyToStore → Store executes → Store emits event (remote=true) → SyncManager ignores → UI receives event
```

In both cases, the UI receives exactly one event from the Store. The `remote` flag determines whether the SyncManager should record CRDT metadata (local) or skip (remote).

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

#### Sync Module Event Handling

The SyncManager subscribes once to the engine transaction boundary and records the
whole committed transaction under one HLC, emitting a single local-change event:

```typescript
// Sync module subscribes to the engine transaction-commit boundary.
db.onTransactionCommit((batch) => {
  const localSchema = batch.schemaEvents.filter((e) => !e.remote);
  const localData = batch.dataEvents.filter((e) => !e.remote);
  if (localSchema.length === 0 && localData.length === 0) return; // all-remote echo

  const base = hlcManager.tick();                 // ONE HLC per transaction
  const transactionId = deterministicTxnId(base); // stable across peers
  let opSeq = 0;
  const kvBatch = kv.batch();

  for (const e of localSchema) recordMigration(kvBatch, e, base, opSeq++);   // DDL first
  for (const e of localData)   recordFacts(kvBatch, e, base, () => opSeq++);  // then DML
  persistHlcState(kvBatch);
  await kvBatch.write();

  // One local-change event per committed transaction, for UI reactivity.
  syncEventEmitter.emitLocalChange({ transactionId, changes, pendingSync: true });
});
```

#### Applying Remote Changes

When the SyncManager applies remote changes, it must execute SQL in a way that the resulting store events are marked with `remote: true`:

```typescript
// SyncManager applies a remote changeset
async applyRemoteChangeset(changeset: ChangeSet): Promise<void> {
  // 1. Apply to store with remote flag (the data write must land first)
  await this.applyToStore(changeset.changes, { remote: true });
  // Store emits events with remote=true, SyncManager ignores them

  // 2. Commit CRDT metadata only after the data write succeeded — see the
  //    write-ordering invariant under Transactional Integrity During Sync.
  for (const change of changeset.changes) {
    await this.updateMetadataForRemote(change);
  }
}
```

The store plugin provides a mechanism to execute SQL with the remote flag:

```typescript
interface ApplyOptions {
  remote?: boolean;  // Mark resulting events as remote
}

// Store implementation ensures emitted events have remote=true
async applyChanges(changes: Change[], options: ApplyOptions): Promise<void> {
  for (const change of changes) {
    // Execute SQL...
    // When emitting event, include remote flag from options
    this.events.emitDataChange({ ...event, remote: options.remote });
  }
}
```

## Schema Synchronization

Schema (catalog) changes are synchronized using the same CRDT approach as data, ensuring eventual convergence across all replicas without requiring a perpetual migration log.

### Design Principles

1. **Catalog as Data**: Schema elements (tables, columns, indexes) are tracked with HLCs just like row data
2. **Column-Level Granularity**: Each column definition has its own HLC, enabling parallel schema changes
3. **Most Destructive Wins**: DROP operations take precedence over modifications
4. **DDL Before DML**: Sync batches always apply schema changes before data changes
5. **No Perpetual Log**: Only current state is tracked, not a history of migrations

### Schema Metadata Storage

Schema metadata is stored alongside data metadata using the same patterns:

| Key Pattern | Purpose | Value |
|-------------|---------|-------|
| `sv:{schema}.{table}:__table__` | Table existence | `{hlc, exists, ddl}` |
| `sv:{schema}.{table}:{column}` | Column definition | `{hlc, definition, deleted?}` |
| `sv:{schema}.{table}:{index}:__index__` | Index definition | `{hlc, definition, deleted?}` |

### Conflict Resolution: Most Destructive Wins

Schema conflicts follow a hierarchy where more destructive operations take precedence:

```
DROP TABLE > DROP COLUMN > ALTER COLUMN > ADD COLUMN
DROP TABLE > DROP INDEX > CREATE INDEX
```

Within the same level of destructiveness, Last-Write-Wins (LWW) applies based on HLC.

**Examples:**

```
Replica A: DROP COLUMN foo      @ HLC(1000, 1, A)
Replica B: ALTER COLUMN foo...  @ HLC(2000, 1, B)

Resolution: DROP wins (more destructive), even though B has higher HLC.
```

```
Replica A: ALTER COLUMN foo SET DEFAULT 'x'  @ HLC(1000, 1, A)
Replica B: ALTER COLUMN foo SET DEFAULT 'y'  @ HLC(2000, 1, B)

Resolution: B wins (same level, higher HLC).
```

```
Replica A: ADD COLUMN bar INTEGER  @ HLC(1000, 1, A)
Replica B: ADD COLUMN bar TEXT     @ HLC(2000, 1, B)

Resolution: B wins (same level, higher HLC). Column ends up as TEXT.
```

### DDL Application Order

When applying a sync batch:

1. **Schema changes first**: All DDL operations are applied before any DML
2. **Destructive operations first**: DROP TABLE, then DROP COLUMN, then ALTER/ADD
3. **Data changes second**: INSERT/UPDATE/DELETE applied to the now-correct schema

This ensures that structures always exist before data referencing them arrives.

### Schema Change Types

```typescript
type SchemaChangeType =
  | 'create_table'
  | 'drop_table'
  | 'add_column'
  | 'drop_column'
  | 'alter_column'
  | 'create_index'
  | 'drop_index'
  | 'create_view'
  | 'drop_view'
  | 'create_trigger'
  | 'drop_trigger';

interface SchemaChange {
  type: SchemaChangeType;
  schema: string;
  table: string;
  column?: string;           // For column operations
  objectName?: string;       // For index/view/trigger
  definition?: string;       // DDL or column definition
  hlc: HLC;
  deleted?: boolean;         // True for DROP operations
}
```

### Applying Remote Schema Changes

When a remote schema change is received:

1. Compare HLCs using the "most destructive wins" rule
2. If remote wins, update local schema metadata
3. Execute the DDL against the database (with `remote: true` flag)
4. The store emits schema change events for UI reactivity

```typescript
async applySchemaChange(change: SchemaChange): Promise<'applied' | 'skipped'> {
  const local = await this.getSchemaVersion(change.schema, change.table, change.column);

  if (local && !this.shouldApplySchemaChange(change, local)) {
    return 'skipped';
  }

  // Update metadata
  await this.setSchemaVersion(change.schema, change.table, change.column, {
    hlc: change.hlc,
    definition: change.definition,
    deleted: change.deleted,
  });

  // Execute DDL via callback (store applies with remote flag)
  if (change.definition) {
    await this.applyDDL(change.definition, { remote: true });
  }

  return 'applied';
}

private shouldApplySchemaChange(remote: SchemaChange, local: SchemaVersion): boolean {
  // Most destructive wins
  if (remote.deleted && !local.deleted) return true;   // DROP beats non-DROP
  if (!remote.deleted && local.deleted) return false;  // non-DROP loses to DROP

  // Same level: LWW
  return compareHLC(remote.hlc, local.hlc) > 0;
}
```

## Configuration

```typescript
interface SyncConfig {
  /** Tombstone retention period in milliseconds (default: 30 days) */
  tombstoneTTL: number;

  /** Whether deleted rows can be resurrected by later writes (default: false) */
  allowResurrection: boolean;

  /** Maximum changes per sync batch (default: 1000) */
  batchSize: number;

  /** Site ID (auto-generated if not provided) */
  siteId?: Uint8Array;
}

// Usage
const sync = createSyncModule(storeModule, storeEventEmitter, {
  tombstoneTTL: 30 * 24 * 60 * 60 * 1000,  // 30 days
  allowResurrection: false,
  batchSize: 1000,
});
```

## Usage Example

```typescript
import { Database } from '@quereus/quereus';
import { LevelDBModule, LevelDBStore, StoreEventEmitter } from 'quereus-store';
import { createSyncModule } from '@quereus/sync';

// 1. Set up store with event emitter
const storeEvents = new StoreEventEmitter();
const store = new LevelDBModule(storeEvents);

// 2. Open a KV store for sync metadata
const kvStore = await LevelDBStore.open({ path: './sync-meta' });

// 3. Create sync module
const { syncManager, syncEvents } = await createSyncModule(kvStore, storeEvents, {
  tombstoneTTL: 30 * 24 * 60 * 60 * 1000,
});

// 4. Register store module with database
const db = new Database();
db.registerModule('store', store);

// 5. Create tables (sync automatically tracks changes via storeEvents)
await db.exec(`
  create table users (
    id integer primary key,
    name text,
    email text
  ) using store(path='./data')
`);

// 6. Subscribe to sync events for UI
syncEvents.onRemoteChange((event) => {
  console.log('Remote changes applied:', event.changes.length);
  // Update UI, invalidate caches, etc.
});

syncEvents.onConflictResolved((event) => {
  console.log(`Conflict on ${event.table}.${event.column}: ${event.winner} won`);
});

// 7. Implement your transport layer
async function syncWithServer(ws: WebSocket) {
  // Get changes to send
  const localChanges = await syncManager.getChangesSince(
    serverSiteId,
    lastServerHLC
  );

  // Send via your transport
  ws.send(JSON.stringify({ type: 'changes', data: localChanges }));

  // Receive and apply server changes
  ws.onmessage = async (msg) => {
    const serverChanges = JSON.parse(msg.data);
    const result = await syncManager.applyChanges(serverChanges);
    console.log(`Applied ${result.applied} changes`);
  };
}
```

### Streaming Snapshot Example

For large databases, use streaming snapshots to avoid loading everything into memory:

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

// Resume interrupted snapshot
async function resumeSnapshot(ws: WebSocket) {
  const checkpoint = await syncManager.getSnapshotCheckpoint(snapshotId);
  if (checkpoint) {
    // Request resume from server
    ws.send(JSON.stringify({ type: 'resume', checkpoint }));

    // Server resumes from checkpoint
    for await (const chunk of syncManager.resumeSnapshotStream(checkpoint)) {
      ws.send(JSON.stringify(chunk));
    }
  }
}
```

### Store Adapter for Remote Changes

The `createStoreAdapter` function creates a unified adapter for applying remote changes to LevelDB and IndexedDB stores:

```typescript
import { createStoreAdapter } from '@quereus/sync';
import { LevelDBStore, StoreEventEmitter } from '@quereus/store';

// Create event emitter for store events
const storeEvents = new StoreEventEmitter();

// Open your KV store
const kvStore = await LevelDBStore.open({ path: './data' });

// Create the store adapter
const applyToStore = createStoreAdapter(kvStore, storeEvents);

// Use with SyncManager - remote changes are applied via the adapter
const syncManager = new SyncManagerImpl(metadataKvStore, storeEvents, applyToStore, {
  tombstoneTTL: 30 * 24 * 60 * 60 * 1000,
});

// When remote changes arrive, the adapter:
// 1. Handles UPSERT semantics (insert if row doesn't exist, update if it does)
// 2. Deletes rows by primary key
// 3. Executes DDL for schema changes
// 4. Emits events with remote=true to prevent re-recording CRDT metadata
```

## Implementation Status

### Completed

#### Phase 1: Core Infrastructure ✅
- [x] Create package structure (`quereus-sync`)
- [x] Implement HLC (Hybrid Logical Clock)
  - [x] `clock/hlc.ts` - HLC type, comparison, tick, receive
  - [x] `clock/site.ts` - Site ID generation and persistence
- [x] Implement CRDT metadata storage
  - [x] `metadata/keys.ts` - Key builders for sync metadata
  - [x] `metadata/column-version.ts` - Column version tracking
  - [x] `metadata/tombstones.ts` - Deletion tracking with TTL
  - [x] `metadata/peer-state.ts` - Peer sync state tracking
  - [x] `metadata/schema-migration.ts` - Schema change tracking

#### Phase 2: Sync Protocol ✅
- [x] Define protocol types (`sync/protocol.ts`)
- [x] Implement SyncManager interface (`sync/manager.ts`)
- [x] Implement SyncManagerImpl (`sync/sync-manager-impl.ts`)
  - [x] `applyChanges()` - Apply with LWW conflict resolution
  - [x] `canDeltaSync()` - TTL check for delta vs snapshot
  - [x] `updatePeerSyncState()` / `getPeerSyncState()` - Track peer sync progress

#### Phase 3: Event Integration ✅
- [x] Subscribe to `StoreEventEmitter` for data change events
- [x] Record column versions on insert/update
- [x] Record tombstones on deletion

#### Phase 4: Schema Sync ✅
- [x] `SchemaMigrationStore` - Track DDL changes with HLC
- [x] First-writer-wins conflict resolution for schema changes

#### Phase 5: Reactive Hooks ✅
- [x] Implement `SyncEventEmitter`
  - [x] `onRemoteChange` - Remote changes applied
  - [x] `onLocalChange` - Local changes pending
  - [x] `onSyncStateChange` - Connection state
  - [x] `onConflictResolved` - Conflict outcomes

#### Phase 6: Testing ✅
- [x] Unit tests for HLC
- [x] Unit tests for Site ID
- [x] Unit tests for ColumnVersionStore
- [x] Unit tests for TombstoneStore
- [x] Integration tests for SyncManager

#### Phase 7: Change Extraction ✅
- [x] `getChangesSince()` - Extract delta changes from metadata storage
- [x] `getSnapshot()` - Full snapshot for initial/recovery sync
- [x] `applySnapshot()` - Full state replacement
- [x] `pruneTombstones()` - Clean up expired tombstones

#### Phase 8: Streaming Snapshots ✅
- [x] `getSnapshotStream()` - Memory-efficient chunked snapshot streaming
- [x] `applySnapshotStream()` - Apply streamed snapshots with progress tracking
- [x] `getSnapshotCheckpoint()` / `resumeSnapshotStream()` - Resumable transfers
- [x] HLC-indexed change log for efficient delta queries

#### Phase 9: Remote Change Application ✅
- [x] `remote?: boolean` flag exists on both `DataChangeEvent` and `SchemaChangeEvent`
- [x] `handleDataChange()` skips events with `remote === true`
- [x] `handleSchemaChange()` skips events with `remote === true`
- [x] `applyToStore` callback mechanism for applying remote changes
  - [x] `ApplyToStoreCallback` type with `{ remote: true }` option
  - [x] `DataChangeToApply` / `SchemaChangeToApply` types for callback parameters
  - [x] Store implementations can emit events with `remote: true` flag
- [x] Reactive events fire exactly once (UI receives from Store, SyncManager ignores remote events)
- [x] Unit tests for `applyToStore` callback behavior

#### Phase 10: Store Integration ✅
- [x] Implement `createStoreAdapter()` - unified adapter for LevelDB and IndexedDB
- [x] Handle UPSERT semantics (column changes may be insert or update)
- [x] Handle row deletions by primary key
- [x] Execute DDL for schema changes with `remote: true`
- [x] Emit data change events with `remote: true` to prevent re-recording CRDT metadata

#### Phase 11: Schema Sync Refinement ✅
- [x] Implement column-level schema version storage (`SchemaVersionStore`)
- [x] Track schema elements with HLCs: `sv:{schema}.{table}:{column}` pattern
- [x] Implement "most destructive wins" conflict resolution
  - [x] `getDestructiveness()` - rank schema version types
  - [x] `getOperationDestructiveness()` - rank schema change operations
  - [x] `shouldApplySchemaChangeByOperation()` - compare changes with destructiveness hierarchy
- [x] Schema conflict tests (destructiveness ranking, LWW for same level)

#### Phase 12: Integration Testing ✅
- [x] E2E test: two replicas with bidirectional sync
- [x] Multi-replica conflict scenarios (concurrent writes to same column)
- [x] LWW conflict resolution tests
- [x] Delete-update conflict handling tests
- [x] Full snapshot sync between replicas

### Remaining Work

#### Transactional Integrity (Short-term)
- [x] Fix write order in `applyChanges`: write data first, then CRDT metadata; abort with no metadata on any whole-batch throw or per-change `ApplyToStoreResult.errors` (see [Transactional Integrity During Sync](#transactional-integrity-during-sync))
- [ ] Use `WriteBatch` for per-table atomicity when applying remote changes
- [ ] Consider using `TransactionCoordinator` in store adapter for batched writes

#### Single-Database Architecture (Store Phase 7) ✓
- [x] Migrate IndexedDB to single database with multiple object stores (`UnifiedIndexedDBModule`)
- [x] Place sync metadata in same database as data tables (`__catalog__` object store)
- [x] Leverage native IDB transactions for cross-table atomicity (`MultiStoreWriteBatch`)
- [ ] Update sync store adapter to use `UnifiedIndexedDBModule` for atomic sync writes

#### Store Isolation (Longer-term - Store Phase 8)
- [ ] Implement isolation in Store module using memory vtab's TransactionLayer pattern
- [ ] Leverage Store isolation for sync to get true ACID semantics (see [Future: Store Isolation](#future-store-isolation))

#### Advanced Testing
- [ ] Tombstone TTL expiration and fallback to snapshot
- [ ] Large dataset streaming snapshot tests
- [ ] Network interruption / resume tests
- [ ] Integration tests with IndexedDB (browser environment)
- [ ] Crash recovery tests (verify idempotent re-apply after partial sync)

#### Documentation & Examples
- [ ] Example: WebSocket sync transport
- [ ] Example: HTTP polling sync transport
- [ ] Example: Implementing `applyToStore` callback
- [ ] Performance benchmarks

#### Reusable Sync Client Package (`@quereus/sync-client`) ✅

The WebSocket sync client is now available as a standalone package: [`@quereus/sync-client`](../../quereus-sync-client/).

**Features:**
- [x] WebSocket connection and handshake (`handshake` → `handshake_ack`)
- [x] Message dispatch (`changes`, `push_changes`, `apply_result`, `error`, `pong`)
- [x] ChangeSet serialization/deserialization (HLC, siteId encoding)
- [x] Local change debouncing (configurable, default 50ms)
- [x] Delta sync optimization (`lastSentHLC`, `pendingSentHLC` tracking)
- [x] Peer sync state tracking (`peerSyncState[serverSiteId]`)
- [x] Reconnection with exponential backoff (1s → 60s max)
- [x] Connection state machine (disconnected → connecting → syncing → synced)
- [x] Framework-agnostic design (no React/Svelte/Worker dependencies)

**`SyncClient` API:**
```typescript
import { SyncClient } from '@quereus/sync-client';

const client = new SyncClient({
  syncManager,
  syncEvents,                        // Local change listener
  onStatusChange: (status) => {},    // Connection state updates
  onRemoteChanges: (result, sets) => {}, // Applied remote changes
  onError: (error) => {},            // Error handling
  autoReconnect: true,               // Default: true
  reconnectDelayMs: 1000,            // Default: 1000
  maxReconnectDelayMs: 60000,        // Default: 60000
  localChangeDebounceMs: 50,         // Default: 50
});

await client.connect('wss://server/sync/ws', token);
// ... changes sync automatically ...
await client.disconnect();
```

**Completed:**
- [x] Create `packages/quereus-sync-client` package
- [x] Implement `SyncClient` class with WebSocket protocol
- [x] Extract serialization helpers
- [x] Add reconnection state machine with exponential backoff
- [x] Add delta sync tracking (peer sync state, sent HLC tracking)
- [x] Add local change listener with debouncing
- [x] Update `quoomb-web` worker to use `SyncClient`
- [x] Framework-agnostic design (no React/Svelte/Worker dependencies)

**Nice-to-have (future):**
- [ ] HTTP polling fallback for environments without WebSocket
- [ ] Connection quality metrics (latency, reconnect count)

---

## Schema Seed: App Provider as Sync Peer

This section describes how to distribute app schema migrations as a static "seed" that syncs into the user's database using the existing sync infrastructure. This pattern treats the app provider as a read-only peer with a well-known site ID.

### Motivation

When distributing an app with Quereus, the initial database schema (and optionally seed data) must be applied to each user's local database. Rather than using imperative migrations or version checks, we can leverage the CRDT sync infrastructure:

1. **Build time**: Generate a JSON bundle containing sync metadata for the app's schema
2. **Runtime**: Sync from the bundled seed into the user's database using `applyChanges()`
3. **Updates**: On app updates, only new schema changes are applied (delta sync)

This approach:
- Reuses existing sync code paths (no new migration infrastructure)
- Handles user customizations naturally via CRDT semantics
- Enables efficient delta sync on app updates (only new schema since last sync)
- Works offline (seed is bundled with the app)

Because the seed is applied through `applyChanges()`, it rides the wire path's group-atomic admission core (`admitGroup`, see [Transactional Integrity During Sync](#transactional-integrity-during-sync)) and inherits the same data-first/metadata-second/abort-with-no-metadata write-ordering guarantees with no seed-specific code.

### Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              BUILD TIME                                      │
│                                                                              │
│   DDL Statements ──▶ SyncManager ──▶ Serialize ──▶ schema-seed.json         │
│   (CREATE TABLE...)   (in-memory)     Metadata                               │
│                                                                              │
│   • Fixed APP_PROVIDER_SITE_ID (well-known, e.g., all zeros)                │
│   • Build timestamp as HLC base                                              │
│   • Records: SchemaMigrations, ColumnVersions for table columns              │
└─────────────────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────────────────┐
│                              RUNTIME                                         │
│                                                                              │
│   ┌──────────────┐    getChangesSince()     ┌──────────────────────────┐    │
│   │  Seed Store  │ ─────────────────────▶   │   User's SyncManager     │    │
│   │  (read-only) │                          │                          │    │
│   └──────────────┘                          │   applyChanges()         │    │
│         │                                   │         │                │    │
│         │ lastSeedHLC                       │         ▼                │    │
│         │ (user metadata)                   │   Schema DDL executed    │    │
│         ▼                                   │   CRDT metadata recorded │    │
│   Only changes after lastSeedHLC            └──────────────────────────┘    │
│   are returned (efficient delta sync)                                        │
└─────────────────────────────────────────────────────────────────────────────┘
```

### The Well-Known App Provider Site ID

Use a deterministic, well-known site ID for the app provider:

```typescript
/** All-zeros site ID for app provider schema seeds */
const APP_PROVIDER_SITE_ID = new Uint8Array(16); // 16 bytes of 0x00

/** Or use a fixed base64 */
const APP_PROVIDER_SITE_ID = siteIdFromBase64('AAAAAAAAAAAAAAAAAAAAAA');
```

This ensures:
- The app provider's site ID is consistent across builds
- User's local changes (with random site IDs) won't conflict with seed schema
- Easy to identify seed-originated changes in debugging

### Efficient Delta Sync

The change log in the seed enables efficient delta sync:

1. **First launch**: `lastSeedHLC` is undefined, all seed entries are applied
2. **App update**: `lastSeedHLC` points to previous seed's latest HLC
3. **Query**: Filter change log entries where `hlc > lastSeedHLC`
4. **Result**: Only new schema changes are processed (O(k) where k = new changes)

### User Schema Customizations

Because the sync uses standard CRDT semantics, user schema customizations are handled naturally:

1. **User adds a column**: User's column has their site ID with later HLC, preserved
2. **App adds same column in update**: LWW resolves (later HLC wins, or user's if concurrent)
3. **User drops a table**: "Most destructive wins" - drop persists even if app's seed has the table

This means:
- App schema is the baseline
- User customizations layer on top
- Conflicts resolve deterministically

### What's Provided by Quereus

All the primitives needed for schema seeds are available in Quereus packages:

| Component | Package | Status |
|-----------|---------|--------|
| `SyncManager.applyChanges()` | `quereus-sync` | ✅ Available |
| `SyncManager.getPeerSyncState()` | `quereus-sync` | ✅ Available |
| `SyncManager.updatePeerSyncState()` | `quereus-sync` | ✅ Available |
| `compareHLC()`, `hlcToJson()`, `hlcFromJson()` | `quereus-sync` | ✅ Available |
| `SerializedHLC` type | `quereus-sync` | ✅ Available |
| `InMemoryKVStore` | `quereus-store` | ✅ Available |
| `siteIdToBase64()`, `siteIdFromBase64()` | `quereus-sync` | ✅ Available |
| `toBase64Url()`, `fromBase64Url()` | `quereus-sync` | ✅ Available |

**Usage:**
```typescript
import {
  SyncManager, compareHLC,
  hlcToJson, hlcFromJson, type SerializedHLC,
  siteIdToBase64, siteIdFromBase64,
  toBase64Url, fromBase64Url
} from '@quereus/sync';
import { InMemoryKVStore } from '@quereus/store';
```

### What's App-Specific

The following should be implemented in your application:

1. **`SchemaSeed` interface**: Define the JSON structure for your seed files
2. **`generateSchemaSeed()`**: Build-time script to create seeds from DDL
3. **`syncFromSchemaSeed()`**: Runtime function to apply seeds

These are app-specific because:
- Seed format may vary (JSON, MessagePack, etc.)
- Generation may integrate with your build system (Vite, webpack, etc.)
- Application may have custom sync logic or validation


