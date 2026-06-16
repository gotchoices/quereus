description: Make the sync layer tick the HLC once per committed transaction (not per row-event) and assign an incrementing per-transaction `opSeq` to every fact. Consume the engine's transaction-commit group; record all of a transaction's column versions / tombstones / schema migrations under one base HLC in a single KV batch; set a real, deterministic `transactionId`; emit one local-change event per transaction. Delivers the write half of "HLC = transaction."
prereq: sync-hlc-opseq-foundation, engine-transaction-commit-signal
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts     # handleDataChange/handleSchemaChange → single handleTransactionCommit; currentTransactionId
  - packages/quereus-sync/src/create-sync-module.ts          # wire sync to the engine's onTransactionCommit (needs the DatabaseEventEmitter)
  - packages/quereus-sync/src/clock/hlc.ts                   # HLCManager.tick returns the per-transaction base HLC (opSeq 0)
  - packages/quereus-sync/src/metadata/change-log.ts         # records keyed by the per-fact HLC (base + opSeq)
  - packages/quereus-store/src/common/backing-host.ts        # MV/derivation replication path also flows through the engine emitter — confirm grouping
  - docs/sync.md                                            # § Integration with Store Events, § Transaction-Based Change Grouping
difficulty: hard
----

# Per-transaction HLC tick + opSeq assignment (write side)

## What changes

Today `handleDataChange` (`sync-manager-impl.ts:185`) calls `hlcManager.tick()` for
**every** `DataChangeEvent`, so every row in one SQL transaction gets a distinct HLC,
and `currentTransactionId` is never assigned (always falls back to
`crypto.randomUUID()`). Replace this with a **per-transaction** handler driven by the
engine's `onTransactionCommit` group (from `engine-transaction-commit-signal`):

```
onTransactionCommit(batch):
  if every event is remote → return            // echo: metadata already recorded on apply
  base = hlcManager.tick()                      // ONE tick per transaction; opSeq 0
  txnId = deterministicTxnId(base)              // see below; replaces randomUUID
  opSeq = 0
  kvBatch = kv.batch()
  // DDL before DML (docs/sync.md § DDL Application Order)
  for each schema event (local) in order:
     record schema migration with hlc = {...base, opSeq: opSeq++}
  for each data event (local) in order:
     for each fact the event yields (per changed column, or the deletion):
        hlc = {...base, opSeq: opSeq++}
        record column-version / tombstone + change-log entry into kvBatch with hlc
  persistHLCStateBatch(this, kvBatch)           // wallTime/counter only (not opSeq)
  await kvBatch.write()
  emit ONE local-change event { transactionId: txnId, changes, pendingSync: true }
```

### Why one tick per transaction is correct

`tick()` advances `wallTime`/`counter` once, so the transaction's base
`(wallTime, counter, siteId)` is unique among this site's transactions (consecutive
ticks always differ in counter or wallTime). Every fact of the transaction shares that
triple and differs only in `opSeq` — exactly the identity the read side
(`sync-getchangessince-transaction-grouping`) groups on.

### Deterministic transactionId (RESOLVED)

Replace `crypto.randomUUID()` with an id **derived from the base HLC**:
`deterministicTxnId(base)` = a stable string over `(wallTime, counter, siteId)` (e.g.
`${wallTime}:${counter}:${siteIdToBase64(siteId)}`). Same transaction ⇒ same id on
every peer, which the read side reproduces from the change-log without persisting a
separate `tx:` record. (The `tx:` key prefix in `keys.ts` is currently unused for
this; leave it.)

## Wiring: consume the engine emitter, not per-table store events

`createSyncModule` currently subscribes to the store's `StoreEventEmitter`
(`storeEvents.onDataChange/onSchemaChange`). The store emitter is **below** the
transaction boundary (per-table coordinators), so it cannot group a multi-table
transaction. Switch the change-capture subscription to the engine's
`DatabaseEventEmitter.onTransactionCommit`. The sync setup already has the engine
`db` available (README: `getTableSchema: (s,t) => db.schemaManager.getTable(...)`),
so obtain the engine event emitter from `db` (e.g. `db.getEventEmitter()` /
the documented accessor) and subscribe there.

- The grouped event shapes are `DatabaseDataChangeEvent` (has `key`, `oldRow`,
  `newRow`, `changedColumns`, `remote`, `moduleName`) and `DatabaseSchemaChangeEvent`
  (has `objectType`, `type`, `ddl`, `remote`). Adapt the existing
  `handleDataChange` / `handleSchemaChange` bodies to read these — they already read
  the same logical fields. `pk` comes from `event.key`.
