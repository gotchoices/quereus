description: A sync batch that both failed to save one change and broke a local data rule on another now always warns the app about the broken rule, instead of silently swallowing it.
files:
  - packages/quereus-sync/src/sync/admission.ts                  # applyDataToStore: violation emit BEFORE throwIfApplyErrors
  - packages/quereus-sync/src/sync/store-adapter.ts              # orthogonality note (~lines 81-91)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts   # mixed error+violation regression test
  - docs/sync.md                                                 # § Transactional Integrity During Sync: mixed-batch note (precision fix in review)
difficulty: medium
----

# Emit inbound assertion violations before the per-change-error abort gate

## What shipped

`applyDataToStore` (admission.ts) now emits `onAssertionViolation` events **before**
`throwIfApplyErrors`. Previously the emit lived on a success-only branch *after* the abort
gate, so a single apply batch carrying **both** a per-change storage error (table A) **and**
a commit-time global-assertion violation tripped by a successfully-applied change (table B)
would throw past the emit and drop B's violation event. Because B's report-mode seam had
already **committed** the violating row durably, the retry re-applied B as a value-identical
upsert → suppressed → B's table absent from the seam batch → assertion never re-evaluated →
host **permanently never notified**. Moving the emit ahead of the abort closes that gap. No
new durable state; the only behavioral delta is the relative order of the violation
notification vs. the abort throw in the mixed case.

## Review findings

### Scope reviewed

- **Implement diff** (`be310711`): admission.ts reorder + doc comment rewrite,
  store-adapter.ts orthogonality note, docs/sync.md mixed-case paragraph, new regression
  test. Read with fresh eyes before the handoff.
- **Load-bearing correctness claims**, traced to source:
  - *Reported violation ⇒ committed data.* Verified: the adapter's single seam call runs in
    `assertionFailureMode: 'report'` (store-adapter.ts:246-254), which collects-and-commits;
    the storage writes (`applyExternalRowChanges`, step 3) and the seam's MV/capture deltas
    land inside `applyToStore` **before** it returns. The later `throwIfApplyErrors` throw
    (admission.ts:94) fires *after* `applyToStore` returns and blocks only the CRDT-metadata
    commit — it cannot roll back the already-committed storage writes. The "orthogonal"
    framing is honest.
  - *No double-notify on retry.* Verified against `database-assertions.ts` —
    "Assertions are evaluated only when the tables they reference have been modified." On
    retry B is a value-identical upsert → suppressed → `t` absent from the changed-tables set
    → `non_negative` not re-evaluated. Holds for dependency-bearing assertions (the normal
    case).
  - *`status:'error'` emitted at most once.* Verified: the whole-batch `catch`
    (admission.ts:69-74) rethrows before the violation block, and the per-change
    `throwIfApplyErrors` is mutually exclusive with it; the new violation emit touches no
    sync-state, so it cannot perturb that invariant.
- **Other call sites of `applyDataToStore`** (`admitGroup` for wire + non-streaming
  snapshot; `applySnapshotStream` per-flush): the reorder is in shared code and only changes
  mixed-case behavior, so pure-success and pure-error paths are unaffected on every path.
- **Build/test gates**: `yarn workspace @quereus/sync test` → **383 passing, 0 failing**
  (the verbose `[Sync] Error …` lines are intentional error-path tests). `tsc --noEmit`
  (src) clean; `tsc -p tsconfig.test.json --noEmit` (tests) clean.

### Found and fixed (minor, inline)

- **docs/sync.md prose imprecision.** The mixed-case paragraph claimed the retry yields an
  "empty seam batch → assertion not re-evaluated." But in the verified scenario (and the
  test) change A *succeeds* on retry and **is** in the seam batch — it is not empty. The real
  reason `non_negative` does not re-fire is that B (its only dependency) is suppressed, so
  B's table is absent from the changed-tables set, and assertions fire only when their
  referenced tables changed. Rewrote that parenthetical to attribute the no-double-fire to
  B's suppression + dependency-gating. (The admission.ts comment already attributed it
  correctly to "B is suppressed", so only the doc needed the fix.)

### Found, judged not actionable (no ticket)

- **No-dependency assertions (e.g. `check (1=0)`) can double-fire on retry in a mixed
  batch.** A no-dependency assertion is evaluated whenever the batch changed *anything*
  (`database-assertions.ts`; cf. the existing "report mode collects a no-dependency
  assertion" test). So in a mixed batch, once A succeeds on retry the batch is non-empty and
  the no-dependency assertion re-evaluates → a second `onAssertionViolation`. This is
  **benign**: the data is still violating, so the duplicate is an accurate (if redundant)
  notification — not the permanent-*loss* bug this ticket fixes — and a no-dependency
  assertion is a degenerate construct. Not worth guarding; documented here for the record.
- **Snapshot-path mixed-case coverage gap** (implementer-flagged). The reorder lives in the
  shared `applyDataToStore`; the test exercises the wire (`applyChanges`) modality only. The
  non-streaming snapshot and per-flush streaming paths reuse the same function, so the
  reorder logic is covered once where it lives; snapshot-path variants would test plumbing,
  not the reorder. Bootstrap flushes skip the seam entirely (`assertionViolations` undefined
  there), so they cannot carry this shape at all. Acceptable; no new test.
- **Relative ordering of the two emissions** (violation vs. `status:'error'`) is not asserted
  against a shared event log — only that the violation fired before the throw. The causal
  intent (data landed, then batch can't fully admit) is satisfied; a stricter interleaving
  assertion is optional polish, not a correctness gap.

### Not changed

- **packages/quereus-sync/README.md** and **docs/materialized-views.md**: re-read; both
  describe detect-and-notify and the per-change-storage abort accurately at their altitude
  and make no stale claim about the mixed case. The detailed mixed-case note lives in
  docs/sync.md by design. Left as-is.

## Outcome

Implementation is correct and well-reasoned; the regression test is a solid floor. One minor
doc-precision fix applied inline. No major findings → no follow-up tickets.
