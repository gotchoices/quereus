----
description: Window MIN/MAX return type is hard-coded REAL nullable but should follow the argument type; add inferReturnType to the window-function schema and thread argument types into WindowFunctionCallNode so MIN/MAX over a typed column derives that column's type
files:
  - packages/quereus/src/schema/window-function.ts                       # WindowFunctionSchema — add inferReturnType field
  - packages/quereus/src/planner/nodes/window-function.ts                # WindowFunctionCallNode — accept argTypes, consult inferReturnType in getType()
  - packages/quereus/src/planner/building/expression.ts                  # window branch (~line 235) — build args, pass argTypes
  - packages/quereus/src/planner/building/select-window.ts               # re-creation site (~line 60-70) — build args first, pass argTypes
  - packages/quereus/src/func/builtins/builtin-window-functions.ts       # MIN (~206) / MAX (~227) — add inferReturnType
  - packages/quereus/src/func/builtins/aggregate.ts                      # minFunc/maxFunc — the pattern being mirrored (reference only)
  - packages/quereus/test/planner/window-function-types.spec.ts          # add MIN/MAX type-fidelity assertions
difficulty: medium
----

# Window MIN/MAX return-type fidelity

The window forms of `MIN`/`MAX` in `builtin-window-functions.ts` declare a fixed
`returnType` of `REAL_TYPE` nullable, but their `step`/`final` pass the argument
value through unchanged. So `min(text_col) over (...)` returns TEXT at runtime
while the planner derives REAL — the window analogue of the aggregate
`min`/`max` type-fidelity case, which `minFunc`/`maxFunc`
(`aggregate.ts:90`/`114`) already solve with
`inferReturnType: (argTypes) => ({ ...logicalType: argTypes[0], nullable: true })`.

## Architecture / why this isn't a one-liner

The aggregate path (`function-call.ts:65-107`) builds the call's argument plan
nodes, derives `argTypes = args.map(a => a.getType().logicalType)`, calls
`schema.inferReturnType(argTypes)`, and stores the result as `_inferredType` on
`AggregateFunctionCallNode`, whose `getType()` returns it.

The window path differs in two structural ways that this ticket must accommodate:

- **`WindowFunctionCallNode` is zero-ary** (`ZeroAryScalarNode`,
  `getChildren()` returns `[]`). It does **not** carry its argument plan nodes —
  the args live in the AST (`expression.function.args`) and are built
  separately. So `getType()` cannot pull arg types from children; the types must
  be supplied to the node.

- **There are two construction sites.** `expression.ts` (the `windowFunction`
  case, ~line 235) builds the original node during expression building.
  `select-window.ts` (`buildWindowPhase`, ~line 60-68) *re-creates* fresh
  `WindowFunctionCallNode` instances for the `WindowNode`, then builds their
  argument expressions via `buildWindowFunctionArguments` (~line 70). The
  authoritative downstream type comes from the **select-window** nodes —
  `WindowNode.getType()` / `getAttributes()` (`window-node.ts:94`, `118`) call
  `func.getType()` on them, and the existing planner test reads them. But the
  `expression.ts` node's type still feeds surrounding-expression inference
  (e.g. `min(text_col) over (...) || 'x'`), so **both** sites must supply types.

### Chosen approach

Keep the inference logic in ONE place — the node — by passing it the built
arguments' logical types and letting `getType()` call `inferReturnType`:

1. **Schema** (`window-function.ts`): add an optional
   `inferReturnType?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ScalarType;`
   to `WindowFunctionSchema`, mirroring `AggregateFunctionSchema.inferReturnType`
   exactly (import `DeepReadonly` from `../common/types.js`, `LogicalType` from
   `../types/logical-type.js`).

2. **Node** (`window-function.ts`): add an optional constructor param
   `argTypes?: ReadonlyArray<DeepReadonly<LogicalType>>` (place it after `alias`,
   before the existing `estimatedCostOverride` — no current caller passes
   `estimatedCostOverride` positionally, so this is non-breaking). Store it. In
   the `outputTypeCache` factory: when the resolved schema has `inferReturnType`
   **and** `argTypes` is present and non-empty, return
   `schema.inferReturnType(argTypes)`; otherwise fall back to
   `schema.returnType`; otherwise the existing unknown-function REAL fallback.

3. **`expression.ts` window branch** (~line 235): build the arg expressions
   (`expr.function.args.map(a => buildExpression(ctx, a, false))`), map to
   `argTypes`, and pass them to the constructor. (These built nodes are only
   needed for their types here; the real arg nodes are built in select-window.)

4. **`select-window.ts`** (`buildWindowPhase`): reorder so arguments are built
   *before* the nodes. `buildWindowFunctionArguments` reads `func.expression` /
   `func.functionName` off the originals — refactor it to take the original
   `functions` list (`functions.map(f => f.func)`) instead of the re-created
   nodes, call it first, then construct each `WindowFunctionCallNode` passing
   `functionArguments[i].map(a => a.getType().logicalType)` as `argTypes`. The
   resulting `functionArguments` still flows into the `WindowNode` unchanged.

