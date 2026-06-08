---
description: Gated the `NOT col → eq-literal{col, 0}` rewrite on column-is-numeric in both the producer (partial-UC FD extraction) and the consumer (Filter guard activation). For TEXT/BLOB/BOOLEAN/OBJECT/ANY columns the rewrite is unsound because the consumer matches the guard via strict `sqlValueEquals` and TEXT `''` / boolean `false` compare unequal to integer `0`, so the rewrite would falsely discharge a guard the runtime UC never enforced. INTEGER/REAL/NUMERIC behavior is unchanged.
files:
  packages/quereus/src/planner/util/fd-utils.ts
  packages/quereus/src/planner/nodes/filter.ts
  packages/quereus/src/planner/analysis/partial-unique-extraction.ts
  packages/quereus/test/optimizer/conditional-fds.spec.ts
  packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic
  docs/optimizer.md
---

## Change summary

- **Consumer (`fd-utils.ts`)**: extended `predicateImpliesGuard` and the internal `buildPredicateFacts` with an `isColumnNumeric: (col: number) => boolean` callback (mirrors the existing `isColumnNonNullable` plumbing). In the `UnaryOpNode` `'NOT'` branch of `buildPredicateFacts`, the `literalEqs.set(cIdx, 0)` line is now gated on `isColumnNumeric(cIdx)`. `isNotNullCols.add(cIdx)` still fires regardless of type — that's sound for any column.
- **Filter wiring (`filter.ts`)**: `FilterNode.computePhysical` now builds an `isColumnNumeric` closure from `sourceAttrs[col].type.logicalType?.isNumeric === true` and threads it to `activateGuardedFds` → `predicateImpliesGuard`.
- **Producer (`partial-unique-extraction.ts`)**: added an `isColumnNumericDeclared` helper alongside the existing `isColumnNotNullDeclared`. Threaded through `recognizeGuardClauses` / `recognizeClause` / `recognizeOr`. The `UnaryExpr` `'NOT'` branch now rejects unless both `isColumnNotNullDeclared(col)` and `isColumnNumericDeclared(col)` hold.
- **Docs (`docs/optimizer.md`)**: updated three references — the producer rewrite table, the soundness paragraph after it, and the `predicateImpliesGuard` signature lines — to mention the numeric-only gate.

## Review findings

### Verified

- **Producer/consumer symmetry preserved**. Both sides now gate the `NOT col → col = 0` rewrite the same way (`isNumeric === true`), with INT/REAL/NUMERIC admitted and TEXT/BLOB/BOOLEAN/OBJECT/ANY rejected. Reviewed `partial-unique-extraction.ts:218–220` (producer) and `fd-utils.ts:978–981` (consumer) — gates are mutually consistent.
- **`isNotNullCols.add(cIdx)` still fires on non-numeric `NOT col`** (`fd-utils.ts:980`). Correct: `NOT col` is `false` when col is NULL regardless of type, so the implicit `IS NOT NULL` fact is sound for any column. Useful in case a guard with `is-null negated:true` for the same column would otherwise miss a discharge opportunity.
- **All `predicateImpliesGuard` callers updated**. The only production call site is `filter.ts:222`. All 37 prior test call sites were extended to pass `allNumeric` so existing INTEGER-column behavior is preserved.
- **Type-system grounding is correct**. `LogicalType.isNumeric` is set to `true` on `INTEGER_TYPE`, `REAL_TYPE`, `NUMERIC_TYPE` only (`builtin-types.ts:22,68,240`). `BOOLEAN_TYPE`, `TEXT_TYPE`, `BLOB_TYPE`, `ANY_TYPE`, `NULL_TYPE`, `JSON_TYPE` all return `undefined`, so they fall outside the gate. `ColumnSchema.logicalType` and `ScalarType.logicalType` are both non-optional, so the `?.` chain in `filter.ts:90` and `partial-unique-extraction.ts:96` is defensively-defensive (harmless).
- **No other producers emit `eq-literal { value: 0 }` as a NOT-rewrite**. Grep on `value: 0` and `kind: 'eq-literal'` shows only the `NOT col` branch in `partial-unique-extraction.ts:220` emits the literal-0 form for boolean rewrites; all other `eq-literal` constructions use a captured `lit` from the AST. The asymmetric consumer behavior on `WHERE col = 0` (still discharges the guard regardless of column type) is therefore confined to the case where the partial UC predicate is also `WHERE col = 0` — and there both sides agree under strict `sqlValueEquals`, which makes the asymmetry sound.
- **`sqlValueEquals` is strict `===` for primitives** (`fd-utils.ts:1445`). Confirms the ticket's premise: `sqlValueEquals('', 0) === false`, `sqlValueEquals('0', 0) === false`, `sqlValueEquals(false, 0) === false`. The numeric gate is exactly the right boundary.
- **Tests cover the regression and the asymmetry contract.** Producer-side TEXT reject (line 1282), consumer-side TEXT `NOT col` non-discharge (line 397), consumer-side TEXT `col = 0` still-discharges (line 406), consumer-side INT `NOT col` still-discharges (line 412). End-to-end sqllogic §7j-NOT-on-TEXT (count = 2 — would be wrong before fix) and §7j-NOT-on-TEXT-INT mirror (count = 1) confirm both the bug-fix and the feature-regression case.
- **Lint clean, all 3103 tests pass, 2 pending.**

