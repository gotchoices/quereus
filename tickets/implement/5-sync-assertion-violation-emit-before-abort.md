description: When one batch of incoming sync data both fails to save one change and breaks a local data rule on another, the app is never told the rule broke even though that data was saved. Fix it so the app always gets the warning.
files:
  - packages/quereus-sync/src/sync/admission.ts            # applyDataToStore: move the onAssertionViolation emit BEFORE throwIfApplyErrors; update the function doc comment
  - packages/quereus-sync/src/sync/sync-context.ts         # throwIfApplyErrors (unchanged; read for the abort contract)
  - packages/quereus-sync/src/sync/store-adapter.ts        # report-mode seam already commits the violating row + returns result.assertionViolations; clarify the "orthogonal" doc note (lines ~81-85)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts  # add the mixed error+violation regression test (reuse both existing describe blocks' scaffolding)
  - docs/sync.md                                           # § Transactional Integrity During Sync line ~396: note the mixed-batch emit-before-abort ordering
difficulty: medium
----

# Emit inbound assertion violations before the per-change-error abort gate

## Background

`applyDataToStore` (admission.ts) is the data-first half of the sync admission
invariant. Today it runs, in order:

1. `result = await ctx.applyToStore(...)` — the store adapter applies inbound rows to
   storage and makes ONE end-of-invocation seam call in **report mode**
   (`assertionFailureMode: 'report'`). A commit-time global-assertion violation is
   **collected** into `result.assertionViolations` and the seam transaction **commits**
   (the violating row's data + MV deltas + watch capture land durably). A per-change
   storage failure is collected into `result.errors` (the adapter keeps applying other
   tables; it does not throw).
2. `throwIfApplyErrors(ctx, result)` — if `result.errors` is non-empty, emit
   `status:'error'` and **throw** before any CRDT metadata is committed, so the whole
   batch re-resolves next sync.
3. **Success branch only** (reached only if step 2 did not throw): emit
   `onAssertionViolation` for each `result.assertionViolations` entry.

## The gap being closed

When a single apply batch carries **both** a per-change storage error (change/table A)
**and** an assertion violation tripped by a successfully-applied change (change/table B):

- B's data + derived effects commit durably in the report-mode seam transaction (step 1).
- `throwIfApplyErrors` throws at step 2 because of A — **before** the step-3 emit.
- The B violation event is dropped. No CRDT metadata commits, so the batch re-resolves.
- On retry, B re-applies as a value-identical upsert → suppressed → not in the seam batch
  → its base table is not in the changed-base set → `runGlobalAssertions` never
  re-evaluates the assertion → the violation is **never re-collected**. The host is
  **permanently never notified**, even though B's violating data is durably committed.

Net: data stays consistent (this is not an MV-divergence bug), but the host's
*notification* of a broken local invariant is silently and permanently lost.

## Decision (resolved in plan — implement exactly this)

**Move the `onAssertionViolation` emit to BEFORE `throwIfApplyErrors`.** Emit any
`result.assertionViolations` first, then run the per-change-error abort gate.

Why this is correct and sufficient (not the durable-pending-state alternative):

- Whenever `result.assertionViolations` is populated, the seam ran in report mode and
  **committed** — so the violating data is *already durably in storage*. The later
  `throwIfApplyErrors` throw blocks only the CRDT-metadata commit; it does **not** roll
  back the storage/seam writes. The violation is therefore a fact about committed data and
  must be surfaced regardless of whether this batch's metadata commits.
- The event arriving alongside a `status:'error'` abort is honest, not contradictory: two
  orthogonal facts — "B's data landed and broke an invariant" (violation) and "the batch
  could not fully admit because A failed and will retry" (error) — are both true.
- The retry's value-identical suppression — the very mechanism that *caused* the permanent
  loss — now correctly prevents **double**-notification: on retry B is suppressed, so no
  second violation event fires. This matches the existing "idempotent re-apply does not
  re-fire" guarantee.
- No new durable state. The "persist pending violations and re-emit after a later
  convergence" option is rejected: it adds storage the feature does not otherwise need to
  defer a notification about data that is *already* committed.

Emit ordering between the two events: emit the **violation first**, then let
`throwIfApplyErrors` emit `status:'error'` and throw. (Causally the data landed first,
then we discovered the batch can't fully admit.) The pure-success path (no `errors`) is
behaviorally identical to today.

### Invariant preserved

`status:'error'` is still emitted at most once: a whole-batch throw (the `catch` in
`applyDataToStore`) and a per-change `errors` abort remain mutually exclusive, and the new
violation emit does not touch sync-state. The data-first → metadata-second →
abort-with-no-metadata write ordering is unchanged — only the relative order of the
*violation notification* vs. the *abort* moves.

## Edge cases & interactions

- **Mixed batch (the target case)**: A errors per-change, B applies + trips an assertion.
  Expect: violation emitted once, then `status:'error'`, then throw; B's data + MV
  committed durably; no CRDT metadata relayed; retry (after A is resolvable) does **not**
  re-fire the violation (B value-identical-suppressed) and commits metadata for both.
- **Pure success, with violation (existing test)**: no `errors` → identical to today
  (violation emitted, no throw, metadata commits). The reorder must not regress this.
- **Pure per-change error, no violation (existing test)**: `assertionViolations`
  undefined → nothing new emitted; abort path unchanged.
- **Whole-batch throw**: `applyToStore` itself throws → `result` never returned → no
  `assertionViolations` to emit; the `catch` emits `status:'error'` and rethrows.
  Unchanged.
- **Empty seam batch**: every data change errored (seamBatch empty → no seam call →
  `assertionViolations` undefined). Nothing to emit; abort fires on `errors`. Unchanged.
- **Bootstrap flush / snapshot**: seam skipped → no `assertionViolations`. The existing
  "bootstrap fires NO assertion event" test must stay green.
- **Multiple violations in one batch**: report mode collects ALL across the batch; emit
  one event per entry (existing loop), now before the abort.
- **No metadata committed but data durable**: confirm the test asserts B's row is present
  in the base table after the first (throwing) attempt — this is the crux that justifies
  emitting before the abort.

## Key test (add to `store-adapter-seam.spec.ts`)

Add a case combining the two existing describe blocks' scaffolding — the
`per-change apply errors abort with no metadata committed` block (oracle that reports
`no_such_table` as in-basis so the adapter's defensive "Table not found" throw fires as a
per-change error) and the `inbound assertion violation: detect-and-notify` block
(`non_negative` assertion on `t`, covering `mv`, `onAssertionViolation` capture).

One change set with two changes:
  - `t` pk `['x']`, `v = -5` (resolves, trips `non_negative`)
  - `no_such_table` pk `['k']` (per-change storage failure)

Assert on the FIRST `applyChanges`:
  - it **throws**, and the error message contains `no_such_table` /
    `apply-to-store failed for`;
  - `violations` has length 1, `assertion === 'non_negative'`, `samples.length > 0`
    (the event fired BEFORE the throw — the regression);
  - `t`'s row landed durably (`select v from t` → `-5`) and `mv` converged (`-5`),
    proving the report-mode seam committed despite the abort;
  - nothing relays (`getChangesSince(generateSiteId())` empty — no CRDT metadata).

Then create `no_such_table`, re-apply the SAME change set:
  - both changes apply, metadata commits, both relay (length 2);
  - `violations` stays length 1 — no double-fire (B value-identical-suppressed → empty
    seam batch → no re-evaluation).

## Docs

- `admission.ts` — update the `applyDataToStore` doc comment: the violation emit now
  precedes the abort gate; state that a reported violation reflects durably-committed data
  (report-mode seam commit) and so is surfaced even when an unrelated per-change `errors`
  abort follows; note the retry's value-identical suppression prevents double-notify.
- `store-adapter.ts` (~lines 81-85) — the "A genuine per-change STORAGE failure ... is
  orthogonal" note: clarify that orthogonal no longer means the violation is dropped when
  both occur in one batch.
- `docs/sync.md` § Transactional Integrity During Sync (line ~396, the bullet that says a
  global-assertion violation "does not block the metadata commit") — add that in the mixed
  case (per-change `errors` + a reported violation in the same batch) the violation is
  emitted **before** the abort, because the violating data already committed in report
  mode; the abort still blocks the metadata commit and the batch still re-resolves.

## TODO

- In `applyDataToStore` (admission.ts), move the `if (result.assertionViolations) { ...
  emitAssertionViolation ... }` block to **before** the `throwIfApplyErrors(ctx, result)`
  call. Update the surrounding doc comment per § Docs above.
- Update the `store-adapter.ts` orthogonality note (~lines 81-85).
- Update `docs/sync.md` line ~396 per § Docs.
- Add the mixed error+violation regression test to `store-adapter-seam.spec.ts` per
  § Key test (reuse the in-basis-`no_such_table` oracle and the `non_negative` assertion
  scaffolding).
- Validate: `yarn workspace @quereus/quereus-sync test 2>&1 | tee /tmp/sync-test.log;
  tail -n 60 /tmp/sync-test.log` (stream output — do not silently redirect). Confirm the
  new test passes and the existing detect-and-notify / per-change-error / bootstrap tests
  stay green.
- Lint the touched package(s) if a lint script applies.
