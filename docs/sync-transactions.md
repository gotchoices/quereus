# Sync: Transactions

> **Stability: Experimental** — see [Stability Tiers](stability.md#tiers).

How `quereus-sync` groups changes by source transaction, and how it keeps a sync apply and its metadata atomic. The data model and storage layout are in [sync.md](sync.md); the wire protocol is in [sync-protocol.md](sync-protocol.md).

## Transaction-Based Change Grouping

Changes are grouped by transaction: all changes within a transaction are sent as a unit and applied atomically, preserving referential integrity across related writes.

**The grouping boundary is the engine, not the store.** The authoritative
"one logical transaction = one group" anchor is the engine's `DatabaseEventEmitter`
(`packages/quereus/src/core/database-events.ts`), which hooks every module's event
emitter and **batches all data and schema events of the whole logical transaction** —
`startBatch()` at `beginTransaction`, `flushBatch()` at `commitTransaction`,
`discardBatch()` at `rollbackTransaction` (`database-transaction.ts`), with savepoint
layers discarded on `ROLLBACK TO SAVEPOINT`. At the commit flush point the complete,
ordered, multi-table fact set of one transaction is known, so it is exposed as a single
grouped delivery:

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

**Why not the store coordinator.** The store has one `TransactionCoordinator` *per
module* (`store-module-base.ts` `getCoordinator()`), shared by every table. A **cross-module**
transaction (e.g. a store source plus a memory source, or two durable modules) spans
several coordinators/emitters, each firing its own event burst, so a per-coordinator
commit would split one logical transaction into multiple groups and assign it multiple
HLCs, breaking the referential-integrity property above. Only the engine emitter sees the
whole transaction at once.

Ordering within a batch is the engine flush order: base batch then each savepoint layer
in push order — i.e. per-module/per-table arrival order at commit, not global
DML-interleave order (store coordinators buffer per-table and fire at their own commit).
This is deterministic and replayable, which is what downstream `opSeq` assignment needs.

### Write side: one tick per commit, `opSeq` per fact

The sync layer's local-change capture (`SyncManagerImpl.handleTransactionCommit`)
consumes that grouped batch and records the whole transaction under **one** base HLC:

```
onTransactionCommit(batch):
  localSchema = batch.schemaEvents where !remote
  localData   = batch.dataEvents   where !remote and its table is still in the basis
  if both empty: return                 // all-remote echo, or empty/idle commit
  base  = hlcManager.tick()             // ONE tick per transaction; opSeq 0
  txnId = deterministicTxnId(base)      // stable over (wallTime, counter, siteId)
  opSeq = 0; kvBatch = kv.batch()
  for each local schema event (DDL before DML):
     record migration with hlc = {...base, opSeq: opSeq++}
  for each local data event, for each fact (per changed column, per column on a first
  edit of a row sync never recorded, or the deletion):
     record column-version / tombstone + change-log entry, hlc = {...base, opSeq: opSeq++}
  persist HLC clock state (wallTime/counter only) into kvBatch
  kvBatch.write()                       // all metadata for the transaction, atomically
  emit ONE local-change event { transactionId: txnId, changes, pendingSync: true }
```

Why one tick is correct: `tick()` advances `wallTime`/`counter` once, so the base
`(wallTime, counter, siteId)` is unique among this site's transactions. Every fact
of the transaction shares that triple and differs only in `opSeq` — exactly the
identity the read side groups on. DDL events take the lowest `opSeq`s so they sort
below the same transaction's DML ([sync-schema.md](sync-schema.md) § DDL Application Order).

**Local capture is best-effort at TABLE granularity.** A table out of basis at capture
time — the schema oracle no longer knows it, typically because this same transaction
dropped it — has no sound pk identity, so it costs its own rows; the transaction's other
tables and all its schema migrations still record. The filter
(`filterCapturableDataEvents`) runs *before* the tick, so a fully-skipped transaction
consumes no HLC and nothing is half-staged into the shared KV batch. Each skipped table
is logged once with its change count — informationally when this transaction dropped it,
as a warning otherwise. The gate is basis membership, not "this transaction dropped the
table": `drop t; create t; insert into t` leaves `t` in basis and is captured in full.
Only the unknown-table case is skipped; any other keying failure still fails the
transaction loudly. A relay-only manager (no schema oracle) reports every table in basis,
so nothing is skipped there.

**Commit recording is serialized.** `handleTransactionCommit` does async dedup reads (the
prior column-version / tombstone lookups that delete a superseded change-log entry) before
its single `kvBatch.write()`. Two rapid commits must not interleave at those awaits, or
commit N+1's dedup would read pre-N-write state, miss the prior version, and leave a stale
change-log entry — breaking the *at most one surviving entry per key* invariant the read
side relies on. `SyncManagerImpl` therefore chains each commit onto a tail promise
(`enqueueTransactionCommit`). The tick itself is synchronous and already ordered; only the
post-tick dedup reads need this.

**Local capture reads its own writes.** Within one transaction, every metadata read (the
dedup lookups and the delete cleanup's column set) consults a per-transaction
staged-metadata overlay (`staged-transaction-metadata.ts`) *before* committed storage,
because the transaction's own writes are still pending in its single `kvBatch`. A
transaction that touches one row more than once — update then update, insert then delete,
delete then reinsert then delete — therefore records exactly the metadata the equivalent
separate transactions would: the later event sees the earlier one's staged cell versions
and tombstone, dedupes the right change-log entry, chains the right before-image, and the
delete cleanup removes staged cells as well as committed ones. The cleanup stages its
removals into the same `kvBatch` (whose later-op-wins ordering resolves put-then-delete
and delete-then-put per key), which also completes the pseudocode's atomicity claim:
*all* of a transaction's metadata lands in one atomic batch.

`opSeq` ordering semantics: **intra-table** order is true write order (a coordinator
buffers its table's events in DML order); **cross-table** order is the deterministic
per-coordinator commit order, not the global DML interleave. That suffices for
intra-transaction atomicity, intra-table parent-before-child, and full determinism
(same facts ⇒ same `opSeq` on every peer), and is **not** an apply-correctness hazard:
the apply path re-validates no declared constraint (child-side FK existence included —
see § Transactional Integrity During Sync → *Apply-time validation*), so a child fact
landing before its parent cannot trip one. It matters only to the opt-in parent-side
FK *actions* path.

Edge cases:
- **Rollback / discard** — the engine fires no group, so `tick()` is never called and no
  HLC/`opSeq` is consumed; a discarded transaction never pollutes a later one's ordering.
- **All-remote group (echo)** — a pure sync-apply transaction (every event
  `remote: true`) is skipped entirely; its metadata was already recorded on apply.
- **Mixed group** — local + remote in one transaction records only the local facts,
  assigning `opSeq` only to recorded facts so they stay contiguous.
- **`opSeq` exhaustion** — `opSeq` is a uint32; a transaction whose fact count would
  exceed `MAX_OPSEQ` throws a `QuereusError` (telemetered as an error sync-state)
  rather than wrapping. Practically unreachable.

### Deterministic transaction id

`transactionId` is derived from the base HLC —
`deterministicTxnId(base) = "${wallTime}:${counter}:${base64(siteId)}"` — rather than
a random UUID. Same transaction ⇒ same id on every peer (the read side reproduces it
from the change-log facts' shared base), so no separate `tx:` record is persisted.

### Read side: one ChangeSet per transaction

`getChangesSince(peerSiteId, sinceHLC?)` returns **one `ChangeSet` per source
transaction** — never splitting a commit, never merging two
(`change-grouping.ts` `buildTransactionChangeSets`):

```
getChangesSince(peerSiteId, sinceHLC):
  facts      = sinceHLC ? changeLog.scan(after sinceHLC) : (all column-versions + tombstones)
               skipping any fact whose hlc.siteId == peerSiteId   // echo filter (whole tx)
  migrations = sm: scan, after sinceHLC, not from peerSiteId
  group facts+migrations by transaction identity (wallTime, counter, siteId):
    each group ⇒ one ChangeSet:
      changes:          group's facts in opSeq order (intra-table write order)
      schemaMigrations: group's migrations in opSeq order (DDL below the tx's DML)
      hlc:              group's MAX fact HLC (last opSeq) — the commit boundary
      transactionId:    deterministicTxnId(base)          — same derivation as write side
      siteId:           the group's origin site
  order ChangeSets by base HLC ascending
  bound by batchSize at TRANSACTION granularity (below)
```

The HLC scan is already ordered by `(wallTime, counter, siteId, opSeq)` (the
change-log key), so a transaction's facts are contiguous and in `opSeq` order.

- **Echo filter** — facts/migrations whose `hlc.siteId == peerSiteId` are excluded.
  Because a transaction is wholly one site's, this drops *whole* transactions — never
  a half-empty ChangeSet.
- **DDL-only transaction** — a `create table` with no DML forms its own ChangeSet
  (`changes: []`, one migration), `hlc` = the migration HLC.
- **DDL + DML in one transaction** — migration and data share the base, so they land
  in one ChangeSet; the migration's lower `opSeq` keeps DDL ahead of DML (the
  applicator processes `schemaMigrations` first regardless).

**Transaction-granularity bounding.** `batchSize` caps the response by accumulating
**whole** transactions: once a completed transaction pushes the cumulative `changes`
count `>= batchSize`, extraction stops and returns — the rest come on the next
`getChangesSince` call. A transaction is **never** split to hit the bound.

The bound applies at **scan time**, not just response time: on the delta path the
change-log scan is HLC-ordered, so `collectChangesSince` detects each transaction
boundary and stops scanning the moment enough whole transactions accumulate. Two scans
are *not* bounded this way — the from-zero full scan (`collectAllChanges`, used when
`sinceHLC` is absent) reads `cv:`/`tb:` keyed by table/pk rather than HLC, so it cannot
early-exit (a large initial range is served by a snapshot instead); and the `sm:`
schema-migration scan is not HLC-ordered, so it is drained in full (migrations are few,
and grouping drops any that sort past the bounded fact watermark — over-scan costs work,
never correctness).

**Pushing upstream.** `getChangesToPush(peerSiteId, sinceHLC?)` answers a different
question with the same machinery: what should this replica send to the server it follows?
It keeps only facts and migrations whose `hlc.siteId` is this replica's own. That identifies
the writer for good, because relays, applies and snapshots all keep the original HLC. Held
store-and-forward changes are still offered ([sync.md § Store-and-forward relay](sync.md#store-and-forward-relay)). The origin check
runs before the batch counter, so a run of other devices' entries spends no budget and an
empty read means nothing is left. With no watermark it scans the change log rather than
`cv:`/`tb:`, so the same early exit applies and a device that writes nothing is not
reading every record per handshake. It makes no delta-floor check: the floor says what a
receiver may be missing, which has no bearing on what this replica has to send. See
[sync-protocol.md § Delta Sync Optimization](sync-protocol.md#delta-sync-optimization) for the push loop.

Scan-time boundary detection keys off the *log entry's* HLC while grouping keys off the
*resolved version's* HLC; the two agree because **at most one change-log entry survives
per key**, with HLC equal to the current version. Three mechanisms keep that true:
**overwrite dedup** across separate writes/applies (a newer value dedupes the prior
column entry, a newer tombstone the prior delete entry — so a `delete → reinsert →
delete` key reuse leaves no stale delete entry to re-attribute to the later tombstone's
HLC and split that transaction across rounds); the **staged-metadata overlay** for
repeats within one local transaction (§ Write side → *Local capture reads its own
writes*); and **in-batch collapse** on apply (`commitChangeMetadata`), where two versions
of one key in a single `applyChanges` call resolve against the same pre-batch prior
version, so only the max-HLC winner per key is written (e.g. concurrent deletes of the
same pk relayed together). Those in-memory collapse keys are built with the same
length-prefixed join as the stored keys ([sync.md § Storage Layout](sync.md#storage-layout)) — punctuation-joining
`(schema, table, identity)` would let rows of two differently-named tables collapse onto
one winner and leave the loser in the store with no bookkeeping at all.

**Entries die with their target.** The change log is a *derived index* over the live
`cv:`/`tb:` records — `resolveLogEntry` returns `null` for an entry whose record is
gone — so every entry is deleted in the same `WriteBatch` as the record it points at:
a row's `column` entries with its column versions on delete
(`deleteRowVersionsAndLogEntries`, called from the local write path `recordDataEvent`
and from apply's `commitChangeMetadata`), and a pk's `delete` entry with its expired
tombstone (`SyncManagerImpl.pruneTombstones`). This bounds the change log to **live
cells + live tombstones** rather than to the replica's lifetime delete volume, and is
lossless by construction — a dropped entry already resolved to `null` and could never
have appeared in any `ChangeSet`.

**The delta floor.** Pruning a tombstone removes a fact a peer may still need: a peer whose
received watermark predates that delete would get a delta without it and keep the row
forever, with nothing on either side reporting anything. So every prune of deliverable
history raises the replica's **delta floor** — the greatest HLC of any tombstone it has
pruned, one `df:` record (`metadata/delta-floor.ts`), written in the *same* `WriteBatch`
as the tombstone deletes so a crash between the two cannot reopen the gap, and only ever
moving forward. An incremental request `since T` is complete iff `T >= floor` (replies
carry changes strictly after `T`, so a tombstone at exactly `T` was already delivered);
`SyncManager.canDeltaSync(sinceHLC)` is exactly that comparison, and `getDeltaFloor()`
exposes the value. The floor is *not* a wall-clock test: a watermark is the HLC of the
last change a peer received, not the time it last synced, so a quiet database never ages
a peer out of delta sync on its own. The floor travels in snapshot headers
(`deltaFloor` on `SnapshotHeaderChunk` / `Snapshot`) and a receiver takes
`max(own, sender's)` in the same batch as its metadata clear — a replica rebuilt from a snapshot (the
coordinator's S3 restore after disk eviction, say) inherits the sender's incompleteness
rather than silently resetting to "can serve anything". `pruneQuarantine` does **not**
raise it: held forwardable changes are not in snapshots either ([sync.md § Store-and-forward relay](sync.md#store-and-forward-relay)),
so refusing a delta there would force a snapshot that lacks them just the same. The
coordinator consults the floor before serving `get_changes` and answers
`snapshot_required` below it; see [sync-protocol.md § Client snapshot
bootstrap](sync-protocol.md#client-snapshot-bootstrap) for the client's recovery.

Pruning entries by a *time* horizon (`ChangeLogStore.pruneEntriesBefore`) is a different,
deliberately **unwired** operation: it drops entries for still-live cells, and is safe only
if it raises the delta floor to its boundary in the same batch, exactly as the tombstone
prune does.

**Repairing pre-existing orphans.** The forward cleanup above only stops *new* orphans —
each deletes a `cl:` entry *via* the record it points at, so an entry whose record died
before the cleanup existed can never be reached that way. `SyncManager.repairChangeLog()`
reaches those instead: a full scan of the change log that deletes every entry
`resolveLogEntry` resolves to `null`. It is a sibling of `pruneTombstones` in the host
maintenance pass (`SyncMaintenanceTarget`, `src/sync/maintenance.ts`) — safe to run at any
time, on any replica, with no peer coordination, since a `null`-resolving entry already
produced no output. Cheap once caught up: a replica with nothing to repair resolves every
entry and deletes none, paying only the scan. A dropped table's entries are also left to
this sweep (see *Table identity*).

**Oversized transaction.** A transaction whose fact count exceeds `batchSize` is returned
**whole** as one ChangeSet and telemetered (a `console.warn`), never silently chunked —
splitting it would violate the one-ChangeSet-per-transaction contract.

**Watermark halts at transaction boundaries.** Every returned ChangeSet is a whole
transaction whose `hlc` is the commit's max fact HLC, so a consumer setting
`lastSyncHLC = max(applied ChangeSet.hlc)` always lands on a real commit boundary;
`buildChangeLogScanBoundsAfter` then excludes everything `<=` it, so re-fetch resumes
strictly *after* the last whole transaction (no repeats, no gaps, no mid-transaction
resume). A partially applied transaction never advances the watermark: `applyChanges`
applies a ChangeSet atomically and commits metadata only on success (§ Transactional
Integrity During Sync), so a failed ChangeSet leaves the watermark at the prior
boundary.

## Transactional Integrity During Sync

Applying remote changes writes to two separate stores: **CRDT metadata** (column versions, tombstones, peer state) into the sync metadata store, and **table data** into each table's data store. In IndexedDB each table has its own database, so no single atomic transaction can span the metadata store and multiple table stores; LevelDB uses one database with key prefixes and commits an atomic `WriteBatch` across tables.

**Write Order**: crash safety requires **data first**, **metadata second**. A crash before the data write leaves nothing written and re-sync retries; a crash between the two leaves the CRDT state "dirty" so the same changes re-apply on the next sync, safe because CRDT operations are idempotent (same HLC → same LWW outcome); a crash after the metadata write leaves a complete, consistent state. The reverse order is dangerous: crashing after metadata but before data leaves the CRDT state believing the change landed while the data is missing — and re-sync will not retry it.

**Clock-drift rejection is pre-commit validation**, orthogonal to the ordering below (which governs a batch that passed validation): both apply paths check the incoming clock before any data or metadata is written, so a drifted batch/snapshot lands **nothing** (see the HLC section's *Clock-drift bound*).

**Invariant — metadata follows a landed data write**: CRDT metadata must **not** be committed for any change whose data write did not land. This covers two failure shapes, handled identically:
- **Whole-batch throw**: the `applyToStore` callback throws (e.g. the seam commit fails on a connection error or a deferred row constraint). The exception propagates; no metadata is committed. A commit-time **global-assertion** violation is *not* one of these — it is detect-and-notify (below), so it neither throws nor blocks the metadata commit.
- **Per-change failure**: the store adapter does *not* throw on a single change's failure — it keeps applying the other tables (maximizing idempotent storage progress) and records each failure in `ApplyToStoreResult.errors`. The **consumer** treats any non-empty `errors` exactly like a whole-batch throw: it emits `status: 'error'` and throws **before** committing any metadata.

In the **mixed case** — one batch carrying *both* a per-change `errors` failure and a reported global-assertion violation tripped by a successfully-applied change B — `applyDataToStore` emits `onAssertionViolation` **before** the abort throws. B's violating row already committed in report mode (the abort blocks the metadata commit, not the storage write), so the violation is a fact about committed data. On retry B contributes nothing to the seam batch, so the assertion over B's table is not re-evaluated (assertions fire only when their referenced tables changed) and does not double-fire; deferring the emit past the abort would lose it permanently.

**Unified admission core** (`admission.ts`) centralizes both failure shapes and the ordering in one seam, so every ingress modality behaves identically. `applyDataToStore` is the data-first half: it runs `applyToStore`, emits `status: 'error'` and rethrows on a whole-batch throw, then aborts via `throwIfApplyErrors` on any per-change `errors` (the two are mutually exclusive, so the error state is emitted at most once). `admitGroup` wraps it as a group-atomic unit — data, then the caller's `commitMetadata`, then the local HLC clock watermark — used by the wire path (`change-applicator`) and the non-streaming snapshot (`snapshot`). The streaming snapshot (`snapshot-stream`) keeps its checkpoint-based model but reuses `applyDataToStore` per flush, so a flush throw emits the same `status: 'error'` event.

With no metadata committed the caller does not advance its per-peer `lastSyncHLC` watermark, so the **whole batch re-resolves and re-applies on the next sync**, idempotently — value-identical upserts are suppressed by the adapter, so only the previously-failed change is genuinely retried. (A change that *always* fails blocks its batch forever: an accepted "poison batch" property; detection/recovery is the host's.) Selective commit (commit the succeeded subset, skip the failed) is intentionally **not** done — a batch spans multiple HLCs but re-fetch is governed by a single `lastSyncHLC` watermark, which cannot express "all but the failed change", so a skipped change would never be re-sent. The wire batch is therefore **one** all-or-nothing `admitGroup` unit, not one per `ChangeSet`.

**Apply-time validation — trust-the-origin.** The apply path does **not** re-run the
engine's constraint machinery. The production adapter (`createStoreAdapter`, the
`applyToStore` implementation) writes inbound data straight to module storage via
`StoreTable.applyExternalRowChanges` — bypassing the DML executor, so there is **no**
per-row CHECK / NOT NULL / UNIQUE / **child-side FK-existence** check at write time —
then makes a single end-of-invocation seam call, `db.ingestExternalRowChanges`, driving
the post-write pipeline: capture for `Database.watch`, commit-time **global assertions**,
materialized-view maintenance, and *opt-in* parent-side FK actions. The seam re-validates
nothing: the origin enforced every declared constraint at its own commit, and merging
already-consistent facts cannot violate a per-row / child-side constraint that held at
the source.

**Global assertions are detect-and-notify, not block.** A cross-origin *merge* can
produce a global-invariant violation no single origin ever saw — exactly what a
receiver-side global assertion guards. But the merged data must still land: rejecting
would diverge the receiver from the converged truth the network agrees on, so a local
assertion can only usefully *notify*. The adapter drives the incremental seam in **report
mode** (`assertionFailureMode: 'report'`): a violation is **collected and returned**
instead of thrown, and the batch **commits** — the violating row's derived effects (MV
maintenance, `Database.watch` capture) land on the **first** apply, so the MV stays
consistent with the base table, with no divergence and no retry. The consumer surfaces
each violation as an **`onAssertionViolation`** event (see [sync.md § Reactive Hooks](sync.md#reactive-hooks)); the host
owns policy. (Snapshot bootstrap does not evaluate assertions at all — it installs one
origin's already-converged state wholesale, so there is no merge to introduce a
violation; see `store-adapter.ts`.)

**Consequence for cross-table ordering.** A child fact carrying a lower `opSeq` than its
parent is harmless: there is no fact-granular FK check to trip. The two facets that *are*
enforced stay order-independent — **global assertions**, the home for referential
invariants the replica itself should enforce and the only form covering self-referential
and cyclic FKs that no topological table sort handles; and **opt-in FK actions**
(`applyForeignKeyActions`, default off), order-independent because the adapter writes
every table's rows to storage *before* the single seam call, so cascade DML re-reads the
fully-merged post-write state.

**Parent-side RESTRICT is not enforced on apply.** The origin already enforced it at its
own commit; re-enforcing it on the receiver would *wedge* the stream (RESTRICT throw →
batch abort → no metadata commit → same batch re-applied → throws again, forever). So the
apply path skips parent-side RESTRICT entirely and propagates only cascade / set-null /
set-default, at **every cascade depth**. This is an **apply-mode RESTRICT suppression**
threaded through the whole DML pipeline: the seam sets a flag for the batch's duration
(mutex held, restored in a `finally`), honored uniformly by the runtime RESTRICT
pre-checks (`runtime/foreign-key-actions.ts`), by every **nested cascade DML** and
**MV-maintenance** FK pass those re-enter, and — crucially — by the **plan-time
parent-side FK check** synthesized into each cascade statement's plan
(`runtime/row-constraints.ts`, the `fk-parent` constraint kind), the primary
enforcer a depth-≥1 cascade would otherwise trip. A replica-only RESTRICT invariant is
**by design not enforced on apply**; express it as a global assertion if the receiver
must be notified.

One exotic limitation no seam-batch ordering fixes: **(F)** a child of two parents with
diverging actions (cascade-delete vs. set-null) whose final state depends on evaluation
order — the seam batch carries no intra-transaction DML order to reconstruct it.
(**(E)**, a child whose two FKs pit one parent's CASCADE against another's RESTRICT, is
moot since RESTRICT never throws on apply; at worst the outcome depends on which cascade
fires first, the same caveat as (F).) Both are handled by keeping `applyForeignKeyActions`
off (the default) or by expressing the referential invariant as a **global assertion**.

Two gaps remain, both addressed below. **Per-table atomicity**: changes *should* be applied through the Store module's `TransactionCoordinator` `WriteBatch`, and the legacy per-table-database `IndexedDBModule` cannot span tables at all. **Isolation**: even with correct write ordering, readers may see partially-applied state during sync, which needs Store-level support.
