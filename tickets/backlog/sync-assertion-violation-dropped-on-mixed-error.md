description: When a single batch of incoming sync data both fails to store one change AND trips a local integrity rule on another, the application is silently never told about the broken rule, even though that data did land.
files:
  - packages/quereus-sync/src/sync/admission.ts                # applyDataToStore: throwIfApplyErrors gate runs BEFORE the onAssertionViolation emit
  - packages/quereus-sync/src/sync/store-adapter.ts            # report-mode seam commits regardless of result.errors
  - packages/quereus-sync/src/core/database-assertions.ts      # runGlobalAssertions only evaluates assertions whose changed base tables are in this commit's dirty set
difficulty: medium
----

# Inbound assertion violations are dropped when the same apply batch also has a per-change storage error

## Background

Ticket `sync-seam-assertion-violation-event` made inbound commit-time global-assertion
violations *detect-and-notify*: the incremental seam runs in report mode
(`assertionFailureMode: 'report'`), so a violating inbound merge **commits** (data + MV
deltas + watch capture land on the first apply) and the host is notified via
`onAssertionViolation`. Emission happens on the **success** branch of
`applyDataToStore`, *after* the `throwIfApplyErrors` abort gate.

A separate, orthogonal concern (`sync-apply-per-change-errors-ignored`) makes the store
adapter collect per-change storage failures in `ApplyToStoreResult.errors` (it keeps
applying other tables) and the consumer treat any non-empty `errors` like a whole-batch
throw: emit `status:'error'`, throw, commit **no** CRDT metadata, re-resolve the whole
batch next sync.

## The gap

These two interact badly when **one apply batch carries both** — a per-change storage
error on change/table A **and** an assertion violation triggered by the
successfully-applied change/table B:

1. `applyToStore` applies B to storage, runs the seam over B in report mode. The seam's
   implicit transaction **commits** — B's data, MV deltas, and watch capture land
   durably — and returns the B violation in `result.assertionViolations`. A's failure is
   collected in `result.errors`.
2. Back in `applyDataToStore`, `throwIfApplyErrors` sees non-empty `errors` and **throws
   before** the `onAssertionViolation` emission. The B violation event is dropped.
3. No CRDT metadata is committed, so the whole batch re-resolves next sync.
4. On retry, B re-applies as a value-identical upsert → suppressed → **not** in the seam
   batch → B's base table is not in this commit's changed-base set, so
   `runGlobalAssertions` never re-evaluates the `non_negative`-style assertion that
   depends on it. The violation is **never re-collected**, so the host is **permanently
   never notified**.

Net: B's data and derived effects committed and stay mutually consistent (this is *not*
an MV-divergence regression — the data is fine), but the host's *notification* of the
broken local invariant is silently and permanently lost in this specific intersection.

## Why it was deferred, not fixed inline

Closing it is a design decision the implementer deliberately punted, not a one-liner:

- **Emit before the abort gate** — then the host gets a violation event for a batch the
  sync metadata treats as "did not land" and will re-resolve. Confusing in the other
  direction (the seam *did* commit B, but the event arrives alongside a `status:'error'`
  abort).
- **Persist pending violations and re-emit after a later successful convergence** — adds
  durable state the feature does not otherwise need.

Either changes the carefully-ordered abort-vs-emit contract in `applyDataToStore`, so it
wants explicit sign-off rather than a reviewer's inline tweak.

## Scope / expected behavior to decide

- A host subscribed to `onAssertionViolation` should learn about a violation whose data
  committed, **even when** the same batch aborted for an unrelated per-change storage
  error. Decide the event's timing/semantics relative to the abort + the eventual
  re-resolve.
- Add a regression test in `store-adapter-seam.spec.ts` for the mixed
  error-plus-violation batch (the existing per-change-error and assertion-violation
  describe blocks both have reusable scaffolding).

## Severity

Low/narrow: requires the rare intersection of a transient per-change storage failure and
an assertion violation in the *same* apply, and it loses only a notification — never data
consistency. File for a deliberate design pass, not an urgent fix.
