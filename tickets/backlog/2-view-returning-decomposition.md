description: Let inserts, updates and deletes against a logical table that is stored split across several physical tables use a `returning` clause, reporting the logical rows each statement actually changed.
prereq: view-returning-join-insert, returning-mutation-effect
architecture: docs/view-updateability.md#returning-clauses
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/src/runtime/emit/view-mutation.ts, docs/lens.md, docs/view-updateability.md
----
## Context

A decomposition-backed logical table is a lens table whose storage is split into one anchor table plus member tables (optional columnar members, EAV attribute rows) that share the anchor's key; see docs/lens.md § The Default Mapper. Writes fan out one base op per member. All three ops currently reject `returning` with `returning-through-view`. The rejecting `rejectReturning` calls are in `analyzeDecompositionInsert`, `decomposeDelete` and `decomposeUpdate` in packages/quereus/src/planner/mutation/decomposition.ts.

## The contract

Same as view-returning-join-insert: `returning` reports what the statement modified, projected through the **logical** table's columns.

- **insert**: the post-insert logical row for each row actually written. A row skipped by a conflict clause is omitted; a replaced row returns its new image. The image includes the minted shared key, defaults, and every member's values. An optional or EAV member that wrote nothing contributes NULL, exactly as a read of the logical table shows.
- **update**: the post-update logical row for every row the update matched. This includes a row whose own `where` column the update rewrote, matching single-source NEW semantics. The image reflects member rows the update materialized or removed (an all-NULL assignment lowers to a member delete).
- **delete**: the pre-delete logical row (OLD image) of every deleted row.

## Recommended mechanism (plan stage to confirm)

The join-view machinery maps over almost directly. The logical row's identity is the anchor key.

- **insert**: reuse the written-keys seam from view-returning-join-insert, fed by the anchor insert, which every decomposition insert plans. Then re-query the logical body after the ops, restricted to written anchor keys. Partial-write question: if the anchor insert was skipped but a member was written, should the row return? The contract says yes. Confirm whether that state is even reachable given the anchor-first FK order.
- **update**: `buildViewMutation` already plans the logical body once (`analyzeDecomposition`). It builds the anchor-key `__vmupd_keys` capture (`buildDecompositionKeyCapture`) only when an arbitrary value was lowered. Also build it whenever `returning` is present, the same way `buildIdentityCapture` does for join views. Then re-query the planned body after the ops, restricted to the captured anchor keys (`returningTiming: 'post'`).
- **delete**: today the delete still goes through AST `propagate`, so it has no planned body. Either plan the body for a returning delete and capture the OLD logical image before the ops (`returningTiming: 'pre'`, mirroring `buildMultiSourceDeleteReturning`), or route decomposition delete through the same single-plan path the update uses. Prefer whichever keeps one planning of the body.
- Recompute logical columns from base terms over the planned body, not by attribute id, for the same project-merge reason documented for join views.

## Edge cases & interactions

- EAV members: the logical value comes from a pivot over attribute rows; insert/update creating or removing an attribute row must show in the post image.
- Optional columnar member absent before and materialized by the update, or present and removed by an all-NULL assignment.
- Lens constraint enforcement (row-local checks at the envelope, deferred checks, set-level keys) is unaffected. A row the envelope row-check skips under `or ignore` must not be returned.
- `rejectLensSetLevelConflictResolution` still runs first; `returning` adds no new conflict-clause surface.
- Composite or non-integer anchor keys, wherever decomposition accepts them.
- `returning *` / `<q>.*`; references to columns not on the logical table (`unknown-view-column`).
- Statement as a DML-in-CTE source (relational node).

## Docs

docs/lens.md (decomposition write section), docs/view-updateability.md § `returning` Clauses and § Current limitations.

## `mutation_effect()` (from returning-mutation-effect)

Populate it for all three ops. Insert gives `'insert'` / `'update'` (replace or upsert) / `'hidden'`. Update gives `'update'`, or `'exit'` if the logical body filters the NEW row out. Delete is the constant `'delete'`. Paid only when the function is referenced.

## TODO

- Settle the delete routing choice and the partial-write question; write implement ticket(s), splitting insert from update/delete if one run can't hold all three.
