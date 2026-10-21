description: Let an update that switches an outer-join view's "has a matching row" flag on or off use a `returning` clause, reporting each affected view row as it looks after the change.
prereq: returning-mutation-effect
architecture: docs/view-updateability.md#returning-clauses
files: packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, docs/vu-operators.md, docs/view-updateability.md
----
## Context

An outer-join view can expose an **existence column**: `… left join b … exists right as hasB` is true when the row matched a `b` row. Writing it adds or removes the optional side:

- `update v set hasB = true` inserts a `b` row for rows that had none.
- `update v set hasB = false` deletes the matched `b` rows.

See docs/vu-operators.md § Existence columns. `returning` on such an update currently rejects with `returning-through-view`, in packages/quereus/src/planner/mutation/multi-source.ts near the `existenceComponent` handling.

How join-view update `returning` works today: before the base ops, it captures each targeted row's per-side keys plus a per-side **match marker**. The marker records whether the optional side actually matched. After the ops, it re-queries the join keyed on those captured identities. For an optional side it matches either "captured key equals the current key" or, when the marker was false, "identified by the preserved side alone". docs/view-updateability.md § `returning` Clauses has the full detail.

## The contract

`returning` reports what was modified: the **post-update image** of each targeted view row, the same NEW semantics as every other update path.

- `hasB = true`: the row now joined to the newly inserted `b` row, flag true. Rows that already had a partner are unchanged by the flag, but if the statement matched them they are returned like any update that assigns an equal value.
- `hasB = false`: the row as it now reads, with the preserved side's columns, the `b` columns NULL, and the flag false.

## Findings so far and recommended mechanism (plan stage to confirm)

- **`hasB = true` is probably already recoverable.** A targeted row that had no partner was captured with marker false, so the existing preserved-side-only branch finds it after the insert. Because it had no partner before, it has exactly one afterward, so the match is unique. The blanket reject may only need lifting for `true`. Verify with a test.
- **`hasB = false` is the real gap.** The captured `b` key was non-null with marker true, but that `b` row no longer exists, so neither branch of the re-query matches. Re-querying by the preserved side alone is wrong in the one-to-many case. If `a` had several `b` partners and the `where` targeted only some, the re-query would also return the untouched partners' rows. Recommendation: for a side the statement existence-deletes, **synthesize** the post image instead of re-matching the join. Re-read the preserved side by its captured key after the ops, project the deleted side's columns as NULL and its flag as false, and recompute computed view columns over that. This is correct for one-to-one and one-to-many, and it reflects other preserved-side assignments made in the same statement.
- Three-or-more-way joins: other sides keep the existing per-side matching; only the existence-deleted side switches to "NULL, flag false".

## Edge cases & interactions

- One-to-many partner, `where` targeting a subset of partners (the case that rules out preserved-only re-match; one test).
- `set hasB = false` combined with a preserved-column assignment in the same statement.
- `set hasB = true` combined with a non-preserved column assignment (`set hasB = true, b.y = 'x'`): the new row carries the assigned value.
- `hasB = false` on a row that was already null-extended (no-op delete): return it unchanged as NULL / false.
- Preserved-side join key NULL with `hasB = true`: no row can be materialized (documented boundary); return the unchanged row with flag false.
- Nullable and composite preserved keys (NULL-safe matching); right joins (mirror of left); full outer stays rejected upstream.
- A computed view column mixing both sides, evaluated with the deleted side NULL.

## Docs

Remove the existence-flag exception from docs/view-updateability.md § `returning` Clauses and the Boundaries note in docs/vu-operators.md; describe the synthesized image.

## `mutation_effect()` (from returning-mutation-effect)

`hasB = true` gives `'update'`. For `hasB = false`, the synthesized NULL-extended row is `'update'` when it now shows in the view (one-to-one, or the last partner removed). It is `'exit'` when the targeted view row vanished because `a` still has other partners, so the NULL-extended image does not show. Determining which needs a post-write "does `a` still have a partner" probe. Build that probe only when the function is referenced.

## TODO

- Confirm the `true` case passes once the reject is lifted for it; design the `false` synthesis; write the implement ticket.
