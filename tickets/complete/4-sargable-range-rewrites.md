---
description: Sargable range rewrite for `f(col) op c` predicates. Initial coverage: `date(datetime_col) = D` rewrites to `datetime_col >= 'D T00:00:00' AND datetime_col < 'D+1 T00:00:00'`, so the bare-column range can be pushed into Retrieve and (when an ordered access path exists) seek-fed.
prereq:
files:
  - packages/quereus/src/planner/rules/predicate/rule-sargable-range-rewrite.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/func/builtins/conversion.ts
  - packages/quereus/src/func/registration.ts
  - packages/quereus/src/types/temporal-types.ts
  - packages/quereus/test/optimizer/sargable-range-rewrite.spec.ts
  - docs/optimizer.md
  - docs/types.md
---

## What landed

Rule `rule-sargable-range-rewrite` rewrites each FilterNode conjunct of the form `f(col) = c` (literal `c`) to the equivalent half-open range `col >= lower(c) AND col < upper(c)`. Bound computation is delegated through two layers:

1. `ScalarFunctionCallNode.rangeRewriteIn(attrId, c)` (function.ts:157–183) — guards that the operand at the trait index is a bare `ColumnReferenceNode` matching `attrId`, then reads the function's `FunctionSchema.rangeRewriteOnArg[idx].kind`.
2. `LogicalType.bucketBounds(kind, value)` — does the boundary math. `DATE_TYPE` returns `[D, D+1)` as date strings; `DATETIME_TYPE` returns `[D T00:00:00, D+1 T00:00:00)` as ISO datetime strings.

Registered at PassId.Structural (registration order is what actually runs; priority numbers are advisory) such that sargable-range-rewrite fires before aggregate-predicate-pushdown and predicate-pushdown — so the rewritten `col op literal` conjuncts ride the same pushdown wave and become visible to the constraint extractor.

Trait wiring: unary `date()` (`func/builtins/conversion.ts`) is annotated `rangeRewriteOnArg: { 0: { kind: 'date_bucket' } }`; the variadic `dateFunc` (`func/builtins/datetime.ts`, `numArgs: -1`) is intentionally not annotated — its modifiers can shift / re-bucket the result. `schema-resolution.resolveFunctionSchema` dispatches exact-arity first, so SQL `date(col)` lands on the unary form.

## Review findings

### Checked — soundness

- **Operand identity guard.** The leaf walk `findUniqueColumnReference` (in the rule file) picks an attrId, then `rangeRewriteIn` (function.ts:170) independently re-verifies the function's operand-at-trait-index IS a bare `ColumnReferenceNode` with that attrId. Both checks compose correctly for `f(col)`, `f(col, 1)`, `f(col, :p)`, and correctly decline for `f(g(col))`, `f(col + col)`, `f(col1, col2)`, scalar-subquery operands, parameter-only operands, and constant-only RHS literals.
- **Null handling.** Literal-null RHS returns `null` from the rule (no rewrite). `DATE_TYPE`/`DATETIME_TYPE.bucketBounds` reject non-string values, so even if a non-null non-string constant survived CAST stripping it'd decline. Null column rows are still rejected post-rewrite because `col >= L` and `col < U` both evaluate to null.
- **Boundary correctness.** DATETIME canonical form is `'YYYY-MM-DDTHH:MM:SS'` (`Temporal.PlainDateTime.toString()` in `DATETIME_TYPE.parse` at temporal-types.ts:144). The emitted bounds `'YYYY-MM-DDT00:00:00'` compare correctly under BINARY_COLLATION against canonical PlainDateTime values, and the boundary at `D+1 T00:00:00` is correctly excluded from the previous-day bucket. Boundary-row test case at sargable-range-rewrite.spec.ts confirms.
- **Consumer compatibility.** `constraint-extractor.extractBinaryConstraint` (constraint-extractor.ts:289–334) accepts both `col op literal` and `literal op col`; the rule emits the former with `colRef` reused verbatim on the LHS, preserving attributeId for downstream extraction. The rule's local `unwrapCast` / `isLiteralConstant` / `getLiteralValue` helpers are byte-identical to constraint-extractor's so the literal-side handling stays consistent.
- **Dispatch correctness.** `schema-resolution.resolveFunctionSchema` (schema-resolution.ts:140–147) does exact-arity lookup before variadic fallback, so `date(col)` resolves to the unary DATE_FUNC (annotated), not the variadic dateFunc (unannotated and unsound under modifiers).

