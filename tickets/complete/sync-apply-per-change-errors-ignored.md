description: Sync consumers now honor ApplyToStoreResult.errors — a per-change storage failure aborts the apply (emit error + throw) with NO CRDT metadata committed, instead of being silently ignored while metadata committed for the failed change. Reviewed and completed.
files:
  - packages/quereus-sync/src/sync/sync-context.ts             # throwIfApplyErrors helper
  - packages/quereus-sync/src/sync/change-applicator.ts        # phase 2 captures result; throwIfApplyErrors before phase 3
  - packages/quereus-sync/src/sync/snapshot.ts                 # applySnapshot throws before clear/rewrite metadata
  - packages/quereus-sync/src/sync/snapshot-stream.ts          # flushDataToStore throws before footer emits 'synced'
  - packages/quereus-sync/src/sync/store-adapter.ts            # unchanged — collects per-change errors (read for context)
  - packages/quereus-sync/src/sync/protocol.ts                 # unchanged — ApplyToStoreResult.errors contract
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts # 3 tests + strengthened aggregation assertions (this pass)
  - docs/sync.md                                               # write-ordering invariant + 2 further stale refs fixed (this pass)
----

# Sync apply must not commit CRDT metadata for per-change storage failures

## Summary

`ApplyToStoreCallback` returns `ApplyToStoreResult { dataChangesApplied, schemaChangesApplied, errors }`.
The store adapter deliberately **continues applying other tables** when one fails, recording each
failed change in `result.errors` (it does not throw) so the maximal set of resolvable rows reaches
committed storage. Before this fix, all three consumers (`change-applicator`, `snapshot`,
`snapshot-stream`) **discarded the return value** and committed CRDT metadata for *all* resolved
changes — including the failed ones. Local HLC/column-version metadata then claimed the failed
change was applied, so delta sync (governed by a single `lastSyncHLC` watermark) never re-fetched
it → row data permanently missing on that replica.

**Fix:** new `throwIfApplyErrors(ctx, result)` helper in `sync-context.ts` aggregates any non-empty
`result.errors` into one `Error` (message lists `schema.table (type): <msg>` per failure; `cause` =
first error), emits `{ status: 'error' }`, and throws. All three consumers call it **after** the
store apply (phase 2) and **before** any CRDT metadata write (phase 3 / clear-rewrite / footer
`synced`). This makes a per-change failure behave **identically** to the pre-existing whole-batch
throw path: no metadata committed → the whole batch re-resolves and re-applies idempotently next
sync. Selective commit of the succeeded subset is intentionally not done (a single `lastSyncHLC`
watermark cannot express a per-change gap). The adapter and the `errors` contract are unchanged.

## Review findings

### Scope of the adversarial pass
Read the full implement diff (commit `5e1b8eb3`) with fresh eyes before the handoff summary: all 5
source files (`sync-context.ts`, `change-applicator.ts`, `snapshot.ts`, `snapshot-stream.ts`, plus
unchanged `store-adapter.ts`/`protocol.ts` for context), the test additions, and the docs change.
Verified the consumer set is complete (grep: exactly 3 call sites of `ctx.applyToStore`, all now
route through `throwIfApplyErrors` — no missed consumer). Ran typecheck (clean) and the full sync
suite (183 passing, exit 0; the `[Sync] Error handling …` lines are pre-existing fault-injection in
`sync-manager.spec.ts`, not failures). No lint run — `@quereus/sync` has no lint script (only
`packages/quereus` does).

### Correctness — checked, no defects found
- **Type safety**: `throwIfApplyErrors` reads `change.schema/table/type` — all present on both
  `DataChangeToApply` and `SchemaChangeToApply`, so the union access is sound. `result.errors[0]`
  is guarded by the `length === 0` early-return; `error.message`/`cause` are typed `Error`. ✓
- **Definite assignment**: `let result: ApplyToStoreResult` in `change-applicator` is assigned in
  `try`; the `catch` ends with `throw`, so TS control-flow proves `result` is assigned at the
  `throwIfApplyErrors` call. Typecheck confirms. ✓
