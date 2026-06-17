description: When a replica re-runs foreign-key rules on incoming sync data and hits a RESTRICT block, it currently throws and the same batch retries forever. Decide whether that should instead just notify, like the existing assertion path does.
files:
  - packages/quereus/src/core/database-external-changes.ts    # ingestExternalRowChangeBatch — applyForeignKeyActions loop; assertionFailureMode handling
  - packages/quereus/src/runtime/foreign-key-actions.ts       # assertTransitiveRestrictsForParentMutation / assertNoRestrictedChildrenForParentMutation throw QuereusError(CONSTRAINT)
  - packages/quereus-sync/src/sync/store-adapter.ts           # seam call (assertionFailureMode: 'report'); a seam throw propagates out of applyToStore
  - packages/quereus-sync/src/sync/admission.ts               # consumer treats a throw / non-empty errors as whole-batch error → no metadata commit → re-resolve
  - docs/sync.md                                              # § Apply-time validation (trust-the-origin; assertions are detect-and-notify)
----

# FK-actions apply-path RESTRICT: throw-and-retry vs detect-and-notify

## Problem

With `applyForeignKeyActions: true`, the external-row-change seam runs
`assertTransitiveRestrictsForParentMutation` over each inbound parent
update/delete. A RESTRICT match throws `QuereusError(CONSTRAINT)`. On the
production apply path that throw propagates out of `applyToStore`; the consumer
(`admission.ts`) treats it as a whole-batch error and does **not** commit CRDT
metadata, so the next sync re-resolves and **re-applies the identical batch**,
which throws again — an unbounded retry deadlock for a batch that can never
apply.

This collides with the seam's governing principle. `docs/sync.md`
§ Apply-time validation states the apply path is **trust-the-origin** and
re-validates nothing, and that the one referential-invariant facet meant for the
receiver — **global assertions** — is deliberately **detect-and-notify** (report
mode), precisely because *blocking would diverge the replica from the converged
truth the network agrees on*. A throwing RESTRICT on the same path does exactly
the blocking that design rejected.

The collision is reachable without exotic topologies whenever the **replica's
schema declares a RESTRICT FK the origin did not** (the FK-actions option exists
for receiver-side schemas): an origin-committed parent delete then trips the
replica's RESTRICT and wedges the stream. It is also the failure mode behind the
exotic ordering case (E) documented in
`sync-fk-actions-apply-ordering-contract` — there the throw is additionally
*spurious*.

## The question for design sign-off

On the trust-the-origin apply path, should a parent-side **RESTRICT** detected
by the FK-actions facet:

1. **Throw and abort** (today) — strongest local enforcement, but wedges the
   sync stream on any replica-only RESTRICT and contradicts trust-the-origin; or
2. **Detect-and-notify** — collect the violation (alongside / like
   `assertionViolations`) and let the batch commit, surfacing it via a host hook
   (e.g. reuse or parallel `onAssertionViolation`), so the stream stays live and
   the host owns policy; or
3. **Skip RESTRICT entirely on apply** — pure trust-the-origin: propagate only
   the non-RESTRICT actions (cascade / set-null / set-default), since the origin
   already enforced RESTRICT at its own commit.

Note option 2/3 also has to reckon with **nested cascade DML re-entering the DML
executor**, which enforces RESTRICT for the *cascaded* tables' children
independently of the top-level walk — fully non-throwing apply may require an
"apply mode" flag threaded through the DML pipeline, which is a larger change.

This is a behavioral change to a documented, tested feature (the
`FK RESTRICT mid-batch` test in `external-row-change-ingestion.spec.ts` pins the
current throw-and-rollback contract), with the project's trust-the-origin
philosophy at stake — hence human sign-off before design.

## Use case / expected behavior

A replica with `applyForeignKeyActions: true` and a local RESTRICT FK receives
an origin-committed parent delete that references a surviving local child. The
desired outcome is that the sync stream does **not** wedge: the replica either
applies-and-notifies or trusts the origin, per the chosen option — and the
`FK RESTRICT mid-batch` test is updated to match whatever contract is chosen.