### Checked — ordering & convergence

- **Rule iteration order.** `pass.rules` is iterated in *registration order* (pass.ts:378), not sorted by `priority`. Confirmed registration order in optimizer.ts:166–195: sargable-range-rewrite → aggregate-predicate-pushdown → predicate-pushdown — all with `nodeType: Filter`, so the chain executes in the desired order. The "priority 18/19/20" labels in comments and docs are advisory but happen to match registration order, so reading them as enforced is harmless.
- **Convergence.** `applyPassRules`' `while (changed)` loop (pass.ts:375–392) plus per-node `markRuleApplied` ensures the rewritten Filter (new node id) gets predicate-pushdown applied in the same pass without re-firing sargable-range-rewrite (post-rewrite conjuncts have `>=` / `<` operators, not `f(col) =`, so the pattern doesn't re-match anyway).

### Checked — tests

- **Test coverage.** Unit cases cover the happy path, the flipped `literal = f(col)` form, null-constant, non-bucket function (`upper(name) = 'X'`), `f(g(col))` non-identity operand, and mixed-conjunct partial rewrites. SQL cases cover in-bucket match, next-bucket-boundary exclusion, null-ts exclusion, and predicate-shape via `query_plan(?)`.
- **Acknowledged gap (deferred per handoff).** No fixture asserts the rewrite enables `IndexSeek` end-to-end; only that the rewritten `col op literal` shape is visible to the constraint extractor. The memory vtab does not currently expose a covering ordered index on `DATETIME` that the existing test helpers can spin up. The query_plan assertion is the precondition; the IndexSeek-asserting fixture is appropriately deferred to a follow-up.
- **Edge cases not in the spec but verified by walk-through.** `f(col, :p)` is correctly rejected (parameter at trait index 0? — actually `:p` is at idx 1; idx 0 has the bare col, so it's accepted *if* the trait is on arg 0. The test of "parameter-bound RHS" is acknowledged out of scope.) `where date(ts) = date(ts2)` correctly declines (both sides non-literal). `where date('now') = D` correctly declines (no column ref on the candidate side).

### Checked — docs

- `docs/optimizer.md` — § "Sargable range rewrites" added, cross-linked from § "Scalar Expression Properties". Accurate.
- `docs/types.md` — the `LogicalType` interface excerpt was missing the new `bucketBounds?` method (the TS interface at logical-type.ts:67–70 has it). **Fixed inline** by adding the method signature with a cross-link to optimizer.md.
- `docs/datetime.md` — not affected (this is a planner-level rule, not a temporal-value semantics change).

### Findings disposition

| Finding | Severity | Disposition |
| --- | --- | --- |
| `docs/types.md` LogicalType excerpt missing `bucketBounds` | Minor | Fixed inline (this pass) |
| Local `unwrapCast`/`isLiteralConstant`/`getLiteralValue` duplicate constraint-extractor's | Minor (DRY) | Left as-is; identical implementations preserve consistency, extracting a shared helper is a follow-up cleanup not specific to this ticket |
| `findUniqueColumnReference` uses instance-identity (`found !== n`) rather than attributeId comparison | Minor | Left as-is; the rangeRewriteIn guard in function.ts:170 is independently load-bearing, so the over-strict instance check never gates a rewrite that would otherwise have succeeded |
| End-to-end IndexSeek plan-shape test | Major (already filed) | Already promoted to follow-up backlog by the implement stage; depends on a covering-`(ts)` memory vtab fixture |

### Validation

- `yarn workspace @quereus/quereus run lint` → exit 0
- `yarn workspace @quereus/quereus run build` → exit 0
- `cd packages/quereus && yarn test` → **3167 passing, exit 0** (matches the implement-stage count; no regressions)
- `yarn test:store` / `yarn test:full` not run — this rule operates on the predicate tree pre-pushdown and does not touch access-path execution, so memory-vs-store parity is unaffected.

## Follow-ups already promoted to backlog (carried over from implement)

- `<`, `<=`, `>`, `>=` shapes — direction analysis on `monotonicityIn`, asymmetric bound mapping.
- Parameter-aware rewrite — `date(ts) = :p` via `bucket_lower(:p)` / `bucket_upper(:p)` scalar functions.
- Additional bucket kinds — `datetime` normalization, `strftime` quanta, integer-bucketing functions.
- `decreasing`-direction support in `rangeRewriteIn`.
- End-to-end IndexSeek plan-shape test once a covering `(ts)`-ordered memory-vtab fixture is available.