- **No double error-emit**: the `change-applicator` catch (whole-batch throw) and
  `throwIfApplyErrors` (per-change) are mutually exclusive paths — no duplicate `status: 'error'`. ✓
- **Write-ordering placement**: in all three consumers the throw fires strictly before metadata
  commit (phase 3 / clear-rewrite / footer `synced`). Confirmed against current source. ✓
- **Adapter unification**: the adapter's two failure shapes — per-table collect (`result.errors`)
  and seam-call throw (`db.ingestExternalRowChanges` propagates) — now both abort with no metadata.
  The fix correctly closes only the previously-leaking per-change path. ✓
- **Test efficacy**: each new test is genuinely red without the fix — (1) `applyChanges` would not
  throw → `String(thrown)` mismatch; (2) `applySnapshot` would clear+rewrite → relays 1 not 0;
  (3) `applySnapshotStream` would emit `synced`. Verified by per-assertion reasoning against the
  unfixed control flow. The 3 tests pass individually and in the full suite. ✓

### Minor findings — fixed inline this pass
- **`docs/sync.md` line ~717**: the "Applying Remote Changes" example code block showed the *old*
  metadata-first order (`// 1. Update CRDT metadata first … 2. Apply to store`) — i.e. it
  illustrated the exact bug just fixed, contradicting the corrected invariant. Reordered to
  data-first with a pointer to the write-ordering invariant. The implement pass corrected only the
  status line (~154) and missed this.
- **`docs/sync.md` line ~1130**: the "Remaining Work" checklist still had `- [ ] Fix write order in
  applyChanges …` unchecked — that work just landed. Marked `[x]` and expanded to note the
  per-change `ApplyToStoreResult.errors` abort.
- **Test aggregation coverage**: `throwIfApplyErrors`'s aggregated message format and `cause` chain
  had no direct assertion (test 1 only checked the message *contains* `no_such_table`). Strengthened
  test 1 with `instanceOf(Error)`, message contains `apply-to-store failed for`, and
  `cause instanceOf Error`.

### Major findings — filed as new ticket
- **`snapshot-stream-resume-clears-completed-metadata`** (new `fix/` ticket): `applySnapshotStream`
  (receiver) unconditionally clears **all** CRDT metadata at the top, while `resumeSnapshotStream`
  (sender) **skips `completedTables`** and never re-emits them. A resumed transfer therefore wipes
  completed-table metadata and never rewrites it → potential data/metadata loss on resume. This is
  **pre-existing** (predates and is unrelated to this error-handling change) and was flagged in the
  implement handoff; filing it for tracking rather than fixing here. Not a regression of this fix.

### Documented gaps reviewed — no action needed (not regressions)
- **Narrow failure-mode coverage**: all 3 tests trigger `result.errors` via *table-not-found*, not
  an error originating inside `applyExternalRowChanges`. Acceptable: the **consumer** logic under
  test (`throwIfApplyErrors`) is identical regardless of where in the adapter the error originated —
  it only inspects `result.errors`. The distinction matters for the adapter, which is unchanged and
  separately covered by the existing "partial failure does not throw" / "seam-throw propagation"
  tests. No new test warranted for this fix.
- **>1000-row mid-stream metadata flush untested**: within a large table, column-version metadata is
  flushed (`BATCH_FLUSH_SIZE=1000`) *before* that table's rows reach the store at `table-end`, so a
  later data-flush failure can leave provisional metadata in the sync KV. Confirmed sound under
  **full** retry: `applySnapshotStream` clears all metadata at the top, `synced` is never emitted,
  and the checkpoint persists, so a full re-drive re-clears and rewrites. This fix strictly improves
  the prior behavior here (which emitted `synced` + committed metadata despite a failed data write).
  The only residual unsoundness is on the **resume** path — captured by the major ticket above.
- **Poison batch**: a change that always fails blocks its batch forever — an accepted, documented
  property shared with the pre-existing seam-throw path. Not a regression.

## Validation
- `yarn workspace @quereus/sync typecheck` → clean (exit 0), before and after the inline edits.
- `yarn workspace @quereus/sync test` → 183 passing (exit 0).
- 3 new per-change-error tests pass in isolation (`--grep "per-change apply errors"`).
