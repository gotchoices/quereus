description: In autocommit mode, an insert's `values` rows are computed before the insert opens its implicit transaction, so a module function that answers from the open transaction (Optimystic's `StampId()`) sees none and returns NULL. Make every statement that writes open its implicit transaction before any of its expressions run.
architecture: docs/module-authoring-transactions.md#connection-lifecycle
files: packages/quereus/src/core/database.ts (`_executeSingleStatement`), packages/quereus/src/core/statement.ts (`_iterateRowsRawInternal`, scheduler cache), packages/quereus/src/planner/building/reject-stored-body-writes.ts (walker to share), packages/quereus/src/planner/nodes/plan-node-type.ts (`DML_NODE_TYPES`), packages/quereus/src/runtime/emit/dml-executor.ts (`runInsert`/`runUpdate`/`runDelete` comments), packages/quereus/src/core/database-auto-analyze.ts (doc comment on `getAutocommit`), docs/module-authoring-transactions.md, docs/usage.md (§ Implicit Transactions), packages/quereus/test/core-api-transactions.spec.ts
----

# A write statement begins its transaction before evaluating it

Filed from Optimystic (its `stampid-answers-inside-an-autocommit-write` is blocked on this).

## Problem

The scheduler evaluates an instruction's parameters before running it. A `values` list's row expressions are synchronous parameters of the instructions that feed the insert, so in autocommit they run before `runInsert` (dml-executor.ts) reaches `await ctx.db._ensureTransaction()`. Measured from Optimystic:

| statement, autocommit | result today |
|---|---|
| `insert into t (id, body) values (StampId(), 'a')` | NOT NULL refusal (`id` is NULL) |
| same, multi-row `values` | NOT NULL refusal |
| `insert into t (id, body) select StampId(), 'sel'` | works (rows are pulled inside `runInsert`) |
| the first, inside `begin … commit` | works |
| the first, into a nullable column | stores NULL silently |

## Decision

In autocommit, a statement whose optimized plan contains a write — any node whose type is in `DML_NODE_TYPES` (insert, update, delete, update-executor) at any depth, which covers `returning`, upsert, data-modifying CTEs (`Sequence` children) and writes through views (`ViewMutation` wraps base DML) — begins its implicit transaction immediately before the scheduler runs, so every expression evaluated at run time, `values` rows included, runs inside it. Read-only statements are unchanged: `select fn()` in autocommit still opens no transaction. The emitters' `_ensureTransaction()` calls stay; for such statements they become no-ops (they are still needed for nested statements and DDL). The implicit transaction ends exactly as today, through `_finalizeImplicitTransaction` in the caller.

Rejected: exposing `DatabaseInternal.ensureTransaction()` for modules to call themselves — every module with such a function would have to call it, and each read-only statement evaluating one would open and commit an empty transaction. Not done here; if a module later needs a transaction for a read-only `select fn()`, that is a separate feature.

Tradeoff accepted: a write statement whose DML is never reached at run time (e.g. a `returning` subquery inside an untaken `case` branch) now opens and commits an empty transaction. Harmless; noted so the reviewer doesn't re-raise it.

Out of reach by design: a deterministic function whose arguments are constant may be folded at plan time by the optimizer, before any transaction exists. The guarantee covers run-time evaluation only; a function that answers from the transaction must be registered non-deterministic (StampId is). Say so in the doc.

## Design

**One predicate, shared.** `rejectStoredBodyWrites` already walks a plan (iterative worklist + `seen` set, because the plan is a DAG) looking for a `DML_NODE_TYPES` node. Extract that walk into an exported `findPlanWrite(plan: PlanNode): DmlPlanNode | undefined` (new file `packages/quereus/src/planner/analysis/plan-writes.ts`, moving `DmlPlanNode`/`isDmlPlanNode` with it). `rejectStoredBodyWrites` calls it and throws on a hit; the new callers test `!== undefined`. Reads plan node types, not `physical.readonly`, for the same reason the stored-body check does: a side-effect UDF is not a write and must not open a transaction.

**Exec path** — `Database._executeSingleStatement`: after `optimizer.optimize`, compute `findPlanWrite(optimizedPlan)`; if found, `await this._ensureTransaction()` right before `scheduler.run(runtimeCtx)`, inside the existing `try` so the `finally` still disconnects scan connections on a failed `begin`. Callers (`_execBatchAutocommit`, `_execBatchAsTransaction`, `_evalGenerator`, prepared-batch loops) already finalize; nothing changes there.

**Statement path** — `Statement._iterateRowsRawInternal`: compute the predicate when the scheduler is built (the `if (!this.scheduler)` block) and cache it in a field nulled wherever `this.scheduler` is nulled, so it is recomputed on recompile and costs nothing per execution. Begin after `validateCapturedSchemaObjects()` and before `scheduler.run`. On the committed-read path (`runtimeOverrides.readCommitted`) a write plan is impossible (`_isConcurrentReadEligible` rejects side-effecting nodes); assert that with an `INTERNAL` `QuereusError` rather than silently beginning a transaction the mutex-free path must never touch.

