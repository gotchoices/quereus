---
description: Streaming fast path for WindowNode over a MonotonicOn input — recognition rule + one-pass runtime emitter for ranking, LAG/LEAD, FIRST/LAST_VALUE, and running aggregates. Skips the buffered emitter's O(N log N) sort and O(N) materialization when the source already arrives in `[PARTITION BY..., ORDER BY[0]]` order.
files: packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/src/planner/rules/window/rule-monotonic-window.ts, packages/quereus/src/planner/optimizer.ts, packages/quereus/src/runtime/emit/window.ts, packages/quereus/src/util/ast-literal.ts, packages/quereus/test/optimizer/monotonic-window.spec.ts, packages/quereus/test/logic/07.5-window.sqllogic, docs/window-functions.md, docs/optimizer.md
---

## What was built

A new optimizer rule `monotonic-window` (registered in `PostOptimization` at priority 6) that recognises a `WindowNode` whose input already streams in `[PARTITION BY..., ORDER BY[0]]` order and tags it with a `streaming` config. The runtime (`emit/window.ts`) dispatches on this flag to a new `runStreaming` emitter that walks the source in source order, maintains O(P) per-partition state, and emits in source order — saving the O(N log N) sort and O(N) materialisation buffer the buffered path required.

### Plan-layer (`planner/nodes/window-node.ts`)

- `StreamingWindowFunctionMode` discriminated union (`rowNumber | rank | denseRank | lag{offset} | lead{offset} | firstValue | lastValue | runningAgg`).
- `StreamingWindowConfig { modes }` attached as optional `streaming` field on `WindowNode`, propagated by `withChildren` and produced by `withStreaming(config)`.
- `computePhysical()`: when `streaming` is set, source's `monotonicOn` is preserved unchanged (row-pass-through). Buffered branches unchanged.
- `getLogicalAttributes()` surfaces the per-function modes for EXPLAIN.

### Recognition rule (`planner/rules/window/rule-monotonic-window.ts`)

`ruleMonotonicWindow(node, ctx)` fires when **all** of:

- The leading ORDER BY key is a trivial `ColumnReferenceNode` whose attrId/direction matches a `physical.monotonicOn` entry on the source.
- Subsequent ORDER BY keys are also trivial column refs and are covered by `physical.ordering` in declared order/direction.
- All PARTITION BY expressions are trivial column refs and form an emit-order prefix of `physical.ordering`.
- Every function in the WindowNode is individually recognised:
  - `ROW_NUMBER`, `RANK`, `DENSE_RANK`
  - `LAG(expr [, n [, default]])`, `LEAD(expr [, n [, default]])` with `n` a non-negative integer literal (rejects column-ref offsets)
  - `FIRST_VALUE(expr)`, `LAST_VALUE(expr)` (latter only under default-equivalent frame)
  - `SUM` / `COUNT` / `AVG` / `MIN` / `MAX` over the default frame (or explicit `UNBOUNDED PRECEDING TO CURRENT ROW` in either ROWS or RANGE mode)
- No function is `DISTINCT`.

Bails on any sliding/explicit-bound frame, NTILE/PERCENT_RANK/CUME_DIST, mixed streaming-capable + non-capable functions in the same node, or partition-by misalignment.

The lifted `tryExtractNumericLiteral` helper now lives in `util/ast-literal.ts` (the runtime emitter imports the shared version).

### Runtime (`runtime/emit/window.ts`)

`emitWindow` dispatches on `plan.streaming`: buffered path (unchanged) when unset, `runStreaming` (new) when set.

`runStreaming` highlights:

- Manages its own source-attribute getter directly in `rctx.context` rather than via `createRowSlot`. Per iteration it re-promotes its descriptor to the end of the context map (delete-then-set) so it wins attribute-index resolution even when stacked Windows would otherwise shadow each other.
- Per-row pipeline: compute partition key + ORDER BY values; on partition or peer-group boundaries, finalise pending state (RANGE running-agg peer fills, LEAD trailing default fills, queue drain); allocate a per-row queue entry; update each function's state and fill what can be filled; promote slot to yielded row before each yield.
- Per-function helpers: `runRanking` inlined (single counter + last-key); `fillLag` (ring buffer of size `offset`); `handleLead` (read-ahead queue of size `offset`); `firstValue` (cache first row's expr); `lastValue` (current row's expr); `stepRunningAgg` (fold via existing `WindowFunctionSchema.step`/`final` hooks; defers slot fill until peer-group close in RANGE mode).
- `finalizePartition` flushes the trailing peer group, fills remaining LEAD slots with default, and yields queued entries.

State is bounded by `peer-group-size + max(LEAD offset)` per partition.

## Key files

- `packages/quereus/src/planner/nodes/window-node.ts` — plan-layer types and physical preservation
- `packages/quereus/src/planner/rules/window/rule-monotonic-window.ts` — recognition rule
- `packages/quereus/src/planner/optimizer.ts` — rule registration (PostOptimization, priority 6)
- `packages/quereus/src/runtime/emit/window.ts` — `runStreaming` emitter
- `packages/quereus/src/util/ast-literal.ts` — shared `tryExtractNumericLiteral` helper
- `packages/quereus/test/optimizer/monotonic-window.spec.ts` — 14 cases (positive/negative/equivalence)
- `packages/quereus/test/logic/07.5-window.sqllogic` — extended streaming-fast-path SQL coverage
- `docs/window-functions.md`, `docs/optimizer.md` — recognised functions / preconditions / composition

## Testing notes

- All 2637 existing tests pass; new optimizer spec adds 14 cases.
- Streaming sqllogic section exercises ROW_NUMBER, RANK/DENSE_RANK, LAG (with non-NULL default and offset 2), LEAD (with default at boundary), running SUM (default RANGE), MIN (explicit ROWS UNBOUNDED PRECEDING), FIRST_VALUE, LAST_VALUE, all-NULL expr column, single-row partitions, and empty result via `WHERE 1=0`.
- Equivalence cases in the spec disable the rule via `tuning.disabledRules.add('monotonic-window')` and assert identical output to the buffered path.

### Coverage gaps (non-blocking, candidates for follow-up tickets)

- **Streaming RANGE peer ties** — current tests use unique-keyed data, so the RANGE peer-fill code path is exercised only with singleton peer groups. A non-strict monotonic source (non-unique secondary index) would cover the multi-row peer-group close path.
- **LEAD column-ref default** — streaming evaluates the LEAD default once per partition close in the *next* partition's row context, while the buffered emitter evaluates per-trailing-row in that row's context. Constants behave identically (the only tested form). Column-ref LEAD defaults could diverge.
- **Stacked streaming Windows** — the slot-promotion logic exists for this case, but no SQL-logic test plans two streaming WindowNodes back-to-back.

## Usage

The rule is on by default. Disable per-database via:

```ts
const tuning = db.optimizer.tuning;
db.optimizer.updateTuning({
  ...tuning,
  disabledRules: new Set([...(tuning.disabledRules ?? []), 'monotonic-window']),
});
```

## Out-of-scope (deferred to follow-ups)

- Sliding frames — parked at `tickets/backlog/3-monotonic-window-sliding-frames.md`.
- `NTILE`, `PERCENT_RANK`, `CUME_DIST` — would need a two-pass streaming variant.
- DISTINCT aggregates inside windows.
- Splitting a mixed `WindowNode` (streaming-capable + non-streaming) into two stacked nodes so the streaming subset still benefits.
- Composite `monotonicOn` prefix recognition (multi-key streaming).
