---
description: DML-in-expression-position landed. Full-drain + run-once contracts for scalar / IN / EXISTS subqueries with impure inners, planning gates lifted at all five sites, view-body DML rejection made permanent, determinism flag set on DmlExecutorNode so CHECK/DEFAULT/generated rejects subquery-wrapped DML.
files:
  - packages/quereus/src/runtime/emit/subquery.ts
  - packages/quereus/src/planner/nodes/dml-executor-node.ts
  - packages/quereus/src/planner/building/expression.ts
  - packages/quereus/src/planner/building/select-compound.ts
  - packages/quereus/src/planner/building/with.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/building/create-view.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/parser/ast.ts
  - packages/quereus/src/schema/view.ts
  - packages/quereus/test/logic/01.9-query-expr-dml.sqllogic
  - packages/quereus/test/logic/01.9-query-expr-dml-gates.sqllogic
  - docs/sql.md
  - docs/runtime.md
  - docs/view-updateability.md
  - docs/architecture.md
---

## Outcome

DML (`INSERT/UPDATE/DELETE … RETURNING`) now executes in scalar /
`IN` / `EXISTS` / compound-leg / CTE-body / INSERT-source positions
under emitter-applied full-drain + run-once semantics. The planning
gates ticket 1 installed for those positions are gone. DML as a view
body remains rejected — now permanently, with a clear error code
(`ERROR`, not `UNSUPPORTED`) and rationale ("a view re-evaluates per
reference; replaying a write per read is incoherent"). `DmlExecutorNode`
flips `physical.deterministic: false` so subquery-wrapped DML cannot
sneak past the determinism gate inside CHECK / DEFAULT / generated /
assertion expressions.

Lint clean. `yarn test` green (3660 + 9 pending, no failures).

## Review findings

### Verified by inspection

- **Parser RETURNING gate is wired everywhere.** `parseQueryExpr(_, true)`
  is passed at every non-top relation site: subquery-as-expression
  (`( … )` scalar, `IN ( … )`, `EXISTS ( … )`), `subquerySource` (FROM
  clause), compound-leg DML, CTE body, CREATE VIEW body, INSERT source.
  The `as RelationalPlanNode` casts in `expression.ts` / `select-compound.ts`
  / `with.ts` / `insert.ts` are sound because the parser-gated path
  guarantees `buildInsertStmt`/`buildUpdateStmt`/`buildDeleteStmt`
  return a `ReturningNode` (a relational node) rather than a `SinkNode`.

- **Run-once memoization scope is correct.** `_iterateRowsRawInternal`
  (`src/core/statement.ts:290+`) calls `emitPlanNode` and constructs a
  fresh `Scheduler` per iteration. `EmissionContext` does not cache
  instructions across runs. So the impure-path closure state in
  `subquery.ts` (`let memoized = …`) resets per `prepare`/`run` cycle.
  Within a single execution, sub-schedulers wrapped by `emitCall` reuse
  the same `Instruction` across per-row callback invocations, which is
  exactly what makes the memoization useful for correlated outers.

- **Physical-property propagation reaches the determinism gate.**
  `DmlExecutorNode.computePhysical` sets `deterministic: false`. The
  default `PlanNode.physical` getter (`plan-node.ts:560+`) computes
  `deterministic` as AND-of-children, so it flows up through
  `ConstraintCheckNode → ReturningNode → ScalarSubqueryNode` (whose
  `getChildren()` includes the subquery — `subquery.ts:33`) into the
  surrounding CHECK expression. `checkDeterministic` (`determinism-validator.ts:26`)
  rejects on `physical.deterministic === false`. CHECK validation is
  lazy (fires at first INSERT planning through
  `constraint-builder.ts:150`), which matches the test's
  CREATE-TABLE-succeeds, INSERT-rejects shape.

- **`subtreeHasSideEffects` remains sound under cache wrapping.** If
  `MaterializationAdvisory` wraps the inner with a `CacheNode`, the cache
  itself is `readonly: true` but its child carries `readonly: false`;
  `subtreeHasSideEffects` walks children recursively (`framework/characteristics.ts:36`),
  so the impure-path branch is still taken. Doubly safe: `CacheNode` is
  itself a run-once fence (materialize-on-first-read + replay), so even
  in the unlikely event the emitter's memoization is bypassed, the cache
  prevents the DML from re-firing.

- **`getRelations()` on `ScalarSubqueryNode` includes the subquery
  (`subquery.ts:39`)**, so the change-scope walker descends through it.
  This is the path that delivers the "nested DML writes are reported
  by `getChangeScope`" guarantee the ticket called out. No new test pin
  was added (see Gaps below).

- **View-body rejection rationale is correct and the status code change
  is the right call.** `UNSUPPORTED` reads as "pending"; `ERROR` reads
  as "rejected by design". Doc updates in `docs/sql.md` /
  `docs/view-updateability.md` / `schema/view.ts` cohere with the
  diagnostic.

- **`buildInsertStmt`'s DML-as-source path** (the three new branches
  added in the diff) correctly threads `contextWithSchemaPath` into
  the inner builders and applies `checkColumnsAssignable` against the
  outer target columns. Same shape as the SELECT-as-source path.

