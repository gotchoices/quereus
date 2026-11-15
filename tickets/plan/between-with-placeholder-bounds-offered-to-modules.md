description: A query such as "x between ? and ?" never offers its bounds to the storage module, because the engine only turns BETWEEN into index bounds when both ends are literal values; with placeholders the whole BETWEEN is checked row by row above a full scan. Offer it the same way "x >= ? and x <= ?" is offered, so indexes (including the multi-dimensional box lookup lamina asked for) can use it.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/planner/analysis/constraint-extractor.ts   # extractBetweenConstraints (literal-only gate); extractBinaryConstraint (dynamic-binding classification to share)
  - packages/quereus/test/vtab/module-seek-filters.spec.ts           # box test currently spelled with comparisons; switch to between once this lands
  - packages/quereus/test/vtab/null-bound-seek.spec.ts               # existing coverage for a null run-time range bound
  - docs/module-authoring.md                                         # "Module-listed seek arguments" ends with a sentence saying between ? and ? is not offered yet
----
# BETWEEN with placeholder (or correlated) bounds is never offered to modules

`extractBetweenConstraints` (constraint-extractor.ts) returns null unless both bounds are literals ("Only support column BETWEEN literal AND literal"). So `where x between ? and ?` reaches `getBestAccessPlan` with no filter for `x` at all, and stays a residual `Filter` above a full scan. The same predicate written `x >= ? and x <= ?` is extracted as two constraints carrying `valueExpr` and `bindingKind: 'parameter'`, and every module can seek it.

Found while implementing `module-listed-seek-arguments-planner`: lamina's multi-dimensional index wants `x between ? and ? and y between ? and ?` handed to it as four listed seek arguments. The planner half works for the comparison spelling (its test uses it); the BETWEEN spelling never reaches the module.

## Expected behaviour

- `col between A and B` (not `not between`), where each of A and B is a literal or a value the binary-comparison path would accept as a dynamic binding (parameter, correlated outer column, expression not reading the constrained table), yields the same two constraints `col >= A` and `col <= B` the comparison spelling yields: `valueExpr`, `bindingKind`, `correlated` classified exactly as `extractBinaryConstraint` does (share that classification rather than copying it), both sharing the BETWEEN node as `sourceExpression`, collation per bound as today (`effectiveBetweenBoundCollation`).
- A bound that reads the constrained table's own columns keeps the whole BETWEEN as a residual, as the binary path declines a same-table column ref.
- A literal NULL bound still leaves the BETWEEN as a residual (unchanged). A run-time NULL bound matches nothing, as a run-time NULL `>= ?` bound already does.
- Mixed bounds (`x between 1 and ?`) extract both halves.

## Interactions to check

- Every module sees the new filters, so memory and store plans for `between ?` change from scan-plus-filter to range seeks. Look for plan snapshot tests that pin the old shape.
- The two constraints share one source expression; `combineResidualExpressions` de-duplicates by identity, and a half the rule does not consume reattaches as the whole BETWEEN, which is correct (the consumed half is implied).
- Correlated bounds become correlated range seeks; the `IndexSeekNode` row-context invariant (OPT-061) already governs those for the comparison spelling.
