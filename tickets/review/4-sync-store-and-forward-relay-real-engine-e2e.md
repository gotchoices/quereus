description: Review a new test that proves a relay peer which dropped a table actually passes a straggler's write through to a peer that still has the table, which then reads it back as a real row.
prereq:
files:
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts   # NEW — the real-engine e2e suite under review
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts          # wiring pattern this suite was copied from
  - packages/quereus-sync/test/sync/store-and-forward-relay.spec.ts       # metadata-layer sibling (the gap this closes)
  - packages/quereus-sync/src/sync/store-adapter.ts                       # createStoreAdapter — the real applyToStore
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                   # collectForwardableChanges + recordColumnVersions + getChangesSince
  - docs/sync.md                                                          # § Store-and-forward relay (added e2e-coverage note)
difficulty: medium
----

# Review: real-engine end-to-end store-and-forward relay

## What was built

A new self-contained spec, `store-and-forward-relay-e2e.spec.ts`, that drives **real**
`Database` + `StoreModule` + `createStoreAdapter` peers (wiring copied from
`echo-loop-quiescence.spec.ts`, per the suite's "each spec is self-contained" convention).
It closes the gap left by `store-and-forward-relay.spec.ts`, which proves the relay only at
the CRDT-metadata layer (recording stub + `columnVersions` cross-check). Here the headline
assertion is the one the metadata suite cannot make: **`select id, note from orders` on the
holder deep-equals the row the straggler wrote, carrying the straggler's origin HLC.**

Three real peers model the uneven-retirement window:
- **S (straggler)** — has `orders`, writes the row (logs under S's HLC).
- **R (relay)** — has **no** `orders` table (so its basis oracle reports it out-of-basis →
  diverted in SyncManager Phase 1, *before* the store adapter), `unknownTableDisposition:
  'store-and-forward'` → the diverted change is held forwardable.
- **H (holder)** — has `orders` → applies the forwarded change via the real store adapter and
  materializes a live row.

Relays are **from-zero** (the `relay()` helper, no `sinceHLC`), and strip `schemaMigrations`
(data echo, not DDL propagation).

## Build / test status

- `node ... mocha "packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts"` →
  **4 passing**.
- `yarn workspace @quereus/sync test` → **378 passing** (no regressions; the
  `[Sync] Error handling transaction commit` lines are pre-existing fixtures in
  `sync-manager.spec.ts` that deliberately inject failing KV stores).
- `yarn tsc -p tsconfig.test.json --noEmit` (quereus-sync) → **exit 0** (spec call sites
  type-check clean; the package's test tsconfig has `noUnusedLocals`/`noUnusedParameters` on).

## The four specs (use cases to validate)

1. **Straggler INSERT relays S→R→H** — R holds it forwardable & materializes nothing; H's
   `select` returns the row; the materialized `note` column carries S's origin siteId + exact
   HLC; H received it `remote:true` with no local re-derivation event and logged no H-origin
   echo; H now serves it from its own change log with S's origin intact.
2. **Idempotent re-relay** — a second S→R keeps the held count stable (no duplication); a
   second R→H is a value-identical no-op (no local orders event, no H-origin echo).
3. **Echo exclusion** — R never re-offers the change back to its author S, both from-zero and
   at a watermark *below* the change (proving echo exclusion, not the watermark, is what drops
   it); a neutral peer still sees it.
4. **Straggler DELETE relays S→R→H** — after an insert is relayed and materialized, a DELETE
   on S relays through and tombstones the row on H (`select` empty); the tombstone carries S's
   origin. Confirms the relay carries `RowDeletion`, not only `ColumnChange`.

## Honest gaps & deviations (look here first)

- **Per-column count deviates from the ticket's "exactly one forwardable entry."** The ticket
  was written against the metadata suite's hand-built *single* `ColumnChange`. The **real
  engine records one CRDT `ColumnChange` per column of a fresh insert, PK included** (verified
  in `recordColumnVersions`, sync-manager-impl.ts ~729-733; matches the cold-fill suite's
  `COLUMNS_PER_FRESH_INSERT = 2`). So a straggler `insert into orders(id, note)` is held on R
  as **two** entries (id + note). The spec defines `COLUMNS_PER_FRESH_INSERT = 2` and asserts
  the held count is **stable across re-relays** (idempotency = no duplication), not literally
  one. **Reviewer: confirm this reading of per-column recording is correct** — it is the one
  substantive departure from the ticket text.
- **From-zero only — the delta-watermark filter is not exercised through the real engine.**
  The `relay()` helper uses no `sinceHLC`, so `collectForwardableChanges`' watermark filter
  (`HLC ≤ sinceHLC` ⇒ drop) is never hit on this real-engine path. Spec 3 touches a low
  watermark only to isolate *echo* exclusion. The watermark/`does-not-re-relay-after-advance`
  behavior is covered at the metadata layer (`store-and-forward-relay.spec.ts`). Gap: no
  real-engine assertion that an advanced holder watermark stops re-delivery.
- **Spec 4 lets R's quarantine accumulate.** After the relayed delete, R holds the 2 stale
  column entries *plus* the delete (3 forwardable entries) — the column entries are not GC'd
  by a later delete from a different relay. The spec asserts the delete is present and that H
  converges to a tombstone (delete wins by HLC and by row-group rule), but deliberately does
  **not** pin R's exact held count post-delete. Convergence is correct; the lingering entries
  GC at the retention horizon. Worth a reviewer's eye on whether that accumulation deserves
  its own assertion or doc note.
- **No deeper-than-one materialization hop.** Spec 1 asserts H *serves* the change onward but
  does not relay H→(another holder) and re-materialize. Multi-hop depth ≥ 3 convergence is the
  scope of the sibling ticket `sync-store-and-forward-relay-multihop-chain` (currently in
  implement) — not duplicated here.
- **Telemetry not asserted.** `getUnknownTableStats()` (`forwarded`/`relayed`) is covered by
  the metadata suite; the e2e suite does not re-assert the counters.
- **`settle()` timing.** Fire-and-forget transaction-boundary capture is bridged with a 25ms
  `settle()` (copied verbatim from the echo-loop suite). Same theoretical flake surface as the
  sibling suites; no new risk introduced.

## Suggested reviewer focus

- Validate the per-column-recording claim and the `COLUMNS_PER_FRESH_INSERT = 2` constant.
- Confirm R genuinely diverts **before** the store adapter (the load-bearing distinction): the
  spec asserts no `orders` data event on R and `R.db.schemaManager.getTable('main','orders')`
  is `undefined`. Is there a stronger "store adapter never invoked" probe worth adding?
- Decide whether the from-zero-only and Spec-4-accumulation gaps warrant a follow-up
  fix/plan ticket or are acceptable as documented.
