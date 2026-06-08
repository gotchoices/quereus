---
description: Constant-binding companion layer for the FD/EC framework. Parameters now count as per-execution constants; bindings are closed over ECs at Filter and inner-join contribution points; every relational operator propagates bindings per its FD/EC rule.
files:
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/alias-node.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/planner/nodes/set-operation-node.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/test/optimizer/fd-equivalence.spec.ts
  - docs/optimizer.md
---

## Summary

Extended the FD/EC framework from `fd-property-foundation` with a `ConstantBinding`
companion surface that records *what value* each `∅ → col` FD is pinned to —
either a literal `SqlValue` or a parameter reference. Parameters are treated as
per-execution constants because `ParameterReferenceNode` is bound once before
iteration and the same value is observed by every row.

## What shipped

- **`ConstantValue` / `ConstantBinding`** types on `PhysicalProperties` in
  `planner/nodes/plan-node.ts`, re-exported from `planner/util/fd-utils.ts`.
- **Parameter recognition** in `extractEqualityFds`: `WHERE col = ?` and
  `WHERE col = :foo` now emit both a `∅ → col` FD and a `ConstantBinding`.
  `constantValueOf` peels through `CastNode` and `CollateNode` so the parser's
  numeric-cast around `?` doesn't hide the parameter case.
- **Helpers** in `fd-utils.ts`:
  - `mergeConstantBindings(a, b)` — coalesces same-`ConstantValue` bindings by
    unioning `attrs`. Cap at `MAX_FDS_PER_NODE`; later additions dropped on
    overflow (earlier-node bindings are preferred — closer to keyed columns).
    Truncations logged under `quereus:planner:fd`.
  - `closeConstantBindingsOverEcs(bindings, ecs)` — extends `attrs` over every
    overlapping EC member (fixed-point; bounded by EC list size).
  - `projectConstantBindings(bindings, mapping)` / `shiftConstantBindings(bindings, offset)` —
    mirrors of the FD/EC project/shift helpers.
- **Per-operator propagation** wired into every relational `computePhysical`:
  - Filter: inherit + extract + close over merged ECs.
  - Inner / Cross join (via `propagateJoinFds`): union both sides (right shifted)
    + close over merged ECs (covers both literal and parameter equi-pair cases).
  - Left / Right outer: keep the preserved side only (NULL-pad invalidates the
    nullable side).
  - Full outer: drop both.
  - Semi / Anti: left only.
  - Project / Returning / Aggregate / StreamAggregate / HashAggregate: project
    through the source→output column mapping.
  - Alias / Distinct / Window / SeqScan / IndexScan / IndexSeek: pass through.
  - SetOperation: drop conservatively (UNION can mix differing values).
  - AsofScan: inherit left only.

## Validation

- `yarn build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn test` (quereus) — **2776 passing, 2 pending, 0 failing**.
- `yarn test:store` — not run (metadata-only change).

## Test coverage

`packages/quereus/test/optimizer/fd-equivalence.spec.ts` adds 22 tests:

**Unit:** `extractEqualityFds` literal/parameter/mixed bindings; `mergeConstantBindings`
coalesce / distinct values / parameter equality / parameter inequality;
`closeConstantBindingsOverEcs` single overlap / transitive chain / no-overlap
pass-through; `projectConstantBindings` drop / partial survival; `shiftConstantBindings`.

**End-to-end via `query_plan(?)`:** Filter parameter equality emits a binding;
Filter literal + parameter mix produces two bindings; Filter EC closure
(`WHERE a = b AND a = 7` binds both); Inner JOIN closes a one-sided literal /
parameter binding over the equi-pair EC; LEFT JOIN drops right-side ON-clause
constants; Project drops bindings on unprojected columns; non-equality predicate
contributes no bindings.

## Notes for downstream consumers

`rule-predicate-inference-equivalence` and ordering-pruning rules should read
`PhysicalProperties.constantBindings` directly — that's the surface this ticket
exists to provide.

## Out of scope

- Refining outer-join EC/binding survival per join-key-preservation — separate ticket.
- Wiring rule-predicate-inference-equivalence to consume bindings — separate ticket.

## Review notes

Comment on `mergeConstantBindings` was tightened to accurately describe the
cap-overflow behavior (later additions dropped; earlier-node bindings preferred).
The earlier wording was internally contradictory.
