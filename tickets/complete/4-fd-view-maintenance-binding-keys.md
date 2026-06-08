---
description: Reusable DeltaExecutor kernel, FD-aware BindingExtractor, projection-capture support in ChangeCapture, and the AssertionEvaluator migration that drives 'group' classifications through per-group-key residual execution. Reviewed and shipped with two inline fixes (savepoint merge consistency + non-PK 'row' binding capture) and one follow-up ticket (NULL group-key dispatch).
files:
  - packages/quereus/src/planner/analysis/binding-extractor.ts
  - packages/quereus/src/runtime/delta-executor.ts
  - packages/quereus/src/core/database-transaction.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/src/planner/analysis/constraint-extractor.ts
  - packages/quereus/src/planner/optimizer-tuning.ts
  - packages/quereus/test/optimizer/binding-extractor.spec.ts
  - packages/quereus/test/incremental/delta-executor.spec.ts
  - packages/quereus/test/incremental/transaction-merge.spec.ts (added in review)
  - packages/quereus/test/logic/95-assertions.sqllogic
  - docs/optimizer.md
  - docs/architecture.md
  - docs/incremental-maintenance.md
---

## Summary

Generalized the assertion delta machinery into a reusable change-driven
kernel (`DeltaExecutor`) and migrated `AssertionEvaluator` onto it.
`extractBindings` packages `analyzeRowSpecific`'s output into a
`BindingMode` per `TableReferenceNode` (`'row'`, `'group'`, `'global'`).
`TransactionManager` gained on-demand projection capture so `'group'`
bindings see the column values they need at COMMIT, and `'group'`
classifications now drive per-group-key residual execution instead of
falling back to a full violation query. The shared surface is shaped so
materialized views, signals, and triggers can register `DeltaSubscription`s
without rewriting change capture or binding-key analysis.

## Key files

- `packages/quereus/src/planner/analysis/binding-extractor.ts` —
  `extractBindings`, `chooseRowKey` (PK preferred, else lex-min covered key).
- `packages/quereus/src/runtime/delta-executor.ts` — `DeltaExecutor.runAll`,
  cost fallback via `tuning.deltaPerRowFallbackRatio` (default `0.5`).
- `packages/quereus/src/core/database-transaction.ts` —
  `registerCaptureSpec`, `getChangedTuples`, the shared `mergeRecordInto`
  state machine (used by both record paths and savepoint RELEASE).
- `packages/quereus/src/core/database-assertions.ts` — `injectKeyFilter`
  (used for both `'row'` and `'group'`), pre-compiled residuals per
  `'row'`/`'group'` relation, no-deps assertion short-circuit.
- DML emitter — INSERT/UPDATE/DELETE call sites pass full pre/post rows +
  PK column indices.

## Testing

- Unit: `binding-extractor.spec.ts` (5 cases) + `delta-executor.spec.ts`
  (10 cases) cover the optimizer-side packaging and the kernel dispatch
  semantics with mock context.
- Regression added in review: `transaction-merge.spec.ts` (3 cases) for
  the savepoint merge fix — verifies that an UPDATE inside a savepoint
  followed by RELEASE preserves the parent layer's `oldProjection`, that
  INSERT-then-UPDATE merges to a single INSERT, and that
  INSERT-then-DELETE collapses on RELEASE.
- End-to-end: `test/logic/95-assertions.sqllogic` `orders_nonneg` case
  exercises the `'group'` path through a real assertion (commit-time
  failure + rollback verification).
- `yarn lint` — clean.
- `yarn test` — 2895 passing, 2 pending. `yarn test:store` not run by this
  pass; spot-check before any release that cares.

## Usage

```ts
// Register a change-driven consumer:
const bindings = extractBindings(plan);
const dispose = deltaExecutor.register({
  id: 'view:my_view',
  dependencies: /* set of base tables in plan */,
  bindings: bindings.perRelation,
  relationToBase: bindings.relationToBase,
  pkIndicesByBase: /* PK indices per base table */,
  async apply({ perRelationTuples, globalRelations }) {
    for (const [relKey, tuples] of perRelationTuples) { /* per-binding refresh */ }
    if (globalRelations.size > 0) { /* full re-evaluation */ }
  },
  dispose() { /* release any per-subscription resources */ },
});
```

For non-PK columns the consumer needs to retain across changes:

```ts
db.registerCaptureSpec('main.t', { extraColumns: new Set([2, 3]) });
```

## Review findings

### Scope of review

Read the implement diff (`e55d9559`) cold against the handoff. Walked
every changed file plus the un-changed-but-related `func/builtins/explain.ts`.
Scrutinized: cleanup paths, savepoint merge consistency, capture-spec
contract, NULL handling, ordering of no-deps assertions vs kernel
dispatch, residual parameter shape, schema-generation invalidation,
documentation accuracy.

### Findings — fixed in this pass (minor)