Every serialized caller of `_iterateRowsRawInternal` already runs inside `_iterateFinalizing` (top-level `_iterateSerialized`, `_iterateRowsNestedWithTrace` when no transaction is open) or inside an enclosing statement's transaction (FK cascades through `InternalStatementCache`, MV helpers, alter-table backfill, constraint builder, assertions at commit — `ensureTransaction` is a no-op whenever `inTransaction`), so no new finalization is needed.

**Comments and docs.**
- dml-executor.ts: the three "lazy/JIT transaction start" comments become: already begun by the statement in autocommit; kept for nested statements.
- database-auto-analyze.ts: the `getAutocommit` doc comment says `runInsert` opens the transaction before its first row; now the statement opens it before any instruction runs.
- docs/module-authoring-transactions.md § Connection lifecycle: add the guarantee — in autocommit, a statement that writes begins its implicit transaction before evaluating any of its expressions, so a function called anywhere in it (`values` rows, `set`, `where`, `returning`) runs with `begin` already delivered to every connection registered at that point; a read-only statement opens no transaction; plan-time folding of deterministic calls is outside this, so register such a function non-deterministic.
- docs/usage.md § Implicit Transactions: one sentence to the same effect.

## Edge cases & interactions

- **Explicit transaction / savepoint open**: `ensureTransaction` is a no-op. Inspection.
- **Connection registered lazily during the statement** (memory module registers on first access): unchanged — `registerConnection` joins it to the open transaction. A module whose function needs the transaction must have its connection registered before the statement, or register it from the function; document as part of the guarantee ("connections registered at that point"). Inspection.
- **`begin()` on a connection rejects**: `beginTransaction` rolls back the begun connections and rethrows; the statement fails before any row; `_finalizeImplicitTransaction` sees no implicit transaction and does nothing. Database stays in autocommit. Covered by existing lifecycle tests; inspect.
- **Failure before the first row** (a `values` expression throws): implicit transaction rolls back via the caller's finalize. Test.
- **OR ROLLBACK / OR FAIL**: finalize rules unchanged. Existing sqllogic covers them.
- **DDL**: not in `DML_NODE_TYPES`, so DDL keeps its own `assertDdlTransactionPolicy` → `_ensureTransaction` order. A DDL statement whose plan contains DML does not exist today (stored bodies refuse writes, `alter` backfills run as nested statements); if one appears, beginning early still precedes `assertDdlTransactionPolicy`, which only gates explicit transactions, so it would still pass. Inspection.
- **Cardinality feedback**: write statements already published with the transaction open (the emitter began it before publication), so `publish` behavior is unchanged. Inspection.
- **Memory layer per-mutation autocommit** (`vtab/memory/layer/manager.ts` `getAutocommit()` check): already false during writes. Inspection.
- **Committed-read path**: assertion above.
- **Nested trace run** (`execution_trace('insert …')` inside a read-only outer select in autocommit): the nested statement begins its own and `_iterateFinalizing` ends it — as today, just earlier. Inspection.
- **In-tree modules relying on `begin` arriving after `values` evaluation** (memory, store, isolation): none known; `yarn test` and `yarn test:store` are the check — run both.

## Tests

One spec block in `packages/quereus/test/core-api-transactions.spec.ts`: a non-deterministic scalar function (`deterministic: false`, so the optimizer can't fold it) that records `!db.getAutocommit()` on each call.
- autocommit `insert … values (fn(), …)` single-row and multi-row, via `db.exec` and via `db.prepare(...).run()` → every recorded value `true`; `getAutocommit()` true afterwards.
- `insert … values (fn()) returning …` via `db.eval`, and `update … set c = fn()`, `delete … where c = fn()` → `true`.
- `select fn()` in autocommit → `false` (read-only unchanged).
- `insert … values (fn_throws())` → rejects, `getAutocommit()` true, table unchanged.

No test for upsert separately (same insert path) or for the shared walker (exercised by the stored-body tests already).

## TODO

- Extract `findPlanWrite` into `planner/analysis/plan-writes.ts`; make `rejectStoredBodyWrites` use it.
- Begin early in `Database._executeSingleStatement`.
- Begin early in `Statement._iterateRowsRawInternal`, predicate cached alongside the scheduler; committed-read assertion.
- Update the dml-executor and auto-analyze comments.
- Update docs/module-authoring-transactions.md § Connection lifecycle and docs/usage.md § Implicit Transactions.
- Add the spec block above.
- `yarn workspace @quereus/quereus run lint`, `yarn test`, `yarn test:store`.
