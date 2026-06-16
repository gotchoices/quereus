description: Collapse the sync ingress data-apply seam onto one group-atomic admission core (`admitGroup` + `applyDataToStore`) so wire `applyChanges`, non-streaming `applySnapshot`, and each `applySnapshotStream` flush share the one data-first → metadata-second → abort-with-no-metadata sequencing. Closes the gap where snapshot/stream whole-batch throws skip the `status:'error'` emit, and makes the seed path's reuse explicit. Streaming stays on its checkpoint-based model (the documented escape hatch) but adopts the shared data-apply seam for consistent error emission.
prereq:
files:
  - packages/quereus-sync/src/sync/admission.ts              # NEW — admitGroup + applyDataToStore core
  - packages/quereus-sync/src/sync/change-applicator.ts      # wire applyChanges → admitGroup
  - packages/quereus-sync/src/sync/snapshot.ts               # applySnapshot → admitGroup (bootstrap unit)
  - packages/quereus-sync/src/sync/snapshot-stream.ts        # flushDataToStore → applyDataToStore
  - packages/quereus-sync/src/sync/sync-context.ts           # throwIfApplyErrors, persistHLCState, toError (reused)
  - packages/quereus-sync/src/sync/protocol.ts               # ApplyToStoreOptions/Result, DataChangeToApply (types only)
  - docs/sync.md                                             # § Transactional Integrity During Sync, § Schema Seed
  - packages/quereus-sync/test/sync/snapshot-bootstrap.spec.ts   # add: snapshot whole-batch throw emits status:'error'
  - packages/quereus-sync/test/sync/sync-manager.spec.ts         # existing wire-apply invariants stay green
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts   # seam abort/idempotence invariants stay green
difficulty: medium
----

# Unify the sync ingress data-apply seam behind one group-atomic admission core

## Motivation

Three ingress paths each open-code the same write-order invariant from
`docs/sync.md` § Transactional Integrity During Sync (data first → metadata
second; abort with no metadata on any whole-batch throw **or** per-change
`ApplyToStoreResult.errors`; idempotent re-apply on retry):

- `change-applicator.ts` `applyChanges` — the wire path. Already wraps the
  `applyToStore` call in a `try/catch` that emits `status:'error'` before
  rethrowing, then calls `throwIfApplyErrors`, then commits metadata.
- `snapshot.ts` `applySnapshot` and `snapshot-stream.ts` `applySnapshotStream`
  — bootstrap / recovery. These call `applyToStore` **bare**: they get
  `throwIfApplyErrors` for per-change errors, but a **whole-batch throw**
  (e.g. a commit-time global-assertion failure) propagates **without** the
  `status:'error'` emit the wire path produces. That inconsistency is the
  concrete defect this consolidation closes.
- The **schema-seed-as-sync-peer** pattern (`docs/sync.md` § Schema Seed) is a
  fourth caller, but it already feeds through `applyChanges`, so it inherits the
  wire path's admission for free. No seed-specific code changes — only a doc
  note making the reuse explicit.

The four production data-applying `applyToStore` call sites are exactly these
three paths (wire `change-applicator.ts:116`, snapshot `snapshot.ts:165`,
stream `snapshot-stream.ts:313`). The two `bootstrapFinalize` calls
(`snapshot.ts:243`, `snapshot-stream.ts:503`) carry no data/schema — they are
the MV-convergence step, **not** data admission, and stay outside the seam.

## Design — the admission core

A new module `packages/quereus-sync/src/sync/admission.ts` exports two
functions layered so the genuinely-shared invariant-bearing seam is reused by
all three paths, while the strategy that legitimately differs (merge vs.
wholesale-replace metadata commit) stays in each caller.

### `applyDataToStore` — the data-first seam (shared by all three)

