description: Review window MIN/MAX return-type fidelity — schema gained inferReturnType, WindowFunctionCallNode now accepts argTypes and consults it in getType(), both build sites thread argument logical types in, and window MIN/MAX derive their argument's type instead of fixed REAL
files:
  - packages/quereus/src/schema/window-function.ts                       # WindowFunctionSchema.inferReturnType added
  - packages/quereus/src/planner/nodes/window-function.ts                # argTypes ctor param + inferReturnType consult in outputTypeCache
  - packages/quereus/src/planner/building/expression.ts                  # window branch builds args, passes argTypes (~line 235)
  - packages/quereus/src/planner/building/select-window.ts               # buildWindowPhase: args built first, argTypes threaded into re-created nodes
  - packages/quereus/src/func/builtins/builtin-window-functions.ts       # MIN/MAX inferReturnType added
  - packages/quereus/test/planner/window-function-types.spec.ts          # +4 type-fidelity / regression assertions
difficulty: medium

# Review: window MIN/MAX return-type fidelity

## What changed

The window forms of `MIN`/`MAX` previously declared a fixed `returnType` of REAL
(nullable) while their `step`/`final` pass the argument value through unchanged —
so `min(text_col) over (...)` reported REAL at plan time but produced TEXT at
runtime. This mirrors the aggregate `min`/`max` case already solved by
`minFunc`/`maxFunc` (`aggregate.ts:90,114`).

Implemented exactly along the ticket's "chosen approach" — inference lives in ONE
place (the node), fed argument logical types by the builders:

- **`schema/window-function.ts`** — added optional
  `inferReturnType?: (argTypes: ReadonlyArray<DeepReadonly<LogicalType>>) => ScalarType`
  to `WindowFunctionSchema`, mirroring `AggregateFunctionSchema`. New imports:
  `DeepReadonly` (`../common/types.js`), `LogicalType` (`../types/logical-type.js`).

- **`planner/nodes/window-function.ts`** — added optional ctor param
  `argTypes?: ReadonlyArray<DeepReadonly<LogicalType>>`, placed **after `alias`,
  before `estimatedCostOverride`** (non-breaking — no caller passes
  `estimatedCostOverride` positionally; verified via `find_references`). In the
  `outputTypeCache` factory: when the resolved schema has `inferReturnType` AND
  `argTypes` is present and non-empty → `schema.inferReturnType(argTypes)`; else
  `schema.returnType`; else the existing unknown-function REAL-nonnullable fallback.

- **`planner/building/expression.ts`** (window branch) — builds the arg
  expressions (`expr.function.args.map(a => buildExpression(ctx, a, false))`),
  maps to logical types, passes as `argTypes` (with `alias` left `undefined`).
  These built nodes exist only to derive types here; the authoritative arg nodes
  are (re)built in select-window.

- **`planner/building/select-window.ts`** (`buildWindowPhase`) — reordered so
  `buildWindowFunctionArguments` runs **first**, fed the original nodes
  (`functions.map(({ func }) => func)`), then each re-created
  `WindowFunctionCallNode` gets `functionArguments[i].map(a => a.getType().logicalType)`
  as `argTypes`. `functionArguments` still flows into `WindowNode` unchanged.
  `buildWindowFunctionArguments` param renamed `windowFuncsWithAlias`→`windowFuncs`
  (it now receives originals; body only reads `.expression`/`.functionName`).

- **`builtin-window-functions.ts`** — window MIN and MAX gained
  `inferReturnType: (argTypes) => ({ typeClass:'scalar', logicalType: argTypes[0], nullable:true, isReadOnly:true })`.
  The fixed `returnType: REAL` is retained as the no-arg-types fallback.

`WindowNode.withChildren`/`withStreaming` reuse `this.functions`, so the
`argTypes` carried on each node persist through optimization unchanged (verified
in `window-node.ts` — both reconstruct from `this.functions`).

## Validation performed (this is the floor, not the ceiling)

- `yarn workspace @quereus/quereus run lint` — **green** (eslint + `tsc -p
  tsconfig.test.json`, so spec call-sites type-check too).
- `yarn workspace @quereus/quereus run test` — **6118 passing, 9 pending, 0
  failing**. No sqllogic snapshots required updating (see below).
- New assertions in `window-function-types.spec.ts` (all via the existing
  `getWindowFunctionTypesFromPlan` helper, which reads `w.functions[i].getType()
  .logicalType.name` off the `WindowNode`):
  - `min(v)`/`max(v) over ()` → TEXT (v is the TEXT column).
  - `min(id)`/`max(id) over ()` → INTEGER.
  - `min(id || '') over ()` → TEXT — expression argument whose type (TEXT) differs
    from both the column type (INTEGER) and the REAL fallback, proving the built
    expression's logical type flows through (not just bare column refs).
  - regression: `sum(id)`→REAL, `count(id)`→INTEGER, `row_number()`→INTEGER
    unchanged even though argTypes now flow into every window node.

## Reviewer attention / known gaps

- **Surrounding-expression inference is NOT directly pinned.** The ticket calls
  out `min(text_col) over (...) || 'x'` — the `expression.ts` node's `getType()`
  must be TEXT so the outer `||` types correctly. Both build sites supply
  `argTypes`, and the `id || ''` test exercises the expression path on the
  *WindowNode* side, but there is no test asserting the **outer `||` result type**
  off the projection/expression tree. The helper only inspects `WindowNode.functions`,
  so a dedicated assertion would need to read the projection output column type
  (or `db.prepare(sql).getColumnType(...)`). Worth adding if the reviewer wants
  the expression-tree path locked down. I believe it is correct (the
  `expression.ts` node now receives the same `argTypes`) but it is unverified by
  an explicit test.

- **No runtime-value test for `min(text) over`.** All new tests are plan-time
  type assertions (`db.getPlan`). The full sqllogic suite covers MIN/MAX runtime
  over INTEGER columns (`test/logic/07.5-window.sqllogic`), which still pass
  unchanged — confirming the type change does not float-coerce window output
  (expected snapshots already showed integers like `{"rm":10}` under the old REAL
  declaration). But there is no end-to-end test of `min`/`max` over a TEXT (or
  BLOB) column actually returning/comparing TEXT at runtime. Behavior is believed
  correct (step/final pass values through unchanged), just not pinned.

- **Sqllogic snapshots untouched — intentional.** Reviewer should confirm: all
  `min/max over` cases in `07.5-window.sqllogic` / `27-window-edge-cases.sqllogic`
  are over INTEGER columns; their expected JSON already shows integers, so the
  REAL→INTEGER type tightening produced no diff. The passing suite corroborates.

- **Minor duplicate arg-building.** `expression.ts` builds the window arg
  expressions purely to extract `argTypes`, then discards the nodes (the real
  arg nodes are rebuilt in select-window). This is inherent to the chosen
  single-source-of-truth approach (zero-ary node can't carry arg children) and is
  cheap, but flagged as a deliberate tradeoff, not an oversight.

- **Aside (not introduced here):** integer literal `1` types as REAL, so
  `id + 1` derives REAL — which is why the expression-arg test uses `id || ''`
  (TEXT) instead, to stay distinguishable from the REAL fallback. Pre-existing
  planner behavior; no change made.

## Acceptance — met

- `min/max(text) over` derive TEXT, numeric `min/max over` derive their numeric
  arg type, expression args flow through — pinned in `window-function-types.spec.ts`.
- All other window functions keep their declared `returnType` (SUM/COUNT/ROW_NUMBER
  regression pinned).
- `lint` and `test` green.
