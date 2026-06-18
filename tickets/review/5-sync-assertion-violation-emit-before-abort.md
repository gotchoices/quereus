description: A sync batch that both failed to save one change and broke a local data rule on another now always warns the app about the broken rule, instead of silently swallowing it.
files:
  - packages/quereus-sync/src/sync/admission.ts                  # applyDataToStore: violation emit moved BEFORE throwIfApplyErrors; doc comment rewritten
  - packages/quereus-sync/src/sync/store-adapter.ts              # orthogonality note (~lines 81-91) clarified
  - packages/quereus-sync/src/sync/sync-context.ts              # throwIfApplyErrors (read-only; unchanged abort contract)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts   # new mixed error+violation regression test in the per-change-abort block
  - docs/sync.md                                                 # § Transactional Integrity During Sync: mixed-batch emit-before-abort note
difficulty: medium
----

# Review: emit inbound assertion violations before the per-change-error abort gate

## What changed (one-paragraph)

`applyDataToStore` (admission.ts) used to emit `onAssertionViolation` events on a
**success-only** branch *after* `throwIfApplyErrors`. When a single apply batch carried
**both** a per-change storage error (table A) **and** a commit-time global-assertion
violation tripped by a successfully-applied change (table B), the abort threw before the
emit ran, so B's violation event was dropped. Because B's report-mode seam had already
**committed** durably, the retry re-applied B as a value-identical upsert → suppressed →
empty seam batch → assertion never re-evaluated → host **permanently never notified**.
The fix moves the violation-emit block to run **before** `throwIfApplyErrors`. No new
durable state; the only behavioral delta is the relative order of the *violation
notification* vs. the *abort* in the mixed case.

## Why this is correct (the load-bearing claims to scrutinize)

- **A reported violation ⇒ committed data.** `result.assertionViolations` is only
  populated when the adapter ran the seam in `assertionFailureMode: 'report'`, which
  **commits** the violating row + its MV deltas + watch capture. The later abort throw
  blocks only the *CRDT-metadata* commit; it does **not** roll back the storage/seam
  writes. So surfacing the violation alongside a `status:'error'` abort is honest, not
  contradictory — two orthogonal facts ("B's data landed and broke an invariant" and "the
  batch can't fully admit because A failed and will retry") are both true.
- **No double-notify on retry.** The same value-identical suppression that *caused* the
  permanent loss now *prevents* a second event: on retry B is suppressed → empty seam
  batch → no re-evaluation → no second violation. Matches the existing idempotent-re-apply
  guarantee.
- **`status:'error'` still emitted at most once.** The whole-batch `catch` and the
  per-change `throwIfApplyErrors` remain mutually exclusive; the new violation emit does
  **not** touch sync-state, so it cannot perturb that invariant.

## Use cases / validation done

- **New regression test** (`store-adapter-seam.spec.ts`, in the
  `per-change apply errors abort with no metadata committed` block):
  `a reported assertion violation is emitted BEFORE the co-occurring per-change abort throws`.
  One change set, two changes:
    - `t` pk `['x']`, `v = -5` — resolves, trips a `non_negative` assertion.
    - `no_such_table` pk `['k']` — per-change storage failure (oracle reports it in-basis,
      so the adapter's defensive "Table not found" throw fires as a per-change error).
  First `applyChanges` asserts: it **throws** (`no_such_table` / `apply-to-store failed
  for`); `violations` length 1 with `assertion === 'non_negative'` and `samples.length > 0`
  (the event fired before the throw — the regression); `t`'s row landed durably (`select v
  from t` → `-5`) and `mv` converged (`-5`); nothing relays (`getChangesSince` empty).
  Then `no_such_table` is created and the SAME change set re-applied: both apply, metadata
  commits, both relay (length 2), and `violations` stays length 1 (no double-fire).
- **Full sync suite**: `yarn workspace @quereus/sync test` → **383 passing, 0 failing**.
  The existing detect-and-notify, per-change-error-abort, and bootstrap-fires-no-event
  tests all stay green (the reorder does not regress the pure-success or pure-error paths).
- **Typecheck**: `tsc --noEmit` (src) clean; `tsc -p tsconfig.test.json --noEmit` (tests)
  clean. No lint script exists for the `@quereus/sync` package (only `packages/quereus`
  has one).

## Reviewer focus / known gaps

- **The test is a behavioral floor, not a proof.** It exercises the `applyChanges` (wire)
  modality only. The reorder lives in `applyDataToStore`, which is *also* reused by the
  non-streaming snapshot (`admitGroup` via `snapshot.ts`) and each streaming flush
  (`snapshot-stream.ts`). The mixed error+violation shape is not reproduced for those two
  paths. Worth a reviewer's judgment whether the snapshot paths can realistically carry a
  per-change error **and** a reported violation in one flush (bootstrap flushes skip the
  seam entirely, so `assertionViolations` is undefined there — see the existing "bootstrap
  fires NO assertion event" test). I judged the shared-seam coverage sufficient but did
  not add snapshot-path variants.
- **Ordering of the two events.** The violation is emitted first, then `status:'error'`.
  This is intentional (causally the data landed, then we discovered the batch can't fully
  admit) but the test does not assert the *relative ordering* of the two emissions against
  each other — only that the violation fired at all before the throw. A reviewer wanting a
  stricter guarantee could assert interleaving on a shared event log.
- **Multiple violations in one batch**: report mode collects all entries and the existing
  loop emits one event each — now before the abort. Not separately tested here (the
  single-violation case covers the reorder); the loop itself is unchanged.
- **Docs touched**: `admission.ts` doc comment (rewritten), `store-adapter.ts`
  orthogonality note (~lines 81-91), and `docs/sync.md` § Transactional Integrity During
  Sync (new mixed-case paragraph after the per-change-failure bullet). Verify the prose
  matches the code ordering.
