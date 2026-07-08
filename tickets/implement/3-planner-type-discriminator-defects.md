description: Fix two broken "what kind of node is this?" checks in the query optimizer (one has redundant dead code, one matches on incidental fields), and delete two unused detection features that could mislead future work.
prereq:
files: packages/quereus/src/planner/framework/characteristics.ts, packages/quereus/src/planner/nodes/aggregate-function.ts, packages/quereus/src/planner/nodes/function.ts, packages/quereus/src/schema/function.ts, packages/quereus/test/optimizer/characteristics.spec.ts, packages/quereus/test/planner/framework.spec.ts
difficulty: medium
----

## Context

`framework/characteristics.ts` holds duck-typed predicates the optimizer uses to ask "what
kind of node / what can this node do?" (`CapabilityDetectors.*`). Four concrete problems, all
in that one file. The broader "pick one canonical discrimination mechanism" redesign is tracked
separately in `planner-type-discrimination-canonical` (still in `plan/`, mechanism not yet
chosen). This ticket fixes the live defects and removes dead surface now, independent of that
decision.

## Findings from the fix investigation (state of the code as of this ticket)

Verified against current `characteristics.ts`. Note the code has **drifted** from the original
bug report, so read carefully:

### 1. `isColumnBindingProvider` (line 370-373) — dead disjunct, not a live misfire

Current body:
```ts
return 'getBindingRelationName' in node &&
    (typeof (node as any).getBindingRelationName === 'string' || typeof (node as any).getBindingRelationName === 'function');
```
`getBindingRelationName` is a **method**, so `typeof` is always `'function'`. The
`=== 'string'` disjunct can never be true — dead code — but the `|| === 'function'` clause
makes the detector currently *work*. So this is a cleanup (remove the dead `=== 'string'`
disjunct), not a behavior fix. There are **no production callers** today (only the definition;
`TableReferenceNode` in `nodes/reference.ts:249-263` is the sole implementer). Keep the detector
(the redesign or a future caller will use it), just make it canonical:
```ts
static isColumnBindingProvider(node: PlanNode): node is ColumnBindingProvider {
    return 'getBindingRelationName' in node &&
        typeof (node as any).getBindingRelationName === 'function';
}
```
This matches the shape of every sibling detector (`isSortable`, `isLimit`, etc.).

### 2. `isAggregateFunction` (line 423-434) — keys off incidental property presence

Current body checks presence of `functionName` (string) + `isDistinct` (boolean) + `args`
(array) + `'functionSchema' in node`. Any node that later grows those same-named members would
wrongly acquire aggregate status. Use a **real, intentional discriminator**.

The canonical "is this an aggregate" test used ~everywhere else in the planner is
`isAggregateFunctionSchema(schema)` (from `schema/function.js`). Aggregates are always
`AggregateFunctionCallNode` (`nodes/aggregate-function.ts`), which carries a
`functionSchema` that satisfies `isAggregateFunctionSchema`. Critically:
- `AggregateFunctionCallNode` and `ScalarFunctionCallNode` (`nodes/function.ts`) **share**
  `nodeType === PlanNodeType.ScalarFunctionCall`, so `nodeType` alone cannot discriminate.
- `ScalarFunctionCallNode` carries a *scalar* schema and exposes `operands` (not `args`);
  the aggregate/scalar split is decided at build time via `isAggregateFunctionSchema` in
  `building/function-call.ts:67`, so a scalar node never carries an aggregate schema.

