description: Let an insert through a view that joins several tables use a `returning` clause, reporting exactly the view rows the insert actually wrote — the same contract a plain table insert has.
prereq: returning-mutation-effect
architecture: docs/view-updateability.md#returning-clauses
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md, docs/vu-operators.md
----
## Context

`returning` through updatable views already ships for single-table views (insert / update / delete) and for join views on update and delete (see docs/view-updateability.md § `returning` Clauses). An insert through a join view still rejects with diagnostic `returning-through-view` (`rejectReturning` in `analyzeMultiSourceInsert`, packages/quereus/src/planner/mutation/multi-source.ts). This is also the base the decomposition and set-operation `returning` tickets build on.

## The contract: report what was modified

The purpose of `returning` is to tell the caller what the statement changed. For a base-table insert, quereus returns only the rows the insert actually stored. A row skipped by a conflict clause is not returned (`insert or ignore …`, `on conflict do nothing` → `[]`; pinned in test/logic/42.1-returning-extras.sqllogic and 42.2-returning-stored-row.sqllogic). A replaced row returns its new stored image. An insert through a join view must keep the same contract at the view level:

- A view row appears in the result if and only if this statement wrote at least one of its base rows. A row whose every base insert a conflict clause skipped is omitted.
- Each returned row is the **post-insert view image**, projected through the view's columns. That image includes the minted shared key (a surrogate from the anchor key column's `default`), base-column defaults on omitted columns, σ-defaults (constants lifted from the body's `where`), and computed view columns recomputed from base terms. `returning *` expands to the view's columns, and `returning <q>.*` is validated against the view name (`assertReturningStarQualifier`).
- Only columns the view exposes may be referenced (same scope guard as the update and delete paths, `unknown-view-column`).

Update and delete through views need no change for this contract. Quereus rejects per-statement conflict overrides on `update` (`update or ignore` is pinned closed in 42.1-returning-extras.sqllogic), so update and delete never skip a matched row.

## Recommended mechanism (plan stage to confirm)

Re-querying the view by the envelope's key values after the insert would break the contract. The envelope holds the materialized source rows plus the minted shared key, built once and read by every per-side insert. Under `or ignore` a key re-query would return the pre-existing row the insert did not touch. Instead:

- Have each per-side base insert also produce the key columns it actually wrote. That is an internal `returning <pk>` on the side insert; the base `ReturningNode` already yields only stored rows. The `ViewMutation` emitter collects those rows into a **written-keys** context descriptor as each side runs. This is a small new seam in `runtime/emit/view-mutation.ts`, analogous to the existing up-front `identityCapture` but filled from base-op output instead of before the ops.
- After all base ops, re-query the already-planned join body restricted to rows whose per-side key is in that side's written set. Use the same base-term projection the update path uses (`buildMultiSourceReturningProjection`) so body-computed columns survive project-merge. Thread it as `ViewMutationNode.returning` with `returningTiming: 'post'`.
- Keep the seam generic (written keys per base op, keyed by side), so the decomposition insert can reuse it unchanged.

Before adding a new seam, check whether the existing `identityCapture` plumbing can carry this.

## Edge cases & interactions

- Conflict clauses: `or ignore` and `on conflict do nothing` (row omitted), `or replace` (new image returned), and an upsert `on conflict do update` if the join-insert path accepts it (updated image returned). One test pinning the `or ignore` omission is warranted; it is the contract's branching point.
- Partial write: the anchor insert is skipped but a child side inserts, or the reverse. By the contract the row is returned if any side wrote. Decide how the re-query matches when one side's key is in the written set and the other's is not, and pin it with one test.
- Outer-join optional sides: a presence-gated side that inserts nothing for a row, or a gated FK-child key projected NULL. The re-query must still find the row through the preserved side.
- Duplicate source rows in one `values` list under `or ignore` (second is skipped). SELECT source and empty source (`[]`).
- Composite primary keys on a side; nullable key columns (NULL-safe matching, as in the update path's capture correlation).
- Set-operation join-leg inserts call `buildMultiSourceInsert` through `buildSetOpMutation` (`joinLegInserts`). They must keep building as void with no `returning`; the set-op ticket decides whether to consume this.
- Ephemeral targets (a CTE name, or an inline subquery as the DML target) and materialized-view write-through over a join body. Both should inherit the feature; verify by inspection plus one MV case if not already covered generically.
- Statement used as a DML-in-CTE source (`with m as (insert into jv … returning …) select …`). The node must be relational there (block.ts treats a `ViewMutation` with returning as relational).
- Lens-backed join views: lens constraint seams are unaffected; verify by inspection.

## Docs

Update docs/view-updateability.md § `returning` Clauses and § Current limitations, and the join-insert notes in docs/vu-operators.md. State the "rows actually written" contract explicitly there, because it governs the sibling tickets.

## `mutation_effect()` (from returning-mutation-effect)

Populate it for join inserts: `'insert'` for a newly written view row, `'update'` when `or replace` / upsert modified an existing row, `'hidden'` when the written row does not show in the view. Example: the body has a non-σ-default filter the data fails, or an inner-join partner is missing. Paid only when the function is referenced.

## TODO

- Confirm the mechanism above; write the implement ticket(s) with the final design.
- Note: multi-source.ts is ~3.5k lines (`wc -l`), so put new returning helpers in a focused module rather than growing it (see backlog debt-oversized-source-files).
