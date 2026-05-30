description: Review the row-time MV gate change that lifts the passthrough-only projection restriction — a backing output column may now be a deterministic scalar expression over the single source row (e.g. `id, v + 1 as v1, lower(name) as ln`). PK / backing-key / UNIQUE-covered columns must still be passthrough; non-deterministic projections are rejected. Verify correctness (MV ≡ view), the design deviation from the ticket's recommended approach, and the diagnostics.
prereq: materialized-view-rowtime-only-consolidation, incremental-maintenance-plan-abstraction
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, docs/materialized-views.md
----

## What landed

The row-time eligibility gate (`buildMaintenancePlan` in
`core/database-materialized-views.ts`) no longer rejects every non-passthrough
projection column. A backing output column is now classified as one of:

- **passthrough** — copies a source column (the existing column permutation); or
- **expr** — a **deterministic scalar expression** over the single source row.

`InverseProjectionPlan.projectionSourceCols: number[]` was generalized to
`projectors: BackingProjector[]` (a tagged union `{kind:'passthrough', sourceCol}` |
`{kind:'expr', eval}`). `applyInverseProjection`'s `project(row)` now maps each
projector (copy vs. evaluate); `lookupCoveringConflicts` builds its inverse
(source↔backing) map from the **passthrough projectors only**, so PK/UC recovery is
unchanged and any extra computed columns are invisible to conflict resolution.

The maintenance math is unchanged in shape: one source row → one backing row,
O(log n) per row (btree delete + insert), **no body re-execution, no scan**. The only
addition is evaluating the computed columns of that one row.

### Constraints kept (verify these in review)

- **PK columns stay passthrough.** Every source PK column must be projected as a
  passthrough column (so `lookupCoveringConflicts` can invert it); a PK col produced
  only via an expression (or not at all) is rejected.
- **No computed column in the backing key.** After building `backingPkDefinition`,
  each backing-key column index (order-by columns + logical PK) must map to a
  passthrough projector — else rejected. This protects the btree key and the inverse
  map.
- **UNIQUE-covered columns stay passthrough** transitively: the coverage prover
  already requires UC columns be passthrough, so a covering MV is unaffected; it
  *ignores* extra computed columns (only checks UC+PK coverage — verified). A
  non-covering MV may freely compute non-PK columns.
- **Determinism.** Each computed column's producing `ScalarPlanNode` is checked via
  `checkDeterministic` (reads `physical.deterministic`); `random()`/`now()`/… are
  rejected with a **determinism** diagnostic, distinct from the **shape** diagnostic.

## ⚠️ Design deviation from the ticket — please scrutinize

The ticket **recommended approach (a)**: extend the AST row-scalar compiler in
`vtab/memory/utils/predicate.ts` (export `compileScalar`, factor out
`compileExpression`). **I chose approach (b) instead** — reuse the runtime: emit the
producing `ScalarPlanNode` once and run it per changed row against a row context that
maps source attribute ids → row column indices (new helper
`compileSourceRowEvaluator`, mirroring `planner/analysis/const-evaluator.ts` but with
a row context).

Rationale (the ticket explicitly allows (b) "unless (a)'s form set proves too narrow",
and it is): `predicate.ts`'s compiler today supports **no binary arithmetic and no
function calls** — both are required (the ticket's own `abs`/`lower` test). Extending
(a) to cover them would (1) re-implement numeric/bigint/temporal coercion that already
lives in the runtime's `emitNumericOp`, and (2) re-resolve functions by name (the
`ScalarPlanNode` already carries the resolved `functionSchema`). Both duplicate runtime
semantics and risk **MV ≠ view** divergence. Approach (b) reuses the canonical
evaluator, so a computed backing value is **byte-for-byte** what `select <body>`
produces — verified directly (a scratch probe showed `select * from mv` == `select
<body>` for the same rows) and now property-tested (see below).

Consequences a reviewer should weigh:
- **`predicate.ts` was NOT touched.** The partial-WHERE still uses `compilePredicate`
  unchanged. The ticket's "factor out `compileScalar`" TODO was deliberately not done.
- **Per-row cost** is a synchronous `Scheduler.run` over a tiny pre-built instruction
  tree (built once at create), not a hand-rolled closure. Heavier than (a)'s closure,
  but dominated by the btree ops, and only paid for *computed* columns.
- **Synchronicity** relies on the gated forms being subquery-free deterministic
  scalars (all `ScalarFunc` impls are sync). `compileSourceRowEvaluator` throws a loud
  `INTERNAL` if `Scheduler.run` ever returns a Promise — it shouldn't for gated forms,
  but that path is unproven (see gaps).
