description: Review the cleanup of two node-kind checks in the query optimizer and the removal of two unused detection features, confirming no behavior drift and that the new intentional aggregate discriminator is sound.
prereq:
files: packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/nodes/aggregate-function.ts, packages/quereus/src/planner/nodes/function.ts, packages/quereus/src/schema/function.ts, packages/quereus/test/optimizer/characteristics.spec.ts, packages/quereus/test/planner/framework.spec.ts
difficulty: medium
----

## What was done

All four defects in `packages/quereus/src/planner/framework/characteristics.ts` fixed;
`lint` (eslint + `tsc -p tsconfig.test.json`) and full `yarn test` (6524 quereus passing / 9
pending, every other package green — 4m10s wall clock) both green.

### 1. `isColumnBindingProvider` — dead disjunct removed (no behavior change)
Was:
```ts
return 'getBindingRelationName' in node &&
    (typeof (node as any).getBindingRelationName === 'string' || typeof (node as any).getBindingRelationName === 'function');
```
Now:
```ts
return 'getBindingRelationName' in node &&
    typeof (node as any).getBindingRelationName === 'function';
```
`getBindingRelationName` is a method → `typeof` is always `'function'`; the `=== 'string'`
disjunct was unreachable. Detector already worked via the `'function'` clause, so this is pure
cleanup — **behavior identical**. No production callers today (sole implementer:
`TableReferenceNode`, `nodes/reference.ts`); kept for the pending
`planner-type-discrimination-canonical` redesign / future callers.

### 2. `isAggregateFunction` — now keys off a real discriminator
Was: presence of `functionName`(string) + `isDistinct`(bool) + `args`(array) + `'functionSchema' in node`.
Now:
```ts
return PlanNodeCharacteristics.isScalar(node) &&
    'functionSchema' in node &&
    isAggregateFunctionSchema((node as any).functionSchema);
```
Chose the **schema guard** (not `instanceof AggregateFunctionCallNode`) to keep the file
duck-typed and free of concrete node-class coupling; rationale is written into a code comment at
the site so the redesign can converge on it. `isAggregateFunctionSchema` (`schema/function.ts`)
tests `'stepFunction' in schema && 'finalizeFunction' in schema` — the aggregate/scalar split is
already decided at build time via that same guard (`building/function-call.ts`), so an
`AggregateFunctionCallNode` carries an aggregate schema and a `ScalarFunctionCallNode` carries a
scalar one. Both node classes share `nodeType === ScalarFunctionCall`, so nodeType alone can't
discriminate — the schema is the intentional marker.

### 3. `PredicateAnalysis` class — deleted
Dead (no callers anywhere in `packages/quereus`); its private `predicateReferencesOnly` stub
returned the unsafe default `true`.

### 4. `CapabilityRegistry` class + its 12 `register(...)` calls — deleted
No production queries (`hasCapability`/`getCapable`/`getAllCapabilities` were test-only). The
registered detectors themselves are untouched — they're still called directly elsewhere; only
the registry wrapper and its registrations were removed.

## Tests changed
- `test/optimizer/characteristics.spec.ts`: dropped `CapabilityRegistry` import + its `describe`
  block (deleted, not skipped).
- `test/planner/framework.spec.ts`: dropped `CapabilityRegistry` import + its `describe` block;
  added three regression tests (in the `CapabilityDetectors` block):
  - `isColumnBindingProvider` detects a function member; rejects a same-named **string** member.
  - `isAggregateFunction` detects a real `AggregateFunctionCallNode` (aggregate schema); rejects
    a real `ScalarFunctionCallNode` (scalar schema); rejects a plain scalar node wearing the old
    `functionName`/`isDistinct`/`args` shape but carrying no aggregate schema.

## Use cases to validate / where to look
- **Behavior-preservation of `isAggregateFunction` callers** — the real reason to review. Callers
  to eyeball: `building/function-call.ts:20`, `building/select-aggregates.ts:265,639`,
  `building/select-projections.ts:21,110,192`. All aggregate-detection paths exercised by the
  logic suite (`test/logic/*.sqllogic`, e.g. aggregate/GROUP BY files) which passed. Confirm no
  caller depended on the *old* looser shape matching a non-aggregate node (none found; the new
  guard is strictly more precise).
- **Schema-guard edge**: `isAggregateFunctionSchema` does `'x' in schema`, which throws if
  `functionSchema` is null/undefined. Real nodes always carry an object schema, and the
  `'functionSchema' in node` clause gates it. A node with `functionSchema: null` would be an
  invalid node regardless — worth a glance but not expected in practice.

## Known gaps / honest flags
- Defects #2 and #3 were **latent** (no live misfire, no callers) — there is no black-box repro
  that failed before and passes now. The regression tests lock in the *intended* semantics;
  they are the floor, not proof of a prior bug.
- The three new tests construct schemas/nodes minimally (count/abs). They don't sweep the full
  builtin aggregate/scalar catalog. A reviewer wanting more confidence could parametrize over the
  registered functions, but the discriminator is schema-shape-based so one aggregate + one scalar
  covers the branch.
- Discriminator choice intentionally anticipates `planner-type-discrimination-canonical` (still
  in `plan/`). If that redesign standardizes on a different mechanism, this one site follows —
  the code comment flags it.

## Review findings
(none pre-recorded; reviewer fills in)
