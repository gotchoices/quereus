---
description: A query that converts a column's value before comparing it — for example matching rows where the text column read as a number equals 1 — returns no rows at all when that column is the table's primary key, but the correct rows when it is not.
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts        # unwrapCast() — the defect
  - packages/quereus/src/planner/analysis/scalar-invertibility.ts        # isNoOpCast() — already exported
  - packages/quereus/src/planner/analysis/sat-checker.ts                 # unwrap() — the same fix, already landed
  - packages/quereus/src/planner/building/expression.ts                  # insertCrossTypeCoercion() — mints the converting casts
  - packages/quereus/test/planner/constraint-extractor.spec.ts           # 6 tests pin the old behavior; must be rewritten
  - packages/quereus/test/logic/                                         # add a .sqllogic seek-correctness case
difficulty: medium
---

# Converting `CAST` is erased when extracting index-seek constraints

## Confirmed reproduction (on `main` @ `1bb24aff`)

```sql
create table t (x text primary key);
insert into t values ('1'), ('1abc'), ('2');

select x from t where cast(x as integer) = 1;             -- actual: (no rows)
select x from t where 1 = cast(x as integer);             -- actual: (no rows)
select x from t where cast(x as integer) between 1 and 1; -- actual: (no rows)
select x from t where cast(x as integer) = 1
                   or cast(x as integer) = 2;             -- actual: (no rows)
select x from t where x = 1;                              -- actual: (no rows)
-- expected in all five cases (the last one returns '1','1abc','2'):  '1', '1abc'
```

The same predicates against a non-indexed text column return the correct rows.
`select x from t where cast(x as integer) in (1)` already returns the right rows, because
`extractInConstraint` requires a bare `ColumnReferenceNode` and never unwraps.

**The last repro line is the important discovery, and it is wider than the original bug
report.** `packages/quereus/src/planner/building/expression.ts` → `insertCrossTypeCoercion`
wraps the *textual* operand of a comparison in a synthetic `CastNode` whenever the other
operand is numeric. So a plain `where x = 1` against a `text` column is planned as
`cast(x as REAL) = 1` and hits the exact same erasure. No explicit `cast(...)` in the SQL
is needed to trigger the wrong answer — any numeric-vs-text comparison on an indexed text
column does it.

## Root cause

`constraint-extractor.ts`:

```ts
function unwrapCast(node: ScalarPlanNode): ScalarPlanNode {
	return node.nodeType === PlanNodeType.Cast ? (node as CastNode).operand : node;
}
```

Every `CastNode` is stripped, so `cast(x as integer) = 1` is matched as `x = 1` and pushed
down as a seek key on `x` for the integer `1`. Under storage-class ordering no stored text
compares equal to the integer `1`, so the seek returns nothing — and because the conjunct
was reported as fully consumed, no residual `FILTER` survives to catch the mistake. The
plan for the first repro is a bare `INDEXSEEK … LITERAL 1` with no filter above it.

