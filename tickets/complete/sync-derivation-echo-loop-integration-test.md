description: Two-peer echo-loop quiescence integration test for the `quereus.sync.replicate` change-log opt-in — a replicated derived row closes its own echo loop (B's re-derivation is value-identical → suppressed → no B-origin change-log entry → no ping-pong). Reviewed and shipped.
files:
  - packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts        # the test (5 cases: 4 original + a negative control added in review)
  - packages/quereus-sync/src/sync/store-adapter.ts                     # per-table storage writes BEFORE the single ingestExternalRowChanges seam call (the ordering the test guards)
  - packages/quereus-sync/src/sync/change-applicator.ts                 # commitChangeMetadata stamps applied changes under the ORIGIN's HLC
  - packages/quereus-sync/src/sync/sync-manager-impl.ts                 # handleDataChange / getChangesSince exclusion
  - packages/quereus/src/core/database-external-changes.ts              # ingest seam drives _maintainRowTimeCoveringStructures per source change (re-derivation fires)
  - packages/quereus-store/test/backing-host.spec.ts                    # bodyless pending stub deleted
  - docs/migration.md                                                   # § Synced vs. local derived tables (spec the test pins)
----

# Two-peer echo-loop quiescence integration test — COMPLETE

## Summary

Shipped `packages/quereus-sync/test/sync/echo-loop-quiescence.spec.ts`, wiring two
real `Database` + `StoreModule` + `createStoreAdapter` + `SyncManagerImpl` peers
together and proving the `quereus.sync.replicate` invariant end-to-end: a
replicated derivation write closes its own echo loop and does not ping-pong.
When peer B ingests A's source change AND A's logged derived MV row, B's own
re-derivation is value-identical → suppressed → no event → no B-origin
change-log entry. The bodyless pending stub and its design comment were deleted
from `quereus-store/test/backing-host.spec.ts`.

The test now has **five** cases (the implementer's four + one negative control
added in review):
1. A→B: replicated derivation converges on B and closes its own echo loop.
2. **Negative control (added in review)**: relaying ONLY the source change makes
   B re-derive locally and log a B-origin echo — proving suppression is real, not
   absence of maintenance.
3. B→A round-trip: the empty reverse relay adds no spurious change on A.
4. Follow-up UPDATE steady state.
5. DELETE → MV-tombstone path stays quiescent.

## Review findings

### What was checked

- **Implement diff read fresh** (the 302-line spec + 13-line stub deletion) before
  the handoff summary.
- **API surface verified** — `SyncManagerImpl.{getSiteId, getCurrentHLC,
  getChangesSince, applyChanges, updatePeerSyncState}` all exist with the
  signatures the test calls (sync-manager-impl.ts).
- **The load-bearing ordering claim verified in source** — `createStoreAdapter`
  writes every batched table's rows to committed storage via
  `StoreTable.applyExternalRowChanges` (store-adapter.ts:194) BEFORE the single
  end-of-invocation `db.ingestExternalRowChanges` seam call (store-adapter.ts:222).
  The regression this guards (reorder the seam ahead of the storage writes → B's
  re-derivation reads a stale MV backing → emits → B-origin echo → red) is real.
- **Quiescence assertion is meaningful** — `commitChangeMetadata`
  (change-applicator.ts:336) stamps applied column versions under the *change's*
  HLC, i.e. origin A's siteId; `getChangesSince(A.siteId)` →
  `collectAllChanges` excludes those, so a B-origin echo (recorded under B's HLC
  by `handleDataChange`) WOULD surface. The length-0 assertion can actually fail.
- **Re-derivation genuinely fires** — the ingest seam
  (database-external-changes.ts:183-185) drives
  `_maintainRowTimeCoveringStructures` on the ingested `src` change, so B's
  store-backed MV re-derives. The suppression under test is not vacuous.
- **`!e.remote` predicate** — correct: the adapter emits applied effective changes
  with `remote: true`; only a genuine local derivation has it falsy.
- **Both deviations from the ticket sketch confirmed sound.** (1) `relay` strips
  `schemaMigrations` — faithful to the ticket's "schema created directly on each
  peer, not schema-synced"; without it the A→B case passes only by HLC-dedup
  accident and B→A fails outright. (2) The round-trip asserts A's full
  change-log count is unchanged rather than the ticket's literal
  `A.getChangesSince(B.siteId)`-flattens-to-0, which is non-detecting by
  construction (it excludes B-origin, not A's own legitimate src+mv entries). The
  implementer's faithful invariant is correct.
- **Docs** — `docs/migration.md` § Synced vs. local derived tables (lines 135-160)
  accurately documents the tag opt-in (one `DataChangeEvent` per realized
  `BackingRowChange`) and the value-identical-upsert suppression the test pins.
  Read in full; reflects current reality. No change needed.

### What was found / done

- **MINOR (fixed inline) — vacuousness risk.** The four quiescence cases all prove
  a *negative* (no local `mv` event), which is only meaningful while B's
  re-derivation actually fires. If store-backed MV maintenance ever stopped
  running on external ingest, all four would pass green while silently becoming
  vacuous, and the ordering-regression guard would silently break with them.
  Added a **negative-control** case that relays ONLY A's `src` change (drops the
  derived row), forcing B to re-derive with nothing pre-committed to match: it
  asserts B converges the `mv` row AND emits a LOCAL (non-remote) `mv` event AND
  logs a B-origin `mv` echo — exactly the ping-pong the full-relay cases prove is
  suppressed. This pins the machinery live and makes the suite self-validating.

### Major findings → new tickets

- **None.** The implementation is correct, the ordering guarantee is verified in
  source, the API matches, and the only gap (test vacuousness risk) was a minor
  robustness issue fixed inline. No fix/plan/backlog ticket filed.

### Deliberate scope (not deficiencies)

The handoff's known-gaps list (single `StoreModule` flavor; trivial 1:1 column
projection; full-sync only / no delta watermark; create-fill publication out of
scope — tracked as `sync-derivation-fill-publication`; no ≥3-peer topology or
concurrent/conflicting writes) are intentional scoping decisions consistent with
the ticket and covered by other sync specs. Confirmed, not flagged.

## Validation

- `echo-loop-quiescence.spec.ts` — **5 passing**.
- `yarn workspace @quereus/sync test` (full sync suite) — **196 passing**, 0
  failing (the `[Sync] Error handling…` console lines are deliberate
  error-injection tests in `sync-manager.spec.ts`).
- `packages/quereus-store/test/backing-host.spec.ts` — **54 passing** (stub
  deletion compiles).
- `tsc -p packages/quereus-sync/tsconfig.test.json --noEmit` — exit 0.
