description: Row-time materialized-view eligibility gate lifted to allow deterministic scalar-expression projection columns (e.g. `id, v + 1 as v1, lower(name) as ln`) over the single source row, while keeping PK / backing-key / UNIQUE-covered columns passthrough and rejecting non-deterministic and cross-row/subquery projections. Reviewed and accepted.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, docs/materialized-views.md
----

## What landed

The row-time eligibility gate (`buildMaintenancePlan` in
`core/database-materialized-views.ts`) no longer rejects every non-passthrough
projection column. A backing output column is now classified as one of:

- **passthrough** — copies a source column (the existing column permutation); or
- **expr** — a deterministic scalar expression over the single source row.

`InverseProjectionPlan.projectionSourceCols: number[]` was generalized to
`projectors: BackingProjector[]` (tagged union `{kind:'passthrough', sourceCol}` |
`{kind:'expr', eval}`). `applyInverseProjection`'s `project(row)` maps each projector
(copy vs. evaluate); `lookupCoveringConflicts` builds its inverse (source↔backing) map
from the **passthrough projectors only**, so PK/UC recovery is unchanged and extra
computed columns are invisible to conflict resolution.

Computed columns are compiled once at create (`compileSourceRowEvaluator`) by emitting
the producing `ScalarPlanNode` and running it per changed row against a `RowContextMap`
that maps source attribute ids → row column indices — the same runtime-reuse pattern as
`planner/analysis/const-evaluator.ts`. This guarantees a computed backing value is
byte-for-byte what `select <body>` produces (MV ≡ view by construction). Maintenance
shape is unchanged: one source row → one backing row, O(log n) per row, no body
re-execution, no scan.

Gate invariants kept: PK columns must be passthrough; no computed column may land in
the backing key (order-by cols + logical PK); UNIQUE-covered columns stay passthrough
(coverage prover unchanged); non-deterministic producers (`random()`/`now()`) are
rejected with a **determinism** diagnostic; subquery/cross-row producers are rejected
with a **shape** diagnostic (`assertSingleRowEvaluable`).

## Review findings

**Verdict: accepted.** No code changes were required; the implementation is correct,
well-decomposed, and matches the surrounding code's idioms. One exploratory test
addition was attempted and reverted (see Tests). Disposition of every angle examined:

### Correctness (MV ≡ view) — checked, sound
- The design deviation (approach **b**: reuse the runtime via `compileSourceRowEvaluator`
  instead of approach **a**: extend `vtab/memory/utils/predicate.ts`) was scrutinized and
  is the **better** choice. The ticket explicitly permitted (b) "unless (a)'s form set
  proves too narrow", and it is: `predicate.ts`'s compiler supports no binary arithmetic
  and no function calls — both required by the ticket's own `abs`/`lower` test. Approach
  (a) would re-implement numeric/bigint/temporal coercion (`emitNumericOp`) and re-resolve
  functions by name, duplicating runtime semantics and risking MV ≠ view divergence.
  Approach (b) makes the MV evaluate the **identical** `ScalarPlanNode` the live view runs,
  so equivalence holds by construction. `predicate.ts` was correctly left untouched.
- `assertSingleRowEvaluable` is a sound shape gate: it rejects any relational subtree
  (subquery → cross-row) and any `ColumnReferenceNode` whose `attributeId` is not in the
  source descriptor (correlated/outer ref). This guarantees evaluation is a pure function
  of the changed row, and means a provenance mismatch becomes a clean create-time rejection
  rather than a silent wrong value. Verified against `determinism-validator.ts` (reads
  `physical.deterministic`) — ordering is correct: `random()` fails determinism, `(select
  g.v)` passes determinism then fails shape, matching the new diagnostics tests.
- PK-passthrough, backing-key-passthrough, and UC-passthrough enforcement all verified:
  `lookupCoveringConflicts` reads only `kind==='passthrough'` projectors for the inverse
  map, so computed columns cannot perturb conflict resolution.

### Type safety — checked, acceptable
- `result as SqlValue` in `compileSourceRowEvaluator` is guarded: relational outputs are
  rejected earlier by `assertSingleRowEvaluable`, so a gated top-level scalar returns a
  `SqlValue`; the `instanceof Promise` branch throws `INTERNAL` for any async escape. No
  `any`. `RuntimeContext` is constructed with the documented optional fields omitted
  (`stmt: undefined`, no `tracer`/`activeConnection`) — consistent with `const-evaluator`.

### Resource cleanup / state — checked, acceptable
- The `RuntimeContext`/`RowContextMap` is built once per computed column and reused with a
  mutable `currentRow` closure. Since `Scheduler.run` is synchronous for gated forms and JS
  is single-threaded, there is no reentrancy/interleaving across `project(oldR)`/`project(newR)`
  or across the MV-over-MV cascade (each plan owns its own evaluators). The implementer's
  flagged debug-level "context leak" log (context.size > 0 at end of run, because the
  source descriptor entry is intentionally never removed) is cosmetic and harmless; left
  as-is to avoid disturbing working code. Note: `const-evaluator` uses the strict-fork
  RowContextMap for leak *detection*; this code uses the plain map, which is fine.

