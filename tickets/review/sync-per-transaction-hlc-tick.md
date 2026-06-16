description: Review the write-side "HLC = transaction" implementation — the sync layer now ticks the HLC once per committed transaction (driven by the engine's onTransactionCommit group), assigns an incrementing per-transaction opSeq to every fact, records all of a transaction's column versions / tombstones / schema migrations under one base HLC in a single KV batch, sets a deterministic transactionId, and emits one local-change event per transaction.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # handleTransactionCommit (replaces handleDataChange/handleSchemaChange); recordSchemaMigration/recordDataEvent/recordColumnVersions; mapSchemaMigrationType; assertOpSeqInRange
  - packages/quereus-sync/src/create-sync-module.ts            # TransactionCommitSource interface; createSyncModule(kv, options) with transactionSource
  - packages/quereus-sync/src/clock/hlc.ts                     # deterministicTxnId(base); MAX_OPSEQ
  - packages/quereus-sync/src/index.ts                         # exports deterministicTxnId, MAX_OPSEQ, TransactionCommitSource
  - packages/quereus-sync/test/helpers/fake-transaction-source.ts   # test double for the engine transaction-commit channel
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts      # NEW TDD suite (write side)
  - packages/quereus-sync/test/sync/sync-manager.spec.ts            # migrated to FakeTransactionSource
  - packages/quereus-sync/test/sync/sync-protocol-e2e.spec.ts       # migrated; one real-Database test points at db
  - packages/quereus-sync/test/sync/conflict-resolvers.spec.ts      # migrated
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts    # real-Database peers now source capture from db; added settle()
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts      # apply-path only → transactionSource undefined
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts      # apply-path only → transactionSource undefined
  - packages/quoomb-web/src/worker/quereus.worker.ts          # createSyncModule(kv, { ..., transactionSource: db })
  - packages/sync-coordinator/src/service/store-manager.ts    # relay-only → no transactionSource
  - docs/sync.md                                              # § Transaction-Based Change Grouping (write side); § Integration with Store Events
difficulty: hard
----

# Review: per-transaction HLC tick + opSeq assignment (write side)

Delivers the **write half** of "HLC = transaction". Read side (`getChangesSince`
grouping) is a separate ticket (`sync-getchangessince-transaction-grouping`).
Foundations already landed: `sync-hlc-opseq-foundation` (the `opSeq` field +
30-byte encoding), `engine-transaction-commit-signal` (`db.onTransactionCommit`).

## What changed

**Capture is now sourced from the engine transaction boundary, not the per-table
store emitter.** `SyncManagerImpl.create(kv, transactionSource, …)` subscribes to
`transactionSource.onTransactionCommit`. The old `handleDataChange` /
`handleSchemaChange` (one `tick()` per row-event, `currentTransactionId` never
assigned) are replaced by a single `handleTransactionCommit(batch)`:

- Filters to **local** facts (`!remote`). All-remote group (pure sync-apply echo)
  or empty group → returns, **no tick consumed**.
- `base = hlcManager.tick()` — **one** tick per committed transaction.
- `transactionId = deterministicTxnId(base)` — stable `"${wallTime}:${counter}:${base64(siteId)}"`, replaces `crypto.randomUUID()`.
- Threads a single `opSeq` counter via a `nextHlc()` closure: each recorded fact
  gets `{...base, opSeq: opSeq++}`. DDL recorded **before** DML (lower opSeq).
- All metadata (migrations, column versions, tombstones, change-log entries, HLC
  clock state) goes into **one** `kv.batch()`.
- Emits **one** `local-change` event per transaction.

`createSyncModule` signature changed: `createSyncModule(kv, options)` where
`options.transactionSource` is the engine `Database` (or any `onTransactionCommit`
emitter). Omitted ⇒ relay-only (coordinator), no local capture.

`assertOpSeqInRange(opSeq)` is an exported pure guard (throws `QuereusError` past
`MAX_OPSEQ`), used by the handler and unit-tested directly.

## Build & test status (what I ran)

- `yarn workspace @quereus/sync build` ✅, `… typecheck` ✅
- `yarn workspace @quereus/sync test` ✅ **224 passing, 0 failing** (the two
  `[Sync] Error handling transaction commit:` console lines are the intentional
  error-injection tests, not failures).
- Built/typechecked the changed consumers: `@quereus/sync-coordinator` ✅,
  `@quereus/sync-client` ✅, `quoomb-web typecheck` ✅.
- Engine (`@quereus/quereus`) was **not** modified.

## Use cases to validate (test map + suggested adversarial pushes)

Covered by `transaction-commit.spec.ts` (FakeTransactionSource — drives grouped
batches directly) + the real-`Database` cases:

- **Multi-row single-statement INSERT** → exactly one tick; N facts with opSeq
  0..N-1 sharing `(wallTime, counter, siteId)`; one local-change emit; one KV batch.
- **Multi-table transaction** → all facts share one base HLC; per-table flush
  order preserved (users opSeq < orders opSeq).
- **DDL+DML transaction** → migration opSeq < data opSeq; shared base.
- **Deterministic transactionId** → equals `deterministicTxnId(base)`, opSeq-independent.
- **Echo (all-remote group)** → records nothing, emits nothing, consumes no tick.
- **Mixed group (local+remote)** → only local facts recorded, opSeq contiguous.
- **opSeq exhaustion guard** → `assertOpSeqInRange` accepts `MAX_OPSEQ`, throws beyond.
- **Rollback consumes no HLC** (real `Database`): write+rollback then write+commit →
  only the committed row is in the change log.
- **MV / derivation replication** (real `Database`, `echo-loop-quiescence.spec.ts`):
  a tagged `quereus.sync.replicate=true` MV's derived write joins the source
  transaction's group and is captured under the same base HLC; the two-peer
  quiescence/convergence invariants still hold.

Adversarial angles the reviewer should push on (my tests are a floor):
- **opSeq ordering across columns within a row** — I assert contiguity/sharing but
  not that intra-row column order is stable/meaningful. Confirm whether the read
  side relies on any particular intra-row opSeq order.
- **Schema version counter within one transaction** — `recordSchemaMigration`
  tracks a running per-table version via `versionCounters` (seeded from
  `getCurrentVersion`). Not directly tested for **two DDLs on the same table in one
  transaction**; worth a targeted test (versions must increment, not collide).
- **`changedColumns` vs value comparison** — the handler still derives changed
  columns by value comparison (`!oldRow || oldValue !== newValue`), ignoring the
  event's `changedColumns`. Verify that's intended (it matches prior behavior) and
  that an UPDATE that changes nothing correctly records zero facts (and still ticks
  + emits an empty local-change — confirm that's acceptable).

## Known gaps / honest flags (treat as starting points)

1. **Fire-and-forget capture (timing).** The `onTransactionCommit` listener cannot
   `await` the async metadata write, so capture completes *after* the commit
   returns. In production this is fine — the sync loop is driven by the post-capture
   `onLocalChange` event. But a consumer that calls `getChangesSince` synchronously
   right after a local `db.exec` (without awaiting `onLocalChange`) can miss the
   just-written change. The `echo-loop` test had to add explicit `settle()` waits
   for exactly this reason. **Reviewer: consider whether a `whenSettled()` /
   awaitable-capture affordance is warranted, and whether handler errors (which only
   surface as `onSyncStateChange({status:'error'})`, never as a rejected promise to
   the writer) are adequately observable.**

2. **Store-backed DML is double-delivered at the engine boundary (pre-existing,
   non-breaking).** Empirically, a single `insert into src` arrives in the
   `onTransactionCommit` batch as **two** identical data events. Root cause: the DML
   executor's auto-event gate is `_needsDataEvents() && !hasNativeEventSupport(vtab)`,
   and `hasNativeEventSupport` checks the **vtab instance** — only `StoreModule`
   exposes `getEventEmitter`, not its table/connection instances — so the gate
   evaluates `true` and the engine auto-emits *in addition to* the hooked
   module-level emitter. This is **not introduced by this ticket** (any `db.onDataChange`
   listener + a store module already triggers it; quoomb-web subscribes db-level
   listeners), but routing sync capture through `db.onTransactionCommit` now exercises
   it. **Impact on sync: harmless to convergence** (column versions/tombstones are
   idempotent; the duplicate fact resolves to the same value), but it **doubles the
   recorded facts and inflates opSeq counts** for store-backed local transactions.
   **Recommend a follow-up engine/store fix** (the auto-event gate should recognize a
   module whose events are already hooked at the module level, OR store vtab
   instances should expose `getEventEmitter`). The FakeTransactionSource unit tests
   deliberately deliver a clean batch, so they assert the handler's logic, not this
   upstream duplication.

3. **`deleteRowVersions` on a delete runs outside the transaction's KV batch**
   (pre-existing). The tombstone + change-log entry are batched, but the cleanup of
   the row's column versions is a separate write. Minor atomicity nuance, unchanged
   from before; flag only if the reviewer wants strict single-batch atomicity.

4. **`tx:` key prefix left unused** (per the original ticket's RESOLVED note). The
   deterministic id is derived, not persisted; `docs/sync.md` Storage Layout still
   lists a `tx:` row describing an unwritten record — intentionally left.

5. **Apply-path test wiring.** `store-adapter-seam` / `snapshot-bootstrap` pass
   `transactionSource: undefined` (they only exercise the remote-apply path and must
   not capture the DDL they run during setup). Confirm that's the right call vs.
   passing `db`.

## Out of scope (separate tickets)

- Read side: `sync-getchangessince-transaction-grouping`.
- True cross-table dependency ordering on apply: backlog `sync-cross-table-apply-ordering`.
- The engine/store double-emit (flag #2) — recommend filing if the reviewer agrees.
