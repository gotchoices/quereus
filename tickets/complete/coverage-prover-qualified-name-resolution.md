description: Qualifier-aware AST column resolution in the coverage prover, replacing the over-broad bare-name collision guard so 1:1 join bodies whose lookup key reuses a UC column name prove `Covers`. Reviewed and accepted.
files: packages/quereus/src/planner/analysis/coverage-prover.ts, packages/quereus/src/planner/analysis/partial-unique-extraction.ts, packages/quereus/src/planner/analysis/predicate-shape.ts, packages/quereus/test/covering-structure.spec.ts, docs/optimizer.md, docs/materialized-views.md
----

## What shipped

The coverage prover's body `ORDER BY` / `WHERE` column resolution is now
**qualifier-aware** (`makeBodyColumnResolver` in `coverage-prover.ts`):
`alias.col` resolves to a base-table `T` column only when `alias` denotes `T`'s
reference (alias, or table name when unaliased — collected via
`collectBaseTableQualifiers`, walking nested joins), and a bare `col` only when
`T` has it and no lookup-side column shares the name. A term on a lookup-side
column resolves to `undefined`, which propagates to a full rejection
(`ordering-mismatch` for `ORDER BY`, `predicate-entailment` for `WHERE`) rather
than mis-mapping onto a same-named `T` column.

This let the implementer **remove** the former conservative bare-name
collision guard (`proveJoinOneToOne` → renamed `proveJoinNoFanout`, with the
`collectColumnNames` / `nameSensitiveCols` dependencies gone), so a 1:1 join
whose lookup key reuses a UC column name (`line_items ⋈ products on l.sku =
p.sku`) now correctly proves `Covers`.

Mechanism: a `ColumnIndexResolver` type was added to `predicate-shape.ts` and
threaded through every partial-UNIQUE recognizer in `partial-unique-extraction.ts`
(`recognizeConjunctiveClauses` gained an optional resolver; default is bare-name,
so partial-UNIQUE FD extraction is unchanged). `lookupColumnNames` is a
standalone helper shared between the resolver and the no-fan-out gate.

## Review findings

**Implement diff reviewed first** (commit `f098723b`), then the handoff. Verdict:
the change is **sound, well-factored, and correctly tested**. One major finding
filed, one minor fixed inline.

### Soundness — the load-bearing claim (all-or-nothing rejection)
Verified that a lookup-side term (resolver → `undefined`) forces a **full**
rejection for every predicate shape, never a silent drop that would understate
the body's restriction:
- `IS [NOT] NULL`, `NOT col`, `IN`, `BETWEEN` — each returns `undefined` on an
  unresolved column ⇒ `recognizeClause` ⇒ `recognizeGuardClauses` drops the
  whole predicate.
- `=` — `col = literal`/`literal = col`/`col = col` with a lookup operand: both
  index lookups fail or `literalValue` of a column expr returns `undefined`
  ⇒ `undefined` ⇒ whole-predicate reject. Confirmed both operand orders.
- range (`<,<=,>,>=`) — same: a lookup operand ⇒ `undefined`.
- `OR` — any unrecognized disjunct ⇒ `recognizeOr` ⇒ `undefined` ⇒ whole reject.
- Top-level conjunct split: any unrecognized conjunct ⇒ entire predicate
  `undefined`. Confirmed.
- `uc.predicate` (the governed scope) correctly resolves **bare-name** against
  `baseTable` (it is a constraint on `T`, qualifier-free); only the body `WHERE`
  uses the qualifier-aware resolver. Correct.
- Comma-join/cross-join bodies that put the join condition in `WHERE`
  (`from t l, p where l.sku = p.sku`) reject soundly: the AST `WHERE` is read
  regardless of how the optimizer rewrites the plan, and the lookup operand makes
  it unrecognized ⇒ `predicate-entailment` (conservative, never a false cover).