```ts
/**
 * Data-first half of the admission invariant: apply this unit's data+schema to
 * the store, emit status:'error' and rethrow on a whole-batch throw, then abort
 * (throw) on any per-change ApplyToStoreResult.errors — BEFORE the caller commits
 * any CRDT metadata. No-op when there is no applyToStore callback or nothing to
 * apply. Centralizes docs/sync.md § Transactional Integrity write ordering for
 * every ingress modality.
 */
async function applyDataToStore(
  ctx: SyncContext,
  dataChanges: DataChangeToApply[],
  schemaChanges: SchemaChangeToApply[],
  options: ApplyToStoreOptions,
): Promise<void> {
  if (!ctx.applyToStore || (dataChanges.length === 0 && schemaChanges.length === 0)) return;
  let result: ApplyToStoreResult;
  try {
    result = await ctx.applyToStore(dataChanges, schemaChanges, options);
  } catch (error) {
    ctx.syncEvents.emitSyncStateChange({ status: 'error', error: toError(error) });
    throw error;
  }
  throwIfApplyErrors(ctx, result);   // per-change errors → throw before metadata
}
```

### `admitGroup` — full group-atomic admission (wire + non-streaming snapshot)

```ts
interface AdmissionGroup {
  readonly dataChanges: DataChangeToApply[];
  readonly schemaChanges: SchemaChangeToApply[];
  readonly applyOptions: ApplyToStoreOptions;
  /** Commit this unit's CRDT metadata. Runs ONLY after the data write landed. */
  readonly commitMetadata: () => Promise<void>;
  /**
   * Local HLC clock watermark to merge in on full-unit success. The per-PEER
   * lastSyncHLC is the transport caller's concern (see § Watermark scope) and is
   * deliberately NOT advanced here.
   */
  readonly watermarkHLC?: HLC;
}

async function admitGroup(ctx: SyncContext, group: AdmissionGroup): Promise<void> {
  await applyDataToStore(ctx, group.dataChanges, group.schemaChanges, group.applyOptions);
  await group.commitMetadata();                    // metadata SECOND
  if (group.watermarkHLC) {
    ctx.hlcManager.receive(group.watermarkHLC);    // monotonic merge, idempotent
    await persistHLCState(ctx);
  }
}
```

`admitGroup` is the realization of the ticket's "apply a transaction group
atomically, advance the watermark idempotently." A "group" here is **one
admission unit**, not necessarily one source transaction — see § All-or-nothing
granularity, which the ticket requires we preserve.

### Per-path rewiring

- **Wire `applyChanges`** (`change-applicator.ts`): keep PHASE 1 resolution
  exactly as-is **except** drop the per-changeset `ctx.hlcManager.receive(changeSet.hlc)`
  on line 64. Replace PHASE 2 + `throwIfApplyErrors` + PHASE 3 + trailing
  `persistHLCState` with a single `admitGroup` call:
  - `dataChanges`/`schemaChanges` = the accumulated `dataChangesToApply` /
    `schemaChangesToApply` (whole batch — see § All-or-nothing granularity).
  - `applyOptions` = `{ remote: true }`.
  - `commitMetadata` = the existing PHASE 3 body: `commitChangeMetadata(ctx,
    resolvedDataChanges)` followed by the `recordMigration` loop over
    `pendingSchemaMigrations`.
  - `watermarkHLC` = `maxHLCFromChangeSets(changes)` (max over the batch).
    Receiving the max once is equivalent to receiving each changeset's HLC
    (`receive` is a monotonic max-merge), so the dropped per-changeset receives
    are subsumed.
  - The remote-change event emission and `ApplyResult` aggregation stay after
    `admitGroup` returns, unchanged.

- **Non-streaming `applySnapshot`** (`snapshot.ts`): the snapshot is one
  wholesale admission unit. PHASE 1 (build `dataChangesToApply` /
  `schemaChangesToApply`) unchanged. Wrap PHASE 2 + clear + PHASE 3 in one
  `admitGroup`:
  - `applyOptions` = `{ remote: true, bootstrap: true }` (keeps the bootstrap
    fast-path / seam skip).
  - `commitMetadata` = the existing clear-then-write body: the
    `clearBatch` delete sweep, the `applyBatch` column-version/change-log
    rewrite, and the `recordMigration` loop.
  - `watermarkHLC` = `snapshot.hlc`.
  The `bootstrapFinalize` call and the `status:'synced'` emit stay **after**
  `admitGroup`, unchanged. This path now gains the `status:'error'` emit on a
  whole-batch throw it currently lacks.

