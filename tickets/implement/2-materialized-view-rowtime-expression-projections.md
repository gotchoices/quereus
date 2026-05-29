description: Lift the row-time eligibility gate's passthrough-only projection restriction. Allow a **deterministic expression projection** over single-source columns (e.g. `select id, x + 1 as x1, lower(name) as ln from t`). Such a projection is still a pure per-row (per-statement) function of the changed row — O(log n), no body re-execution — so it fits row-time. Non-deterministic projections remain rejected. PK and UNIQUE-covered columns must still be passthrough (the backing key / conflict-resolution inverse projection depend on it).
prereq: materialized-view-rowtime-only-consolidation
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/utils/predicate.ts, packages/quereus/src/planner/validation/determinism-validator.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, docs/materialized-views.md
----

## Goal

Today `buildRowTimePlan` rejects any non-passthrough projection column
("requires every projected column to be a passthrough source column (no
computed/expression columns)"). This was the documented v1 gap. As the *sole*
maintenance model, that gap makes row-time nearly unusable for ordinary derived
columns. This ticket lifts it: a backing output column may be either a passthrough
source column **or** a deterministic scalar expression over single-source columns.

The maintenance math is unchanged in shape — each source row still maps to exactly
one backing row; the backing row is now `project(sourceRow)` where `project`
permutes passthrough columns *and evaluates* the expression columns. Still no body
re-execution, still O(log n) per row.

## Constraints that stay

- **Single source, linear body, includes every source PK column** — unchanged.
- **PK columns must be passthrough.** The backing primary key must be a
  deterministic identity of the source row, and `lookupCoveringConflicts` recovers
  the **source** PK from the backing row by an inverse passthrough map
  (`sourceColToBacking`). An expression PK column would break both. Reject a
  computed column that lands in the backing PK (in practice the gate already
  requires every *source* PK column be projected; keep requiring those specific
  columns be passthrough).
- **UNIQUE-covered columns stay passthrough** for the same inverse-projection
  reason — the coverage prover already requires UC columns be passthrough, so a
  covering MV is unaffected; a non-covering MV may freely compute non-PK columns.
- **Determinism.** A projection column calling a non-deterministic function
  (`random()`, `now()`, …) is rejected — a row-time backing value must be
  reproducible from the source row (consistent with DEFAULT / CHECK / generated-
  column determinism enforcement). Reuse `checkDeterministic(scalarPlanNode)` from
  `planner/validation/determinism-validator.ts` on each computed column's producing
  scalar plan node (available via `collectProducingExprs` / `getProducingExprs`,
  already used by the gate).

## Design

`RowTimeMaintenancePlan.projectionSourceCols: number[]` (a pure permutation) must
generalize to a per-output-column projector: either "copy source column `i`" or
"evaluate expression `e` against the source row". Suggested shape:

```
type BackingProjector =
  | { kind: 'passthrough'; sourceCol: number }
  | { kind: 'expr'; eval: (sourceRow: Row) => SqlValue }
projectors: BackingProjector[]   // one per backing output column
```

`applyRowTimeChange`'s `project(row)` becomes
`projectors.map(p => p.kind === 'passthrough' ? row[p.sourceCol] : p.eval(row))`.
`lookupCoveringConflicts` keeps using only the passthrough projectors for the
inverse map (UC + PK columns), so it is unaffected.

### Evaluating an expression column against a source row

Two viable approaches — pick one (recommend (a) for v1, note the tradeoff):

**(a) Reuse the row-scalar compiler in `vtab/memory/utils/predicate.ts`.** That
file already compiles a scalar AST against a `Row` for partial-index/partial-WHERE
predicates (`compileExpression` → `Evaluator = (row) => SqlValue`). Export a
`compileScalar(expr, columns): (row) => SqlValue` (factor out the existing
internal `compileExpression`; `compilePredicate` keeps wrapping it for the boolean
case). Compile each computed projection column's **body-AST** expression against
the source table's columns. This is DRY with how the partial WHERE is already
compiled in `buildRowTimePlan`. Limitation: the current compiler supports
literals, columns, comparison/AND/OR/NOT, IS [NOT] NULL, literal IN, and unary/
binary arithmetic — extend it to deterministic function calls / `CASE` / `CAST`
as needed, throwing a clear shape diagnostic on an unsupported form (mirrors its
existing "unsupported expression in partial-index predicate" errors). A rejected
form steers the user to a plain `view`.

**(b) Emit the producing `ScalarPlanNode` to a runtime evaluator** against a
synthetic single-row context. More general (covers any scalar the planner
supports) but heavier and introduces a runtime-context dependency into the
maintenance plan. Defer unless (a)'s form set proves too narrow.

Whichever path: enforce determinism via `checkDeterministic` on the producing
scalar plan node (it reads `physical.deterministic`), independent of the
compile-form check, so a deterministic-but-unsupported form fails on *shape* and a
supported-but-non-deterministic form fails on *determinism* — distinct diagnostics.

### Provenance

Reuse the existing `resolveSourceCol(attrId, sourceAttrToCol, producingByAttrId)`
to decide passthrough vs. expression per backing column: a resolved source column
→ `passthrough`; otherwise the producing expr (from `collectProducingExprs`) is the
computed expression to compile. The PK-coverage check stays as-is (it already
operates on the passthrough set).

## Tests

- `53-materialized-views-rowtime.sqllogic`: flip the `bad_expr` case
  (`select id, v + 1 as v1 from g`) from a **rejection** to an **acceptance** —
  create succeeds, and insert/update/delete on `g` maintain `v1` correctly
  (reads-own-writes). Add an arithmetic + a deterministic-function (e.g.
  `lower`/`abs`) projection column, verifying the computed value tracks source
  updates (including a key-changing update and a predicate-scope transition with a
  partial WHERE present).
- Add a **non-deterministic projection rejection**: `select id, random() as r from g`
  errors at create with the determinism diagnostic (not the shape diagnostic).
- Add an **unsupported-form** rejection if the chosen compiler can't handle a form
  (asserts the shape diagnostic steers to a plain view).
- Confirm a covering MV still enforces UNIQUE correctly when it *also* carries an
  extra computed column (UC + PK columns remain passthrough; the computed column is
  just stored).

## Docs

`docs/materialized-views.md` already states the eligible projection is
"**passthrough or deterministic expressions** over single-source columns" — so the
contract text needs no change. Verify the "Maintenance" table / projection prose
reads correctly for computed columns and adjust only if it still implies a pure
permutation anywhere.

## Validation

- Build + lint clean.
- `yarn test` green — stream: `yarn test 2>&1 | tee /tmp/mv-expr.log; tail -n 80 /tmp/mv-expr.log`.

## TODO

- Factor/export a row-scalar evaluator (recommend extending
  `vtab/memory/utils/predicate.ts`; keep `compilePredicate` as the boolean wrapper).
- Generalize `RowTimeMaintenancePlan` to per-column projectors (passthrough | expr).
- In `buildRowTimePlan`: classify each backing column via provenance; compile
  expression columns; enforce `checkDeterministic` on each; keep PK/UC columns
  passthrough; remove the blanket "no computed/expression columns" rejection.
- Update `applyRowTimeChange`'s `project()` to evaluate per-column projectors.
- Confirm `lookupCoveringConflicts` still builds its inverse map from passthrough
  columns only.
- Update `53` tests (flip `bad_expr`, add determinism + computed-maintenance cases).
- Build + lint + `yarn test`.
