description: Unified sync-ingress admission core. A new `admission.ts` (`applyDataToStore` + `admitGroup`) centralizes the docs/sync.md § Transactional Integrity write-ordering (data-first → metadata-second → abort-with-no-metadata) for the wire path and non-streaming snapshot; the streaming snapshot reuses the `applyDataToStore` seam only. Headline fix: snapshot/stream whole-batch throws now emit `status:'error'` (previously propagated bare, skipping the emit the wire path produces).
files:
  - packages/quereus-sync/src/sync/admission.ts                  # NEW — applyDataToStore + admitGroup + AdmissionGroup
  - packages/quereus-sync/src/sync/change-applicator.ts          # applyChanges → admitGroup; local maxHLCFromChangeSets
  - packages/quereus-sync/src/sync/snapshot.ts                   # applySnapshot → admitGroup
  - packages/quereus-sync/src/sync/snapshot-stream.ts            # flushDataToStore → applyDataToStore
  - packages/quereus-sync/src/sync/sync-context.ts               # throwIfApplyErrors / persistHLCState / toError (reused, unchanged)
  - docs/sync.md                                                 # § Transactional Integrity, § Schema Seed
  - packages/quereus-sync/test/sync/admission.spec.ts            # NEW — admitGroup/applyDataToStore ordering unit tests
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts   # NEW describe: whole-batch throw → status:'error'
----

# Unify sync ingress data-apply seam behind one group-atomic admission core

A new module `packages/quereus-sync/src/sync/admission.ts` exports the data-first
seam `applyDataToStore` and the full group-atomic `admitGroup`. The wire path
(`change-applicator.applyChanges`) and the non-streaming `snapshot.applySnapshot`
now admit their whole resolved batch through `admitGroup` (data → metadata →
clock watermark, aborting with no metadata on any data failure). The streaming
`applySnapshotStream` reuses only the `applyDataToStore` seam in `flushDataToStore`,
keeping its own checkpoint-based model. The headline defect closed: snapshot and
stream whole-batch throws now emit `status:'error'` exactly once (previously bare).

See the implement commit `3aa941c6` for the full change description.

## Review findings

**Process**: read the implement diff (`git show 3aa941c6`) with fresh eyes before
the handoff summary, then read every touched source file at HEAD, traced the HLC
clock semantics, the single-emit guarantee end-to-end, and confirmed seam coverage.

### Correctness — checked, no defects

- **Watermark merge equivalence.** `HLCManager.receive()` is *not* a pure max-merge
  — it always advances the counter (`max(local, remote)+1`, or `remote.counter+1`).
  So N per-changeset `receive` calls and one `receive(max)` do **not** yield
  identical clock state (the old per-changeset path inflates the counter more).
  **Not a bug**: the new code receives the max of exactly the same value set the old
  code received per-changeset, and the only invariant that matters — local clock ends
  `>` every received HLC — holds in both. Causality and idempotent re-application are
  preserved. The inline comment calling `receive` a "monotonic max-merge / equivalent"
  is loose shorthand but its conclusion is sound; left as-is (not worth churn).
- **Move of `receive` to after `commitMetadata`.** Safe: resolution (`resolveChange`)
  compares against *stored* versions via `compareHLC` and metadata is recorded with
  each change's own `change.hlc` — neither reads the live clock or calls `tick()`, so
  the relative order of the `receive` no longer matters. `appliedAt = now()` in the
  event-emission block still reflects the post-receive clock because `admitGroup`
  completes first. On a mid-batch data abort the clock now does **not** advance
  (old code advanced the in-memory clock then failed to persist) — strictly more
  consistent.
- **Single `status:'error'` emit, end-to-end.** The catch path and `throwIfApplyErrors`
  are mutually exclusive (a throw never reaches the per-change check), so the seam
  emits at most once. Verified the transport callers don't re-emit on ingress throw:
  the only other `emitSyncStateChange({status:'error'})` is the unrelated local-commit
  handler in `sync-manager-impl`; `sync-client.handleChanges` propagates without
  re-emitting. No double-emit on the wire path either.
- **Seam coverage.** The only `applyToStore(` call sites are the seam plus the two
  `bootstrapFinalize` calls (snapshot + stream), which are intentionally kept direct
  (they carry no data; the empty-guard would wrongly skip them). No ingress path
  bypasses the seam.
- **Empty-guard.** `applyDataToStore` skips only when *both* data and schema are empty,
  so schema-only units still apply. Empty-batch `applyChanges([])` correctly skips the
  watermark persist (clock unchanged → nothing to persist); return shape unchanged.

### Validation — all green

- `yarn workspace @quereus/sync run typecheck` → exit 0
- `yarn workspace @quereus/sync exec tsc -p tsconfig.test.json --noEmit` → exit 0
- `yarn workspace @quereus/sync test` → **247 passing**, exit 0. The
  `[Sync] Error handling transaction commit` console lines are pre-existing
  injected-failure tests (`sync-manager.spec.ts` ~1344/1376), not failures.
- No lint script exists for `@quereus/sync` (only `packages/quereus` has one per
  AGENTS.md); typecheck is the lint-equivalent and passes. No `packages/quereus`
  code was touched.

### Tests — adequate; the implementer's are a sound floor

The new `admission.spec.ts` pins the core ordering (both failure shapes abort before
metadata/watermark with a single emit; success orders commit-then-receive; omitted
watermark commits without advancing; empty/no-callback no-ops). `snapshot-bootstrap.spec.ts`
pins the headline fix for both snapshot and stream (exactly one `status:'error'`,
never `synced`, no relayable metadata committed). Edge/error/regression paths covered.

### Findings filed / disposition

- **MINOR → filed `backlog/sync-hoist-maxhlc-helper.md`.** `maxHLCFromChangeSets` is
  duplicated across `change-applicator.ts` and `quereus-sync-client/sync-client.ts`
  (a DRY-rule violation). Not fixed inline because the clean fix hoists a shared
  `maxHLC` into `clock/hlc.ts` + a new `@quereus/sync` export, which couples to the
  sync-client build order — out of scope for a review-stage inline edit. Tracked.
- **OBSERVATION, not filed.** A `bootstrapFinalize` throw (MV convergence) still does
  **not** emit `status:'error'` on either snapshot path — it propagates bare. This is
  pre-existing and *consistent* with the documented finalize-retry model (checkpoint
  retained, storage rows already correct, retry rebuilds cleanly); it is outside this
  ticket's data-apply-seam scope. Noted here in case error-surfacing for finalize is
  later desired.
- **OBSERVATION, not filed.** Streaming still writes CRDT metadata batches mid-stream
  (`batch.write()` at the 1000-entry threshold) before the corresponding data flush —
  the streaming path's pre-existing checkpoint model, explicitly retained and out of
  scope. The footer ordering (data flush before final metadata `batch.write`) is what
  makes the headline test's "no metadata committed on throw" assertion hold.
- **No test gaps worth blocking.** The flagged wire-path empty-batch and null-store
  streaming-clear deltas are covered at the core level (`admission.spec`) or are strict
  improvements (the null-store clear now avoids unbounded `pendingDataChanges` growth).

### Net

Implementation is correct, well-documented, and the headline fix is verified by new
tests. One minor DRY cleanup deferred to backlog; two pre-existing, out-of-scope
observations noted. No major findings.
