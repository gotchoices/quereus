description: GROUP BY column-coverage validation for SELECT projections — non-aggregate columns not covered by GROUP BY now raise the canonical error instead of silently using implementation-defined values.
files:
  packages/quereus/src/planner/building/select-aggregates.ts
  packages/quereus/test/logic/07-aggregates.sqllogic
  packages/quereus/test/logic/03-expressions.sqllogic
----

# Aggregate / GROUP BY column-coverage validation

## What was built

`validateAggregateProjections` in `select-aggregates.ts` runs after `groupByExpressions` is built and enforces, for the `hasGroupBy` branch, that every non-aggregate column reference in the SELECT list is *covered* by GROUP BY. Two coverage signals:

1. **Attribute-id match** — a `ColumnReferenceNode` whose `attributeId` is in the set of attribute ids of GROUP BY expressions that are themselves column references.
2. **Subtree fingerprint match** — any subtree whose `expressionToString` AST fingerprint matches one of the GROUP BY expression fingerprints (covers `SELECT id+1, count(*) ... GROUP BY id+1`).

Walker `findUngroupedColumnRef` short-circuits on:
- aggregate-function subtrees (inner refs are aggregated),
- relational subtrees (correlated subqueries resolve via their own scope),
- subtrees whose AST fingerprint matches a GROUP BY expression.

On first uncovered column reference: `QuereusError('Cannot mix aggregate and non-aggregate columns in SELECT list without GROUP BY', StatusCode.ERROR)` — same wording as the no-GROUP-BY branch and the canonical corpus error string.

## Test corpus changes

- `07-aggregates.sqllogic:74` — `SELECT grp, count(*), val FROM agg_t GROUP BY grp;` assertion now genuinely fires (was previously tautological).
- `03-expressions.sqllogic:125,128` — two queries that relied on PK-based functional-dependency coverage (`GROUP BY id` with non-grouped refs) rewritten to `GROUP BY id, a, b` with comment noting the missing FD analysis.

## Verified behavior

Succeeds:
- `SELECT grp, count(*) FROM t GROUP BY grp` (attrId-covered)
- `SELECT grp, count(*), 0 AS k FROM t GROUP BY grp` (literal has no col refs)
- `SELECT grp, coalesce(max(val), 0) FROM t GROUP BY grp` (wrapped aggregate isolated)
- `SELECT id+1, count(*) FROM t GROUP BY id+1` (fingerprint match)
- `SELECT grp+1, count(*) FROM t GROUP BY grp` (recurses into `grp`)
- `SELECT * FROM t WHERE …` (no GROUP BY — unchanged)
- `SELECT max(val)+1 FROM t` (no projections to validate)

Fails with canonical error:
- `SELECT grp, count(*), val FROM t GROUP BY grp` — `val` not in GROUP BY set.
- `SELECT * FROM t GROUP BY grp` — non-`grp` star refs uncovered.
- `SELECT id, count(*), a FROM t GROUP BY id` — `a` uncovered (no PK-FD).

## Out of scope (deliberate)

- HAVING-clause column-coverage validation — add only when a corpus case demands it.
- Functional-dependency / unique-key coverage (would let `GROUP BY pk` cover all columns). Lift point: `constraint-extractor.ts:1027-1058` (`demoteForAggregate` key-coverage logic).

## Verification

- `yarn workspace @quereus/quereus test` — 2453 passing, 2 pending.
- `yarn test` (all workspaces) — all suites passing.
- `yarn workspace @quereus/quereus lint` — 0 errors / 0 new warnings on `select-aggregates.ts`.

## Review notes

- `validateAggregateProjections` placement (line 93) is correct: `groupByExpressions` is built one statement earlier; nothing mutates plan-node attribute ids between build and check.
- Walker correctly defers correlated outer-column refs to the subquery's own scope by skipping relational children — outer-scope errors are caught later by the scope resolver, not the validator.
- Fingerprint stability: GROUP BY and SELECT projections both build via `selectContext.scope` from parsed AST; `expressionToString` is structural over AST (parens are not stored as nodes), so identical parses fingerprint identically.
- All `ScalarPlanNode` subclasses expose a readonly `expression` AST node, so the `'expression' in node` guard reliably feeds `expressionToString`.
