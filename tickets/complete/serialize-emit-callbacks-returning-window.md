description: Serialize callback evaluation in returning.ts and window.ts emitters
files:
  packages/quereus/src/runtime/emit/returning.ts
  packages/quereus/src/runtime/emit/window.ts
  packages/quereus/test/logic/42.1-returning-extras.sqllogic
  packages/quereus/test/logic/07.5-window.sqllogic
----

## What was built

Extends the `serialize-project-subquery-evaluation` fix to the four
remaining `Promise.all`-over-callbacks sites in the runtime emitters.
When two callbacks reference the same plan subtree (a shared CTE,
cache-deduplicated derived table, etc.), their emitted Instruction trees
collapse to the same `RowSlot` for the inner scan. Parallel evaluation
under real async I/O (LevelDB) interleaves their `rowSlot.set(row)`
calls and corrupts each other's row context. Memory mode hides this
because callbacks resolve synchronously in practice.

### Code

- `returning.ts:26-35` — RETURNING projection callbacks evaluated
  sequentially per row.
- `window.ts:158-185` (`groupByPartitions`) — PARTITION BY callbacks
  sequential per row.
- `window.ts:281-324` (`sortRows`) — both outer (per-row) and inner
  (per-callback) loops now sequential. Also fixes a pre-existing per-row
  `sourceSlot` race that could surface if any ORDER BY callback yielded
  asynchronously.
- `window.ts:944-961` (`runStreaming`) — streaming-path partition +
  ORDER BY callbacks sequential per row.

The pattern mirrors `project.ts:33-35` exactly: `for (const cb of cbs)
{ values.push(await cb(rctx)) }` inside a `for (... of rows)` outer
loop with `sourceSlot.set(row)` immediately before.

Other `await Promise.resolve(cb(...))` callsites in window.ts (at
401, 441, 448, 462, 499, 528, 996, 1117, 1211) are single-callback
calls — no concurrency exists to serialize.

### Tests

- `42.1-returning-extras.sqllogic` §8 — INSERT … RETURNING with two
  scalar subqueries against textually-identical derived tables. Asserts
  count=3, sum=90 over the post-insert table state.
- `07.5-window.sqllogic` (end of file):
  - `partition by (select count(*) from high), (select sum(v) from
    high) order by id` over a CTE — exercises the buffered
    `groupByPartitions` path.
  - `order by (select count(*) from high), (select sum(v) from high)`
    (no PARTITION BY) — exercises the buffered `sortRows` path.

  Streaming-path sequential loops are exercised by the existing
  monotonic-window tests in the same file.

## Validation

- `yarn build` — green.
- `yarn test` (memory) — 2655 passing.
- `yarn test:store` (LevelDB) — 561 passing / 1 failing
  (`10.5.1-partial-indexes.sqllogic:49`, pre-existing and unrelated).
- `yarn workspace @quereus/quereus run lint` — clean.

## Usage notes

This is a behind-the-scenes correctness fix; no public-API or SQL
surface changes. Callers see correct results under the LevelDB store
where they previously could see null/wrong subquery values when
multiple subqueries shared a plan subtree.
