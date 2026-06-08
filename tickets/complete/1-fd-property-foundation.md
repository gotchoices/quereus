---
description: Functional-dependency foundation — adds optional `fds` and `equivClasses` physical properties on every relational node, with propagation rules across all relational operators. No consumer migration yet.
files:
  - packages/quereus/src/planner/nodes/plan-node.ts
  - packages/quereus/src/planner/util/fd-utils.ts
  - packages/quereus/src/planner/nodes/reference.ts
  - packages/quereus/src/planner/nodes/filter.ts
  - packages/quereus/src/planner/nodes/project-node.ts
  - packages/quereus/src/planner/nodes/returning-node.ts
  - packages/quereus/src/planner/nodes/alias-node.ts
  - packages/quereus/src/planner/nodes/distinct-node.ts
  - packages/quereus/src/planner/nodes/aggregate-node.ts
  - packages/quereus/src/planner/nodes/stream-aggregate.ts
  - packages/quereus/src/planner/nodes/hash-aggregate.ts
  - packages/quereus/src/planner/nodes/join-node.ts
  - packages/quereus/src/planner/nodes/join-utils.ts
  - packages/quereus/src/planner/nodes/bloom-join-node.ts
  - packages/quereus/src/planner/nodes/merge-join-node.ts
  - packages/quereus/src/planner/nodes/set-operation-node.ts
  - packages/quereus/src/planner/nodes/window-node.ts
  - packages/quereus/src/planner/nodes/asof-scan-node.ts
  - packages/quereus/src/planner/nodes/table-access-nodes.ts
  - packages/quereus/test/optimizer/fd-propagation.spec.ts
  - docs/architecture.md
  - docs/optimizer.md
---

## What landed

A first-class **functional dependency (FD)** property surface on every relational physical plan node, with **no consumer migration**. Existing `uniqueKeys` consumers (`rule-distinct-elimination`, `analyzeJoinKeyCoverage`, `CatalogStatsProvider.joinSelectivity`, change-detection classification) are unchanged. This pass is the foundation; consumer migration and new optimizations are tracked as follow-up tickets per the FD plan.

### Data shape (`plan-node.ts`)

```typescript
export interface FunctionalDependency {
  readonly determinants: readonly number[]; // empty = "constant"
  readonly dependents: readonly number[];   // non-empty
}

interface PhysicalProperties {
  // ... existing fields ...
  fds?: ReadonlyArray<FunctionalDependency>;
  equivClasses?: ReadonlyArray<ReadonlyArray<number>>;
}
```

Column indices are output-column indices (consistent with `uniqueKeys`). Superkeys imply `key → all-columns`; `fds` carries the additional dependencies. The list is non-canonical — consumers use `computeClosure` to derive what a set of attributes implies.

### Helper surface (`planner/util/fd-utils.ts`)

- `computeClosure(attrs, fds)` — iterative fixed-point.
- `determines(attrs, target, fds)` — closure-based check.
- `minimalCover(attrs, fds)` — greedy minimization.
- `mergeFds(a, b, opts?)`, `addFd(fds, next, opts?)` — subsumption-aware merge with cap enforcement (default `MAX_FDS_PER_NODE = 64`). Cap behavior drops FDs whose determinants are not a subset of any `uniqueKeys` entry; truncations logged at debug under `quereus:planner:fd`.
- `projectFds(fds, mapping)` — drop FDs that lose any determinant or dependent column.
- `shiftFds(fds, offset)` / `shiftEquivClasses(classes, offset)` — column index translation for joins.
- `mergeEquivClasses(a, b)` / `addEquivalence(classes, a, b)` — union-find–style transitive closure of overlapping classes.
- `superkeyToFd(key, columnCount)` — build `key → others` from a superkey.
- `extractEqualityFds(predicate, attrIdToIndex)` — predicate walker used by `FilterNode` to extract `col = literal` → `∅ → col` and `col1 = col2` → bi-FDs + EC pair. Parameters and subqueries are intentionally excluded from the "constant" check.

### Per-operator propagation