### Considered, no action

- **Asymmetry on `WHERE col = 0` for TEXT cols**: documented and tested as intentional (consumer test at line 406). Sound because both producer (`col = literal` branch) and consumer (`literalEqs.set` from `col = 0` form) use the same strict-equality literal; the runtime UC enforces the same strict equality. Not a soundness gap.
- **`BOOLEAN_TYPE` not covered**: `NOT bool_col` is meaningfully `bool_col = false`, not `= 0`. The current gate correctly rejects boolean (since `isNumeric` is not set), which is conservative-correct. Per-column literal sets to support `bool_col = false` are an explicit out-of-scope follow-up.
- **`ANY_TYPE` not covered**: ANY columns can hold any storage class, so `NOT col` ⇒ `col = 0` is generally unsound. The gate correctly rejects ANY. This is a pre-existing-behavior change for ANY columns: previously `NOT col` on a NOT-NULL ANY column would have produced an FD; now it doesn't. The ticket's scope is "for TEXT/BLOB/BOOLEAN/OBJECT" but ANY follows the same logic; correct behavior.
- **`attr?.type.logicalType?.isNumeric === true` in `filter.ts:90`**: the second `?.` on `logicalType` is unnecessary since `ScalarType.logicalType` is non-optional. Stylistic nit only — defensive nullish-check is harmless and matches the pattern of the surrounding code. Not worth changing.
- **No end-to-end plan-layer assertion in sqllogic**: the §7j-NOT-on-TEXT sqllogic case asserts row count (the observable symptom), not absence of the FD at the plan layer. The unit test on `predicateImpliesGuard` covers the plan-layer behavior directly. Adequate coverage for the regression boundary.
- **`recognizeOr` and producer's recursive descent**: confirmed the numeric gate is threaded through `recognizeGuardClauses` → `recognizeClause` → `recognizeOr` → `recognizeClause`. A `NOT col` inside an OR-disjunct of a partial-UC predicate is also gated correctly.

### Tested

- Unit (`conditional-fds.spec.ts`): producer reject TEXT, consumer reject TEXT, consumer accept INT, consumer accept `= 0` on TEXT (asymmetry contract). 37 existing tests updated to pass `allNumeric`; all pass.
- Integration (`10.5.1-partial-indexes.sqllogic` §7j-NOT-on-TEXT and §7j-NOT-on-TEXT-INT mirror): asserts row counts before/after the fix's window.
- Lint: clean. Test suite: 3103 passing / 2 pending. No regressions.

### Filed as follow-ups (out of scope, per ticket)

- Boolean-set support for `NOT col` (requires per-column literal sets in `literalEqs`).
- Symmetric handling of `WHERE col` (truthy test) on the producer/consumer.
- Casts / function-wrapped column references in the `NOT col` branch.

No new tickets opened — the original ticket explicitly defers these.
