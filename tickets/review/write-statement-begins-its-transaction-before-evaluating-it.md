description: In autocommit, a statement that writes now opens its implicit transaction before any of its expressions run, so a function that answers from the open transaction (Optimystic's `StampId()`) works inside an insert's `values` rows. Review the change and its tests.
architecture: docs/module-authoring-transactions.md#connection-lifecycle
files: packages/quereus/src/planner/analysis/plan-writes.ts (new), packages/quereus/src/planner/building/reject-stored-body-writes.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/core/database.ts (`_executeSingleStatement`, `exec`/`eval` doc comments), packages/quereus/src/core/statement.ts (`schedulerWrites`, `_iterateRowsRawInternal`, `beginWriteTransaction`, `run` doc comment), packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database-auto-analyze.ts, docs/module-authoring-transactions.md, docs/usage.md, packages/quereus/test/core-api-transactions.spec.ts
----

# A write statement begins its transaction before evaluating it

Filed from Optimystic (its `stampid-answers-inside-an-autocommit-write` is blocked on this).

## What was wrong

The scheduler evaluates an instruction's synchronous parameters before running the instruction. A `values` list's row expressions are such parameters of the instructions feeding the insert, so in autocommit they ran before `runInsert` reached `await ctx.db._ensureTransaction()`. A non-deterministic function reading the open transaction saw none: `insert into t (id) values (StampId())` got NULL (NOT NULL refusal, or NULL stored silently). `insert … select StampId()` and anything inside `begin … commit` already worked.

## What changed

- **`findPlanWrite(plan)`** (new `planner/analysis/plan-writes.ts`, with `DmlPlanNode` / `isDmlPlanNode` moved there) — the iterative, DAG-safe walk that `rejectStoredBodyWrites` used, returning the first node whose type is in `DML_NODE_TYPES` or `undefined`. `rejectStoredBodyWrites` now calls it and throws on a hit. Reads node types, not `physical.readonly`, so a side-effect UDF does not count as a write.
- **Exec path** — `Database._executeSingleStatement` computes `findPlanWrite(optimizedPlan)` once and, when it hits, `await this._ensureTransaction()` immediately before `scheduler.run`, inside the existing `try` (so the `finally` still disconnects scan connections and publishes cardinality observations if `begin` fails). Finalization is unchanged: callers (`_execBatchAutocommit`, `_execBatchAsTransaction`, `_evalGenerator`, the prepared-batch loop) already finalize.
- **Statement path** — `Statement._iterateRowsRawInternal` computes `schedulerWrites` when it builds the cached scheduler; the field is reset in `invalidatePlan()` and `finalize()` alongside `this.scheduler`. After `validateCapturedSchemaObjects()` and before `scheduler.run`, a writing plan calls the new private `beginWriteTransaction(readCommitted)`, which throws an `INTERNAL` `QuereusError` on the committed-read path (unreachable: `_isConcurrentReadEligible` refuses side-effecting plans) and otherwise calls `db._ensureTransaction()`.
- The DML emitters' `_ensureTransaction()` calls stay (no-ops now for a top-level write in autocommit; still needed for nested statements). Their comments were rewritten. The `getAutocommit` comment in `database-auto-analyze.ts`, the `exec` / `eval` / `Statement.run` doc comments, and `_iterateRowsRawInternal`'s doc were updated to the new timing.
- Docs: `docs/module-authoring-transactions.md` § Connection lifecycle gains a fourth "consequence" bullet stating the guarantee (functions in `values`, `set`, `where`, `returning` see `begin` delivered to every connection registered at that point; read-only statements open none; lazily registered connections join on registration; plan-time folding of deterministic calls is outside it, so register such a function non-deterministic). `docs/usage.md` § Implicit Transactions gets one sentence linking to it.
- Accepted tradeoff recorded as a `NOTE:` at the `_executeSingleStatement` site: a write the run never reaches (e.g. a `returning` subquery in an untaken `case` branch) now opens and commits an empty transaction.

## Tests

In `packages/quereus/test/core-api-transactions.spec.ts`, new block `a writing statement in autocommit`, using a non-deterministic `in_txn()` that records `!db.getAutocommit()` per call and returns a fresh id:

- `evaluates every values row inside its implicit transaction, through exec and a prepared statement` — single- and multi-row `values` via `db.exec`, multi-row via `db.prepare(...).run()`; every call saw a transaction; autocommit afterwards; rows landed. **Fails without the fix.**
- `evaluates returning, set and where expressions inside it` — `insert … values (in_txn(), …) returning in_txn()` via `db.eval` (the eval/Statement path; fails without the fix because of the `values` call), then `update … set val = 'u' || in_txn()` and `delete … where id = in_txn()`. The update/delete arms already held before the change; they pin the documented guarantee only.
- `leaves a read-only statement outside any transaction` — `select in_txn()` sees no transaction.
- `rolls its transaction back when a values expression throws` — `values (in_txn(), 'x'), (boom(), 'y')` rejects; `in_txn()` ran inside the transaction (**fails without the fix**: it saw none), autocommit afterwards, table unchanged. Relies on `values` rows being evaluated left to right.

Also changed: the existing `transaction-state checks taken under the mutex` tests used a one-row `gate_src` table purely to get the gated function evaluated after the transaction opened, with a comment saying `values` would park too early. That comment became false; the setup table was dropped and the three writes now use `insert into t values (3, park_writeN())`. They still pass.

Validation run: `yarn workspace @quereus/quereus run lint` clean; `yarn test` all green (quereus 11191 passing, 23 pending; all other workspaces green); `yarn test:store` 11184 passing, 30 pending. I confirmed the two "fails without the fix" claims by temporarily removing both begin calls and re-running the block (2 of 4 failed), then restoring.

## For the reviewer — known gaps / things to check

- **Statement path committed-read assertion** is untested (unreachable by construction). Check you agree it should throw rather than silently skip.
- **Nested statements** (`InternalStatementCache` for FK cascades, MV helpers, alter-table backfill, constraint builder, assertions at commit, `_execWithinTransaction`) now call `_ensureTransaction` before running when their plan writes. Each already runs inside an open transaction or would have opened one from the emitter anyway, so only timing moves; I checked this by reading call sites, not with dedicated tests. The one new behavior is the empty-transaction case above, which for a nested caller with no surrounding transaction and no finalizer would leave an implicit transaction open — but such a caller would already leave one open whenever its DML ran, so none can exist without a bug elsewhere.
- **`execution_trace('insert …')`** nested inside a read-only outer select in autocommit: the inner statement now begins earlier and `_iterateFinalizing` still ends it. Covered only by existing trace tests passing.
- DDL emitters still carry "lazy/JIT transaction start" comments; those remain accurate for DDL (not in `DML_NODE_TYPES`) and were left alone.
- `findPlanWrite` walks the whole optimized plan once per `exec` statement (exec path has no plan cache) and once per scheduler build on the statement path. Not measured; it is the same walk the stored-body check does at build time.
