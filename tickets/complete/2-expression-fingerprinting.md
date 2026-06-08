description: Expression fingerprinting infrastructure for common subexpression detection
files:
  - packages/quereus/src/planner/analysis/expression-fingerprint.ts
  - packages/quereus/test/optimizer/expression-fingerprint.spec.ts
  - packages/quereus/src/planner/rules/cache/rule-scalar-cse.ts (consumer)
----

## What was built

`fingerprintExpression(node: ScalarPlanNode): string` — produces a canonical string identifying the computation of a scalar expression tree. Two subtrees with the same fingerprint compute the same value given the same row input. Used by `ruleScalarCSE` for common subexpression elimination.

### Key design points

- Short prefixed tags: `LI:` (literal), `CR:` (column ref), `PR:` (param ref), `UO:` (unary), `BO:` (binary), `FN:` (scalar fn), `AG:` (aggregate), `CE` (case), `CA:` (cast), `CO:` (collate), `BW:` (between), `AI:` (array index), `WF:` (window fn)
- Non-deterministic nodes → unique `_ND:<id>` (never deduplicated)
- Commutative ops (`+`, `*`, `=`, `!=`, `<>`, `AND`, `OR`) sort children lexicographically
- Subquery/window nodes → unique fingerprints (relational subplan canonicalization out of scope)
- Literal type discrimination: `5n` (bigint), `3.14f` (number), `'hello'` (text), `null`, `true`/`false`, `xdead` (blob)

## Testing

34 tests covering all node types, commutativity vs non-commutativity, type discrimination, non-deterministic guard, nested/deep expressions. All pass.

## Documentation

CSE rule documented in `docs/optimizer.md` line 384.