| Operator | Behavior |
| -------- | -------- |
| `TableReferenceNode` | Seed `key → others` for every declared key (PK + UNIQUE). |
| `SeqScanNode` / `IndexScanNode` / `IndexSeekNode` | Pass child FDs/ECs through unchanged. |
| `FilterNode` | Inherit child; add FDs/ECs from equality conjuncts (`col = literal`, `col1 = col2`). |
| `ProjectNode` / `ReturningNode` | Project FDs/ECs through the source→output mapping built from bare column-reference projections. |
| `AliasNode` / `DistinctNode` | Pass-through. |
| `AggregateNode` / `StreamAggregateNode` / `HashAggregateNode` | A source FD `X → Y` survives iff `X ∪ Y` are all column-reference GROUP BY columns; project to output indices. ECs project the same way. Shared helper `propagateAggregateFds`. |
| `JoinNode` / `BloomJoinNode` / `MergeJoinNode` | Inner/cross: union + equi-pair bi-FDs + EC merge. Left/right outer: keep preserved side only, no equi-pair FDs. Full outer: drop both. Semi/anti: keep left only. Shared helper `propagateJoinFds`. |
| `AsofScanNode` | Inherit left's FDs/ECs only — asof is at-most-one match + NULL-pad in outer mode; the asof condition is not an equality. |
| `SetOperationNode` | Conservative: drop FDs/ECs entirely. |
| `WindowNode` | Pass source FDs/ECs through unchanged. |

## Key files for testing / usage

- **Inspect FDs/ECs via `query_plan`:** the `physical` column exposes `fds` and `equivClasses` as JSON. For `SELECT * FROM t WHERE a = b`, expect `fds` containing `{determinants: [a], dependents: [b]}` + the reverse, and `equivClasses` containing `[a, b]`.
- **Closure semantics:** `computeClosure({a}, [{a→b}, {b→c}])` returns `{a, b, c}` (covered by unit test).
- **Cap behavior:** a wide table with many UNIQUE constraints can push FD count up; the per-node list stays at ≤ 64 and `quereus:planner:fd` debug log fires.

## Tests (`packages/quereus/test/optimizer/fd-propagation.spec.ts`)

41 tests in two top-level blocks:

- **`fd-utils` unit tests** — direct tests of each helper: `computeClosure` (incl. transitive and constants), `determines`, `minimalCover`, `mergeEquivClasses` (overlap union, disjoint classes, singleton drop), `addEquivalence`, `projectFds`, `addFd` / `mergeFds` (subsumption), `shiftFds` / `shiftEquivClasses`, `superkeyToFd`, `extractEqualityFds` (constant-equality, column-equality, AND-decomposition, non-equality ignore).
- **Per-operator propagation tests** via `query_plan(?)`: TableReference (PK + UNIQUE), Filter (`col = literal`, `col1 = col2`, non-equality ignored), Project (bare-column survives, expression drops), Alias, Distinct, aggregates (GROUP BY restriction), inner join (bi-FDs + EC merge), LEFT outer join (right + equi dropped), UNION ALL (no FDs), Window (pass-through).

## Validation

- `yarn build` — passes.
- `yarn workspace @quereus/quereus run lint` — passes.
- `yarn test` — quereus package: 2754 passing, 2 pending. (Two unrelated `sample-plugins` failures pre-date this branch.)
- `yarn test:store` — skipped; ticket adds physical-property metadata only, no execution-path changes.

## Review notes

- `fd-utils.ts` correctness verified: closure fixed-point, subsumption rules in `addFd`, cap enforcement with key-preference, predicate walker (literal-only "constant" check as specified).
- Join propagation: outer-join rules correctly drop the null-padded side; full-outer drops both; semi/anti keep left only.
- Aggregate propagation correctly restricts the source→output mapping to bare-column GROUP BY entries, so non-trivial GROUP BY expressions drop out.
- No semantic drift: `uniqueKeys`, `ordering`, `monotonicOn` propagation byte-identical to pre-change for every operator (only the new fields are additive).
- Docs: propagation table in `docs/optimizer.md` and architecture summary in `docs/architecture.md` match the implementation.

## Out of scope (deferred — separate tickets)

- Migration of `uniqueKeys` consumers to read `fds`.
- Injective-expression projection FDs.
- FK→PK derived FDs on the child side of a join.
- Outer-join key-preservation refinements beyond the conservative rule.
- All consumer-side optimization tickets: GROUP BY simplification, ORDER BY pruning, join elimination, predicate inference through ECs, change-detection FD classification, view maintenance with FD binding keys.