### Module boundaries — checked, consistent
- The new core→runtime import edge (`emitPlanNode`/`Scheduler`/`EmissionContext`/
  `RowContextMap`/`RuntimeContext`) mirrors the existing `const-evaluator` (planner→runtime)
  and the pre-existing `runtime/emit/materialized-view-helpers` import in this file. Build
  is clean, so no load-time cycle.

### Tests — checked; implementer's floor is solid, one exploratory addition reverted
- Verified green (this pass): `yarn lint` clean (exit 0); the MV test surface —
  `logic.spec.ts` (all `*.sqllogic`, including §1–20 of `53-...` and §8 of `54-...`),
  `materialized-view-diagnostics.spec.ts`, and `maintenance-equivalence.spec.ts` (8 shapes
  incl. the 4 new expression shapes) — ran **237 passing, 0 failing**.
- The implementer's coverage is a genuine floor: equivalence harness fuzzes computed
  columns (arithmetic, function+cast, CASE, expression+partial-WHERE) across random
  insert/update/key-change/delete sequences in-txn and after rollback; sqllogic §19/§20
  cover reads-own-writes, CASE/CAST/`||`, predicate-scope transitions in/out, key-changing
  updates; §7 flips the old `bad_expr` accept→reject into `bad_nondet` (determinism tail)
  and `bad_subq` (shape tail); diagnostics spec adds the determinism case, the subquery
  case, and a positive "accepts + maintains a deterministic expression column" test;
  `54-...` §8 proves a covering MV with an extra computed column still enforces UNIQUE
  (ABORT + REPLACE) with the computed col maintained through eviction.
- **Minor finding (reverted, recommendation below): NULL-input coverage gap.** The
  equivalence harness generates only non-null integers (`fc.integer({min:0,max:10})`) and
  §19/§20 use non-null values, so NULL values flowing through `v+1`/`abs(v)`/`lower(name)`
  are not empirically exercised. I added a `53-...` §21 to cover this; it **failed — but the
  failure was in my test, not the feature, and it is instructive.** The error was
  `ConstraintError: NOT NULL constraint failed: en.v` raised from `runInsert` on the
  *source* `insert into en values (2, null, null)` — i.e. it never reached MV maintenance.
  Root cause: Quereus treats a bare `v integer` column as **NOT NULL** (the existing §14
  uses `x integer null` explicitly for nullable columns — the precedent I missed); my §21
  table omitted the `null` markers, so the NULL source row could not even be inserted. This
  is doubly reassuring: (a) it is a pure test-authoring bug, and (b) it confirms there is
  **no** MV-computed-NULL defect — and in any case MV ≡ view is guaranteed *by construction*
  for NULL inputs because the MV evaluator and the live view run the *identical*
  `ScalarPlanNode` through the *identical* runtime (the equivalence harness, which compares
  MV vs view directly, would catch any divergence and is green for the expression shapes).
  Rather than commit a failing test, I **reverted §21**, restoring the confirmed-green
  state. See "Recommended follow-up".

### Docs — checked, accurate
- `docs/materialized-views.md` was updated to describe the passthrough-or-deterministic-
  expression projection, the determinism-vs-shape rejection split, the PK/backing-key
  passthrough requirement, and the per-column-projector `MaintenancePlan` shape. The prose
  matches the implemented gate (verified against the code). The module-level doc comment and
  the `MaintenancePlan`/`BackingProjector`/`InverseProjectionPlan` JSDoc were likewise
  brought into line with the new reality.

### Honest flags from the handoff — assessed
- Async guard unproven: acceptable defense-in-depth (throws `INTERNAL`, never silently
  awaits) — no gated form can produce a Promise.
- `predicate.ts` factoring skipped: correct call (see Correctness).
- Per-row scheduler overhead not benchmarked: acceptable — dominated by btree maintenance,
  paid only for computed columns; not a correctness concern.

## Recommended follow-up (minor, not blocking)

Extend `maintenance-equivalence.spec.ts`'s value arbitrary to occasionally emit `NULL`
(e.g. `fc.option(fc.integer({min:0,max:10}), { nil: null })`) so the `read(MV) ==
evaluate(body)` property covers NULL inputs flowing through computed columns. This is the
clean way to lock NULL behavior in (it compares MV vs the live body, so no hardcoded
expectations to get wrong) and would permanently close the coverage gap noted above. Low
priority — the property is guaranteed by construction (shared `ScalarPlanNode`/runtime).

## Validation status

- `yarn lint` (quereus) — **clean (exit 0)**.
- MV test surface (`logic.spec.ts` + `materialized-view-diagnostics.spec.ts` +
  `maintenance-equivalence.spec.ts`) — **237 passing, 0 failing** (re-run this pass).
- Full `yarn test` per the implement handoff — 3948 passing, 9 pending, 0 failing; other
  workspaces green. (The pre-existing `[property-planner] Rule '…' never fired` notices are
  unrelated and predate this change.)
- `yarn test:store` not run (no store-specific code touched; the backing table is always
  the memory module).

## End
