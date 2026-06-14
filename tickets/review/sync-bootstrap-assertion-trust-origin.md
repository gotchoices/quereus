description: Review docs + contract-pin test settling the snapshot-bootstrap global-assertion contract as trust-the-origin (Option 1, human-signed-off).
files:
  - packages/quereus-sync/src/sync/store-adapter.ts          # doc block :30-70 — settled open-question note
  - docs/materialized-views.md                               # § Snapshot bootstrap defers maintenance (~:623) — settled open design question
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts  # new test: assertion-violating bootstrap succeeds
----

## Summary

No production code was changed. This ticket settles the open design question in two doc locations and pins the contract with a test.

### Changes made

**`packages/quereus-sync/src/sync/store-adapter.ts`** (doc block, ~lines 36–60):
- Replaced the "open design question — see backlog ticket `sync-bootstrap-assertion-enforcement`" note with a settled statement of the trust-the-origin contract.
- States the merge-vs-replace rationale: incremental path **merges** (cross-origin merge can introduce violations → must enforce); bootstrap **replaces** (one origin's already-converged state, wholesale → redundant to re-check).
- Documents that no assertion is evaluated at finalize — not even a no-dependency one (uniform skip).
- Notes MV-backed assertions: moot under trust-the-origin (not evaluated at all, so MV-refresh ordering is irrelevant for assertions).
- Notes that per-flush evaluation could not serve bootstrap anyway (partial-data spurious failure).
- Cross-references the Trust boundary section in docs.
- Removed the dangling backlog-ticket reference.

**`docs/materialized-views.md`** (§ Snapshot bootstrap defers maintenance, ~line 623):
- Replaced "whether the finalize should re-validate assertions over the converged state is an open design question" with the settled contract and merge-vs-replace rationale.
- Links back to the Trust boundary section rather than restating the full constraint-type list.
- Notes no-dependency-assertion and MV-backed-assertion edge points inline.

**`packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts`**:
- Added test: `'assertion-violating bootstrap succeeds — trust-the-origin (deliberate inverse of store-adapter-seam.spec.ts "assertion failure propagates")'`
- Creates `table t (id text primary key, v integer) using store` + `assertion non_negative check (not exists (select 1 from t where v < 0))` on the receiver.
- Streams a one-row bootstrap snapshot with `v = -5` (violates the assertion).
- Asserts: no throw; converged row present with `v = -5`; `seamCalls === 0`; `refreshCalls === 1`; checkpoint key `sc:${snapshotId}` cleared from KV; states include `synced`; states do not include `error`.
- Comment names the deliberate inverse relationship to the seam spec's "assertion failure propagates" test.

### Validation

- `yarn workspace @quereus/sync test`: **191 passing** (full suite).
- `yarn workspace @quereus/sync test --grep "assertion-violating"`: **1 passing** (new test isolated).

## Use cases for testing / review focus

- Verify the doc block in `store-adapter.ts` is accurate: the `bootstrapFinalize` call (line ~228) reaches `refreshAllMaterializedViews()` and `notifyExternalChange` but does NOT call `runGlobalAssertions` or the seam — confirm by tracing `finalizeBootstrap` → no assertion path.
- Verify the doc update in `materialized-views.md` is coherent with the surrounding Trust boundary and DML-replay-vs-seam sections.
- Verify the test correctly reuses existing helpers (`installSpies`, `makeSyncManager`, `cvEntry`, `toStream`, `collect`) without introducing new harness infrastructure.
- Verify the KV checkpoint check (`kv.get(encode('sc:snapshotId'))` → `undefined`) correctly proves the checkpoint was cleared on success (compare to the resumed-snapshot test which explicitly writes the key).
- Verify the `seamCalls === 0` assertion locks the test to the bootstrap path (not incremental), making it the deliberate inverse of `store-adapter-seam.spec.ts:321-359`.

## Known gaps

None. This is docs + one test; no engine or behavior change.
