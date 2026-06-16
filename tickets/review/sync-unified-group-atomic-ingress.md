description: Review the unified sync-ingress admission core. A new `admission.ts` (`applyDataToStore` + `admitGroup`) now centralizes the docs/sync.md § Transactional Integrity write-ordering (data-first → metadata-second → abort-with-no-metadata) for the wire path and non-streaming snapshot; the streaming snapshot reuses the `applyDataToStore` seam only. The headline fix: snapshot/stream whole-batch throws now emit `status:'error'` (previously they propagated bare, skipping the emit the wire path produces).
prereq:
files:
  - packages/quereus-sync/src/sync/admission.ts                  # NEW — applyDataToStore + admitGroup + AdmissionGroup
  - packages/quereus-sync/src/sync/change-applicator.ts          # applyChanges → admitGroup; local maxHLCFromChangeSets
  - packages/quereus-sync/src/sync/snapshot.ts                   # applySnapshot → admitGroup
  - packages/quereus-sync/src/sync/snapshot-stream.ts            # flushDataToStore → applyDataToStore
  - packages/quereus-sync/src/sync/sync-context.ts               # throwIfApplyErrors / persistHLCState / toError (reused, unchanged)
  - docs/sync.md                                                 # § Transactional Integrity (new "Unified admission core" para + Current Status), § Schema Seed (one-sentence note)
  - packages/quereus-sync/test/sync/admission.spec.ts            # NEW — focused admitGroup/applyDataToStore ordering unit tests
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts   # NEW describe: whole-batch throw → status:'error' (snapshot + stream)
difficulty: medium
----

# Review: unify sync ingress data-apply seam behind one group-atomic admission core

## What was implemented

A new module `packages/quereus-sync/src/sync/admission.ts` exports two layered functions:

- **`applyDataToStore(ctx, dataChanges, schemaChanges, options)`** — the data-first
  seam shared by all three ingress paths. No-ops when there is no `applyToStore`
  callback or nothing to apply; otherwise runs `applyToStore`, emits a single
  `status:'error'` + rethrows on a whole-batch throw (catch), else aborts via
  `throwIfApplyErrors` on per-change `errors`. The two failure shapes are mutually
  exclusive, so `status:'error'` is emitted **at most once**.
- **`admitGroup(ctx, group)`** — full group-atomic admission: `applyDataToStore`
  → `group.commitMetadata()` → (if `watermarkHLC`) `hlcManager.receive` +
  `persistHLCState`. Aborts with no metadata + no watermark advance on any data
  failure.

### Per-path rewiring (behavior preserved except the documented fix)

- **Wire `applyChanges`** (`change-applicator.ts`): dropped the per-changeset
  `hlcManager.receive` in PHASE 1; replaced PHASE 2 + `throwIfApplyErrors` +
  PHASE 3 + trailing `persistHLCState` with one `admitGroup` call over the whole
  resolved batch (`applyOptions:{remote:true}`, `commitMetadata` = the old
  `commitChangeMetadata` + `recordMigration` loop, `watermarkHLC` =
  `maxHLCFromChangeSets(changes)` — a new local helper). Event emission +
  `ApplyResult` aggregation stay after `admitGroup`. Receiving the batch max once
  is equivalent to the dropped per-changeset receives (monotonic max-merge).
- **Non-streaming `applySnapshot`** (`snapshot.ts`): PHASE 2 + clear-sweep + PHASE 3
  wrapped in one `admitGroup` (`bootstrap:true`, `watermarkHLC = snapshot.hlc`);
  `bootstrapFinalize` + `status:'synced'` stay after. **Gains** the `status:'error'`
  emit on a whole-batch throw it previously lacked.
- **Streaming `applySnapshotStream`** (`snapshot-stream.ts`): only `flushDataToStore`
  changed — bare `applyToStore` + `throwIfApplyErrors` → one `applyDataToStore`
  call. Footer watermark + `bootstrapFinalize` + checkpoint logic untouched.
  **Gains** the `status:'error'` emit on a whole-batch flush throw.

`bootstrapFinalize` calls stay direct (they carry no data; the empty-guard would
wrongly skip them). The two finalize call sites are NOT routed through the seam.

## Validation performed (all green)

- `yarn workspace @quereus/sync run typecheck` → exit 0
- `yarn workspace @quereus/sync exec tsc -p tsconfig.test.json --noEmit` → exit 0
  (the test runner uses Node native type-stripping, which does NOT type-check —
  this command does; reviewers should re-run it after touching specs)
- `yarn workspace @quereus/sync test` → **247 passing**, exit 0
  - The `[Sync] Error handling transaction commit` console lines are from
    PRE-EXISTING tests (`sync-manager.spec.ts` ~1344/1376) that inject failing KV
    stores to exercise error logging — not failures.

## Tests added/extended

- `test/sync/admission.spec.ts` (NEW) — direct unit tests of the core:
  whole-batch throw aborts before `commitMetadata`/watermark (order =
  `['error-event']`); per-change errors abort with a single error emit and no
  receive; success orders `['commit','receive']`; omitted `watermarkHLC` →
  `['commit']`; empty unit / no-callback are no-ops.
- `test/sync/snapshot-bootstrap.spec.ts` (NEW describe
  "whole-batch throw surfaces status:error") — a stub `applyToStore` that throws
  outright (passing `bootstrapFinalize`/empty through). Asserts both
  `applySnapshot` and `applySnapshotStream` emit **exactly one** `status:'error'`,
  never reach `synced`, and commit no relayable metadata. This is the headline
  defect closed.

## What to scrutinize (reviewer focus — treat tests as a floor)

- **Single-emit guarantee under both failure shapes**: confirm no path can
  double-emit `status:'error'` (catch vs `throwIfApplyErrors` are exclusive). The
  admission.spec pins the core; verify no *end-to-end* path re-emits (e.g. an
  outer catch in a transport caller). Not exhaustively covered for the wire path.
- **Empty-batch watermark drop**: `applyChanges([])` no longer calls
  `persistHLCState` (was unconditional). Confirmed harmless (clock unchanged) and
  return shape unchanged, but I did NOT add an explicit `applyChanges([])` unit
  assertion — worth a glance / a test.
- **Streaming `flushDataToStore` now clears `pendingData/SchemaChanges`
  unconditionally** (previously only inside the `applyToStore && non-empty`
  guard). For a configured store this is identical; for a NULL `applyToStore` it
  now clears instead of accumulating (more correct, but a behavior delta in the
  no-store case — no test exercises a null store mid-stream).
- **`maxHLCFromChangeSets` duplication**: an identical helper already lives in
  `quereus-sync-client/src/sync-client.ts`. I added a local copy in
  `change-applicator.ts` rather than create a cross-package dependency
  (sync-client depends on sync, not vice-versa). Reviewer may prefer hoisting it
  to `clock/hlc.ts` — deferred as out-of-scope.
- **Watermark scope**: per-peer `lastSyncHLC` (`updatePeerSyncState`) deliberately
  stays OUT of the core — it is the transport caller's concern
  (`sync-client.ts handleChanges`). Confirm no path was accidentally moved.
- **All-or-nothing granularity**: the wire batch is admitted as ONE `admitGroup`
  unit, not per `ChangeSet` (the parent ticket forbids per-transaction partial
  commit). Confirm preserved.

## Known gaps / deferrals

- No new test for the wire-path empty-batch persistHLCState removal (argued
  harmless above).
- No test for the null-`applyToStore` streaming clear-behavior delta.
- `maxHLCFromChangeSets` left duplicated (cross-package hoist deferred).
