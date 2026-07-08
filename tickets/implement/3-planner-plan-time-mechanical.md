description: The query optimizer rebuilds a lookup table and re-runs an expensive analysis it could reuse or look up directly; do the cheap, low-risk fixes that speed up planning without changing which plans come out.
files: packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/analysis/constraint-extractor.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/src/planner/nodes/plan-node.ts
difficulty: easy
----

## Scope

The two **low-risk, plan-preserving** plan-time inefficiencies from the parent fix ticket
(`3-planner-plan-time-perf`). These do not change optimizer output — they only remove
redundant work — so they can land and be reviewed independently of the riskier
decline-tracking change (`planner-decline-tracking`, no ordering dependency between them).

### (b) `FilterNode.computePhysical` redundant work

`nodes/filter.ts:59-165`. Two independent issues:

1. **Hand-built attribute index (lines 67-69).** The method builds
   ```ts
   const attrIdToIndex = new Map<number, number>();
   sourceAttrs.forEach((a, i) => attrIdToIndex.set(a.id, i));
   ```
   but `this.source.getAttributeIndex()` (base `PlanNode`, `plan-node.ts:737-778`) already
   returns exactly this map, cached per instance. Replace the hand-built map with the cached
   one. `extractEqualityFds` takes `ReadonlyMap<number, number>`; `getAttributeIndex()` returns
   `ReadonlyMap<number, number>` — type-compatible.

2. **`extractConstraints` re-runs on every re-mint (lines 131-139).** `.physical` caches
   `_physical` per instance (`plan-node.ts:825`), so within one instance the extraction runs
   once. The waste is **re-minting**: bottom-up traversal rewrites children, `withChildren`
   mints a fresh `FilterNode`, and each fresh instance re-runs `createTableInfoFromNode` +
   `extractConstraints` (the ~1457-line `analysis/constraint-extractor.ts` module) even when
   the predicate is unchanged.

   Key insight: `FilterNode.withChildren` (filter.ts:177-203) reuses the **same predicate
   object** when only the source changes (`new FilterNode(scope, newSource, this.predicate)`).
   So a cache keyed on the predicate instance hits across source-only re-mints — the common
   case in bottom-up traversal. The extraction result also depends on the source's unique
   keys, so the key must include a source signature (`tableInfo.relationKey` plus a hash/join
   of `tableInfo.uniqueKeys`) to stay correct when the source genuinely changes shape.

   Suggested shape: a module-level `WeakMap<ScalarPlanNode, Map<string, CoveredResult>>`
   where the inner key is the source signature. `WeakMap` on the predicate lets entries GC
   when predicate nodes die. Only the covered-key portion (lines 131-139) needs caching —
   that is the call into the heavy module; the FD merges above it are cheap.

### (c) One residual O(n) attribute scan

`rules/parallel/rule-async-gather-zip-by-key.ts:581`, inside `branchesKeyUnique`:
```ts
const attrs = branches[b].getAttributes();
...
const ix = attrs.findIndex((a: Attribute) => a.id === id);
```
`branches[b]` is a `RelationalPlanNode`, so `branches[b].getAttributeIndex().get(id)` is the
O(1) replacement. This runs inside a nested loop over key attrs, so the scan is genuinely
O(n·k).

**NOT a target — the parent ticket's claim here is stale:** `framework/physical-utils.ts:41`
(and the sibling `getColumnIndex` / `deriveOrderingFromMonotonicOn` scans in the same file)
carry an explicit code comment explaining why they stay: they are raw `{ id }[]` helpers with
no owning `PlanNode`, unit-tested against bare arrays, so `getAttributeIndex()` (a `PlanNode`
method) does not apply without changing the helper's signature contract. Leave them. If you
disagree after reading the comment, that is a signature-refactor decision — record it as a
review finding, do not silently rewrite.

## TODO

- [ ] filter.ts: replace hand-built `attrIdToIndex` (lines 67-69) with `this.source.getAttributeIndex()`.
- [ ] filter.ts: memoize the `createTableInfoFromNode` + `extractConstraints` covered-key computation (lines 131-139) in a `WeakMap<ScalarPlanNode, Map<sourceSignature, result>>`; hit across source-only re-mints, recompute when the source signature changes.
- [ ] zip-by-key.ts:581: replace `attrs.findIndex(a => a.id === id)` with `branches[b].getAttributeIndex().get(id)` (return false when `undefined`, matching the current `< 0` guard).
- [ ] Add/extend a plan test asserting the optimized plan for a multi-filter-over-keyed-table query is byte-identical before/after (these changes must not alter output). Reuse existing fixtures under `test/plan/` or `test/optimizer/`.
- [ ] `yarn workspace @quereus/quereus test` and `yarn lint` green.

## Notes

- If the extraction-cache key turns out awkward to make correct (e.g. `uniqueKeys` not cheaply
  hashable), it is acceptable to land only the `getAttributeIndex()` swaps (item 1 of (b) and
  (c)) and drop the memoization to the decline-tracking ticket's follow-up or a tripwire — the
  index swaps alone are unconditionally safe. Document the choice in the review handoff.
- NOTE candidate for the extraction cache site: if predicate nodes are ever mutated in place
  (they are not today — PlanNodes are immutable), the WeakMap key would go stale. Add a
  `NOTE:` comment at the cache site stating the immutability assumption it rests on.