**Recommended discriminator — schema guard** (no coupling to concrete node classes, keeps
this file duck-typed as it is today, matches the codebase's de-facto aggregate test):
```ts
static isAggregateFunction(node: PlanNode): node is AggregateFunctionCapable {
    return PlanNodeCharacteristics.isScalar(node) &&
        'functionSchema' in node &&
        isAggregateFunctionSchema((node as any).functionSchema);
}
```
Add `import { isAggregateFunctionSchema } from '../../schema/function.js';` (type import of
`FunctionSchema` if needed for the cast).

**Alternative — class check** `node instanceof AggregateFunctionCallNode`. Equally intentional
and matches the ~179 existing `instanceof` uses, but couples `characteristics.ts` to a concrete
node class (a coupling the file currently avoids) and the redesign flags `instanceof`'s
cross-bundle awkwardness as a concern. Prefer the schema guard; if a circular-import problem
surfaces, fall back to `instanceof`. **Note whichever you pick in a code comment** so the
redesign can converge on it.

Callers to re-verify after the change (all should still behave identically for real aggregates):
`building/function-call.ts:20`, `building/select-aggregates.ts:265,639`,
`building/select-projections.ts:21,110,192`.

### 3. `PredicateAnalysis` (line 537-558) — dead class, unsafe-defaulting stub

No callers anywhere in `packages/quereus` (verified: only the definition). Its private
`predicateReferencesOnly` stub `// TODO` returns `true` — the *unsafe* default (claims a
predicate is analyzable/pushdown-safe when it was never analyzed). Delete the whole class.

### 4. `CapabilityRegistry` (line 448-479) — registered into, never queried

No production code queries it (`hasCapability` / `getCapable` / `getAllCapabilities` appear
only in tests). Delete the class **and** the 12 `CapabilityRegistry.register(...)` calls at the
bottom of the file (lines 561-572). The registered detectors themselves stay (they're called
directly elsewhere); only the registry wrapper is dead weight.

## Expected behavior

- `isColumnBindingProvider` identifies column-binding providers via the method's existence as a
  function; no dead `=== 'string'` disjunct.
- `isAggregateFunction` identifies aggregates via a real marker (aggregate schema guard, or
  class check), so unrelated same-named members on other nodes cannot flip the result.
- No `PredicateAnalysis` class; no `CapabilityRegistry` class or its registrations.
- Build + tests green.

## TODO

- [ ] Rewrite `isColumnBindingProvider` to the function-only form above.
- [ ] Rewrite `isAggregateFunction` to use `isAggregateFunctionSchema(functionSchema)` (add the
      import); add a one-line code comment naming the chosen discriminator and why.
- [ ] Delete the `PredicateAnalysis` class (lines ~534-558).
- [ ] Delete the `CapabilityRegistry` class (lines ~445-479) and all `CapabilityRegistry.register(...)`
      calls (lines ~560-572).
- [ ] Update tests: remove the `CapabilityRegistry` import + its `describe` blocks in
      `test/optimizer/characteristics.spec.ts` (import line 12, block lines 78-109) and
      `test/planner/framework.spec.ts` (import line 24, block lines 716-755). Do **not** skip —
      delete the now-obsolete blocks.
- [ ] Add a regression test for `isColumnBindingProvider`: a mock/real node whose
      `getBindingRelationName` is a function is detected; a bare node is not. (Put in
      `test/planner/framework.spec.ts` alongside the other `CapabilityDetectors` cases.)
- [ ] Add a regression test for `isAggregateFunction`: an `AggregateFunctionCallNode` (aggregate
      schema) is detected; a `ScalarFunctionCallNode` (scalar schema) is not; a plain node that
      merely has a `functionName`/`isDistinct`/`args` shape but no aggregate schema is not.
- [ ] Confirm no re-export of `PredicateAnalysis` / `CapabilityRegistry` outside this file
      breaks (grep was clean across `packages/quereus`; a build pass confirms).
- [ ] `yarn workspace @quereus/quereus run lint` (type-checks test files too) and
      `yarn test` green. Stream long output with `2>&1 | tee`.

## Handoff notes for the reviewer

- The original fix report described `isColumnBindingProvider` as "can never match"; the code had
  already gained a `|| === 'function'` disjunct since, so it worked — this ticket only strips the
  dead `=== 'string'` clause. Behavior for that detector is unchanged.
- `isAggregateFunction` and `PredicateAnalysis`'s unsafe stub were **latent** (no current
  misfire / no callers), so there's no black-box repro; the regression tests lock in the
  intended semantics.
- Discriminator choice for `isAggregateFunction` intentionally anticipates
  `planner-type-discrimination-canonical`; if that redesign later standardizes on a different
  mechanism, this one site follows.
