---
description: MonotonicOn(attrId) plan characteristic — type, PhysicalProperties field, helpers, and propagation rules across the relational node set
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/framework/physical-utils.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/distinct-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/alias-node.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/join-utils.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/set-operation-node.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/planner/nodes/window-node.ts, packages/quereus/test/optimizer/monotonic-on.spec.ts, docs/optimizer.md
---

## Summary

Installs `MonotonicOn(attrId)` as a first-class plan characteristic on
`PhysicalProperties` plus the propagation layer that carries it through the
relational node set. The leaf-side advertisement (vtab access plans) is the
companion ticket `1-bestaccessplan-monotonic-ordering`; this ticket only
installs the carrier and the propagation logic above the leaves. SortNode is
the in-tree establishment point so the property is testable end-to-end without
the leaf-side ticket having landed.

## Carrier

- `MonotonicOnInfo { attrId: number; strict: boolean; direction: 'asc'|'desc' }`
  exported from `plan-node.ts`; added as `monotonicOn?: readonly MonotonicOnInfo[]`
  on `PhysicalProperties`. `monotonicOn` strictly implies `ordering`; nodes may
  populate either.
- `PlanNodeCharacteristics.getMonotonicOn(node)` and `.isMonotonicOn(node, attrId)`
  accessors mirror the existing `ordering` ones.
- Helpers in `framework/physical-utils.ts`:
  - `projectMonotonicOnByAttrId(monotonicOn, preservedAttrIds)`
  - `intersectMonotonicOn(left, right)`
  - `deriveOrderingFromMonotonicOn(monotonicOn, attrs)`
- EXPLAIN serialization is automatic (`safeJsonStringify(node.physical)` in
  `func/builtins/explain.ts` picks up the new field).

## Propagation rules

| Node | Rule applied |
| --- | --- |
| `Sort` | Establishes monotonicOn on the leading sort key when it is a trivial ColumnReference. Strict iff source.uniqueKeys contains `[<that-column-index>]`. Direction comes from the sort key. |
| `Distinct` | Strengthens source's monotonicOn entries to `strict: true`. Does not establish on its own. |
| `Filter`, `LimitOffset`, `Alias` | Preserve source's monotonicOn unchanged. |
| `Project` | Filters source's monotonicOn to attrIds preserved as trivial ColumnReferences. Drops on any non-trivial expression (until ticket `4-expression-properties-injective-monotone` lands). |
| `JoinNode` / `MergeJoin` | Shared helper `propagateJoinMonotonicOn` in `join-utils.ts`. Cross/full → drop. Semi/anti → preserve left. Inner/left/right: for each equi-pair `(l.X, r.X)` where both sides are monotonicOn on their X with matching direction, the non-null-extended side(s) propagate that attrId with `strict = l.strict ∧ r.strict`. |
| `SetOperation` | Drops with TODO for the deferred UNION-ALL-with-disjoint-X-ranges case. |
| `HashAggregate`, `StreamAggregate` | Drop (the grouped relation is a set). |
| `WindowFunction` | Output ordering is determined by `[PARTITION BY, ORDER BY]`. Carrier rule: PARTITION BY non-empty → drop; PARTITION BY empty + ORDER BY empty → preserve source unchanged; PARTITION BY empty + ORDER BY present → derive monotonicOn from the leading ORDER BY key (mirrors Sort). The runtime sorts within each partition by ORDER BY and groups partitions in insertion order, so a "preserve source" rule is unsafe — review caught this and tightened the rule. |

Anything else (bloom-join, hash-join, table-access, etc.) defaults to dropping
because they don't include `monotonicOn` in `computePhysical` return.

## Tests (`packages/quereus/test/optimizer/monotonic-on.spec.ts`)

17 cases:

- Sort establishment (strict and non-strict, both directions).
- Distinct strengthens to strict.
- Filter / LimitOffset / Alias preserve.
- Project preserves attrId-stable; drops on attrId removed; drops on non-trivial expression.
- Inner join on monotonic equi-pair propagates with strict-AND.
- Cross join drops.
- UNION / UNION ALL drop.
- GROUP BY drops.
- Window without PARTITION BY (matching ORDER BY) propagates.
- Window with PARTITION BY drops.
- EXPLAIN's `physical` JSON column contains `"monotonicOn"` when set.

Test rerun cookbook:

- The strict-Sort test uses `ORDER BY id DESC` on a PK so the ascending PK index doesn't elide the Sort. Direct `ORDER BY id` collapses to an `IndexScan`.
- The non-strict tests use `nu (k INTEGER PRIMARY KEY, x INTEGER)`, ordering on `x`. The PK is on `k`, so the Sort survives and source uniqueKeys don't cover the sorted column.
- The Filter test wraps the inner SELECT in `LIMIT 100` to block predicate pushdown, keeping the FilterNode above the Sort.
- The inner-join test uses two non-unique columns on each side, and verifies the output attrIds are propagated with `strict: false` on both.
- The window-partition test uses `PARTITION BY k ORDER BY x` to demonstrate that even with a sorted source, partitioning forces monotonicOn to drop.

## Review changes

- **WindowNode propagation tightened.** The original rule was "preserve source's monotonicOn (within a partition the row order is preserved)". Inspecting `runtime/emit/window.ts` showed the runtime always groups by partition key in insertion order then sorts within each partition by ORDER BY — so the source's row order is *not* preserved end-to-end. Replaced with the [PARTITION BY, ORDER BY]-driven rule above. Added `windowSpec.orderBy[0].direction` propagation and a strictness check via source's uniqueKeys (mirroring SortNode).
- **Test coverage broadened.** The original "Window preserves source" test happened to pass only because the window's `ORDER BY x` matched the source's `monotonicOn(x)`. Renamed it to make that intent explicit, plus added a partition-case test that asserts the property drops.
- **Docs.** `docs/optimizer.md` now mentions `monotonicOn` alongside ordering/uniqueness/cardinality, with a one-line description and a pointer to `MonotonicOnInfo`.

## Validation

- `cd packages/quereus && yarn lint` — clean.
- `cd packages/quereus && node --import ./register.mjs node_modules/mocha/bin/mocha.js test/optimizer/monotonic-on.spec.ts` — 17 passing.
- `yarn test` — 2543 passing, 2 pending across the quereus package; all other packages unchanged.
- `yarn build` — clean monorepo build.

## Deferred / out-of-scope (documented in code)

- UNION ALL with disjoint X-ranges → can preserve `MonotonicOn(X)`. Inline TODO in `set-operation-node.ts`.
- Project through injective/monotone expressions → blocked on `4-expression-properties-injective-monotone`. Current code drops on any non-trivial expression.
- Vtab access-plan advertisement → `1-bestaccessplan-monotonic-ordering`. Until it lands, leaf-monotonicity tests use Sort as the establishment point.
- Window with PARTITION BY where the partition keys functionally determine the candidate attribute could in principle preserve monotonicOn; left as a TODO in `WindowNode.computePhysical`.