- **Streaming `applySnapshotStream`** (`snapshot-stream.ts`): does **not** use
  `admitGroup` — it has a different consistency model (interleaved
  metadata/data flushes + checkpoint-based resume; not strict data-first per
  row, by design for a wholesale load). Only swap the bare `applyToStore` +
  `throwIfApplyErrors` inside `flushDataToStore` for a single
  `applyDataToStore(ctx, pendingDataChanges, pendingSchemaChanges, { remote:
  true, bootstrap: true })` call. The footer's `hlcManager.receive` +
  `persistHLCState` and the `bootstrapFinalize` call stay as-is. Net effect: the
  stream gains the consistent `status:'error'` emit on a whole-batch flush throw.

### Watermark scope (resolves a naming ambiguity in the parent ticket)

The parent ticket says "advance `lastSyncHLC`." There are **two** distinct
watermarks; the core touches only one:

- **Local HLC clock** (`hlcManager.receive` + `persistHLCState`) — advanced
  inside `admitGroup` on full-unit success. This is what all three paths already
  do internally.
- **Per-peer `lastSyncHLC`** (`updatePeerSyncState`) — advanced by the
  **transport caller**, not the ingress core. `sync-client.ts` `handleChanges`
  calls `updatePeerSyncState(serverSiteId, maxHLC)` **after** `applyChanges`
  resolves; on an admission throw that line never runs, so the peer watermark
  stays at the prior boundary and the whole unit re-resolves next sync. This
  stays outside the core deliberately — it differs per modality (delta vs.
  snapshot bootstrap) and per transport.

Do **not** pull `updatePeerSyncState` into the admission core.

### All-or-nothing granularity (preserve — do NOT change to per-ChangeSet)

The wire path today treats the entire `ChangeSet[]` as **one** all-or-nothing
admission unit (resolve all → apply all → commit all metadata). The parent
ticket explicitly requires preserving this: the single per-peer `lastSyncHLC`
watermark cannot express "all but the failed change," so selective/partial
commit is inexpressible and intentionally not done. `admitGroup` is therefore
called **once** for the whole wire batch — not once per `ChangeSet`. Do not
introduce per-transaction partial commits in this ticket; that would be a
behavior change the ticket forbids.

## Edge cases & interactions

