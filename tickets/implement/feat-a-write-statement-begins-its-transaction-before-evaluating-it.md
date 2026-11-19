description: In autocommit, start the implicit transaction for a write statement before any of its instructions run, so a scalar function evaluated in a `values` row (or an `update`/`delete` expression) runs inside the same transaction the DML will commit — fixing the case where Optimystic's `StampId()` sees no open transaction and answers null.
architecture: docs/module-authoring-transactions.md#connection-lifecycle
files: packages/quereus/src/core/database.ts (`Database._executeSingleStatement`), packages/quereus/src/core/statement.ts (serialized iterate path, around `scheduler.run` call at ~line 601 / `_iterateRowsRaw`), packages/quereus/src/planner/nodes/plan-node.ts (`PlanNode.hasSideEffects`, `DEFAULT_PHYSICAL`), packages/quereus/src/planner/framework/characteristics.ts (`isReadOnly`), packages/quereus/src/runtime/emit/dml-executor.ts (`runInsert`/`runUpdate`/`runDelete` — their `_ensureTransaction` calls stay as no-ops), docs/module-authoring-transactions.md (`#connection-lifecycle` — document the guarantee)
----

# A write statement begins its transaction before evaluating it

## Problem

In autocommit, the rows of an `insert … values (fn(), …)` are evaluated by the scheduler **before** `runInsert` reaches `await ctx.db._ensureTransaction()`. A scalar function `fn()` that answers from the open transaction (Optimystic's `StampId()` is the motivating case) sees none, returns a null, and the insert fails with a NOT NULL refusal (or stores NULL silently into a nullable column). `insert … select` works only because its rows are pulled inside `runInsert`, after the transaction has begun. See the plan ticket for the measured repro.

## Design

In `Database._executeSingleStatement`, after the plan is built and optimized and before the scheduler runs, detect whether the statement writes and, if so, start the implicit transaction eagerly. Detection uses the existing `physical.readonly` flag, which already propagates up through `BlockNode` (AND over its children in `computePhysicalFromChildren`) and is set to `false` on every DML / DDL / side-effecting node. `TransactionPlanNode` has no override and inherits the default `readonly: true`, so `begin`/`commit`/`rollback` statements are not misclassified as writes and do not provoke an early implicit begin on top of the user's own transaction control.

The same early-begin is added to the `Statement.iterateRows` serialized path (`_iterateRowsRaw` in `packages/quereus/src/core/statement.ts`, around the `scheduler.run(runtimeCtx)` call at ~line 601): the compiled `blockPlanNode` is already in hand, and the serialized wrapper (`db._iterateSerialized`) owns the exec mutex and the implicit-transaction finalize/rollback, so the eager begin runs under the same mutex as the finalize that will close it. The committed-read path (`_iterateConcurrent`) is NOT touched — it is a read-only route that refuses to touch the transaction lifecycle; a committed-read statement is by definition non-writing.

The `_ensureTransaction()` calls inside `runInsert`, `runUpdate`, `runDelete`, and the DDL emitters STAY in place and become no-ops once a transaction is already open (they delegate to `transactionManager.ensureTransaction`, which is already a no-op inside a transaction). Keeping them preserves the existing guarantee for any future caller — a nested or test-harness-driven write path — that reaches these emitters without the eager begin above.

A read-only statement (`select`, `pragma` read, `values` with no DML) has `physical.readonly !== false`, skips the eager begin, and leaves autocommit intact — a `select fn()` in autocommit still sees no open transaction and leaves `getAutocommit()` true afterward.

## Edge cases & interactions

- **Multi-row `values` insert (`values (fn(),…), (lit,…)`)**: eager begin covers every row; verified by test.
- **Upsert (`insert … on conflict … do update set … = fn()`)**: same path, covered.
- **`returning` form**: `ReturningNode` wraps a DML executor child; aggregation flows `readonly: false` to the block. Covered without special-casing. Verify by inspection of `returning-node.ts` physical/no-override + an insert-returning-with-fn test.
- **`update … set c = fn()` / `delete … where c = fn()`**: readonly=false on `UpdateNode` / `DeleteNode` triggers the eager begin. Covered by test.
- **CTE wrapping DML (`with x as (insert … returning *) select …`)**: aggregation carries `readonly: false` to the block; eager begin fires. Verify by inspection.
- **`BEGIN` / `COMMIT` / `ROLLBACK` / `SAVEPOINT` / `RELEASE`**: `TransactionPlanNode` has no `computePhysical`, inherits `readonly: true` — no eager begin, so a user `BEGIN` still opens a clean explicit transaction. Covered by existing transaction-control tests; add an assertion in a new test that a `BEGIN; …; COMMIT;` executed as a batch does not acquire an extra implicit transaction up front.
- **Write statement that fails before any row is produced** (e.g. a `values` row that itself throws): the eager begin's implicit transaction is finalized by `_execBatchAutocommit`'s existing `catch → _finalizeImplicitTransaction(false, err)` → rollback. Verified by test.
- **`exec` path with `options.transaction: true`**: `_execBatchAsTransaction` opens an explicit transaction up front; the eager-begin check inside `_executeSingleStatement` sees `isInTransaction() === true` and the `_ensureTransaction` no-ops. No change to behaviour.
- **Committed-read concurrent iteration** (`_iterateConcurrent`): untouched. A writing plan is not eligible for committed-read routing (gated by `_isConcurrentReadEligible` on the compiled plan). Verify by inspection.
- **DDL statements** (`create table`, `alter table`, `drop …`, `create index`, `create assertion`, `set object tags`, materialized-view DDL, `add constraint`): also have `readonly: false`. The eager begin fires one step earlier than today's in-emitter `_ensureTransaction()`; the emitters' own calls become no-ops. No observable change — DDL already began a transaction at its first emitter step. Verify by running the existing DDL suite.
- **`ddl-transaction-policy`**: its policy check runs at the top of each DDL emitter and is documented as happening BEFORE `_ensureTransaction`. The eager begin at `_executeSingleStatement` happens even earlier, but the policy check still runs before any connection write — only the transaction-manager state has moved. Verify by inspection + DDL suite.
- **External-change ingestion (`database-external-changes.ts` line 192)**: a separate entry point, outside `_executeSingleStatement`; keeps calling `_ensureTransaction` itself. No change.
- **Auto-analyze note (`database-auto-analyze.ts` line 148)**: comment says "a read-only statement leaves this true, …". The comment stays accurate — the eager begin only fires on `readonly === false` plans.
- **Nested statements**: `_iterateRowsNestedWithTrace` executes inside an outer statement that already holds the mutex (and typically has an open transaction). The eager begin is still safe — `_ensureTransaction` no-ops when a transaction is open — but it must NOT finalize the outer's transaction. Nothing here finalizes; finalization lives in `_execBatchAutocommit` / `_iterateFinalizing`. Verify by inspection.
- **Connection lifecycle TXN-001**: the `begin` on connections now happens before any of the statement's expression evaluation instead of just before the first DML write. For a module whose `begin` has side-effects visible to a scalar function it registered, this is the whole point of the fix. For a module that relies on `begin` arriving AFTER its `values`-expression evaluation — flag during review: engine's own modules (`vtab/memory`, `quereus-store`, `quereus-isolation`) must not depend on that order. The plan ticket's "Reversibility" note calls this out; verify by inspection + full SQL logic test suite on both the memory backend and `test:store`.

## Tests to add (new file: `packages/quereus/test/transaction-eager-begin.spec.ts` or extend an existing logic test)

Register a scalar function from a test module that captures `db.getAutocommit()` and `db._isImplicitTransaction()` at call time. One assertion per behaviour:

- `insert into t(id, body) values (probe(), 'a')` in autocommit — probe sees `autocommit=false`, `implicitTx=true`; row stores.
- `insert into t(id, body) values (probe(), 'a'), (probe(), 'b')` — multi-row; both calls see an open implicit tx.
- `insert into t(id, body) select probe(), 'c'` — regression guard; was already passing, still passes.
- `insert into t(id, body) values (probe(), 'u') on conflict(id) do update set body = probe()` — upsert; conflict and non-conflict arms both.
- `insert into t(id, body) values (probe(), 'r') returning id` — `returning` form.
- `update t set body = probe() where id = 1`.
- `delete from t where id = probe_matches(…)`.
- `select probe()` in autocommit — probe sees `autocommit=true`, `implicitTx=false`; `getAutocommit()` stays true after.
- An `insert into t(id, body) values (fails(), 'x')` where `fails()` throws before `runInsert` — assert the implicit transaction was begun and then rolled back (`getAutocommit() === true` after, no row stored). Test by registering a function that calls `db._isImplicitTransaction()` to confirm it was open at throw time, then throws.

Follow the "Tests must pay for themselves" rule: one test per distinct branch, no cosmetic duplication.

## Documentation

Update `docs/module-authoring-transactions.md § Connection lifecycle` with one paragraph stating the new guarantee: *"In autocommit, a statement whose plan writes (any node with `physical.readonly === false` — insert/update/delete, DDL, `returning`) begins its implicit transaction before any of the statement's instructions run. A scalar function registered by a module may rely on reading the transaction the engine has opened for the statement it is evaluated inside, including from a `values` row."*

Do NOT add a new top-level section — fold into the existing lifecycle paragraph set (around line 326, after the three bullets listing the three consequences).

## TODO

### Core change

- In `packages/quereus/src/core/database.ts`, inside `_executeSingleStatement` after `const optimizedPlan = this.optimizer.optimize(…) as BlockNode;` and BEFORE `const emissionContext = new EmissionContext(this);` (or equivalently before `scheduler.run`), add:
  - `if (PlanNode.hasSideEffects(optimizedPlan.physical)) await this._ensureTransaction();`
  - Alternative formulation if an import cycle is cleaner: `if (optimizedPlan.physical.readonly === false) await this._ensureTransaction();`
- In `packages/quereus/src/core/statement.ts`, inside `_iterateRowsRaw` (serialized path), after `const blockPlanNode = this.compile();` and the empty-statements early return, before `scheduler.run(runtimeCtx)`:
  - Same check and call. The serialized wrapper holds the exec mutex; the implicit transaction's finalize is driven by `db._iterateSerialized` as today.

### Verification

- `yarn workspace @quereus/quereus run lint` (eslint + test-file tsc) — must pass clean.
- `yarn test` — all logic + spec tests must pass, including the new ones.
- `yarn test:store` — not required inside this ticket (store-backend parity is covered by CI / release prep) unless a store-specific failure surfaces.

### Documentation

- Update `docs/module-authoring-transactions.md § Connection lifecycle` per the paragraph above.

### Out of scope (do not touch)

- Do NOT remove the `_ensureTransaction()` calls in `runInsert`/`runUpdate`/`runDelete` or the DDL emitters — they stay as defence-in-depth no-ops.
- Do NOT add `ensureTransaction()` to the public `DatabaseInternal` interface — the plan ticket's *Alternative* is rejected by the *Recommended* option implemented here.
- Do NOT change the committed-read path (`_iterateConcurrent`) or the external-changes seam.
