---
description: Per-attribute scalar expression property surface (injective + monotone/range-rewrite) on ScalarPlanNode
files: packages/quereus/src/planner/nodes/plan-node.ts, packages/quereus/src/planner/nodes/scalar.ts, packages/quereus/src/planner/nodes/reference.ts, packages/quereus/src/planner/nodes/function.ts, packages/quereus/src/schema/function.ts, packages/quereus/src/types/logical-type.ts, packages/quereus/test/optimizer/expression-properties.spec.ts, docs/optimizer.md
---

## Summary

Landed a first-class **per-attribute** scalar expression property surface on `ScalarPlanNode`, mirroring the existing `getType()` / `computePhysical()` / `getLogicalAttributes()` pattern. Each scalar node answers questions about itself; composite nodes answer by recursing into children — no parallel `nodeType` switch and no registry shadow.

Three new methods on `PlanNode` (declared on `ScalarPlanNode` so callers don't need null-checks):

```typescript
isInjectiveIn(inputAttrId: number): InjectivityResult;
monotonicityIn(inputAttrId: number): MonotonicityResult;  // 'increasing' | 'decreasing' | 'constant' | 'non_monotone' | 'unknown'
rangeRewriteIn(inputAttrId: number, constant: SqlValue): RangeRewrite | undefined;
```

Conservative defaults (`injective: false` / `'unknown'` / `undefined`); concrete nodes override only what they can prove. Pure-function helpers `addMonotonicity` / `negateMonotonicity` form the composition lattice.

## Per-node implementations

- **`ColumnReferenceNode`** — own-attr → `injective: true`, `'increasing'`; other-attr → `'constant'`, not injective.
- **`LiteralNode`**, **`ParameterReferenceNode`** — `'constant'` for any attribute; not injective.
- **`UnaryOpNode`** — `-` on numeric: pass-through injectivity, negate monotonicity. Unary `+`: pass-through. Other ops: conservative defaults.
- **`BinaryOpNode`** numeric `+` / `-` — `addMonotonicity(left, right)` / `addMonotonicity(left, negate(right))`. Injectivity passes through from the dependent side when the other is `'constant'`, or follows from a strictly-monotone combined direction.
- **`ScalarFunctionCallNode`** — consults new `FunctionSchema` traits: `injectiveOnArgs`, `monotoneOnArgs`, `rangeRewriteOnArg`. Identifies the unique dependent operand; composes function trait with operand's own monotonicity/injectivity.

## Function-schema traits (`packages/quereus/src/schema/function.ts`)

```typescript
injectiveOnArgs?: readonly number[];
monotoneOnArgs?: { readonly [argIndex: number]: 'increasing' | 'decreasing' };
rangeRewriteOnArg?: { readonly [argIndex: number]: { readonly kind: string } };
```

`LogicalType.bucketBounds?(kind, value)` is the optional surface for type-aware boundary computation. No built-ins are annotated yet — the surface lands first; consumer tickets follow.

## Review-stage refinement

The implementation's `rangeRewriteIn` only checked `monotonicityIn === 'increasing'` on the dependent operand. Although a code comment noted that the operand "must be an identity-like reference to attrId," the check didn't actually enforce it — `f(g(x))` with a monotone-annotated `g` would have produced bounds in `g(x)`'s value space and falsely returned them as bounds on `x`. Tightened to require the operand IS a `ColumnReferenceNode` whose `attributeId === inputAttrId` (`packages/quereus/src/planner/nodes/function.ts:163-172`), and added a regression test covering the composition-with-bucketBounds case.

## Validation

- `yarn test` (root) — 2691 passing across packages (`expression-properties.spec.ts` covers 36 tests across helper lattice, per-node defaults, composition, function-trait consultation, and `rangeRewriteIn` surface).
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn build` — clean.

## Documentation

`docs/optimizer.md` gained a "Scalar Expression Properties (per-attribute)" subsection within the Engineering Considerations area, describing the surface, the per-function traits, the composition rules, and the identity-only constraint on `rangeRewriteIn`.

## Out of scope (follow-up tickets)

- **Consumers**: extending key propagation through non-trivial projections; sargable predicate rewrites (`date(ts) = D` → `ts >= startOfDay(D) AND ts < startOfNextDay(D)`).
- **Built-in trait annotations** (e.g. `date`/`datetime` with `rangeRewriteOnArg`).
- **`LogicalType.bucketBounds`** implementations on temporal types.
- **Decreasing-direction `rangeRewriteIn`** support.
- **`*` / `/` and `||`** on `BinaryOpNode` — non-trivial sign analysis / collation considerations.
