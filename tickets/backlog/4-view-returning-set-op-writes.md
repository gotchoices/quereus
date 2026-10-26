description: Let inserts, updates and deletes through a view built from union / except / intersect use a `returning` clause, reporting the view rows each statement changed.
prereq: view-returning-join-insert, returning-mutation-effect
architecture: docs/vu-setops.md
files: packages/quereus/src/planner/mutation/set-op.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/runtime/emit/view-mutation.ts, docs/vu-setops.md, docs/view-updateability.md
----
## Context

Set-operation views are writable in two forms (docs/vu-setops.md):

- **Membership** views expose per-branch flags (`… union exists left as inA, exists right as inB …`); writing a flag inserts into or deletes from that branch.
- **Flag-less** views have literal discriminator legs (`'red' as kind`); writes route to legs by predicate.

Every write fans out into per-branch base ops. All of them reject `returning` with `returning-through-view`, via `rejectReturning` in packages/quereus/src/planner/mutation/set-op.ts. The rejecting functions are `buildUpdate`, `buildDelete`, `buildInsertThrough`, `buildFlaglessInsert`, `buildFlaglessDelete` and `buildFlaglessUpdate`. The current message claims "the per-branch fan-out yields no single recoverable view row". That is true for re-matching the view after the write, but it does not hold for the contract below.

## The contract

`returning` reports what was modified, one row per affected **view** row, never one per branch op.

- **delete**: the OLD view image of each deleted view row, flags included.
- **update** (data columns and/or flag flips): the NEW image of each affected view row. That is the captured row with the `set` assignments applied: data values recomputed, flags as assigned or else as captured. A row whose flips leave it in no branch has left the view. It is still returned with its NEW image (all flags false), matching how single-source update returns a row pushed out of the view's filter.
- **insert**: the inserted view rows as stored, including flags/discriminators and any base defaults applied to omitted columns.

## Recommended mechanism (plan stage to confirm)

- Update and delete already materialize every affected view row before any branch op fires: data columns plus probe flags (`buildSetOpCapture`, shared through `identityCapture`). **Delete** `returning` can project directly from that capture (`'pre'`). **Update** `returning` can be a projection over the same capture that applies the `set` expressions to the captured values. No re-query of the view is needed, which sidesteps union de-duplication and the fact that a set-op view may have no key to re-match by. Decide whether re-reading branches is ever needed for accuracy, e.g. a base default or trigger-like effect a pure projection can't see. Updates assign explicit values, so likely not.
- **Insert** is the open question. The flag-routed and flag-less insert paths accept `values` sources. The supplied values plus the flags or discriminator give most of the image, but an omitted column takes the **target leg's** base default, which a projection over the source rows cannot know. Options: (a) restrict insert `returning` to inserts that supply every view column, otherwise rejecting with a clear diagnostic; (b) collect each leg insert's own `returning` output (written rows) and map it back to view columns per leg, de-duplicating a row inserted into both branches into one view row. (b) also honours conflict-skipped rows, consistent with view-returning-join-insert. Recommendation: (b), reusing that ticket's written-rows seam. If the per-leg mapping proves ambiguous, use (a) and say so in docs.
- Join-leg branches: update/delete go through nested per-branch captures (`nestedCaptures`). Join-leg inserts go through `buildMultiSourceInsert`, whose `returning` view-returning-join-insert delivers. Make sure the outer view-level projection, not the inner per-branch one, determines the result.

## Edge cases & interactions

- A row present in both branches (`inA and inB`): one result row, not two.
- `union all` with duplicate rows: decide and document whether duplicates are each returned (one per affected view row is the natural reading).
- `except` / `intersect` and nested subtree operands (membership-gated fan-out).
- Flip that removes a row from every branch (NEW image with all flags false); flip that adds it to a branch it was absent from.
- Zero-leg no-op (`buildNoOpMutationSink`, unsatisfiable predicate): must return `[]` with the view's column shape, not a void sink.
- Flag-less discriminator columns in `returning *`.
- Ephemeral targets (CTE-name / inline subquery), which keep their existing flag-less phase-1 reject.

## Docs

docs/vu-setops.md (both the membership and the flag-less sections that say RETURNING is rejected), docs/view-updateability.md § `returning` Clauses and § Current limitations.

## `mutation_effect()` (from returning-mutation-effect)

Delete gives `'delete'`. Update gives `'update'` while any branch flag (or discriminator leg) still holds the NEW row, and `'exit'` when the flips leave it in no branch. This replaces the bare "still returned with its NEW image" reading above with an explicit label. Insert gives `'insert'` / `'update'` (upsert) / `'hidden'`. Paid only when the function is referenced.

## TODO

- Settle insert option (a) vs (b) and the `union all` duplicate reading; write implement ticket(s), likely delete+update first, insert second.
