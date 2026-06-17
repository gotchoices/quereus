description: Make a single transaction that writes several tables in the persistent store land as one all-or-nothing commit, so a crash can never leave two tables (or a materialized view and its source) out of sync, and the engine can stop conservatively rebuilding views on every reopen.
prereq: store-atomic-batch-capability
files:
  - packages/quereus-store/src/common/transaction.ts         # per-table coordinator → module-scoped
  - packages/quereus-store/src/common/store-module.ts         # getCoordinator, getBackingHost, capability detection
  - packages/quereus-store/src/common/store-table.ts          # op addressing (explicit store handles)
  - packages/quereus-store/src/common/store-connection.ts     # connections delegate to shared coordinator
  - packages/quereus-store/src/common/backing-host.ts         # backing writes share the module commit
  - packages/quereus/src/core/database-transaction.ts         # sequential per-connection commit loop
  - docs/materialized-views.md                                # § Cross-module atomicity, adopt gates 4–5
----

# Module-wide (cross-table) atomic commit + adopt fast-path gate drop

This is the larger follow-on phase of the parent plan
`store-atomic-multi-store-commit`. The prereq `store-atomic-batch-capability`
makes **one table's** data + index stores commit atomically; this phase extends
that to **all tables of one module** touched by a single transaction, then uses
the resulting cross-table consistency guarantee to drop the MV adopt fast
path's clean-shutdown gate for same-module backings.

It is parked in backlog because it is an architectural change (not a localized
fix) that deserves its own dedicated plan/design pass once the capability
substrate from the prereq exists and can be measured. The correctness windows
it closes (two plain tables divergent; an MV source + backing divergent) are
**self-healed today** — plain tables carry no engine-level cross-table
invariant, and MV backings rehydrate-refill — so this is consistency-hardening
+ an optimization (skip the conservative refill), not an outstanding bug. The
acute, un-healed window (data vs. its own indexes) is already handled by the
prereq.

## Why it is not trivial

The engine commits virtual-table connections **sequentially**, one
`connection.commit()` at a time (`database-transaction.ts` ~240, inside
`inCoordinatedCommit`). Each store table has its **own** `TransactionCoordinator`
(`StoreModule.getCoordinator(tableKey)`), so "one transaction" already maps to
N independent coordinator commits — there is no single point where the module
writes everything. The `AtomicBatch` primitive can span any stores of a
provider, but nothing currently *aggregates* the ops across tables before the
write.

## Proposed design (to be validated in the dedicated plan pass)

**Module-scoped coordinator.** Replace per-table coordinators with **one
coordinator per (module, active transaction)** that every `StoreConnection` of
that module delegates to. Because the engine's sequential commit loop calls
`connection.commit()` on each store connection and `commit()` is **idempotent**
(after the first commit `inTransaction` is false → early return), the *first*
store connection to commit flushes **all** the module's accumulated ops in one
`AtomicBatch.write()`; the rest no-op. Rollback is idempotent the same way. This
finally makes the coordinator's own long-standing docstring ("Coordinates
transactions across multiple tables") true.

**Op addressing must go fully explicit.** The blocker is the current
**default-store (`null`) bucket**: data ops are queued with no store argument and
land in a per-coordinator default that *is* the table's data store. Sharing one
coordinator across tables makes that default ambiguous (every table's data ops
would collide in one bucket). The refactor:

- address **every** op by explicit `KVStore` handle (data ops included), so the
  pending index buckets purely by handle — no `null` default, no
  `bucketKey`/lazy-default-thunk machinery;
- the read-your-own-writes paths (`getPendingOpsForStore(store)`,
  `getOrderedPendingOps(store)`) already take a handle — callers in
  `store-table.ts` just always pass the concrete data store handle;
- the synchronous `BackingHost.connect()` requirement that motivated the lazy
  default thunk needs a new answer (e.g. resolve the data store handle eagerly
  at attach, or let the backing host queue against its already-resolved data
  store handle). This is the subtlest part and the main design question for the
  dedicated pass.

**Capability-gated, with safe fallback.** When the provider lacks
`beginAtomicBatch`, the module-scoped coordinator still groups by store and
writes per-store batches — no worse than today (today's per-table commits are
already non-atomic across tables). When the capability is present, the whole
module transaction is one durable commit.

## Adopt fast-path gate drop (the payoff)

With a provider that reports the atomic capability, a source table and a
same-module backing **cannot** diverge across a crash. The MV adopt fast path's
gate 5 (clean-shutdown marker attestation) exists *only* because that divergence
was possible within one store module (`docs/materialized-views.md` § Cross-module
atomicity, gates 4–5). So:

- when `provider.beginAtomicBatch` is present (atomic domain), **gate 4 alone**
  (every source in the same module as the backing, MV-over-MV upstreams adopted)
  becomes sufficient — skip the clean-shutdown-marker requirement for
  same-module backings;
- when absent, keep the marker gate exactly as today.

This makes the gate condition a runtime capability check rather than an
unconditional conservative refusal, and lets the common durable path adopt
without refill after a clean reopen *and* after a crash (the atomic domain
guarantees consistency either way). Update `docs/materialized-views.md` gate 5
and the caveats accordingly.

## Requirements / acceptance

- One transaction touching multiple store tables (and their indexes) of one
  module commits as a single `AtomicBatch.write()` when the capability is
  present; verified by a test that injects a fault between what *used* to be
  separate per-table commits and asserts all-or-nothing.
- A store-hosted MV's backing and its same-module source commit/rollback in one
  atomic batch (backing-host writes ride the same module coordinator).
- With the capability present, MV adopt succeeds across a simulated crash
  (no clean-shutdown marker) for same-module backings; without it, the marker
  gate still governs.
- Full fallback parity when the capability is absent (LevelDB before
  `store-leveldb-shared-root`, or any minimal provider): behavior unchanged.
- `yarn test` and `yarn test:store` green; MV adopt suite extended.

## Edge cases & interactions to enumerate in the implement pass

- **Per-table stats callbacks** currently registered on per-table coordinators
  (`StoreTable.attachCoordinator` → `applyPendingStats`/`discardPendingStats`).
  A shared coordinator must fan out commit/rollback to every participating
  table's stats hooks (the callbacks array already supports many listeners).
- **Savepoints become module-wide** (shared across the module's tables in a
  transaction) — confirm this matches engine savepoint broadcast semantics and
  the DDL-commit-clears-stack warnings still behave.
- **Backing-host incarnation pinning** (`backing-host.ts` `ownsConnection`
  compares coordinator identity) must keep working when the coordinator is
  module-scoped — pinning may need to move to (table, incarnation) identity
  rather than coordinator identity.
- **Cross-module** transactions (store backing + memory source, or two durable
  modules) are explicitly **out of scope** — coordinated commit is not 2PC and
  that window stays documented. "Per module" is the boundary.
- **DDL mid-transaction** (`replaceContents`/`renameTable` clearing the
  savepoint stack) interacting with a shared coordinator.
- **Connection registration/lifecycle**: many tables share one coordinator but
  each still registers its own `StoreConnection`; ensure begin/commit/rollback
  idempotency holds across the sequential per-connection loop and that a
  connection that did no work still cleanly no-ops.
- **Marker co-location** (after `store-leveldb-shared-root`): the clean-shutdown
  marker and data share one root; the marker consume-delete can be folded into
  the session's first atomic commit, though the synced delete from
  `store-marker-sync-durability` already closes that window.