5. **MIN / MAX schemas** (`builtin-window-functions.ts`): add
   `inferReturnType: (argTypes) => ({ typeClass: 'scalar', logicalType: argTypes[0], nullable: true, isReadOnly: true })`
   to both. Leave the existing `returnType: REAL_TYPE` nullable in place as the
   no-arg-types fallback.

`WindowNode.withChildren` / `withStreaming` reuse `this.functions`, so the
`argTypes` carried on each node persist through optimization unchanged — no
change needed there.

## Edge cases & interactions

- **Typed columns**: `min(text_col)`, `max(blob_col)`, `min(int_col)`,
  `max(real_col)` over a window each derive the column's logical type
  (TEXT / BLOB / INTEGER / REAL), not REAL. Nullable stays true.
- **Expression argument**: `min(id + 1) over (...)` derives the arithmetic
  result's logical type, exercising the `argTypes` plumbing (not just bare
  column refs).
- **Surrounding-expression inference**: `min(text_col) over (...) || 'x'` — the
  `expression.ts` node's `getType()` must already be TEXT so the outer `||`
  types correctly; confirms both build sites supply `argTypes` consistently
  (the WindowNode column type and the expression-tree type must agree).
- **COUNT(\*) window**: no args; `buildWindowFunctionArguments` synthesizes a
  literal `1`. COUNT has fixed INTEGER `returnType` and no `inferReturnType`, so
  it is unaffected — but verify the empty/synthetic-arg path doesn't throw and
  COUNT still derives INTEGER.
- **Functions without `inferReturnType`** (ROW_NUMBER, RANK, SUM, AVG, LAG,
  LEAD, FIRST_VALUE, LAST_VALUE, NTILE, PERCENT_RANK, CUME_DIST): must keep
  returning their fixed `schema.returnType` — the `argTypes`-present-but-no-
  `inferReturnType` branch falls through to `returnType`. Regression-check at
  least SUM (REAL), COUNT (INTEGER), ROW_NUMBER (INTEGER).
- **Unknown window function**: the existing REAL-nonnullable fallback path must
  remain reachable when `resolveWindowFunction` returns undefined.
- **`argTypes` empty guard**: only call `inferReturnType` when `argTypes` is
  non-empty, so a hypothetical zero-arg call can't produce an `undefined`
  `logicalType`. (MIN/MAX are `argCount: 1`, validated upstream, so this is
  defense-in-depth.)
- **Distinct nodes / fingerprinting**: `fingerprintExpression` for window nodes
  uses name + node id, not `getType()`, so the new param is inert there. The
  existing `expression-fingerprint.spec.ts` 4-arg constructor calls must still
  compile (param is optional and appended).

## Acceptance

- `min(text_col) over (...)` / `max(text_col) over (...)` derive the argument's
  logical type (TEXT), and numeric `min/max over` derive their numeric arg type
  — pinned in `window-function-types.spec.ts` via the existing
  `getWindowFunctionTypesFromPlan` helper (reads `w.functions[i].getType()
  .logicalType.name` off the `WindowNode`).
- All other window functions keep their declared `returnType` (regression
  assertions for SUM/COUNT/ROW_NUMBER).
- `yarn workspace @quereus/quereus run lint` and `... run test` green.

## TODO

- Add `inferReturnType` to `WindowFunctionSchema` in `schema/window-function.ts`
  (with `DeepReadonly` / `LogicalType` imports), mirroring the aggregate schema.
- Add the optional `argTypes` constructor param to `WindowFunctionCallNode` and
  consult `schema.inferReturnType` in the `outputTypeCache` factory, with the
  non-empty guard and `returnType` fallback.
- Update the `expression.ts` `windowFunction` branch to build args and pass
  `argTypes`.
- Update `buildWindowPhase` / `buildWindowFunctionArguments` in `select-window.ts`
  to build args first (from the original `functions`) and pass `argTypes` into
  each re-created node.
- Add `inferReturnType` to window `MIN` and `MAX` in
  `builtin-window-functions.ts`.
- Extend `window-function-types.spec.ts`: assert `min(v)`/`max(v)` over a window
  derive TEXT, `min(id)`/`max(id)` derive INTEGER, and add a regression case
  confirming SUM/COUNT/ROW_NUMBER are unchanged. (Table `t(id integer, v text)`
  is already set up in the spec's `beforeEach`.)
- Run `yarn workspace @quereus/quereus run lint` and `... run test`; if any
  existing window logic snapshots (`test/logic/07.5-window.sqllogic`,
  `27-window-edge-cases.sqllogic`) assert a REAL type for `min/max over`, update
  them to the corrected type and note it.
