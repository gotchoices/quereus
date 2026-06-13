description: Settle the snapshot-bootstrap global-assertion contract as trust-the-origin (Option 1, human-signed-off). Bootstrap installs one origin's already-converged state wholesale (replace, not merge), so it does NOT re-validate global assertions — documented with the merge-vs-replace rationale and pinned by a test that an assertion-violating snapshot bootstraps successfully. Docs + contract-pin only; no engine/behavior change.
files:
  - packages/quereus-sync/src/sync/store-adapter.ts                  # doc block :30-46 — settle the open-question note (:44-46) into a stated contract
  - docs/materialized-views.md                                       # § External row-change ingestion :623 — settle the "open design question" sentence
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts       # add the contract-pin test here; reuse installSpies/makeSyncManager/cvEntry/toStream/collect helpers
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts       # :321-359 incremental "assertion failure propagates" — the inverse this test documents the divergence from
difficulty: easy
----

# Snapshot bootstrap: global assertions are trust-the-origin (do not re-validate)

## Decision (human sign-off recorded 2026-06-13)

**Option 1 — trust the origin.** The incremental sync path enforces global
assertions on every applied batch because it **merges** deltas from possibly
many origins into the receiver's existing state, and a cross-origin merge can
produce a global-invariant violation no single origin ever saw. Snapshot
bootstrap does something different: it installs **one** origin's already-converged
state **wholesale (replace, not merge)**. No merge happens, so the
merge-introduced-violation class cannot arise; a complete snapshot already
satisfied the origin's assertions. Re-checking is therefore redundant for an
honest origin and consistent with the seam re-validating **nothing** else on any
inbound row (no CHECK / NOT NULL / UNIQUE / child-side FK — see
`docs/materialized-views.md` § External row-change ingestion → Trust boundary).

The two paths **agree on intent** (trust-the-origin everywhere) and **differ in
mechanism** (incremental enforces because it merges; bootstrap trusts because it
replaces). This asymmetry is correct, not a bug — the goal of this ticket is to
state it explicitly so a future reader does not re-file it.

Residual risk (a corrupt/hostile snapshot silently installs invariant-violating
data) is **already unguarded for every other constraint type**; defending only
global assertions would be inconsistent defense-in-depth. If origins are ever
distrusted, the fix is a separate broader integrity layer, not a one-off
assertion sweep. (The rejected alternative — re-validate at finalize over the
converged state — was Option 2; it is not taken. No new engine primitive is
added.)

## Background (established, do not re-derive)

- The engine seam `Database.ingestExternalRowChanges` runs `runGlobalAssertions()`
  via its capture facet, so the **incremental** path enforces assertions on every
  batch — pinned by `store-adapter-seam.spec.ts` "assertion failure propagates"
  (`:321-359`) and `external-row-change-ingestion.spec.ts`.
- The bootstrap flush **skips the seam call** (`store-adapter.ts:184`); MV
  maintenance + watch capture defer to one end-of-snapshot `bootstrapFinalize`
  (`store-adapter.ts:228` `finalizeBootstrap` → `refreshAllMaterializedViews()` +
  coarse `notifyExternalChange`). The finalize does **not** evaluate assertions —
  and under this decision it deliberately stays that way.
- `runGlobalAssertions()` is delta-driven (short-circuits when no base table
  changed in the txn), so it could not serve bootstrap anyway (bootstrap captures
  no deltas). This is moot under Option 1 — nothing is added.
- The snapshot stream issues `bootstrap` flushes then `bootstrapFinalize` from
  `snapshot-stream.ts` (`streamSnapshotChunks` footer case → `applyToStore([], [],
  { bootstrapFinalize: true, ... })`, then `clearSnapshotCheckpoint`, then emits
  `status: 'synced'`). A finalize throw leaves the checkpoint in place and skips
  `synced` — so "no throw" ⟹ checkpoint cleared + `synced` emitted.

## Scope of change

This is **docs + one test**. No production behavior changes — bootstrap already
does not re-validate assertions; this ticket makes that a stated contract and
locks it with a test.

### Edge cases & interactions (the reviewer will check these)

- **Bootstrap-then-incremental sequence.** After a trusted bootstrap, the first
  incremental batch enforces assertions over its delta **assuming the bootstrapped
  baseline is valid**. This is the trust boundary and the per-tuple-residual
  optimization's own baseline-valid assumption — document it where the contract is
  stated, do not test it here (it is the existing incremental behavior).
