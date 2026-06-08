---
description: Streaming asof-scan for the lateral-top-1 idiom (LEFT JOIN LATERAL ... LIMIT 1)
files:
  - packages/quereus/src/planner/nodes/plan-node-type.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/runtime/emit/asof-scan.ts
  - packages/quereus/src/runtime/register.ts
  - packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/parser/parser.ts
  - packages/quereus/src/planner/building/select.ts
  - packages/quereus/test/optimizer/asof-scan.spec.ts
  - packages/quereus/test/logic/84-asof-scan.sqllogic
  - docs/optimizer.md
---

## Summary

Recognize the lateral-top-1 idiom — `LEFT JOIN LATERAL (… LIMIT 1)` — and
rewrite it to a streaming `AsofScanNode`. Collapses
`O(L · log R)` per-left-row re-evaluation to `O(L + R)` for time-series and
event-stream queries.

## What was built

### `AsofScanNode` (`packages/quereus/src/planner/nodes/asof-scan-node.ts`)

A `BinaryRelationalNode`: takes a left input, a right input that advertises
`monotonicOn(matchAttr)` and `accessCapabilities.asofRight`, an asof attribute
pair, optional partition equi-pairs, and `strict`/`outer` flags. Output
attributes preserve the original `JoinNode`'s IDs via
`rightOutputColumnIndices` + `rightOutputAttrs` so the parent of the join
keeps seeing the same IDs after rewrite.

`computePhysical` propagates the left's `ordering` and `monotonicOn`. Drops
`uniqueKeys`.

### `emitAsofScan` (`packages/quereus/src/runtime/emit/asof-scan.ts`)

Hash-bucketed streaming algorithm:

1. Bucket the right input by partition key (single `''` bucket when no
   partition). NULL match values and NULL partition values are dropped.
2. For each left row: advance the bucket's cursor while the next row still
   satisfies the asof predicate (`<= left.match` non-strict, `<` strict). Emit
   `(leftRow, projected_right)` when the cursor matches; else NULL-pad (outer)
   or drop (inner).

Per-bucket cursors are independent; left rows for different partitions
interleave freely. The cursor cannot regress, which is why the rule requires
the left to be `monotonicOn(matchAttr)`.

### `ruleLateralTop1Asof` (`packages/quereus/src/planner/rules/join/rule-lateral-top1-asof.ts`)

Registered in the **Structural pass** at priority 5 (before
`predicate-pushdown` at 20, so the `FilterNode` carrying the asof predicate is
intact).

Pattern: `JoinNode (joinType ∈ {inner, left, cross}, condition absent or `true`)`
with right peeled through `Project | LimitOffset | Sort | Alias` to a
`Filter` whose predicate is AND of `(q.K op left.K)` and zero or more
`(q.P_i = left.P_i)`.

Bail conditions:
- No correlation (`isCorrelatedSubquery(node.right)` returns false)
- Multiple inequalities, non-trivial sort key, non-trivial projection,
  `LIMIT n ≠ 1`, `OFFSET ≠ 0`
- Right's underlying `TableReference` does not advertise
  `supportsAsofRight + monotonicOn(K)` via `getBestAccessPlan`
- Left does not have `physical.monotonicOn(matchAttr)`

When the rule does not fire, the existing nested-loop / cached-lateral path
runs unchanged.

### LATERAL parser support

The original parser was discarding the `LATERAL` keyword. Without LATERAL
semantics the lateral subquery cannot reference outer columns, which is a
prerequisite for the asof rule.

Minimal LATERAL plumbing was added:
- `AST.JoinClause.isLateral?: boolean`
- Parser captures the flag.
- `buildJoin` extends the right's build context with a
  `ShadowScope([leftScope, ...])` when `joinClause.isLateral` is true.

## Use cases

1. **Trade enrichment** — for each trade, attach the latest quote at or
   before the trade time:
   ```sql
   select t.*, q.bid, q.ask
   from (select * from trades order by ts) t
   left join lateral (
     select bid, ask from quotes q
     where q.symbol = t.symbol and q.ts <= t.ts
     order by q.ts desc limit 1
   ) q on true;
   ```
2. **Strict asof** (`q.ts < t.ts`).
3. **Unpartitioned asof** — no partition equi-pair; whole right is one
   bucket.
4. **Inner cross-join lateral** — drops left rows with no match.

## Testing

- **`packages/quereus/test/optimizer/asof-scan.spec.ts`** (10 cases):
  positive (unpartitioned, partitioned, strict, inner cross), negative
  (`LIMIT 2`, `LIMIT 1 OFFSET 1`, non-trivial sort key, multiple
  inequalities), and properties (left ordering inherited; rule disable falls
  back to join path).
- **`packages/quereus/test/logic/84-asof-scan.sqllogic`** — end-to-end
  correctness through the runtime: plan-shape sentinel, partitioned
  non-strict, inner cross-join, strict, boundary tie (strict skips, non-strict
  matches), empty right (NULL-padded vs. dropped), unpartitioned.
- Validation: `npx tsc --noEmit`, `yarn lint`, `yarn test` (2566 passing,
  2 pending) — all clean.

## Review-pass cleanup

- Removed unused `PartitionMapping.collation` field in `emitAsofScan` —
  collation was resolved per-partition but never consulted, since
  `buildPartitionKey` uses BINARY-equivalent typed-string encoding. The
  collation-aware encoding is filed as a backlog item.

## Deferred / out of scope

- ASC variant (`q.K >= left.K order by q.K asc limit 1`) — backlog ticket
  `asof-scan-asc-variant`.
- Collation-aware partition key encoding (NOCASE etc.) — backlog ticket
  `asof-scan-collation-aware-partition-key`.
- Auto-inserting a `Sort` on the left when its ordering doesn't match the
  asof attribute — currently the rule simply does not fire.
- Cost-model-driven selection between hash-bucketed and merge-by-partition
  emitters — backlog ticket `asof-scan-merge-by-partition-key`.
- Recognizing the lateral when the outer `Project` lifts a non-trivial
  expression of right columns — currently bails for any non-trivial
  projection.
