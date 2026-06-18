description: When a remote peer re-creates a table that was previously deleted, the edits that were being held for that table now replay the instant the re-creation is applied, instead of waiting up to five minutes for a background sweep.
prereq:
files:
  - packages/quereus-sync/src/sync/change-applicator.ts                 # drainReappearedTables helper + applyChanges wiring + refined drain doc-comment
  - packages/quereus-sync/src/sync/protocol.ts                          # SyncConfig.drainOnReappear + DEFAULT_SYNC_CONFIG
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts   # harness model of create_table→basis + 6 reactive-drain tests
  - packages/quereus-sync/test/sync/sync-drain-e2e.spec.ts              # 1 real-store e2e: inbound create_table reactively drains
  - docs/migration.md                                                   # § 4 Contract → Revival / drain note
  - docs/sync.md                                                        # § Unknown-Table Disposition → Revival / drain note
difficulty: medium
----

# Review: low-latency scoped drain when an inbound `create_table` revives a held table

## What was built

The unknown-table drain feature (`drainHeldChanges`) was previously **only** invoked by
the host's ~5-minute periodic sweep. This ticket closes that latency for the highest-value
reappearance path: an inbound `create_table` arriving in an `applyChanges` batch (a remote
peer re-created a retired table mid-sync). The held edits for that table now replay the
moment the DDL has committed locally, as a **separate post-commit apply**, not on the next
tick.

Concretely, three production changes + tests + docs:

1. **`SyncConfig.drainOnReappear: boolean`** (default `true`) added to `protocol.ts` +
   `DEFAULT_SYNC_CONFIG`. Hosts opt out via `createSyncModule({ drainOnReappear: false })`
   (spread over defaults — no other wiring). `sync-coordinator`'s partial `sync` config is
   unaffected (it never constructed a full `SyncConfig` literal).

2. **`drainReappearedTables(ctx, tables)`** — new **exported** advisory helper in
   `change-applicator.ts`. Early-returns when `!drainOnReappear` or the list is empty.
   Drains each table independently through `drainHeldChanges(ctx, schema, table)`, each in
   its own `try/catch` so one table's failure never aborts the others **and never propagates
   out of `applyChanges`** (logged via `console.warn`, `[Sync] ...`, then swallowed).

3. **`applyChanges` wiring** — after `admitGroup` commits (and after the batch's
   `emitRemoteChanges`, before the unknown-table telemetry), it collects the applied
   `create_table` tables from `pendingSchemaMigrations` (deduped by `schema.table`, minus
   `batchDropped` keys) and calls `drainReappearedTables`.

The drain doc-comment was refined from "never drains inline" → "never **interleaves** drain
into the admitting batch" (a reactive drain is its own post-commit admission unit).

## Why it is correct (the load-bearing invariants)

- **Separate unit, correct order.** The drain's `admitGroup` runs strictly after the
  admitting batch's `admitGroup` resolved (sequential `await`), so fresh create+data is in
  storage before held changes LWW-resolve against it. No intra-admission interleave.
- **Only *applied* DDL triggers a drain.** An HLC-dominated `create_table` that lost
  resolution `continue`s in Phase 1 *before* being pushed to `pendingSchemaMigrations`, so it
  is never in the candidate set.
- **Advisory.** A drain throw cannot turn a committed apply into an error — the per-table
  `try/catch` swallows it; held entries stay held for the periodic sweep (drain is
  idempotent — a re-drain returns 0).
- **Disjoint from divert.** A table created by the batch is "known" in Phase 1 (via
  `batchCreated`), so its changes are never diverted — created tables and `unknownByTable`
  tables can't overlap, so drain/telemetry ordering is independent.

## How to validate (all currently green)

- `yarn workspace @quereus/sync typecheck` → exit 0
- `tsc -p packages/quereus-sync/tsconfig.test.json` → exit 0
- `yarn workspace @quereus/sync test` → **419 passing** (was 412 pre-ticket; +6 in-memory,
  +1 e2e)

### New tests — what they pin

`unknown-table-disposition.spec.ts` → `describe('reactive drain on inbound create_table (revival)')`:
- Inbound `create_table` drains a held table immediately (no explicit `drainHeldChanges`);
  one drained event, `applied + skipped === drained`, remote-change keyed by origin.
- LWW-resolves a held edit against fresh data carried in the same revival batch.
- `create_table` + `drop_table` of the same table in one batch = no-op drain.
- HLC-dominated (skipped) `create_table` does **not** drain.
- `drainOnReappear=false` defers to the host sweep; a later explicit drain still clears.
- A thrown reactive drain is swallowed — the `create_table` apply still returns its
  `ApplyResult`, entries stay held, a later sweep drains without double-apply.

`sync-drain-e2e.spec.ts` (real `Database` + `StoreModule` + adapter):
- Inbound `create_table` reactively drains the hold **mid-`applyChanges`** — the held row
  materializes as a live SQL row via `select`, carrying S's origin HLC + siteId, with the
  data deliberately stripped so the row can *only* reach storage through the held-change
  drain (not an inline fresh-data apply).

### Harness changes the reviewer should sanity-check

- The in-memory harness's `applyToStore` now **models the engine**: an applied
  `create_table` adds `schema.table` to the mutable `basis` (default columns `[]` if the test
  did not pre-seed `columns`); `drop_table` removes it. This is what lets the reactive drain
  see the table present. Pre-existing tests still pass (e.g. the in-batch-DDL test now also
  flips `foo` present — harmless, nothing held for it).
- `failApply` gained `drainTable?: string` — fails only a **drain** unit (data apply with
  `schema.length === 0` targeting that table), letting the re-creating `create_table` batch
  (which carries the schema change) commit while its follow-on drain throws. This is a test
  artifact; the production swallow lives in `drainReappearedTables`.

## Known gaps / where to look hard (treat tests as a floor)

- **First-time `create_table` cost.** *Every* applied `create_table` — including a
  brand-new table with nothing held — now costs one scoped `quarantine.list(schema, table)`
  returning `[]`. This is the documented common-case cost (one empty scoped range scan per
  created table); confirm it's acceptable and that `quarantine.list` is genuinely bounded
  to the scoped range (not a full scan) in the real store, not just `InMemoryKVStore`.
- **Event-ordering choice.** Drain fires its `onHeldChangesDrained` / `onRemoteChange`
  *before* the batch's `onUnknownTable` telemetry. Argued safe (disjoint tables), but a
  reviewer may want the telemetry-first ordering — low stakes either way.
- **No new concurrency test for reactive-vs-sweep race.** Idempotency (LWW + no-op
  `quarantine.delete`) is argued from the primitive, not separately exercised here; the
  host-wiring ticket already introduced the sweep-vs-`applyChanges` race.
- **Companion not in scope.** `sync-drain-reappear-lens-redeploy` (in `implement/`, prereq
  on this) reuses the `drainOnReappear` flag + the exported `drainReappearedTables` helper
  added here — both are in place. The rarer local-`create table` path remains parked in
  `tickets/backlog/sync-drain-reappear-local-ddl.md`.
- **No quoomb-web changes** (by design — the worker already subscribes to both events). Not
  re-verified in this ticket; the docs claim it surfaces identically to a sweep drain.
