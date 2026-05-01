description: Audit `Promise.all` callback evaluation in returning/window emitters for the same row-context collision class fixed in emitProject
files:
  packages/quereus/src/runtime/emit/returning.ts
  packages/quereus/src/runtime/emit/window.ts
  packages/quereus/src/runtime/emit/project.ts
  packages/quereus/src/runtime/context-helpers.ts
----

## Background

`3-serialize-project-subquery-evaluation` fixed a row-context collision in
`emitProject`: when projection callbacks ran in parallel via `Promise.all`
and two callbacks shared a plan subtree (e.g. the same CTE), interleaved
`rowSlot.set(row)` calls would overwrite each other's entries in the
shared `RowContextMap.attributeIndex`. The bug surfaced under the LevelDB
store module's true async boundaries; memory mode hid it because callbacks
resolved synchronously in practice.

The same pattern exists in two other emit sites and may carry the same
risk:

- `runtime/emit/returning.ts:29-30` — `Promise.all` over
  `projectionCallbacks` while a single `slot` is updated per row. Any
  RETURNING clause with multiple scalar subqueries sharing a plan subtree
  could collide.
- `runtime/emit/window.ts:156` — `Promise.all` over `partitionCallbacks`
  inside a per-row loop that mutates `sourceSlot`.
- `runtime/emit/window.ts:277-279` — nested `Promise.all` for
  `orderByCallbacks` per row, again sharing one `sourceSlot`.

## Goal

For each site, determine whether the parallel evaluation can produce
incorrect results when:

1. multiple callbacks reference the same plan subtree, **and**
2. that subtree iterates an async source (e.g. a store-backed scan).

If yes, serialize the same way `emitProject` does. If no (e.g. callbacks
are guaranteed leaf expressions with no inner iteration), document why
the pattern is safe so future readers don't assume the project.ts fix
applies uniformly.

## Test ideas

Mirror `test/logic/49-reference-graph.sqllogic:46-54` but exercise:

- a RETURNING clause with two scalar subqueries against the same CTE
- a window function `PARTITION BY` with two scalar-subquery partition
  keys against the same CTE
- a window function `ORDER BY` with two scalar-subquery sort keys
  against the same CTE

Run under `yarn test:store` (the failure mode is store-specific).
