description: Add goldens coverage for non-identity / non-invertible columnar decomposition mappings, which the lineage-driven `classifyColumn` now routes (read-only `computed-mapping`) but which no test exercises. Every existing decomposition advertisement uses identity `colMap('a','a')`, so the new lineage classification of a `member.columns` entry whose basis is a transform (`a+1`) or a composite (`a||b`) is unproven by tests — a regression there would silently flip a column's writability.
prereq:
files: packages/quereus/src/planner/mutation/decomposition.ts, packages/quereus/src/planner/mutation/backward-body.ts, packages/quereus/test/lens-put-fanout.spec.ts, packages/quereus/test/lens-advertisement.spec.ts
effort: medium

## Background

`view-mutation-decomposition-plan-node-consumer` converged the decomposition put
fan-out onto the shared plan-node backward-walk consumer (`analyzeBodyLineage`).
`classifyColumn` now decides a column's route off the threaded `updateLineage`:

- An identity `base` site (no `inverse`) on a join member → `member` (value-writable / insertable).
- A `member.columns` entry the lineage did **not** resolve to an identity base column → `computed-mapping` (read-only; INSERT/UPDATE reject with `no-inverse`).

The second branch is the lineage-driven replacement for the retired
`mapping.basisExpr.type !== 'column'` AST check. The implementer reasoned it is
equivalent — an `a+1` mapping yields a `base`+`inverse` site (inverse ≠ undefined →
fails the identity gate → `computed-mapping`), and an `a||b` mapping yields a
`computed` site (no base column → `computed-mapping`) — but **no test constructs a
non-identity `colMap`**, so the equivalence is unverified.

## What to add

A decomposition advertisement whose `LogicalColumnMapping.basisExpr` is a non-column
expression (e.g. `{ type: 'binary', operator: '+', left: col, right: literal }` for
`a+1`, and a `||` concat for `a||b`), then assert:

- the logical column reads back through the get body (forward transform intact);
- `update x.T set <thatcol> = …` rejects with `no-inverse` / "computed (non-invertible)";
- `insert into x.T (<thatcol>) …` rejects with `no-inverse` / "computed (non-invertible) ... cannot receive an inserted value";
- an identity sibling column on the same member stays writable (no collateral read-only).

This locks the lineage classification against the retired AST behavior and guards the
writable/read-only boundary the refactor moved onto `updateLineage`.

## Notes / related observations (from the review pass, not blocking)

- `classifyColumn`'s `member.columns` fallback matches by `logicalColumn` name only;
  it does not re-confirm the basis is non-identity (it trusts the identity branch
  above to have already claimed identity mappings). Worth asserting that an identity
  mapping the lineage *fails* to resolve (e.g. a member whose table the
  `memberByTableId` schema+name match misses) does not silently degrade to read-only —
  i.e. the match is robust.
- A self-decomposition (two members over the same physical base table) would match
  `memberByTableId` ambiguously; structurally unsupported today (multi-source rejects
  self-joins) but an unguarded assumption — a defensive reject + test would harden it.