- **Whole-batch throw, wire** — `applyToStore` throws; `applyDataToStore` emits
  `status:'error'` once and rethrows; `commitMetadata` never runs; peer
  watermark not advanced (client's `updatePeerSyncState` unreached). Re-resolves
  next sync. (Existing behavior — must stay identical.)
- **Whole-batch throw, snapshot / stream** — previously propagated **without**
  the `status:'error'` emit; now emits exactly once via `applyDataToStore`.
  Add/extend a test asserting a single `status:'error'` event on a snapshot
  whole-batch throw (e.g. stub `applyToStore` to throw).
- **Per-change `errors` (no throw)** — `applyDataToStore` skips the `catch`,
  reaches `throwIfApplyErrors`, which emits `status:'error'` once and throws.
  No double-emit on either failure shape (catch and `throwIfApplyErrors` are
  mutually exclusive). Verify no path emits `status:'error'` twice.
- **Empty unit** — `applyChanges([])` / an empty snapshot: `applyDataToStore`
  early-returns (no callback work); `commitMetadata` is a no-op;
  `watermarkHLC` is `undefined` so no clock persist. The wire path's prior
  unconditional trailing `persistHLCState` on an empty batch is dropped — a
  harmless no-op write removal (the clock is unchanged). Confirm
  `applyChanges([])` still returns `{ applied:0, skipped:0, conflicts:0,
  transactions:0 }`.
- **`receive` timing move (wire)** — `receive` moves from pre-resolution
  (PHASE 1, per changeset) to post-commit (`admitGroup`, max once). Resolution
  reads stored versions via `compareHLC`, never the live clock, so resolution
  outcomes are unaffected. On a mid-batch throw the clock now does **not**
  advance for the failing batch (more correct — it catches up on retry). The
  remote-change event's `appliedAt = hlcManager.now()` is emitted **after**
  `admitGroup` returns, so it still reflects the merged clock.
- **Bootstrap fast-path preserved** — `applyOptions.bootstrap` must still flow
  through `admitGroup`/`applyDataToStore` to the adapter unchanged for both
  snapshot paths; the seam-skip + `bootstrapFinalize` convergence must be
  byte-for-byte the same. `bootstrapFinalize` calls stay direct (they carry no
  data, so `applyDataToStore`'s empty-guard would wrongly skip them).
- **Idempotent replay** — after any abort, re-resolution must converge:
  value-identical upserts suppressed by the adapter; equal-HLC column changes
  resolve to `skipped`. No metadata committed on abort means no watermark drift.
- **Echo / mixed-origin** — unchanged: `resolveChange` still skips own-site
  facts; the core does not touch resolution.
- **Streaming partial-failure** — a `flushDataToStore` throw still aborts
  mid-stream before the footer clears the checkpoint, so the checkpoint survives
  and the transfer resumes; `clearExistingMetadata`'s `preserveTables` logic is
  untouched.
- **No new `applyToStore` callers** — confirm grep shows exactly the four
  data sites + two finalize sites after the change; the core must not introduce
  a fifth invocation shape.

## Tests

- **Existing must stay green** (no behavior change on the happy paths):
  `sync-manager.spec.ts`, `sync-protocol-e2e.spec.ts`,
  `echo-loop-quiescence.spec.ts`, `snapshot-bootstrap.spec.ts`,
  `store-adapter-seam.spec.ts`, `conflict-resolvers.spec.ts`,
  and `quereus-sync-client/test/sync-client.spec.ts`.
- **New / extended**:
  - Snapshot whole-batch throw emits exactly one `status:'error'` event and
    leaves CRDT metadata uncommitted (assert no column versions / no
    `status:'synced'` written). Mirror the wire-path assertion that already
    exists for `applyChanges`.
  - Optional: a focused unit test of `admitGroup` ordering — assert
    `commitMetadata` is not called when `applyDataToStore` throws, and that
    `persistHLCState` runs only after `commitMetadata` on success (spy ordering).

## Docs

- `docs/sync.md` § Transactional Integrity During Sync — note the unified
  admission core (`admitGroup` + `applyDataToStore`, `admission.ts`) now
  centralizes data-first/metadata-second/abort-with-no-metadata for wire +
  non-streaming snapshot, and that streaming reuses the `applyDataToStore` seam
  for consistent error emission while keeping its checkpoint-based model.
  Update the "Current Status" bullet accordingly.
- `docs/sync.md` § Schema Seed — one sentence that the seed rides the wire
  `applyChanges` admission core (the "fourth caller" the parent ticket names),
  so it inherits the same write-ordering guarantees with no seed-specific code.
- Keep edits surgical; do not restate the whole invariant — link to the
  existing prose.

## TODO

- Add `packages/quereus-sync/src/sync/admission.ts` exporting `applyDataToStore`
  and `admitGroup` (+ the `AdmissionGroup` interface), importing
  `throwIfApplyErrors` / `persistHLCState` / `toError` from `sync-context.ts`.
- Rewire `change-applicator.ts` `applyChanges`: drop the per-changeset
  `receive`; replace PHASE 2/3 + trailing `persistHLCState` with one
  `admitGroup` call (whole batch, `watermarkHLC = maxHLCFromChangeSets`); keep
  event emission + `ApplyResult` aggregation after it. (Add a local
  `maxHLCFromChangeSets` helper or import the existing one.)
- Rewire `snapshot.ts` `applySnapshot`: wrap PHASE 2 + clear + PHASE 3 in one
  `admitGroup` (`bootstrap:true`, `watermarkHLC = snapshot.hlc`); leave
  `bootstrapFinalize` + `status:'synced'` after it.
- Rewire `snapshot-stream.ts` `flushDataToStore` to call `applyDataToStore`;
  leave footer watermark + `bootstrapFinalize` untouched.
- Add/extend the snapshot whole-batch-throw `status:'error'` test; optionally a
  `admitGroup` ordering unit test.
- Update the two `docs/sync.md` sections.
- Validate, streaming output (the sync package has no lint script — use
  `typecheck` + `test`):
  `yarn workspace @quereus/sync run typecheck` then
  `yarn workspace @quereus/sync test 2>&1 | tee /tmp/sync-test.log; tail -n 80 /tmp/sync-test.log`.
  Verify the wire/snapshot/stream specs are green before handoff.
