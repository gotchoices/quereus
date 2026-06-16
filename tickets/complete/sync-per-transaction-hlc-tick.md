description: COMPLETE — write-side "HLC = transaction": the sync layer ticks the HLC once per committed transaction (driven by the engine's onTransactionCommit group), assigns an incrementing per-transaction opSeq to every fact, records a transaction's column versions / tombstones / schema migrations under one base HLC in a single KV batch, sets a deterministic transactionId, and emits one local-change event per transaction.
prereq:
files:
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # handleTransactionCommit; recordSchemaMigration/recordDataEvent/recordColumnVersions; mapSchemaMigrationType; assertOpSeqInRange
  - packages/quereus-sync/src/create-sync-module.ts            # TransactionCommitSource; createSyncModule(kv, options)
  - packages/quereus-sync/src/clock/hlc.ts                     # deterministicTxnId(base); MAX_OPSEQ
  - packages/quereus-sync/src/index.ts                         # exports deterministicTxnId, MAX_OPSEQ, TransactionCommitSource
  - packages/quereus-sync/test/helpers/fake-transaction-source.ts
  - packages/quereus-sync/test/sync/transaction-commit.spec.ts
  - packages/quoomb-web/src/worker/quereus.worker.ts          # createSyncModule(kv, { ..., transactionSource: db })
  - packages/sync-coordinator/src/service/store-manager.ts    # relay-only → no transactionSource
  - docs/sync.md                                              # § Transaction-Based Change Grouping (write side); § Integration with Store Events; Storage Layout (tx: row corrected)
----

# Complete: per-transaction HLC tick + opSeq assignment (write side)

Delivers the write half of "HLC = transaction". The read side
(`getChangesSince` grouping) remains a separate ticket
(`sync-getchangessince-transaction-grouping`). Foundations
(`sync-hlc-opseq-foundation`, `engine-transaction-commit-signal`) already landed.

Implementation is as described in the implement handoff: local-change capture is
sourced from `transactionSource.onTransactionCommit` (one tick per committed
transaction, contiguous opSeq per fact, DDL before DML, single KV batch, one
`local-change` emit, all-remote echo groups skipped with no tick). The design was
validated end-to-end against the implement diff (`ad38c281`) with fresh eyes.

## Review findings

### Verification run
- `@quereus/sync` build ✅, typecheck ✅.
- `@quereus/sync` test: **223 passing, 1 failing** — the single failure is a
  pre-existing flaky clock test (see *Pre-existing* below), NOT in this diff. All
  of this ticket's own tests (`transaction-commit.spec.ts` + migrated specs) pass.
- No lint script exists for `@quereus/sync` (only `packages/quereus` lints);
  `tsc --noEmit` stands in and is clean.
- Re-confirmed the changed consumers typecheck via the package build/typecheck.

### Aspects scrutinized
- **SPP / DRY / modularity:** `handleTransactionCommit` decomposes cleanly into
  `recordSchemaMigration` / `recordDataEvent` / `recordColumnVersions`, with
  `mapSchemaMigrationType` and `assertOpSeqInRange` as pure, separately-tested
  helpers. `nextHlc()` closure threads one opSeq counter — no duplication. Good.
- **Correctness of "one tick":** `tick()` advances `(wallTime, counter)` exactly
  once per local group; every fact shares the base and differs only in opSeq.
  Verified against `compareHLC` ordering (opSeq is the lowest-priority tiebreak).
- **opSeq bound:** `assertOpSeqInRange` checks `> MAX_OPSEQ` before use; allows
  0..MAX_OPSEQ (uint32), throws beyond. Matches serialization width. Unit-tested.
- **DDL-before-DML:** migrations recorded first → lowest opSeq. Tested.
- **Echo / mixed groups:** all-remote → early return, no tick, no batch, no emit
  (clock-unchanged asserted); mixed → only local facts recorded, contiguous opSeq.
  Tested.
- **Two DDLs on one table in one txn:** `versionCounters` map seeds from
  `getCurrentVersion` then increments in-memory, so the second DDL gets version+1
  rather than colliding on the committed-state read. Logic verified by reading
  `recordSchemaMigration` + `SchemaMigrationStore.getCurrentVersion`/`recordMigrationBatch`.
- **Rollback:** real-`Database` test confirms a rolled-back write consumes no HLC
  and records nothing; the engine fires no commit group on rollback (verified in
  `database-events.ts` `flushBatch`/`discardBatch`).
- **Consumers:** `quoomb-web` worker passes `transactionSource: db`;
  `sync-coordinator` is relay-only (no source) and still returns `storeEvents` in
  its StoreEntry (not an unused var). Both correct.
- **Docs:** `docs/sync.md` write-side + integration sections accurately describe
  the new flow and pseudo-code; README factory signature updated.

### Findings & disposition

**Minor — FIXED in this pass**
- *Doc contradiction (Storage Layout `tx:` row).* `docs/sync.md` § Deterministic
  transaction id states no `tx:` record is persisted, yet the Storage Layout table
  still listed `tx:{txId}` as a written "Transaction record `{changes[], hlc,
  committed}`". Corrected the table row to mark `tx:` *reserved — not persisted*
  (the id is derived; `buildTransactionKey`/prefix remain reserved). Consistent
  with the implement note (handoff flag #4) but now non-contradictory.

**Minor — DOCUMENTED (idempotent / harmless; no inline fix)**
- *Redundant change-log entries on repeated writes to the same `(pk, column)`
  within one transaction.* Because the whole transaction now shares one
  *uncommitted* KV batch, `recordColumnVersions`' `getColumnVersion` read sees only
  pre-transaction committed state, so a second write to the same column in the same
  transaction does NOT delete the first write's change-log entry (the old
  per-event-commit handler did, because each event committed before the next). The
  column-version store still ends at last-writer (correct value); the surplus
  change-log entry resolves to the *current* column version on `getChangesSince`
  (verified at `sync-manager-impl.ts:444-452`), so it is idempotent and converges —
  it only inflates change-log size for the uncommon "same row+column twice in one
  txn" pattern. Same harmless-but-inflating class as the double-emit below; folding
  a dedup into that follow-up is the natural home. Not worth its own ticket.
- *`deleteRowVersions` on delete runs outside the transaction's KV batch*
  (pre-existing, unchanged). Minor atomicity nuance; left as-is.
- *No-op UPDATE still ticks + emits an empty `local-change`* (pre-existing pattern).
  Acceptable; harmless.

**Major — FILED as new ticket**
- *Engine/store DML double-emit* → `tickets/fix/engine-store-dml-double-event.md`.
  Confirmed real and pre-existing: the DML auto-event gate
  (`needsAutoEvents = _needsDataEvents() && !hasNativeEventSupport(vtab)`) checks the
  **vtab instance**, but `StoreModule.getEventEmitter` is **module-level**
  (`store-module.ts:240`), so the engine auto-emits IN ADDITION to the store's
  native emitter → two identical events per store-backed row mutation. Harmless to
  convergence, but doubles recorded facts / opSeq for store-backed local
  transactions in production (quoomb-web). The implement handoff recommended filing
  it; I verified the gate and emitter wiring and filed accordingly. The
  FakeTransactionSource unit tests deliver clean batches (assert handler logic, not
  this upstream duplication); the real-`Database` echo-loop tests use set-membership
  assertions and so do not catch the doubling.

**Pre-existing (flagged, not chased)**
- `hlc.spec.ts` › "should ignore remote opSeq when merging the clock" is a flaky,
  timing-dependent test introduced by the foundation ticket (commit `56f73fdb`),
  outside this diff. Two `Date.now()`-driven `receive()` calls fail when they
  straddle a millisecond boundary. Recorded in `tickets/.pre-existing-error.md`
  with root cause + a deterministic-rewrite suggestion for the triage pass. The
  implement handoff's "224 passing, 0 failing" reflected a lucky same-ms run.

### Out of scope (separate tickets)
- Read side: `sync-getchangessince-transaction-grouping`.
- Cross-table dependency ordering on apply: backlog `sync-cross-table-apply-ordering`.
- Awaitable-capture / `whenSettled()` affordance for the fire-and-forget capture
  (implement handoff flag #1) — not pursued; the production sync loop is driven by
  the post-capture `onLocalChange`, and tests use explicit `settle()`. Left as a
  noted design consideration, not a blocker.
