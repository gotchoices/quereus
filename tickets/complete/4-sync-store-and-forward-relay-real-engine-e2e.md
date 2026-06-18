description: A new test proves that a relay peer which dropped a table really passes a straggler's write through to a peer that still has the table, which then reads it back as a live row — verified and accepted.
prereq:
files:
  - packages/quereus-sync/test/sync/store-and-forward-relay-e2e.spec.ts   # the real-engine e2e suite (reviewed)
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts          # wiring pattern this suite was copied from
  - packages/quereus-sync/test/sync/store-and-forward-relay.spec.ts       # metadata-layer sibling (the gap this closes)
  - packages/quereus-sync/src/sync/store-adapter.ts                       # createStoreAdapter — the real applyToStore
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                   # collectForwardableChanges + recordColumnVersions + getChangesSince
  - packages/quereus-sync/src/sync/change-applicator.ts                   # Phase 1 diversion (before applyToStore)
  - docs/sync.md                                                          # § Store-and-forward relay (e2e-coverage note)
difficulty: medium
----

# Complete: real-engine end-to-end store-and-forward relay

## What was delivered

A new self-contained spec, `store-and-forward-relay-e2e.spec.ts` (4 specs), that drives
**real** `Database` + `StoreModule` + `createStoreAdapter` peers to close the gap left by
`store-and-forward-relay.spec.ts` (which proved the relay only at the CRDT-metadata layer).
The headline assertion — `select id, note from orders` on the holder deep-equals the row the
straggler wrote, carrying the straggler's origin HLC — is now made against a live SQL table.

Three real peers model the uneven-retirement window: **S** (straggler, has `orders`, writes
the row), **R** (relay, has **no** `orders` → diverted in Phase 1 before the store adapter,
`disposition: 'store-and-forward'` → held forwardable), **H** (holder, has `orders` →
materializes the forwarded change). Relays are from-zero and strip `schemaMigrations`
(data echo, not DDL propagation), per the established echo-loop convention.

The four specs cover: (1) straggler INSERT relays S→R→H and materializes with S's origin HLC
+ quiescence on H; (2) idempotent re-relay (stable held count, value-identical no-op);
(3) echo exclusion (from-zero and low-watermark, plus neutral-peer sanity); (4) straggler
DELETE relays S→R→H and tombstones with S's origin (proves the relay carries `RowDeletion`).

## Review findings

### Scope of the review
Read the implement-stage diff (commit 894f41db) with fresh eyes against the original
implement ticket, then verified every load-bearing claim against the source it cites
(`sync-manager-impl.ts`, `change-applicator.ts`), compared wiring/teardown to the sibling
`echo-loop-quiescence.spec.ts`, and ran the full suite + type check.

### Correctness / load-bearing claims — **verified, no findings**
- **Per-column recording (`COLUMNS_PER_FRESH_INSERT = 2`).** The implementer's one
  substantive departure from the ticket text ("exactly one forwardable entry") is **correct**.
  `recordColumnVersions` (sync-manager-impl.ts:729-733) iterates every column and, with no
  `oldRow`, records each as a `ColumnChange`; a fresh `insert into orders(id, note)` is held
  on R as **two** entries. Modelling idempotency as a *stable held count across re-relays*
  (not literally one) is the right reading.
- **Diversion happens before the store adapter.** Confirmed: change-applicator.ts Phase 1
  (lines 88-96, 169, 230-235) diverts out-of-basis straggler changes during *resolution*,
  before the `applyToStore` callback (Phase 2). R's basis oracle
  (`isTableInBasis`, sync-manager-impl.ts:279-281) reports `orders` out-of-basis because R
  never created it. The spec's behavioral probe (no `orders` data event on R +
  `getTable('main','orders')` undefined) is an adequate proxy — the diversion is
  over-determined by construction; a `applyToStore` spy would require exposing the callback on
  the `Peer` interface for marginal gain, so it was **not** added (see "Decisions").
- **Echo exclusion + watermark filter.** Confirmed in `collectForwardableChanges`
  (sync-manager-impl.ts:1063-1080): siteId echo-exclusion is checked first, the watermark
  filter only when `sinceHLC` is defined. Spec 3's low-watermark probe correctly isolates
  echo-exclusion (not the watermark) as the reason the change is dropped for its author, and
  the neutral-peer assertion proves the exclusion is author-specific.
- **DELETE path (spec 4).** Tombstone wins by HLC and row-group rule; carries S's origin.
  Convergence is correct; R's quarantine accumulation (2 stale column entries + the delete)
  is benign — those GC at the retention horizon. Not pinning R's post-delete count is the
  right call (it would assert an implementation detail, not a contract).

### Edge / error / regression coverage — **complete for this ticket's scope**
Every edge case the implement ticket enumerated is covered: pre-store diversion, forwardable
hold, origin identity end-to-end (siteId + exact HLC via `compareHLC === 0`), H as a
second-order relay, no echo to author S, quiescence/no spurious local echo on H, the delete
tombstone path, and settle/teardown. Happy path, idempotent re-apply, and the delete
regression are all exercised.

### Type safety / DRY / cleanup — no findings
- Type check (`tsc -p tsconfig.test.json --noEmit`, which has `noUnusedLocals`/
  `noUnusedParameters` on) → **exit 0**. Casts to `ColumnChange` are guarded by `type`/`column`
  discriminators; no `any`.
- The copied wiring (`createInMemoryProvider`, `makePeer`, `relay`, `settle`, `collect`,
  `closePeer`) is intentional per the suite's "each spec is self-contained" convention, which
  the ticket explicitly endorsed — **not** a DRY violation. `closePeer` not closing the
  manager's in-memory KV matches the sibling suite exactly (no new leak; in-memory, GC'd).

### Build / test status
- `yarn workspace @quereus/sync test` → **378 passing**, no regressions. The
  `[Sync] Error handling transaction commit` lines are **pre-existing intentional fixtures**
  in `sync-manager.spec.ts` (deliberate failing-KV injection, visible in the stack trace),
  not real failures — no `.pre-existing-error.md` filed.
- `yarn tsc -p tsconfig.test.json --noEmit` (quereus-sync) → **exit 0**.

### Decisions on the implementer's flagged gaps (all acceptable as documented)
- **From-zero-only (real-engine watermark filter not exercised).** Acceptable — the
  watermark/`HLC ≤ sinceHLC` drop is unit-covered at the metadata layer
  (`store-and-forward-relay.spec.ts`); the real-engine path does not change that logic.
  **No follow-up ticket.**
- **Spec-4 R accumulation not pinned.** Acceptable — convergence is correct; lingering entries
  GC at the horizon. **No follow-up ticket.**
- **No multi-hop depth ≥ 3.** Out of scope — covered by the sibling ticket
  `sync-store-and-forward-relay-multihop-chain` (in implement). **No follow-up ticket.**
- **Telemetry not re-asserted.** Acceptable — `getUnknownTableStats()` is covered by the
  metadata suite. **No follow-up ticket.**
- **`settle()` 25ms timing.** Same theoretical flake surface as the sibling suites; no new
  risk introduced. Acceptable.

### Disposition
- **Minor findings:** none — nothing required an inline fix; manufacturing changes to a clean,
  passing, type-checked spec would add risk without value.
- **Major findings:** none — no new fix/plan/backlog tickets filed.
