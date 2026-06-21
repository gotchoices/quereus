description: When someone binds a single SQL parameter to a whole array (instead of one value) and compares it to a normal column, the query used to quietly match no rows; it now raises a clear error instead.
prereq:
files:
  - packages/quereus/src/planner/analysis/scalar-param-usage.ts (new: logical-plan walk collecting scalar-required params)
  - packages/quereus/src/core/statement.ts (compile() stashes the set; validateParameterTypes() rejects array/object bindings)
  - packages/quereus/src/util/comparison.ts (isObjectClassValue predicate)
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts (NOTE comment updated to point at the landed guard)
  - packages/quereus/test/parameter-array-scalar.spec.ts (15 cases)
  - docs/types.md (documented the array/object scalar guard)
----

# Reject (or clearly diagnose) an array-valued scalar parameter — COMPLETE

Binding a single `?`/`:name` placeholder to a whole JS array (or plain object) and comparing it
against a scalar column previously matched **no rows silently** (the OBJECT storage class sorts above
every scalar, so the predicate was always false). It now throws `QuereusError(StatusCode.MISMATCH,
"parameter … bound to an array/object value but used in a scalar comparison")` at bind time, while the
legitimate non-scalar uses (function argument, projection, JSON-column storage, JSON-vs-JSON comparison)
keep working.

## Implementation summary (bind-time guard)

The implementer chose the **bind-time** guard over the originally-drafted per-row runtime guard, to keep
the hot comparison path untouched:

- `planner/analysis/scalar-param-usage.ts` — `collectScalarRequiredParams(plan)` walks the **logical**
  plan (before the access-path rule folds `col = ?` into an index seek, which erases the comparison node)
  and returns the set of parameter names/indices used directly (through `CAST`s) as a comparand in a
  scalar comparison (`= <> < <= > >=` / `IN` / `BETWEEN`) against a statically non-object scalar operand.
- `core/statement.ts` — `compile()` stashes that set in `scalarRequiredParams`; `validateParameterTypes()`
  (runs once per execution, before the query streams) throws `MISMATCH` when such a parameter is bound to
  an array/plain object (`isObjectClassValue`).

The single logical-plan walk subsumes all four original footgun sites (PK seek, non-indexed `=`, `IN`,
`BETWEEN`) because it walks before seek-folding. The four runtime emit sites
(`binary.ts`/`subquery.ts`/`between.ts`/`scan.ts`) were intentionally left untouched.

## Review findings

**Scope note:** the working tree carried a *second, unrelated* concurrent ticket's changes
(`engine-managed-table-tag-catalog-exclusion`: `schema/catalog.ts`, `schema/reserved-tags.ts`,
`index.ts`'s `ENGINE_MANAGED_TABLE_TAG` export, and their specs). Those were left untouched — this review
covered only the array-scalar-param diff.

### Correctness — verified, no defects
- **Node-shape assumptions confirmed** against the actual class definitions: `BinaryOpNode.{expression.operator,left,right}`,
  `BetweenNode.{expr,lower,upper}`, `InNode.{condition,source,values}`, `CastNode.operand`,
  `ParameterReferenceNode.nameOrIndex`. The CAST-unwrap loop in `paramOperand` matches the planner's CAST wrapping.
- **Traversal is sound**: `PlanNode.visit` recurses through `getChildren()`, which includes scalar children, so the
  walk reaches `BinaryOpNode`/`BetweenNode`/`InNode` nested inside `FilterNode` predicates. Confirmed it runs on the
  raw (pre-optimization) plan, so the seek case is genuinely covered.
- **Over-fire guard is sound**: `JSON_TYPE.physicalType === PhysicalType.OBJECT`, which `isScalarPhysical` excludes, so a
  JSON-column counterpart (`data = ?`) never flags the parameter. Columns of unknown/ANY type also don't flag
  (conservative: no false positive, at the cost of not diagnosing that rarer shape — acceptable).
- **Binding-key lookup** in `validateParameterTypes` matches the runtime's `emitParameterReference` keying (bare name for
  `:name`, 1-based index for `?`), with an extra `:`-prefixed fallback for robustness.
- **`compile()` is memoized**, so the added `this.compile()` at the top of `validateParameterTypes` is cheap when already planned.

### Tests — strengthened (minor, fixed inline)
The implementer's spec (11 cases) covered the happy/throw/no-over-fire table. Added **4 edge cases** that exercise
code paths the original spec left unverified:
- `id > ?` — a non-equality range comparator (only `=`/`IN`/`BETWEEN` were tested).
- `id = cast(? as integer)` — confirms the `paramOperand` CAST-unwrap actually fires.
- `? = id` — parameter on the **left** of the comparison (`consider` is called for both operands).
- a **plain object** `{lo,hi}` rather than an array (exercises `isObjectClassValue`'s non-array branch).
All 15 pass.

### Housekeeping (minor, fixed inline)
- Removed a leftover scratch debug script `dbg.mjs` (repo root) that the implementer left behind — it only re-ran
  this ticket's example queries through `query_plan(?)`.
- Documented the guard in `docs/types.md` under "Type Checking and Validation" (it was previously undocumented).
- The `NOTE (array-valued scalar param)` comment in `equalitySeekKey` was already updated by the implementer to point
  at the landed guard — verified correct.

### Not done / deferred (no new tickets)
- **IN-subquery counterpart** (`x in (select scalarcol from …)` with an array-bound `x`) is handled in code
  (`node.source.getType().columns[0]`) but has no dedicated test; it is conservative (only flags when the subquery's
  output column is statically scalar) so an un-flagged exotic shape just falls back to the prior silent-empty behavior.
  Not worth a ticket.
- **ANY/untyped-column comparands** are intentionally not flagged (would risk a false positive). Documented as the
  design tradeoff; the runtime guard remains a possible future backstop if a cheaper/earlier-fire diagnostic is ever wanted.

### Validation
- `yarn workspace @quereus/quereus lint` — clean (eslint + test typecheck), exit 0.
- `yarn workspace @quereus/quereus test` — **6397 passing, 9 pending, 0 failing**.
- Targeted spec `parameter-array-scalar.spec.ts` (15) and regression spec `parameter-types.spec.ts` (15) both green.