- **Savepoint merge state machine divergence** (`database-transaction.ts`).
  `releaseSavepointLayer` had its own merge ladder that fell through to a
  raw `tgt.set(pkKey, rec)` for combinations not enumerated, including
  `update→update`. That overwrote the parent layer's `oldProjection`,
  silently losing a row's pre-transaction state on RELEASE. Per-group
  dispatch would then never re-evaluate the original group when a row had
  been touched both before and during a savepoint.
  - Fix: extract `mergeRecordInto(layer, ...)` and route both
    `mergeRecord` and `releaseSavepointLayer` through it. Added the
    explicit `update→update` branch (preserve earliest `oldProjection`,
    take latest `newProjection`) and `delete→delete` no-op branch.
  - Regression: 3 tests in `test/incremental/transaction-merge.spec.ts`
    covering the originally-broken update-update-RELEASE case plus the
    other branches.

- **Non-PK `'row'` bindings silently demoted to global** (`database-assertions.ts`).
  `chooseRowKey` may pick a non-PK covered unique key (e.g. when the
  predicate is `WHERE email = ?` and only `{email}` is covered). The
  capture-registration loop only registered extras for `'group'` bindings,
  with a comment claiming `'row'` always uses PK. The kernel would then
  catch the `getChangedTuples` "column not registered" throw and demote
  the relation to global — correct, but defeats the optimization.
  - Fix: registration loop now records non-PK extras for any binding
    (`'row'` or `'group'`) whose key columns aren't all in the PK.
  - Updated `docs/incremental-maintenance.md` to reflect this.

### Findings — filed as follow-up (major)

- **NULL group-key dispatch silently misses violations**
  (`tickets/fix/delta-null-group-key.md`). The injected residual predicate
  `col_i = :gk{i}` evaluates UNKNOWN against NULL, so a group with NULL
  key value produces no rows under residual evaluation, the aggregate
  sees nothing, and the assertion silently passes even when the actual
  NULL group is in violation. Affects any `'group'` binding on a nullable
  column. Fix requires planner work (IS NOT DISTINCT FROM-style predicate
  or a NULL-track residual variant) — outside review scope. Filed in
  `tickets/fix/delta-null-group-key.md` with options and a repro sketch.

### Findings — noted, not actioned

- **`runOne` is sequential, no parallelism** — known and called out in the
  handoff. Correct for assertions (first violation wins). Future MV
  consumers may want topo-sorted or parallel dispatch; revisit when a
  second consumer lands.
- **`runGlobalAssertions` runs no-deps assertions before the kernel.** A
  no-deps `CHECK (1=0)` will throw before any table-dep assertion fires
  on the same commit. The previous code had the same effective ordering
  via `evaluateAssertion`; no behavior regression. Documented in the
  handoff "Things to scrutinize" section.
- **`explain_assertion` lists group-key column names rather than the
  internal `gk0..gkN-1` parameter names.** Slight mismatch with
  `prepared_pk_params`'s "parameter names" doc string, but the column
  names are the more user-meaningful diagnostic and the runtime parameter
  scheme is otherwise unobservable. Left as-is.
- **Per-subscription residual cache, no shared cache** — by design;
  consumer-specific plan shapes don't share. Revisit when a duplication
  pattern appears.
- **Cost-fallback ratio is a first cut** — `tuning.deltaPerRowFallbackRatio
  = 0.5` is the threshold; a real cost comparator is left as a follow-up
  per the plan ticket's "Design decisions worth surfacing" section.

### Categories explicitly checked with nothing to flag

- **Resource cleanup.** `releaseCached` releases both the subscription
  dispose handle and capture disposers; `dispose()` walks all cached
  entries and then calls `executor.disposeAll()`. Each disposer is
  idempotent (own `disposed` guard). Double-dispose is safe.
- **Type safety.** No new `any`. New `BindingMode` is a discriminated
  union; the executor narrows on `kind` before reading key/group columns.
  `getChangedTuples` throws (rather than returning undefined) on missing
  capture, and the kernel catches and demotes-to-global with a log line.
- **Schema invalidation.** `schemaGeneration` is bumped on
  `table_added/removed/modified`; `getOrCompilePlan` releases the prior
  cached entry (subscription + capture disposers) before recompiling.
- **DML emitter call sites.** All four (`UPSERT`, `INSERT`, `UPDATE`,
  `DELETE`) pass the full row + `pkColumnIndicesInSchema` in the new
  signatures; no callers remain on the old PK-only API.
- **Test coverage of the kernel.** All 10 dispatch-mode and lifecycle
  cases in `delta-executor.spec.ts` cover the kernel surface adequately
  for the assertion consumer; gaps for MV-style multi-subscription
  ordering are noted but out of scope until that consumer lands.

### Test gaps the implementer flagged that weren't closed

- No end-to-end test exercises the cost-fallback through a real assertion.
  Mock-only coverage today.
- No sqllogic test asserts the per-group dispatch actually runs N=1 times
  for a one-row change (would need a probe assertion / counter).
- The `orders_nonneg` sqllogic test asserts only the failure path. A
  passing-path "UPDATE shifts customer_id from one group to another"
  case would tighten coverage of the OLD/NEW projection contract.

These are noted but not added in this pass — they tighten coverage on
already-validated paths rather than block correctness.