- A new core→runtime import edge (`emitPlanNode`/`Scheduler`/`EmissionContext`/
  `RowContextMap`) was added to `database-materialized-views.ts`. Core already imports
  `runtime/emit/materialized-view-helpers`, and `const-evaluator` does the same from
  `planner/`, so this is consistent — but confirm no load-time cycle concern.

`assertSingleRowEvaluable` is the shape gate that keeps (b) honest: it rejects a
producing expr containing any relational subtree (subquery) or a `ColumnReferenceNode`
that doesn't resolve to a source column (a correlated/outer ref), so evaluation stays a
pure function of the changed row.

## How to test / validate (use cases)

Automated coverage added (all green — `yarn test`, lint, full `yarn build`):

- **`53-...sqllogic` §19** — arithmetic + `abs`/`lower` projection columns: create
  equals body; insert/update/delete maintain every computed column (reads-own-writes).
  Plus a §19 case for CASE/CAST/`||` forms (all accepted).
- **`53-...sqllogic` §20** — expression columns under a partial WHERE: a key-changing
  update (the computed col reads the changing key col) and predicate-scope transitions
  in **and** out.
- **`53-...sqllogic` §7** — the old `bad_expr` rejection is **flipped**; replaced by
  `bad_nondet` (`random()` → determinism tail) and `bad_subq` (`(select g.v)` → "shape"
  subquery tail).
- **`54-covering-mv-enforcement.sqllogic` §8** — a covering MV that *also* carries a
  computed column (`x + y as sxy`) still enforces UNIQUE (ABORT + REPLACE), and the
  computed col is maintained through a REPLACE eviction.
- **`materialized-view-diagnostics.spec.ts`** — the per-reason "computed/expression
  column" rejection case was removed; added a determinism-tail case, a subquery-shape
  case, and a positive "accepts + maintains a deterministic expression column" test.
- **`maintenance-equivalence.spec.ts`** — the documented correctness oracle was
  **extended** with 4 expression shapes (arithmetic, function+cast, CASE, expression +
  partial WHERE), so the `read(MV) == evaluate(body)` property now fuzzes computed
  columns across random insert/update/key-change/delete sequences, in-txn and after
  rollback.

Manual angles a reviewer might probe beyond this floor:
- Computed column over a **nullable** source column (NULL propagation through the
  expression — `abs(null)`, `lower(null)` → null; partially covered by §19's negative
  `v`, not by an explicit NULL).
- **Collation / temporal** expression columns (reused from the runtime, not
  specifically tested here).
- A computed column whose value is a **bigint vs number** boundary (equivalence holds
  by construction since both sides use the runtime, but the JSON serialization in
  sqllogic expectations is worth a sanity check).
- Multi-statement / bulk DML where many rows each evaluate the expression (per-row
  scheduler cost path).

## Known gaps / honest flags

- **Async guard is unproven.** `compileSourceRowEvaluator` throws `INTERNAL` if a
  result is a Promise. No test exercises that branch (no gated form produces one); it's
  defense-in-depth. If a reviewer disagrees with throwing vs. awaiting, that's a design
  call.
- **`predicate.ts` factoring skipped** (see deviation). If the project prefers the
  single-AST-compiler DRYness over runtime-reuse correctness, this is the place to push
  back — but note the MV≡view guarantee that (b) buys.
- **Unsupported-form surface is narrow by design.** Because (b) reuses the runtime,
  almost every single-source deterministic scalar is accepted (arithmetic, functions,
  CASE, CAST, `||`). The only projection-specific rejections are non-determinism and
  cross-row/subquery. The "unsupported form" test uses a correlated subquery; window
  functions hit an earlier ORDER-BY parse error, not the projection gate.
- **Per-row evaluation overhead** is not benchmarked. It's expected to be dominated by
  btree maintenance, but no perf assertion exists.
- The `RuntimeContext` is reused across rows with a mutable `currentRow` closure (set
  once, getter reads the closed-over row). Correct given we never `close()` the context
  — but the scheduler emits a debug-level "context leak" log because `context.size > 0`
  at end of each run. Harmless; flag if the noise matters.

## Validation status

- `yarn build` (all packages) — clean.
- `yarn lint` (quereus) — clean.
- `yarn test` (quereus) — **3948 passing, 9 pending, 0 failing**; other workspaces
  green. (Pre-existing `[property-planner] Rule '…' never fired` notices are unrelated
  diagnostics, present before this change.)
- `yarn test:store` was **not** run (no store-specific code touched — the backing table
  is always the memory module; covering enforcement under the isolation-wrapped store
  path does not route through the MV per `54`'s header note).
