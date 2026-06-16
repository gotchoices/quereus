description: Engine per-transaction grouped commit delivery — `db.onTransactionCommit(listener)` fires one `TransactionCommitBatch` per committed logical transaction, carrying all data + schema events across all tables in flush order; dropped on rollback; silent on empty/collisions-only commits. Additive to the per-event `onDataChange`/`onSchemaChange` channels. Includes the auto-event gating widening so the channel works standalone on the default in-memory module.
files:
  - packages/quereus/src/core/database-events.ts            # TransactionCommitBatch/Listener types, transactionCommitListeners set, onTransactionCommit, needsData/SchemaEvents, projection helpers, flushBatch dispatch
  - packages/quereus/src/core/database.ts                   # Database.onTransactionCommit, _needsDataEvents/_needsSchemaEvents
  - packages/quereus/src/index.ts                           # re-export TransactionCommitBatch / TransactionCommitListener
  - packages/quereus/src/runtime/emit/dml-executor.ts       # auto-event gate widened: hasDataListeners() -> _needsDataEvents() (3 sites: insert/update/delete)
  - packages/quereus/src/schema/manager.ts                  # auto-schema-event gate widened: hasSchemaListeners() -> _needsSchemaEvents() (2 sites)
  - packages/quereus/test/database-events.spec.ts           # "Transaction-Commit Grouping" suite (now 10 tests)
  - docs/sync.md                                            # § Transaction-Based Change Grouping + § Integration with Store Events
----

# Complete: engine transaction-commit signal

A standalone, additive engine capability: `db.onTransactionCommit(listener)`. Each
committed logical transaction delivers exactly **one** `TransactionCommitBatch`
(`{ dataEvents, schemaEvents }`, both in flush order) carrying every data and schema
event of that transaction across all tables. Dropped on rollback; never fires for an
empty/idle commit or a collisions-only transaction. Built at the end of `flushBatch()`
from the same `allDataEvents`/`allSchemaEvents` arrays the per-event path uses, so
listeners on either channel see identical event shapes.

The implementation also widened the auto-event **generation** gate (DML executor ×3,
schema manager ×2) from `has*Listeners()` to new internal `_needs*Events()` predicates
(`= has*Listeners() || hasTransactionCommitListeners()`), so a consumer subscribed
**only** to `onTransactionCommit` still gets events collected on modules without native
event support (the default in-memory module). Public `has*Listeners()` semantics are
unchanged.

The downstream consumer is `tickets/implement/sync-per-transaction-hlc-tick.md`, which
will subscribe to this channel and assign one HLC per batch.

## Review findings

Adversarial pass over commit `8e6a505c`. Read the implement diff fresh before the
handoff summary; scrutinized every touched file (and the files it should have touched).

**Verdict: sound, well-decomposed, DRY. One coverage gap found and fixed inline. No
major findings — no new tickets filed.**

### What was checked

- **Gating-widening completeness (the scope expansion).** Searched every remaining
  `hasDataListeners`/`hasSchemaListeners` reference in `packages/quereus/src`. All
  remaining uses are correct: (a) the public `Database`/`DatabaseEventEmitter` methods,
  intentionally left with their literal "is a per-event listener subscribed" meaning
  (a test asserts this); (b) module-level `VTableEventEmitter` uses
  (`vtab/events.ts`, `vtab/memory/layer/manager.ts` `enableChangeTracking`) — these key
  off the *module's* emitter, to which the engine subscribes at `registerModule` time
  (`hookModuleEvents`, unconditional), so the count is always > 0 for native modules.
  The 3 DML gates and 2 schema-manager gates are the complete set of auto-event
  *generation* gates, and all were widened. **Conclusion: widening is complete and the
  reasoning in the handoff holds.**

- **Cross-table grouping architecture (the core property).** Verified via
  `table-handle.ts:33-60`: the module-level emitter is "the same instance shared by
  every table that lives under the same module." The store's per-table
  `TransactionCoordinator`s forward into that one shared module emitter, which the engine
  hooks once. So a multi-table commit funnels into a single engine batch — the design
  premise is real, not aspirational. This substantially downgrades the handoff's
  "store path reasoned-not-verified" worry: the grouped batch is assembled from the
  *exact same* `batchedDataEvents`/savepoint-layer arrays the already-tested per-event
  store path consumes, so store grouping correctness follows from store per-event
  correctness (the only new code is the module-agnostic grouping wrapper, which is
  unit-tested). Left as a documented low-risk gap rather than a blocking ticket; the
  downstream sync-hlc tickets exercise the store path end-to-end.

