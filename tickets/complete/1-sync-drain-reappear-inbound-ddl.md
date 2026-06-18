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

# Complete: low-latency scoped drain when an inbound `create_table` revives a held table

## What shipped

An inbound `create_table` arriving in an `applyChanges` batch (a remote peer re-created a
retired table mid-sync) now replays that table's held out-of-basis edits **immediately** —
as a SEPARATE post-commit apply unit after the admitting batch commits — instead of waiting
up to one periodic-sweep interval (~5 min). Three production changes:

1. `SyncConfig.drainOnReappear: boolean` (default `true`) in `protocol.ts` +
   `DEFAULT_SYNC_CONFIG`; opt out via `createSyncModule({ drainOnReappear: false })`.
2. `drainReappearedTables(ctx, tables)` — exported advisory helper in
   `change-applicator.ts`; drains each table independently under its own `try/catch`
   (logged via `console.warn`, then swallowed — a drain throw never turns a committed
   apply into an error).
3. `applyChanges` wiring — after `admitGroup` commits and after `emitRemoteChanges`,
   collects applied `create_table` tables from `pendingSchemaMigrations` (deduped, minus
   `batchDropped`) and calls `drainReappearedTables`.

All gates green at review (commit `c1946577`):
- `yarn workspace @quereus/sync typecheck` → exit 0
- `yarn workspace @quereus/sync exec tsc -p tsconfig.test.json --noEmit` → exit 0
- `yarn workspace @quereus/sync test` → **419 passing** (the one `[Sync] drainReappearedTables
  failed … advisory` line is the expected swallow-test log, not a failure)

## Review findings

Adversarial pass over the implement diff (`git show c1946577`), read before the handoff.
Scrutinized for correctness, the required-field config change, efficiency, test coverage,
docs accuracy, error handling, and resource cleanup.

### Correctness — checked, sound

- **Load-bearing disjointness invariant verified.** The reactive drain replays held
  entries for batch-created tables, and the drain's correctness rests on those held entries
  being strictly *pre-existing* (never diverted within the same batch). Confirmed at
  `change-applicator.ts:169`: `known = (isTableInBasis || batchCreated) && !batchDropped`,
  so a batch-created table is always `known` ⇒ its changes are never diverted into
  `unknownByTable` ⇒ `reappeared` (created tables) and the just-quarantined set are
  disjoint. The drain can only see holds from *earlier* applies. Holds.
- **Separate-unit ordering.** Drain's `admitGroup` runs strictly after the admitting
  batch's `admitGroup` resolved (sequential `await`), so fresh create+data lands before
  held changes LWW-resolve. No intra-admission interleave. A data-apply failure throws out
  of the batch `admitGroup` *before* the drain code is reached, so the drain only ever runs
  on a committed batch.
- **Only applied DDL triggers a drain.** An HLC-dominated `create_table` `continue`s in
  Phase 1 before reaching `pendingSchemaMigrations`, so it is never a candidate (test:
  "an HLC-dominated (skipped) create_table does not trigger a drain").
- **Advisory swallow.** Per-table `try/catch` logs (`console.warn`, satisfies AGENTS.md
  "don't eat exceptions w/o logging") then swallows; held entries stay held for the sweep;
  drain is idempotent (test: "a thrown reactive drain is swallowed …").
- **No-oracle / relay-only peer.** `isTableInBasis` returns `true` for all tables without
  an oracle ⇒ nothing diverted ⇒ `quarantine.list` empty ⇒ reactive drain is a clean
  no-op. Consistent with existing detection-inert behavior.
- **ApplyResult semantics.** The drain's applied/skipped counts belong to its own
  `onHeldChangesDrained` event, not the triggering batch's `ApplyResult` — same as the
  periodic sweep. Test asserts `result.applied === 1` (just the create_table).

### Required-field config change — checked, no break

`drainOnReappear` was added as a **non-optional** field of `SyncConfig`. Swept every
`SyncConfig` construction: all spread `...DEFAULT_SYNC_CONFIG` (`create-sync-module.ts:138`
and every test harness), so the default flows through. `sync-coordinator` uses a separate
`SyncSettings` type (not the full `SyncConfig` literal), so it is unaffected. No compile
break anywhere.

### Efficiency — checked, acceptable

Every applied `create_table` now costs one `quarantine.list(schema, table)`. Confirmed
this is a **scoped prefix range scan**, not a full scan: `buildQuarantineScanBounds`
(`keys.ts:552`) returns `gte`/`lt` bounds over the `qt:{schema}.{table}{SEPARATOR}` prefix
when both args are present. Empty range returns fast; the common (nothing-held) case is one
bounded empty scan per created table. Acceptable as documented.

### Tests — adequate floor, no gaps worth a ticket

6 in-memory (`unknown-table-disposition.spec.ts`) + 1 real-store e2e (`sync-drain-e2e.spec.ts`)
cover: immediate reactive drain, LWW against fresh data in the same batch, create+drop no-op,
HLC-dominated skip, `drainOnReappear=false` defer-to-sweep, advisory swallow, and real
`Database`/`StoreModule` materialization (row reachable only via the held-change drain,
carrying S's origin HLC + siteId). Happy path, edge, and error paths covered.

### Docs — checked, accurate

`docs/migration.md` § 4 Contract and `docs/sync.md` § Revival / drain both updated to the
new reality: the "never **interleaves** drain into the admitting batch" refinement, the
`drainOnReappear` gate, advisory + idempotent semantics, and the test-coverage pointers.
Read both against the code; they reflect it.

### Minor observations — noted, not fixed (no ticket)

- **drop-then-create in ONE batch.** `computeBatchTableDelta` is order-insensitive, so a
  batch that drops *and* re-creates the same table marks it `dropped` (net basis treated as
  absent), and the reactive drain skips it. This is a pre-existing quirk of the divert
  known-check (predates this ticket), affects a rare single-batch drop+recreate, and is
  caught by the periodic sweep (eventually consistent). Out of scope; not a regression.
- **No dedicated reactive-vs-sweep concurrency test.** Idempotency is argued from the
  primitives (LWW makes the data apply idempotent; `quarantine.delete` of an already-deleted
  key is a no-op) rather than separately exercised. Low risk; the sweep-vs-`applyChanges`
  race was already introduced by the host-wiring ticket.

### Disposition

No **major** findings → no new fix/plan/backlog tickets filed. Minor observations are
documented above and require no code change. The implementation is correct, the tests are a
solid floor, the docs are current, and all validation gates pass.
