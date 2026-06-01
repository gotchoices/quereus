description: Correctly support `update … returning` through a multi-source (inner-join) view when the update rewrites a column its own WHERE predicate filters on. Today that exact shape is rejected with the `returning-through-view` diagnostic (the post-mutation re-query cannot recapture rows whose predicate column changed); make it return the post-mutation view-projected rows like Postgres does.
files: packages/quereus/src/planner/building/view-mutation-builder.ts, packages/quereus/src/runtime/emit/view-mutation.ts, packages/quereus/src/planner/nodes/view-mutation-node.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, docs/view-updateability.md

## Background

RETURNING through a multi-source inner-join view (`update`/`delete`) shipped under
`view-mutation-returning-through-view` (sequence 3.7). Because the view row spans
both base tables, it cannot be recovered from the per-side base ops, so the rows
come from a **re-query of the view** restricted to the user predicate:
`select <returning> from <view> [where <user where>]`, captured `pre` (delete) or
`post` (update).

For an update, the post-mutation re-query matches by the *original* user predicate.
If the update **assigns a column that the WHERE predicate filters on**, the changed
rows no longer match the predicate, so the re-query silently returns the wrong (or
empty) set. The 3.7 review converted this from a silent mis-capture into a **loud
rejection** (`view-mutation-builder.ts` `buildMultiSourceReturning`, guard comparing
assignment columns against `collectColumnRefNames(where)`), with a regression test in
`93.2-view-mutation-pending.sqllogic`.

## Desired behavior

`update <join-view> set <pred-col> = … where <pred-col> = … returning …` should
return the post-mutation, view-projected rows for exactly the rows that were
updated — matching the single-source path (which reads NEW/OLD and has no such
limitation) and Postgres semantics.

## Use cases

- `update rjoin set note = 'A' where note = 'a' returning cid, note, label` → one
  row per updated join row, reflecting `note = 'A'`.
- An update whose predicate references a parent-owned column that the update also
  rewrites.
- An update touching both sides where one assigned column is also in the predicate.

## Notes / constraints

- The robust mechanism is **per-row capture at mutation time** (capture the affected
  view rows' identities before/while the base ops fire, then project), rather than a
  predicate re-query. The single-source NEW/OLD path is the reference for the
  expected output shape.
- Once supported, remove the loud-rejection guard and its `93.2` regression case, and
  add positive coverage to `93.4-view-mutation.sqllogic § RETURNING`.
- RETURNING row order is not contractually guaranteed (no ORDER BY on RETURNING); the
  sqllogic harness is order-sensitive, so any new assertions rely on deterministic
  memory-vtab scan order.