- Keep the per-event recording helpers (`recordColumnVersions`,
  tombstone/change-log writes) but drive them from the grouped handler so they share
  one `base` HLC, one `opSeq` counter, and one KV batch.
- The old `storeEvents` subscription for change capture is removed. Confirm nothing
  else in sync depends on the raw store subscription (the apply path uses
  `applyToStore`, not the store emitter, so it is unaffected).

## opSeq ordering semantics (document, don't over-engineer)

`opSeq` follows the engine group's flush order: **intra-table** order is true write
order (a coordinator buffers its table's events in DML order); **cross-table** order
is the deterministic per-coordinator commit order, not global DML interleave (store
coordinators are per-table — see `engine-transaction-commit-signal`). This is
sufficient for the documented goal — intra-transaction atomicity, intra-table
parent-before-child, and full determinism (same facts ⇒ same opSeq on every peer).
True cross-table dependency ordering on **apply** is a separate concern — see the
backlog ticket `sync-cross-table-apply-ordering`.

## Edge cases & interactions

- **Rollback / discardBatch** — the engine fires no group for a rolled-back
  transaction, so `tick()` is never called and **no HLC/opSeq is consumed** by it. A
  later committed transaction's ordering is never polluted by a discarded one. Add an
  integration test: write, rollback, write+commit → only the committed write produces
  a change-log entry, and its base HLC is the *next* tick (no gap leak that matters,
  but no consumed-then-discarded HLC either).
- **opSeq exhaustion** — if a single transaction's fact count would exceed uint32,
  throw a `QuereusError` (telemetered via `emitSyncStateChange({status:'error'})`)
  rather than wrapping. Practically unreachable; assert the guard exists.
- **Schema migration within a transaction** — DDL events in the group are recorded
  first (lower `opSeq`) so they sort before the same transaction's DML, upholding
  DDL-before-DML. A DDL-only transaction still ticks once and records migrations under
  the base HLC. Test a `create table … ; insert …` single transaction: the migration
  and the inserts share `(wallTime, counter, siteId)` and differ only by opSeq, DDL
  lowest.
- **All-remote group (echo)** — if every event in the group has `remote: true`
  (pure sync-apply transaction), skip entirely (metadata already recorded by the
  apply path). A **mixed** group (local + remote in one transaction — unusual) should
  record only the local facts; assign opSeq only to recorded (local) facts so they
  stay contiguous. Document this filter.
- **MV / derivation replication path** — `backing-host.ts` queues `DataChangeEvent`s
  on the coordinator when a backing has `quereus.sync.replicate=true`; these flow up
  to the engine emitter like ordinary DML and join the committing transaction's group.
  Confirm they are captured (a derivation write in the same transaction shares the
  base HLC). Add/extend an integration test if a replicated backing exists in the test
  harness; otherwise note the path is exercised by existing MV tests.
- **Empty / no-op transaction** — engine fires no group; sync does nothing.
- **`handleSchemaChange`'s schema-version bump** — `recordMigration` increments a
  per-table version; preserve that, but stamp the migration's `hlc` with the shared
  base+opSeq instead of an independent `tick()`.

## Key tests (TDD)

- Multi-row single-statement INSERT → exactly one `tick()`, N facts with opSeq
  0..N-1 sharing `(wallTime, counter, siteId)`, one local-change emit, one KV batch.
- Multi-table explicit transaction → all facts share one base HLC; per-table order
  preserved; one local-change emit.
- DDL+DML transaction → migration opSeq < data opSeq; shared base HLC.
- Rollback consumes no HLC; subsequent commit records normally.
- `transactionId` is deterministic over `(wallTime, counter, siteId)` and identical
  for all facts of the transaction.
- Echo: all-remote group records nothing.

## TODO

- Add an engine-event-emitter accessor usage in `create-sync-module.ts`; subscribe to
  `onTransactionCommit`; remove the per-event store change-capture subscription.
- Replace `handleDataChange`/`handleSchemaChange` with a single
  `handleTransactionCommit(batch)` that ticks once, threads `base`+`opSeq`, batches
  all metadata, and emits one local-change event. Keep the recording helpers, refactor
  their signatures to accept an explicit per-fact `hlc`.
- Implement `deterministicTxnId(base)`; assign `currentTransactionId` per group (or
  pass it through directly and drop the field).
- Add the opSeq-exhaustion guard.
- Update `docs/sync.md` § Integration with Store Events (event flow now sourced from
  the engine transaction boundary) and § Transaction-Based Change Grouping (write
  side now ticks once per commit; opSeq ordering semantics).
- `yarn workspace @quereus/sync build` + sync tests; if `create-sync-module.ts`'s new
  dependency on the engine emitter touches engine exports, `yarn workspace
  @quereus/quereus build` first.