### Behavioral checks via tests

- `01.9-query-expr-dml.sqllogic` covers scalar / `IN` / `EXISTS` /
  compound-leg / CTE-body / INSERT-source DML, the run-once fence under
  a correlated outer (5 outer rows → 1 inner write), outer-`OR REPLACE`
  not propagating inward, view-as-`VALUES` un-updateability, and
  DML-in-CHECK determinism rejection. Re-run added in this pass:
  UPDATE-in-`EXISTS` and DELETE-as-scalar-subquery (single-row form)
  to cover the non-INSERT DML forms in expression position.
- `01.9-query-expr-dml-gates.sqllogic` is now lean — only the
  surviving gates (parser RETURNING-required, view-body DML).
- Full suite: `yarn test` → **3660 passing**, 9 pending, no failures.
- Lint: `yarn workspace @quereus/quereus run lint` → clean.

### Fixed in this pass (minor)

- **`note` string consistency** — the IN impure-path emitter previously
  noted `'IN (subquery, impure)'` while scalar / EXISTS used
  `'SCALAR_SUBQUERY(impure)'` / `'EXISTS(impure)'`. Normalized to
  `'IN(impure)'` for trace/debug consistency.
- **Test coverage for UPDATE/DELETE in expression position** — added
  cases 8b (UPDATE-in-EXISTS) and 8c (DELETE-as-scalar) to
  `01.9-query-expr-dml.sqllogic` so a future regression in
  `update.ts` / `delete.ts` that broke their `RelationalPlanNode` shape
  surfaces here instead of through a side-quest debug session.

### Gaps and deferrals (intentional, carry forward)

- **Per-row DML in an outer DML** (e.g. `update outer set x = (insert
  into inner ... returning y)`) — out of scope; ordering semantics
  are subtle, documented as a limitation in `docs/sql.md`.
- **`Statement.getChangeScope` regression test** — the implementer
  acknowledged this and the mechanism is already in place via
  `ScalarSubqueryNode.getRelations`. A direct pin ("a SELECT containing
  nested DML in expression position reports the nested base-table
  writes") would harden the contract; deferred to a follow-up test
  ticket rather than handled inline (the change-scope test file is in
  a different test runner and the mechanism is already exercised
  indirectly via the writes-actually-happen positive cases).
- **Re-prepare regression test** — no test currently pins
  "prepare → run → reset → run → assert DML fired twice". The
  re-emission invariant the run-once memoization relies on is held by
  `_iterateRowsRawInternal`'s shape, so this is a defensive pin, not a
  bug catch.
- **Memoization-on-error interaction** — if the inner DML throws
  partway, `memoized` stays empty and a hypothetical second evaluation
  would re-drive the iterator. In practice a thrown statement aborts
  the entire run, so this is theoretical. Worth a test pin if a future
  feature catches per-row errors mid-statement (CASE-style branches
  with caught faults). Not actionable today.
- **Plan-shape golden tests** — not refreshed; the golden suite runs as
  part of `yarn test` and is currently green, so no plans changed in a
  way the goldens cared about.
- **`ALTER TABLE ADD CONSTRAINT` determinism gate** — pre-existing gap
  (the full-physical check is only wired into INSERT/UPDATE planning,
  not into ALTER); not introduced by this ticket.
- **`buildExpressionPositionQueryExpr.preserveInputColumns`** — now
  consumed only by the SELECT case (the DML/VALUES builders don't
  expose the knob). Not a bug, just dead-input for four of five legs.
  Cleanup not worth a follow-up unless the helper grows another caller
  that needs different per-leg dispatch.

### Empty categories (explicit)

- **Performance regression check** — no perf-sensitive hot path changed.
  The pure-path scalar / IN / EXISTS emitters retained their
  short-circuits verbatim; the impure-path branch only fires when
  `subtreeHasSideEffects` reports true, which costs one branch on a path
  that is by construction not hot.
- **Resource cleanup** — the impure-path `for await` consumes the inner
  iterator fully on the first call. On the memoized path the iterator
  is never created with `[Symbol.asyncIterator]()` (we return before
  iterating), so no dangling iterator state to close.
- **Type safety** — the `as RelationalPlanNode` casts at the four new
  builder sites are gated by the parser-side RETURNING enforcement,
  which guarantees a `ReturningNode` (relational) return rather than a
  `SinkNode`. No `any` introduced.
- **DRY** — the impure-path closure is repeated three times (scalar /
  IN / EXISTS) with slightly different result-computation. Extraction
  would obscure the difference in result computation more than it would
  save. Left as-is.

## Out of scope (carried forward, unchanged from implement)

- `query-expr-parallel-track-refusal` — parallel-track audit.
- Per-row DML in outer DML — separate backlog ticket if/when needed.