Stripping a **no-op** cast (target logical type equal to the operand's) is sound: the
compared value is unchanged. Stripping a **converting** cast is not.

`sat-checker.ts` had the identical defect in its own `unwrap()` and it was fixed under
ticket `core-callers-collation-resolver` — it now loops `while (cur instanceof CastNode &&
isNoOpCast(cur))`. `coarsened-key.ts:121` does the same. `constraint-extractor.ts` is the
last analysis file still stripping unconditionally.

## Which callers actually need the strict unwrap

`unwrapCast` has two distinct classes of caller in that file, and they want different
things. Prototyping showed a single strict helper is *almost* right but needlessly loses
one pushdown, so split it:

**Must be strict (they discard the cast, so the cast must be value-preserving):**

| call site | why |
|---|---|
| `isColumnReference` (line ~924) | decides the column side of a comparison; a converting cast means the seek key is not the stored column value |
| `getColumnReference` (~932) | same |
| `isLiteralConstant` (~939) | discards the cast on the value side |
| `getLiteralValue` (~952) | returns the **pre-cast** value as the seek key — wrong for `x = cast(1 as text)` |
| `columnSideOf` (~1057) | feeds the collation gates; must agree with the shape actually recognized |

**May stay loose (the cast is retained, only its *shape* is being classified):**

| call site | why |
|---|---|
| `extractBinaryConstraint` line ~421 (`innerValue`) | only picks `bindingKind` (`'parameter'` / `'correlated'` / `'expression'`); `result.valueExpr` keeps the whole cast node and is evaluated at runtime |
| `isDynamicValue` (~943) | same — a `cast(:p as integer)` value side is still a legitimate dynamic seek binding |

Keeping those two loose preserves parameter/correlated pushdown for
`x = cast(:p as integer)`. Add a second, clearly-named helper rather than loosening the
strict one.

`getLiteralValue` returning the pre-cast value is a **latent defect, not a tripwire** — it
is only dormant because constant folding collapses `cast(1 as text)` to the literal `'1'`
before extraction sees it. The strict unwrap fixes it as a side effect; keep it that way.

## Validated fallout

A prototype (strict `unwrapCast` looping on `isNoOpCast`, loose helper at the two value-side
sites) was applied and the full suite run with `yarn workspace @quereus/quereus run test:all`
(the no-bail variant — plain `yarn test` bails on the first failure and hides the rest):

```
6639 passing, 9 pending, 6 failing
```

All 6 failures are in `test/planner/constraint-extractor.spec.ts` →
`describe('CastNode wrapping (unwrapCast)')`, and every one of them asserts the *buggy*
behavior. Its `castNode()` helper defaults to `targetType = 'TEXT'` while `colRef()` is
`INTEGER_TYPE`, so those casts are all value-changing:

- `CAST(col) = lit → extracts through cast`
- `col = CAST(lit) → extracts through cast on literal`
- `CAST(col) = CAST(lit) → extracts through double cast`
- `CAST(lit) < col → flip works through cast`
- `IS NULL on CAST(col) → extraction depends on unwrapCast`
- `col(left) = cast(lit)(right) → nonLiteral true but valueSide is literal`

**Zero** `.sqllogic`, plan, or optimizer tests regressed — the plan-shape churn the original
report anticipated did not materialize beyond that one spec file. `where x = 1` on a text PK
does fall back from `INDEXSEEK` to `INDEXSCAN + FILTER`; that is the correct plan.

Repro snippets for each of the five statements returned the right rows under the prototype,
including the `or` collapse and the `between` range.

## Expected behavior

- A comparison whose column operand is wrapped in a value-changing cast contributes no
  seek / range / covered-key constraint; the predicate stays as a residual filter.
- A no-op cast (`isNoOpCast`) is still stripped, preserving today's folding, including
  through a chain of them.
- `COLLATE` is still never stripped (unchanged — the existing comment on `unwrapCast`
  explains why, and that half of it is correct).
- `select x from t where cast(x as integer) = 1` and `select x from t where x = 1` return
  the same rows whether or not `x` is indexed, and whether or not an index is chosen.

## Noticed nearby — do not fix here

- `rule-sargable-range-rewrite.ts:132` has its own unconditional `unwrapCast`, used by its
  `isLiteralConstant` / `getLiteralValue` on the **literal** side. Same latent
  wrong-value-through-a-converting-cast shape, same dormancy (folding). Its column side is
  safe: it calls `candidateSide.rangeRewriteIn(...)`, which a `CastNode` declines. Worth a
  `NOTE:` comment at that helper pointing at this ticket; not worth a behavior change here.
- `query_plan` renders the synthetic coercion cast's placeholder AST, so the text of a
  `BINARYOP` detail for `where x = 1` on a text column reads `cast(null as real) = 1` — the
  `expr: { type: 'literal', value: null }` placeholder in `wrapInCast`
  (`building/expression.ts:91`) leaks into `formatExpression`. Cosmetic, plan-explain only.

## TODO

- Import `isNoOpCast` from `./scalar-invertibility.js` into `constraint-extractor.ts`.
- Rewrite `unwrapCast` to loop: `while (cur instanceof CastNode && isNoOpCast(cur)) cur = cur.operand;`
  Update its doc comment — the existing block explains at length why `COLLATE` is not
  stripped; extend the same reasoning to a converting `CAST`, and cross-reference
  `sat-checker.ts`'s `unwrap()` (which already cross-references this function).
- Add a loose sibling (e.g. `unwrapCastForBindingKind`) that strips any `CastNode`, and use
  it at `extractBinaryConstraint`'s `innerValue` and inside `isDynamicValue`. Document that
  it is classification-only and that `valueExpr` retains the cast.
- Rewrite the six tests in `test/planner/constraint-extractor.spec.ts` →
  `describe('CastNode wrapping (unwrapCast)')`. They should now come in pairs: a no-op cast
  (give `castNode` an `INTEGER` target over the `INTEGER_TYPE` `colRef`, or use `textColRef`
  with a `TEXT` target) still extracts; a converting cast yields zero constraints and a
  residual predicate. Rename the `describe` block — it currently names the helper, not the
  behavior.
- Add a covered-key case to the same spec: a converting cast on a key column must not land
  in `computeCoveredKeysForConstraints`' covered set (no false ≤1-row claim).
- Add a `.sqllogic` seek-correctness case under `packages/quereus/test/logic/` covering,
  against a `text primary key` table with rows `'1'`, `'1abc'`, `'2'`:
  `cast(x as integer) = 1`, `1 = cast(x as integer)`, `cast(x as integer) between 1 and 1`,
  `cast(x as integer) in (1)`, the two-branch `or`, and bare `x = 1` (implicit coercion —
  this one returns all three rows). Assert row sets, not plan shapes.
- Add a `NOTE:` comment at `rule-sargable-range-rewrite.ts`'s `unwrapCast` per the section
  above.
- Verify `yarn workspace @quereus/quereus run test:all` (not `yarn test` — it bails) and
  `yarn lint`.
