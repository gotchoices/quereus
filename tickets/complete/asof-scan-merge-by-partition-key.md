---
description: AsofScan gains a co-streaming merge strategy when both inputs are pre-ordered by [partition cols..., matchAttr]
files:
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/runtime/emit/asof-scan.ts
  - packages/quereus/src/runtime/context-helpers.ts
  - packages/quereus/src/planner/rules/access/rule-asof-strategy-select.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/optimizer-tuning.ts
  - packages/quereus/test/optimizer/asof-scan.spec.ts
  - packages/quereus/test/logic/84-asof-scan.sqllogic
  - docs/optimizer.md
---

## Summary

`AsofScanNode` now carries a `strategy: 'hash' | 'merge'` discriminator. The
default `'hash'` emitter is the previous behavior unchanged (bucket the right
by partition key; per-bucket cursors). A new `'merge'` emitter co-streams both
inputs in lockstep when both arrive pre-ordered by
`[partition cols..., matchAttr]`. Memory is `O(1)` (vs `O(R)` for hash) and
emits begin as soon as left rows arrive. The optimizer rule
`rule-asof-strategy-select` (PostOptimization phase `'impl'`, priority `11`)
promotes hash → merge when:

- Both children's `physical.ordering` carries a leading
  `[partition cols..., matchAttr]` prefix; partition columns may permute, but
  positions must pair via `partitionAttrs` equi-pairs with matching directions.
- Match-attr is ASC on both sides. The merge emitter is a forward walk; both
  asof directions (`'desc'` accumulates the latest qualifier; `'asc'` returns
  the first qualifier) require ASC match-attr sort regardless of the asof
  predicate direction.
- `right.estimatedRows ≥ tuning.asof.mergeRowThreshold` (default `10000`;
  below this, hash's constant factors win).

Disabled via `tuning.disabledRules` containing `'asof-strategy-select'`.

## Key files

- `packages/quereus/src/planner/nodes/asof-scan-node.ts` — strategy field,
  `withStrategy()`, plumbing through `withChildren`, `toString()`,
  `getLogicalAttributes()`.
- `packages/quereus/src/runtime/emit/asof-scan.ts` — `emitAsofScan` is now
  a 2-line dispatch on `plan.strategy`. `emitAsofScanHash` preserves the
  previous bucketed body unchanged. `emitAsofScanMerge` uses a peek-1
  `peekableAsyncIterator` over each side, per-partition state reset, and
  per-position partition direction read off the left's `physical.ordering`.
- `packages/quereus/src/runtime/context-helpers.ts` — adds
  `RowSlot.reactivate()`. The merge emitter calls it before each yield so
  the AsofScan slot wins the `attributeIndex` race against the right scan's
  cursor slot (the hash variant never has this problem because the right
  iterator is fully drained before any left row is emitted).
- `packages/quereus/src/planner/rules/access/rule-asof-strategy-select.ts` —
  the predicate-driven rewrite rule.
- `packages/quereus/src/planner/optimizer-tuning.ts` — adds
  `asof.mergeRowThreshold`.

## Tests

`packages/quereus/test/optimizer/asof-scan.spec.ts`:

- Default strategy `'hash'`; threshold-zero promotes to `'merge'`;
  threshold-too-high keeps `'hash'`; rule-disabled keeps `'hash'`;
  partitioned-but-mismatched-ordering keeps `'hash'` even at threshold 0.
- Equivalence tests (hash vs merge) for unpartitioned desc, unpartitioned
  asc, inner cross join lateral with strict desc, and boundary-tie semantics
  (non-strict matches the tied row, strict skips it).

End-to-end **partitioned** merge cases are not directly testable today: the
recognition rule `ruleLateralTop1Asof` requires global
`physical.monotonicOn(matchAttr)` on the left, but `ORDER BY symbol, ts`
only advertises `monotonicOn(symbol)`. The merge code path correctly handles
partitioned inputs (the emitter is parameterized on `partitionLen`); a
follow-up extension to the recognition rule (or a vtab that natively
advertises both `monotonicOn(matchAttr)` and a multi-column ordering
covering the partition prefix) is needed to exercise it end-to-end.

## Validation

- `npx tsc --noEmit -p packages/quereus` — clean.
- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run test` — **2655 passing, 2 pending,
  0 failing** (reproduces the ticket's claim).
- `yarn test:store` — not run; no store-specific change.

## Review notes

- **Rule + emitter direction handling**: The rule validates
  `leftEntry.desc === rightEntry.desc` per partition position and
  `tailLeft.desc === tailRight.desc === false` (ASC) for the trailing
  match-attr. The emitter reads `partitionDescending[i]` from the left's
  ordering only — safe given the rule's per-position direction equality.
  ✓ verified.
- **`RowSlot.reactivate()`**: small, focused primitive. Harmless when not
  called; only relevant for streaming operators that interleave with
  downstream context writes for the same attr ids. No other emitters
  silently rely on the old close-and-rebuild behavior. ✓
- **`getLogicalAttributes()` adds `strategy`**: searched all test files
  parsing AsofScan's `properties`; none break. ✓
- **Deferred partitioned recognition**: documented in `docs/optimizer.md`
  as a known limitation pending a future extension to
  `ruleLateralTop1Asof` (accept "monotonic within partition" when the
  left's `physical.ordering` is `[partition cols..., matchAttr]`). Reads
  as a tracked follow-up, not a bug.

## Usage

```sql
-- Default: hash strategy is selected (right's estimated row count below
-- the default 10000 threshold).
select t.*, q.bid from (select * from trades order by ts) t
left join lateral (
  select bid from quotes q where q.ts <= t.ts order by q.ts desc limit 1
) q on true;

-- Merge strategy is selected when:
--   - the right's estimated rows ≥ tuning.asof.mergeRowThreshold, AND
--   - both inputs are co-ordered by [partition cols..., matchAttr] ASC.
-- For testing, force the threshold to 0:
--   db.optimizer.updateTuning({ ...DEFAULT_TUNING, asof: { mergeRowThreshold: 0 } })
```

Disable selectively in tuning:
`disabledRules: new Set(['asof-strategy-select'])`.
