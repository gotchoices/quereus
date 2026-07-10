description: Make the query optimizer's "can this node do X?" checks reliable by having each node explicitly declare its capabilities, so the type checker catches mistakes instead of guesses that silently misfire.
prereq:
files: packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/join-node.ts, packages/quereus/src/planner/nodes/merge-join-node.ts, packages/quereus/src/planner/nodes/bloom-join-node.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/sort.ts, packages/quereus/src/planner/nodes/limit-offset.ts, packages/quereus/src/planner/nodes/project-node.ts, packages/quereus/src/planner/nodes/cache-node.ts, packages/quereus/src/planner/nodes/cte-node.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/table-access-nodes.ts, packages/quereus/src/planner/nodes/function.ts, packages/quereus/src/planner/nodes/aggregate-function.ts, packages/quereus/src/planner/nodes/window-function.ts, packages/quereus/test/optimizer/characteristics.spec.ts
difficulty: hard
----

## Context — the design decision (already made; do not re-open)

The optimizer answers "what is this node / what can it do?" three ways today:

1. **`instanceof` on concrete node classes** (~349 uses across ~83 planner files) — used by rules to narrow a node so they can reach its specific API (`node instanceof JoinNode` → `getJoinCondition()`).
2. **`nodeType` string-enum comparisons** (`node.nodeType === PlanNodeType.Sort`) — used by rule dispatch (`RULE_MANIFEST`), the plan formatter, and EXPLAIN.
3. **Duck-typed `as any` capability detectors** in `framework/characteristics.ts` (`CapabilityDetectors`) — check for the *presence* of methods/fields to detect a capability that cuts across several node classes.