- **No-table-dependency assertion** (e.g. `check (1=0)`). Trust-the-origin means
  bootstrap does not run a finalize sweep, so even a no-dep assertion is not
  evaluated at finalize — consistent. Note: such an assertion cannot be *created*
  in an already-violated state (creation evaluates it), so it is a documentation
  point, not a separate violated-state test. State it in the doc block so the
  contract reads as uniform ("bootstrap evaluates no assertion at finalize, not
  even a no-dependency one").
- **MV-backed assertions.** An assertion referencing a materialized view would see
  the MV only after `refreshAllMaterializedViews()`; under Option 1 it is not
  evaluated at all, so MV-refresh ordering is moot for assertions (it still
  matters for MV correctness). One sentence in the doc block.
- **Poison-snapshot inversion.** The incremental path's poison-batch retry-forever
  posture does **not** apply to a snapshot whose only "violation" is an assertion
  one: bootstrap does not throw on it, so it converges and clears. (A snapshot that
  fails for a *different* reason — unresolvable table, MV rebuild error — still
  retries, unchanged.) The contract-pin test must assert the assertion-violating
  snapshot **succeeds** precisely to lock this distinction against the incremental
  "propagates" test.

## TODO

### Settle the contract in code/docs

- In `packages/quereus-sync/src/sync/store-adapter.ts`, rewrite the open-question
  note at `:44-46` (currently "Whether the finalize should re-validate assertions
  over the converged state is an open design question — see the backlog ticket
  `sync-bootstrap-assertion-enforcement`.") into a **settled statement** of the
  contract: bootstrap does not re-validate global assertions — trust-the-origin,
  because it **replaces** (one origin's converged state, installed wholesale)
  whereas the incremental path **merges** (and so must enforce). Cross-reference
  the seam's general trust-the-origin posture for the other constraint types
  (Trust boundary section). Remove the dangling backlog-ticket reference. Keep the
  existing "per-flush evaluation over partial data could spuriously fail a valid
  snapshot" rationale — it still supports the decision.

- In `docs/materialized-views.md` § External row-change ingestion, update the
  "**Snapshot bootstrap defers maintenance**" paragraph (`:623`) where it says
  "whether the finalize should re-validate assertions over the converged state is
  an open design question" — replace with the settled contract and the
  merge-vs-replace rationale, DRY against the section's existing trust-the-origin
  / Trust boundary statements (link, don't restate the full list of constraint
  types). Note the no-dependency-assertion and MV-backed-assertion edge points in
  one sentence each so the contract reads as uniform.

### Pin the contract with a test

Add to `packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts` (reuse the
file's existing `installSpies`, `makeSyncManager`, `cvEntry`, `toStream`,
`collect` helpers — do not introduce a new harness):

- A test that streams a bootstrap snapshot whose **converged state violates an
  active `create assertion`** and asserts the load **succeeds**. Shape:
  - On the receiving `db`: `create table t (id text primary key, v integer) using
    store` then `create assertion non_negative check (not exists (select 1 from t
    where v < 0))` (mirror the incremental test's assertion at
    `store-adapter-seam.spec.ts:323`).
  - Stream a snapshot whose single converged row sets `v = -5` (header /
    table-start / column-versions via `cvEntry` / table-end / footer — mirror the
    existing streamed-bootstrap test in this file).
  - Subscribe `onSyncStateChange`; capture states.
  - Assert: `applySnapshotStream` **does not throw**; the converged row is present
    (`select v from t` ⟹ `-5`); the snapshot checkpoint is **cleared** (no `sc:`
    key for the snapshotId in the kv — mirror how this file inspects kv); states
    **include `synced`** and **do not include `error`**; the seam was **never
    called** for assertion evaluation (`installSpies().seamCalls === 0`, consistent
    with bootstrap skipping the seam) and `refreshCalls === 1` (finalize converged
    once). This is the deliberate inverse of `store-adapter-seam.spec.ts`
    "assertion failure propagates" — add a comment naming that test so the
    divergence is self-documenting.

### Validate

- `yarn workspace @quereus/sync test 2>&1 | tee /tmp/sync-test.log; tail -n 60 /tmp/sync-test.log`
  (run the sync package's tests; confirm the new test + the existing bootstrap and
  seam specs still pass).
- `yarn workspace @quereus/quereus run lint` is not required for a sync-package
  docs/test change, but run the sync package's typecheck/build if it has one
  (`yarn workspace @quereus/sync build`) to catch spec call-site drift.

## End