### Edge cases / interactions
- **Single-source bodies** reduce to bare-name (empty `lookupNames`, `T`'s sole
  qualifier in the set) ⇒ v1 behavior preserved. The full suite (3821 passing)
  confirms no drift.
- **Self-join** (`T ⋈ T`) and **T-via-subquery** shapes are rejected by the shape
  walk (`leftHasT === rightHasT` ⇒ `shape`) before the resolver runs, so
  `collectBaseTableQualifiers` adding both aliases is moot.
- **Unqualified-ambiguity** (gap #2): a bare `col` present in both `T` and the
  lookup hits `lookupNames` ⇒ `undefined` ⇒ conservative reject; a bare lookup-only
  name not in `T` falls through to `baseTable.columnIndexMap.get` ⇒ `undefined`
  anyway. A genuinely ambiguous bare reference is a plan-time error. Sound —
  confirmed defense-in-depth, not a hole.
- **Derived/function FROM sources** (gap #1): conservatively rejected
  (`undefined`), completeness loss only. Confirmed not a soundness issue; left as
  documented limitation.

### MAJOR (filed) — cross-schema same-name qualifier blind spot
`columnRefParts` reads `ColumnExpr.table` but discards `ColumnExpr.schema` (gap
#3). In a cross-schema join body where the lookup table shares the base table's
*name* (`s1.t ⋈ s2.t`), a schema-qualified `s2.t.col` matches `tQualifiers` by
table name alone ⇒ mis-resolves onto base `s1.t`'s same-named column ⇒ a
**false `Covers`**. The removed collision guard previously covered this case, so
it is a (theoretical, exotic) soundness regression. Quereus does support
cross-schema joins, so it is reachable in principle.
→ Filed **`fix/coverage-prover-cross-schema-qualifier-resolution`** (reproduce
first, then make qualifier matching (schema, table)-aware). Low likelihood; not
fixed inline because it touches the load-bearing resolver and needs a
cross-schema test fixture.

### MINOR (fixed inline)
- Stale comment in `covering-structure.spec.ts` (the "composite-PK" positive
  test) still referred to "the name-collision guard" as if live. Updated to
  describe the qualifier-aware resolver. (Other "former/old collision guard"
  mentions in code/tests are intentional historical context and were left.)

### Docs
Read every touched file. `predicate-shape.ts`, `partial-unique-extraction.ts`,
and `coverage-prover.ts` module/function docs reflect the new resolver.
`docs/optimizer.md` (the `recognizeConjunctiveClauses` signature + the
qualifier-aware paragraph) and `docs/materialized-views.md` (moved from "remaining
follow-up" to delivered) are accurate. No stale live references to the removed
`proveJoinOneToOne` symbol remain. Docs are up to date.

### Tests
- New: positive (UC-named lookup key qualified to `T` covers), negative
  `ordering-mismatch` (same name qualified to lookup side), negative
  `predicate-entailment` (`where p.sku is null`). All present and passing.
- Note (gap #4, left as-is): the two new negatives assert the exact failure
  reason and assume the optimizer keeps the LEFT join. This is **intentional** —
  asserting the precise reason is what guards the "right reason, not `shape`"
  property this ticket exists for. Not hardened to "not `shape`".

### Validation run during review
- `covering-structure.spec.ts` + `conditional-fds.spec.ts` — pass (170 + the
  prover suite, all green; 59 in covering-structure including the 3 new cases).
- `yarn typecheck` — exit 0.
- `yarn lint 'src/**/*.ts'` — exit 0.
- `yarn test` (full quereus suite) — **3821 passing, 0 failing, 9 pending.**

## Empty categories
None silently skipped. Performance: the resolver builds two small `Set`s once per
`proveCoverage` call (qualifiers + lookup names) and does O(1) lookups per term —
no concern. Resource cleanup: all tests `close()` their DB in `finally`. Error
handling: `undefined`-propagation is the intended control flow, not eaten
exceptions.
