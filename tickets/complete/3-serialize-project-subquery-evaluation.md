description: Serialized projection evaluation in emitProject to prevent row-context collision between scalar subqueries sharing plan subtrees
files:
  packages/quereus/src/runtime/emit/project.ts
  packages/quereus/test/logic/49-reference-graph.sqllogic
----

## What was built

`emitProject` previously evaluated projection callbacks concurrently via
`Promise.all(projectionFunctions.map(fn => fn(rctx)))`. When two scalar
subqueries in the same SELECT list referenced the same plan subtree (e.g. a
shared CTE), their emitted `Instruction` trees shared plan-node attribute
IDs. Under real async boundaries (LevelDB store iteration), interleaved
`rowSlot.set(row)` calls overwrote each other's entries in
`RowContextMap.attributeIndex`, causing `column()` reads to resolve against
the wrong row.

The fix replaces parallel evaluation with a sequential `for … await` loop
in `packages/quereus/src/runtime/emit/project.ts:32-35`:

```ts
const outputs: OutputValue[] = [];
for (const fn of projectionFunctions) {
  outputs.push(await fn(rctx));
}
```

SQL projection expressions are independent and order-insensitive, so the
sequential loop is semantically equivalent. Memory-mode tests had always
exhibited serial behavior in practice — only the store mode's true async
boundaries exposed the bug.

## Key files

- `packages/quereus/src/runtime/emit/project.ts` — sequential projection loop
- `packages/quereus/src/runtime/context-helpers.ts` — `RowContextMap` /
  `createRowSlot` (background; not modified)
- `packages/quereus/test/logic/49-reference-graph.sqllogic:54` — canonical
  repro: two scalar subqueries referencing the same CTE

## Testing

- `yarn test` — 2443 passing (memory mode, all green)
- `yarn lint` — 0 errors (warnings pre-existing)
- `yarn test:store` — `49-reference-graph` now passes (count=2, sum=50). One
  unrelated pre-existing failure remains in 50-declarative-schema.sqllogic
  ("Deferred constraint execution found multiple candidate connections")
  which concerns deferred constraints, not projection.

## Follow-ups

- Same `Promise.all(callbacks.map(fn => fn(rctx)))` pattern exists in
  `runtime/emit/returning.ts:29-30` and `runtime/emit/window.ts:156,
  277-279`. These were not addressed here per ticket scope, but carry the
  same risk if multiple projection-style callbacks share plan subtrees.
  Tracked in `backlog/serialize-emit-callbacks-returning-window.md`.
- The originally-noted perf concern (CTE double-scanning via separate
  `CacheNode`s per `CTEReference`) is unrelated and should be tracked
  separately if desired.