The planning pass (this ticket's predecessor) resolved the standard. **Do not survey alternatives again — implement the decision below.**

### The canonical standard

Three questions, three mechanisms — kept distinct on purpose:

- **Concrete class identity → `instanceof`.** It is type-sound, gives native TypeScript narrowing, and is already the dominant idiom. Keep every existing `instanceof`. The old convention doc's blanket "never use `instanceof`" guidance was the *root cause* of the drift: it pushed authors away from the safe idiom toward fragile duck-typing. (The doc is corrected in the follow-up ticket `planner-discrimination-doc-and-lint`.) The one real constraint — planner node classes are singletons inside `@quereus/quereus`; plugins never receive or construct planner nodes — means the cross-bundle-`instanceof` hazard does not arise here.
- **`nodeType` (the `PlanNodeType` enum) → dispatch and serialization only.** Rule-manifest routing, plan formatter, EXPLAIN. It is deliberately *not* the class-narrowing mechanism: it is not 1:1 with classes (e.g. `AggregateFunctionCallNode` and `ScalarFunctionCallNode` both carry `nodeType === ScalarFunctionCall`) and gives no compiler-checked narrowing.
- **Cross-class capability detection → typed marker interfaces with a compiler-enforced brand, detected by centralized type guards in `characteristics.ts`.** This ticket. Replaces the duck-typed `CapabilityDetectors`.

Physical characteristics (readonly, ordering, FDs, determinism, …) remain what they already are: read off `PlanNode.physical` via `PlanNodeCharacteristics`. That is a separate, already-canonical surface and is **not** touched here.

### Why a brand, not `instanceof`, for capabilities

A capability is implemented by a **closed but base-class-less family**. Concretely today:

- `AggregationCapable` is duck-matched on `AggregateNode` (logical) **and** `StreamAggregateNode` **and** `HashAggregateNode` (physical) — and those three extend `PlanNode` directly, sharing **no** common base. An `instanceof AggregateNode` guard would silently stop matching the two physical variants — a behavior change that breaks `rule-aggregate-streaming` / `rule-fanout-lookup-join`.
- `JoinCapable`: `JoinNode`, `MergeJoinNode`, `BloomJoinNode`.
- `TableAccessCapable`: `TableReferenceNode` plus the `TableAccessNode` abstract base and its subclasses.

So `instanceof`-against-a-set is *possible* but re-introduces the exact silent-miss failure mode we are removing: add a new physical aggregate node, forget to add it to the guard's `||` chain, and detection silently drops it.

A **brand** makes the contract compiler-enforced: a class that writes `implements AggregationCapable` fails to compile unless it also sets the brand field, so "implements the capability" and "is detected as having the capability" become the same fact. This is precisely the ticket's success criterion: *the type system catches mistakes.*

## Design — the brand mechanism

Give each capability interface a unique, literal-typed, readonly boolean brand and detect it with a typed (non-`any`) guard.

```ts
// framework/characteristics.ts
export interface AggregationCapable extends RelationalPlanNode {
  /** Capability brand — set to true by every implementer; enables total, misfire-proof detection. */
  readonly isAggregationCapable: true;
  getGroupingKeys(): readonly ScalarPlanNode[];
  // …existing members…
}

static isAggregating(node: PlanNode): node is AggregationCapable {
  // Typed partial cast — NOT `as any`; lint-clean. Unique brand name cannot
  // misfire on an incidental property.
  return (node as Partial<AggregationCapable>).isAggregationCapable === true;
}
```

```ts
// nodes/aggregate-node.ts, stream-aggregate.ts, hash-aggregate.ts
export class AggregateNode extends PlanNode implements UnaryRelationalNode, AggregationCapable {
  readonly isAggregationCapable = true as const;
  // …
}
```

Rules to hold:

- The brand field is `readonly <name> = true as const` (or `readonly <name>: true` satisfied by an initializer). Name = `is<Capability>Capable` (e.g. `isJoinCapable`, `isPredicateCapable`). Unique per interface.
- Every guard becomes a single brand comparison. Keep the existing `if (!node) return false;` null-guards where present (some call sites pass possibly-null nodes).
- Guards return the same `node is XCapable` predicate as today — callers are unchanged.
- `characteristics.ts` must end this ticket with **zero `as any`** and the top-of-file `/* eslint-disable @typescript-eslint/no-explicit-any */` **removed**. Use `Partial<X>` casts.

### The two documented non-brand discriminants (keep, with a comment)

Two guards distinguish classes whose *shape* is brand-ambiguous. After branding, they should still work purely on the brand — but verify and keep the rationale comment:

- **`isAggregateFunction` vs `isWindowFunction`.** `AggregateFunctionCallNode` and `WindowFunctionCallNode` are both scalar function-call nodes. Give `AggregateFunctionCallNode` the `AggregateFunctionCapable` brand and `WindowFunctionCallNode` the `WindowFunctionCapable` brand — the brands are distinct, so no schema/`nodeType` tiebreak is needed anymore. This **removes** the `isAggregateFunctionSchema` null-throw tripwire noted in `planner-type-discriminator-defects` (that path disappears with the brand). Confirm `ScalarFunctionCallNode` does **not** carry the aggregate brand.
- If any residual case genuinely needs `nodeType` (none is expected once brands land), leave a `NOTE:` comment stating why the brand alone is insufficient.

## The capability inventory (starting point — verify against `implements` before editing)

Interfaces already declared via `implements` on their node classes:

| Capability interface | Implementers (current) |
|---|---|
| `AggregationCapable` | `AggregateNode`; **plus** `StreamAggregateNode`, `HashAggregateNode` (today matched only by duck typing — add `implements`) |
| `JoinCapable` | `JoinNode`, `MergeJoinNode`, `BloomJoinNode` |
| `PredicateCapable` | `FilterNode` |
| `PredicateSourceCapable` | `FilterNode`, `JoinNode`, `MergeJoinNode`, `BloomJoinNode` |
| `SortCapable` | `SortNode` |
| `LimitCapable` | `LimitOffsetNode` |
| `ProjectionCapable` | `ProjectNode` |
| `CacheCapable` | `CacheNode` |
| `CTECapable` | `CTENode` |
| `TableAccessCapable` | `TableReferenceNode`, `TableAccessNode` (abstract base of `SeqScan`/`IndexScan`/`IndexSeek`) |
| `ColumnBindingProvider` | `TableReferenceNode` |

Interfaces detected today **without** any `implements` declaration (informal — you must add `implements` AND the brand):

| Capability interface | Node class | File |
|---|---|---|
| `ColumnReferenceCapable` | `ColumnReferenceNode` | `nodes/reference.ts` |
| `WindowFunctionCapable` | `WindowFunctionCallNode` | `nodes/window-function.ts` |
| `AggregateFunctionCapable` | `AggregateFunctionCallNode` | `nodes/aggregate-function.ts` |
| `RecursiveCTERefCapable` | (internal recursive-CTE ref node) | grep `RecursiveCTERefCapable` / `workingTableDescriptor` |

**Do not trust this table blindly.** The correct implementer set for each brand is exactly the set of concrete classes the *current duck-typed guard accepts*. Before converting a guard, enumerate what it matches (see the behavior-preservation test below) and brand precisely that set — no more, no less. A missed class = a silent detection regression; an over-branded class = a false positive.

## Edge cases & interactions

- **Base-class-less families.** `AggregationCapable` (3 classes), `JoinCapable` (3), `TableAccessCapable` (base + subclasses). Each member must carry the brand. `TableAccessNode` is abstract — brand on the base; instance field is inherited by `SeqScan`/`IndexScan`/`IndexSeek`, so confirm those subclasses don't need their own initializer (they inherit it) and that `TableReferenceNode` (separate class) also gets it.
- **Shared `nodeType`.** `ScalarFunctionCall` is worn by both `AggregateFunctionCallNode` and `ScalarFunctionCallNode`. Only the former gets `AggregateFunctionCapable`. Add a test asserting a real `ScalarFunctionCallNode` is **rejected** by `isAggregateFunction` (this is the exact defect class the predecessor ticket hardened).
- **Window vs aggregate function.** Both scalar; ensure `isWindowFunction(aggregateFnNode) === false` and `isAggregateFunction(windowFnNode) === false`.
- **Null / undefined inputs.** Preserve the `if (!node) return false;` prefixes on `isColumnReference`, `isWindowFunction`, `isAggregateFunction`, `isRecursiveCTERef`. A `Partial<X>` cast on `null` would throw on property access order — keep the null-guard first.
- **Interface satisfaction fallout.** Adding `implements XCapable` forces the class to actually satisfy `X`. Every listed class already exposes the members (the guards assert them today), so this should compile; if a member is missing, that is a real latent gap — fix it, do not weaken the interface.
- **Brand name collisions.** Confirm no existing field on any node class already uses the chosen brand name.
- **Import cycles.** `characteristics.ts` needs no new value imports (guards test brands, not classes), so no new cycle. Node classes keep importing the capability interfaces as **type-only** imports — verify they stay `import type` so no runtime cycle is introduced.
- **`isCached` double duty.** `CachingAnalysis.isCacheable` calls `CapabilityDetectors.isCached(node) && (node as any).isCached()`. After branding, the `(node as any).isCached()` call should become `node.isCached()` on the narrowed `CacheCapable` — drop that stray `as any` too.
- **Physical vs logical join phase.** `coverage-prover` / `query-rewrite-matcher` call `isJoin` during the rewrite phase over logical plans; branding logical `JoinNode` covers them. If any physical join node is also reached, brand it — the behavior-preservation test catches a miss.

## Verification

- **Behavior-preservation test (the crux).** For every converted guard, construct one real instance of each class in its implementer set and assert the branded guard returns `true`; construct a structurally-similar look-alike (e.g. a `ScalarFunctionCallNode` for `isAggregateFunction`, a plain relational node for `isAggregating`) and assert `false`. Explicitly include `StreamAggregateNode` and `HashAggregateNode` in the `isAggregating` positive set — that is the case a naive `instanceof AggregateNode` guard would have broken.
- Extend the existing `test/optimizer/characteristics.spec.ts` (already holds `isColumnBindingProvider` / `isAggregateFunction` regression tests from the predecessor ticket).
- The full logic/golden-plan suite is the integration safety net: a missed brand makes a consuming rule stop firing, which surfaces as a golden-plan diff.

## TODO

### Phase 1 — brand the interfaces and implementers
- Add a unique `readonly is<Capability>Capable: true` brand to each capability interface in `characteristics.ts`.
- For each implementer in the inventory, add the brand initializer; add `implements XCapable` to the four informal classes (`ColumnReferenceNode`, `WindowFunctionCallNode`, `AggregateFunctionCallNode`, recursive-CTE-ref node) and to `StreamAggregateNode` / `HashAggregateNode`.
- Verify each `implements` compiles (interface actually satisfied); fix any genuine member gap.

### Phase 2 — convert the guards
- Rewrite every `CapabilityDetectors.is*` guard to a single brand comparison (keep null-guards).
- Confirm `isAggregateFunction` / `isWindowFunction` need no schema/`nodeType` tiebreak once branded; delete the `isAggregateFunctionSchema` dependency from that guard if it becomes unused there, and drop the null-throw `NOTE:`.
- Remove every `as any` in `characteristics.ts` (incl. the `isCached()`/`getValue`-style call-site casts) and delete the file-level `eslint-disable` header.

### Phase 3 — tests and validation
- Add the behavior-preservation tests above.
- `yarn workspace @quereus/quereus run lint` (eslint + `tsc -p tsconfig.test.json`) → must be clean, streaming: `... 2>&1 | tee /tmp/lint.log; tail -n 40 /tmp/lint.log`.
- `yarn workspace @quereus/quereus run test 2>&1 | tee /tmp/test.log; tail -n 60 /tmp/test.log` → green.
