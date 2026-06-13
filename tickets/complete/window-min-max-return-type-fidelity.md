description: Window MIN/MAX return-type fidelity — window MIN/MAX now derive their return type from the argument's logical type instead of a fixed REAL, mirroring the aggregate min/max path. Reviewed, hardened with surrounding-expression + runtime coverage, and a sibling follow-up filed for the other pass-through window functions.
files:
  - packages/quereus/src/schema/window-function.ts
  - packages/quereus/src/planner/nodes/window-function.ts
  - packages/quereus/src/planner/building/expression.ts
  - packages/quereus/src/planner/building/select-window.ts
  - packages/quereus/src/func/builtins/builtin-window-functions.ts
  - packages/quereus/test/planner/window-function-types.spec.ts

# Complete: window MIN/MAX return-type fidelity

## Summary

The window forms of `MIN`/`MAX` previously declared a fixed REAL return type while
their step/final pass the argument value through unchanged, so `min(text_col) over
(...)` reported REAL at plan time but produced TEXT at runtime. The implementation
added an optional `inferReturnType(argTypes)` hook to `WindowFunctionSchema`
(mirroring `AggregateFunctionSchema`), threaded the built argument logical types
into `WindowFunctionCallNode.argTypes`, made the node consult `inferReturnType`
when arg types are present, and opted window MIN/MAX into it. Both builder sites
(`expression.ts` for the expression-tree path, `select-window.ts` for the
WindowNode) feed argument types in.

## Review findings

### Scope / correctness — verified

- **Implementation matches the design.** Inference lives in one place (the node);
  builders feed it. `WindowNode.withChildren`/`withStreaming` reuse `this.functions`,
  so `argTypes` persist through optimization (confirmed in `window-node.ts`).
- **Constructor-param insertion is non-breaking.** `argTypes` was inserted before
  `estimatedCostOverride`. Enumerated every `new WindowFunctionCallNode` call site
  (`find_references`): two production (expression.ts, select-window.ts) and the
  fingerprint spec — none passes `estimatedCostOverride` positionally. Safe.
- **Fallback chain is sound.** Node uses `inferReturnType` only when `argTypes` is
  present and non-empty; else `schema.returnType`; else the unknown-function REAL
  fallback. COUNT(*) (empty args / placeholder) and the ranking/SUM/AVG functions
  are untouched.
- **Argument-type derivation is correct** for bare columns, numeric columns, and
  built expressions (`id || ''` → TEXT), all pinned.

### Gaps the implementer flagged — now closed

The handoff honestly flagged two unpinned gaps. Both were verified correct and
pinned (minor fixes, applied in this pass) in `window-function-types.spec.ts`:

- **Surrounding-expression type** — added `flows MIN window TEXT type through a
  surrounding expression`: `min(v) over () || '!'` types the projection output
  column TEXT (reads the topmost relation's output column type via a new
  `getProjectionColumnTypes` helper). Proves the `expression.ts` build path — not
  just the WindowNode — derives the argument type.
- **Runtime value fidelity** — added `returns the argument value (not a float
  coercion) for MIN/MAX over TEXT/INTEGER at runtime`: end-to-end `db.eval`
  asserting `min(v)/max(v) over ()` return 'a'/'c' (TEXT preserved) and numeric
  min/max equal 1/3 (no float coercion of the emitted value).

Net test delta: +2 (6118 → 6120 passing).

### Major finding — follow-up ticket filed

- **The same latent bug exists for the other pass-through window functions:**
  `FIRST_VALUE`, `LAST_VALUE`, `LAG`, `LEAD` all return their argument value
  verbatim at runtime yet still declare a fixed REAL return type. The
  `inferReturnType` plumbing is now in place for them; only the registrations need
  to opt in (with care for LAG/LEAD's variadic offset/default args — use
  `argTypes[0]`). Filed as `tickets/plan/window-passthrough-return-type-fidelity.md`
  (prereq: this ticket). Deliberately out of scope here — this ticket was scoped
  to MIN/MAX.

### Docs

- `docs/window-functions.md` carries only an illustrative "Extensibility" snippet
  (already loosely drifted from the real `registerWindowFunction` signature,
  pre-existing) and makes no claim about MIN/MAX return types that the change
  contradicts. No doc correction is required for correctness; the new optional
  `inferReturnType` schema field is documented inline via the JSDoc on
  `WindowFunctionSchema`. Left the pre-existing snippet untouched to avoid scope
  creep into unrelated drift.

### Sqllogic snapshots

- Untouched, as intended. All `min/max over` cases in `07.5-window.sqllogic` /
  `27-window-edge-cases.sqllogic` are over INTEGER columns whose expected JSON
  already shows integers, so the REAL→argument-type tightening produced no diff.
  Corroborated by the full suite passing unchanged.

### Validation

- `yarn workspace @quereus/quereus run lint` — green (eslint + `tsc -p
  tsconfig.test.json`, so spec call sites type-check).
- `yarn workspace @quereus/quereus run test` — **6120 passing, 9 pending, 0
  failing**.

### Not checked / intentionally deferred

- LAG/LEAD/FIRST_VALUE/LAST_VALUE type fidelity — deferred to the follow-up ticket
  above (out of scope for MIN/MAX).
- Per-attribute optimizer rewrites that change an argument node's logical type
  after planning would not re-derive the cached `argTypes` on the reused
  `functions` node. Theoretical only — window argument types are stable through
  the existing rules; no rule observed to mutate a scalar arg's logical type. Not
  a regression introduced by this change.