- **Lifecycle / wiring.** `flushBatch()` is invoked from `commitTransaction()`'s
  `finally` (on success) and `discardBatch()` on rollback / failure / `rollbackTransaction`;
  autocommit routes through `ensureTransaction` → `startBatch` and `autocommitIfNeeded`
  → `commitTransaction` → `flushBatch`. Savepoint layers are discarded on
  `ROLLBACK TO SAVEPOINT`. So the new dispatch point inherits correct batch/rollback/
  savepoint semantics for free — confirms the handoff's "no `database-transaction.ts`
  change needed" claim.

- **Error isolation / resource cleanup.** Throwing listener wrapped in try/catch +
  `errorLog`, mirroring the other channels; `removeAllListeners()` clears the new set and
  counts it in the leak warning.

- **Empty/guard correctness.** Batch skipped when no listener subscribed (no per-commit
  allocation) AND when `dataEvents.length + schemaEvents.length === 0` (empty/idle or
  collisions-only). Verified collisions are intentionally excluded from the count
  (they keep their own channel).

- **Downstream API-shape match.** `tickets/implement/sync-per-transaction-hlc-tick.md`
  expects: one `onTransactionCommit(batch)` subscription; ordered `schemaEvents` then
  `dataEvents`; each event carrying `remote` (for its "every event remote ⇒ echo, return"
  check); no need to also subscribe to `onDataChange`. The delivered API satisfies all of
  these. (The consumer's choice of `db.getEventEmitter()` vs the public
  `db.onTransactionCommit()` accessor is its own concern.)

- **Docs.** `docs/sync.md` § Transaction-Based Change Grouping and § Integration with
  Store Events read accurately against the code — including the "why the engine, not the
  per-table store coordinator" rationale. No stale claims found.

### What was found / done

- **Minor (fixed inline): UPDATE/DELETE grouping was untested for the standalone
  channel.** The gate was widened in all three DML paths, but the grouping suite only
  exercised INSERT and DDL. Added a test (`groups insert, update, and delete of one
  transaction into a single batch`) that drives all three operations in one explicit
  transaction with **only** an `onTransactionCommit` listener, asserting one batch with
  `[['insert',[3]],['update',[2]],['delete',[1]]]`. This exercises the widened update
  (`dml-executor.ts:726`) and delete (`:874`) gates that were previously uncovered.

- **Minor (noted, not changed): double projection allocation.** When both `onDataChange`
  and `onTransactionCommit` are subscribed, each event is projected via
  `toDataChangeEvent`/`toSchemaChangeEvent` once for the per-event emit and again for the
  grouped batch. Negligible (small objects, only when both channels are live); not worth
  the added complexity to dedupe.

- **Edge case (noted, no change): subscribing mid-transaction.** Because the auto-event
  gate is evaluated at DML time, subscribing to `onTransactionCommit` *after* DML has run
  within an open transaction means that transaction's prior events were never collected
  (the batch is empty ⇒ no fire). Intended usage is to subscribe before the transaction;
  acceptable and consistent with the per-event channels.

### Categories with nothing to report

- **Type safety:** clean — no `any`; internal accessors use the `_` convention
  (`_needsDataEvents`/`_needsSchemaEvents`) consistent with `_getEventEmitter` etc.;
  exported `TransactionCommitBatch`/`TransactionCommitListener` re-exported from `index.ts`.
- **DRY:** the projection helpers (`toDataChangeEvent`/`toSchemaChangeEvent`) are the
  single source of truth for both channels — a genuine improvement over the prior
  inline-duplicated projection.
- **Regressions:** none — existing per-event and collision channel behavior unchanged;
  full suite green.

### Validation performed (this review)

- `yarn workspace @quereus/quereus lint` (eslint + `tsc -p tsconfig.test.json`) → clean (exit 0), re-run after the new test.
- `yarn workspace @quereus/quereus test` → **6328 passing, 9 pending, 0 failing** (was 6327; +1 from the added UPDATE/DELETE grouping test).
- `yarn test:store` (store-backed logic suite) **not run** — slow / not agent-runnable in-ticket; the store grouping path is left as the documented low-risk gap above and is covered end-to-end by the downstream sync-hlc implement tickets.
