description: A query over a very long constant series, such as all the numbers from 1 to 100 million, can crash the process by running out of memory, because the engine computes and holds every row before returning the first one. The same query written with a parameter streams its rows without trouble.
files:
  - packages/quereus/src/planner/analysis/const-evaluator.ts   # MaterializingAsyncIterable, createRuntimeRelationalEvaluator
  - packages/quereus/src/planner/analysis/const-pass.ts        # replaceBorderNodes chooses what gets folded
  - packages/quereus/src/planner/nodes/values-node.ts          # TableLiteralNode
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: Buffering is what lets a folded relation be scanned repeatedly without re-evaluation, and very long constant relations are rare, so a size limit adds planner logic for a case most users never reach.
----

Constant folding replaces a relational subtree with no runtime inputs by a `TableLiteralNode` over `MaterializingAsyncIterable`, which collects every source row into an array before yielding any of them. For a relation of unknown or large size, this turns a streaming query into one whose memory use grows with the row count.

Reproduction, on Node with `--max-old-space-size=256`, reading only the first 6 rows:

```sql
select value from generate_series(1, 100000000);   -- FATAL ERROR: JavaScript heap out of memory, exit 134
select value from generate_series(1, ?);           -- with 100000000 bound: returns 1..6 promptly
```

The crash is a V8 heap failure, so it cannot be caught as a SQL error. The 256 MB heap was chosen to keep the run short; the row count needed at the default heap size was not measured. `generate_series(1, 2000000)` completed under the same limit.

Expected behaviour: a query over a constant relation does not need memory proportional to that relation's size merely because its inputs are constants. It should either stream as the parameterized form does, or decline to fold a relation known to be large. `generate_series` already advertises `estimatedRows` from its literal bounds, so a size signal exists for that function.
