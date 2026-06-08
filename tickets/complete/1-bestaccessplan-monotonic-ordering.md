---
description: Adds optional monotonic-storage / access-path-capability advertisements to BestAccessPlanResult and lifts them onto IndexScan/IndexSeek physical leaves.
files: packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/rules/access/rule-select-access-path.ts, packages/quereus/src/vtab/memory/module.ts, packages/quereus/test/vtab/best-access-plan.spec.ts, packages/quereus/test/optimizer/bestaccessplan-monotonic-advertisement.spec.ts, docs/module-authoring.md, docs/optimizer.md, docs/plugins.md
---

## What was built

Added three optional, additive fields to the `BestAccessPlanResult` virtual-table contract that let modules advertise storage-level monotonic ordering and access-path capabilities, plus the planner-side plumbing that lifts those advertisements onto the physical leaf node's `physical.monotonicOn` / `physical.accessCapabilities`.

### Public surface

`BestAccessPlanResult` (`packages/quereus/src/vtab/best-access-plan.ts`):
- `monotonicOn?: { columnIndex, direction: 'asc' | 'desc', strict }` — stronger than `providesOrdering`; a property of the underlying storage, with `strict = true` ⇒ no two rows share the value.
- `supportsOrdinalSeek?: boolean` — O(log N) seek to kth monotonic row (LIMIT/OFFSET pushdown). Implies `monotonicOn`.
- `supportsAsofRight?: boolean` — can serve as right side of streaming asof scan. Implies `monotonicOn`.

`validateAccessPlan` enforces the column-index range and the `*Right` / `*Seek` ⇒ `monotonicOn` implications.

`PhysicalProperties` (`packages/quereus/src/planner/nodes/plan-node.ts`):
- Added `accessCapabilities?: { ordinalSeek?: boolean; asofRight?: boolean }`. Documented as a **non-relational** property that survives only on the leaf where the access plan was resolved — pass-through nodes MUST NOT propagate it.

### Lift mechanics

`IndexScanNode` / `IndexSeekNode` (`table-access-nodes.ts`) accept an optional `advertisement: AccessPathAdvertisement`. Their `computePhysical()` calls a shared `liftAdvertisement()` helper that:
- translates `monotonicOn.columnIndex` → `physical.monotonicOn[0].attrId` via `source.getAttributes()`,
- emits `physical.accessCapabilities` only when the leaf actually advertises `ordinalSeek`/`asofRight`.

`SeqScanNode` does not advertise — chosen only when the access plan is non-monotonic.

`rule-select-access-path.ts` exposes a single `extractAdvertisement()` helper, threaded into every `IndexScanNode` / `IndexSeekNode` constructor in both the index-aware and legacy selection paths.

### Memory-table reference implementation

`MemoryTableModule.findBestAccessPlan` calls `buildMonotonicAdvertisement` after finalizing the plan. The helper:
- skips multi-IN multi-seek and OR_RANGE paths (non-monotonic emit order),
- locates the chosen index, picks the leading non-equality-bound column,
- returns `{}` when every column is equality-bound (single-row seek),
- strict iff the index is unique AND the leading non-bound column is the only remaining unbound key column,
- always advertises `supportsAsofRight` alongside `monotonicOn`,
- explicitly defers `supportsOrdinalSeek` (layered store doesn't cheaply support O(log N) kth-row seek).

## Test coverage

**Unit tests** (`packages/quereus/test/vtab/best-access-plan.spec.ts`):
- `validateAccessPlan` accepts a valid `monotonicOn`.
- Rejects out-of-range / negative `monotonicOn.columnIndex`.
- Rejects `supportsOrdinalSeek` / `supportsAsofRight` without `monotonicOn`.
- Accepts both capability flags when accompanied by `monotonicOn`.

**Plan-shape tests** (`packages/quereus/test/optimizer/bestaccessplan-monotonic-advertisement.spec.ts`):
- Full PK scan, single-col PK → strict `monotonicOn` + `accessCapabilities.asofRight: true` lifted onto the physical leaf.
- PK range scan → strict `monotonicOn`.
- Composite PK full scan → non-strict `monotonicOn` on leading column.
- Single-row equality seek → no `monotonicOn`.
- Multi-value IN multi-seek → no `monotonicOn` (IN-list emit order).
- EXPLAIN serialization → `query_plan()` JSON contains `"monotonicOn"`, `"accessCapabilities"`, `"asofRight": true`.

## Validation

- `yarn workspace @quereus/quereus exec tsc --noEmit` → exit 0.
- `yarn build` (full repo) → green.
- `yarn workspace @quereus/quereus test` → 2555 passing, 2 pending; no regressions.
- `yarn workspace @quereus/quereus lint` → exit 0.

## Review notes (passing)

- **Pass-through-node propagation policy.** Verified: `Filter.computePhysical` and `LimitOffsetNode.computePhysical` propagate `monotonicOn` (the relational characteristic) but NOT `accessCapabilities`. The base `PlanNode.physical` getter only inherits `deterministic / readonly / idempotent` defaults from children and merges the per-node `computePhysical` override on top — `accessCapabilities` therefore never silently leaks past the leaf. No additional code change required.
- **EXPLAIN serialization** is via `safeJsonStringify(node.physical)` in `explain.ts`, so the new fields surface automatically through `query_plan()` and PlanViz JSON output. The plan-shape spec asserts this contract.
- **Direction tracking.** Memory-table sets direction from `leadingCol.desc`; flagged in code comments that a future `adjustPlanForOrdering` reverse-walk would need to flip the direction. No path triggers that today.
- **Strict-classification heuristic.** Conservative: a unique composite index with a free suffix yields `strict=false` on its leading free column. Documented as intentional in the implement ticket — not a missed optimization.
- **`RetrieveNode` propagation.** The rule replaces `RetrieveNode` with the physical leaf before optimization completes, so `monotonicOn` wouldn't be lost in practice. Default child-inheritance suffices.

## Docs

Updated to document the new fields:
- `docs/module-authoring.md` — `BestAccessPlanResult` example interface.
- `docs/optimizer.md` — virtual-table integration section.
- `docs/plugins.md` — public TypeScript reference.

## Usage

A virtual-table module that walks a sorted index returns a populated `BestAccessPlanResult`:

```typescript
return {
  handledFilters,
  cost,
  rows,
  indexName: '_primary_',
  seekColumnIndexes: [0],
  monotonicOn: { columnIndex: 0, direction: 'asc', strict: true },
  supportsAsofRight: true,
};
```

The optimizer rule lifts this onto the physical leaf:

```
INDEXSCAN t USING primary
  physical: {
    monotonicOn: [{ attrId: <stable id>, direction: 'asc', strict: true }],
    accessCapabilities: { asofRight: true },
    ordering: [{ column: 0, desc: false }],
    ...
  }
```

Downstream optimizer rules (ordinal-seek pushdown, streaming asof, monotonic merge join, monotonic window fast paths) — to be added in companion tickets — can then key off these fields.
