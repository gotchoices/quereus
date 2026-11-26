description: In autocommit, a statement that writes now opens its implicit transaction before any of its expressions run, so a function that answers from the open transaction (Optimystic's `StampId()`) works inside an insert's `values` rows.
architecture: docs/module-authoring-transactions.md#connection-lifecycle
files: packages/quereus/src/planner/analysis/plan-writes.ts, packages/quereus/src/planner/building/reject-stored-body-writes.ts, packages/quereus/src/planner/nodes/plan-node-type.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/database-auto-analyze.ts, docs/module-authoring-transactions.md, docs/usage.md, packages/quereus/test/core-api-transactions.spec.ts
----

# A write statement begins its transaction before evaluating it

Filed from Optimystic (its `stampid-answers-inside-an-autocommit-write` was blocked on this).

## What was wrong

The scheduler evaluates an instruction's synchronous parameters before running the instruction. A `values` list's row expressions are such parameters, so in autocommit they ran before the insert emitter opened the implicit transaction. A non-deterministic function reading the open transaction saw none: `insert into t (id) values (StampId())` got NULL.

## What was built

- `findPlanWrite(plan)` in `planner/analysis/plan-writes.ts`: the iterative, DAG-safe search for a node in `DML_NODE_TYPES`, extracted from `rejectStoredBodyWrites`, which now calls it.
- `Database._executeSingleStatement` and `Statement._iterateRowsRawInternal` both call `_ensureTransaction()` immediately before `scheduler.run` when the optimized plan writes. The statement path caches the flag beside its cached scheduler (`schedulerWrites`, reset in `invalidatePlan()` and `finalize()`) and throws an `INTERNAL` error if a writing plan ever reaches the mutex-free committed-read path.
- Finalization is unchanged: the callers that already end implicit transactions end these.
- Docs: `docs/module-authoring-transactions.md` § Connection lifecycle states the guarantee and its limits (read-only statements open none; lazily registered connections join on registration; plan-time folding of deterministic calls is outside it). `docs/usage.md` § Implicit Transactions links to it.
- Accepted tradeoff (decided in the plan stage, recorded as a `NOTE:` in `_executeSingleStatement`): a write the run never reaches still opens and commits an empty transaction.

## Tests

`packages/quereus/test/core-api-transactions.spec.ts`, block `a writing statement in autocommit`: `values` rows via `exec` and a prepared statement; `returning` / `set` / `where`; read-only `select` opens none; a throwing `values` expression rolls back. The `transaction-state checks taken under the mutex` tests no longer need a one-row source table to get their gate evaluated inside the transaction and now use `values`.

## Review findings

Read the `ticket(implement): write-statement-begins-its-transaction-before-evaluating-it` diff first, then every touched file and the call sites around it.

- **Correctness, exec path** — checked: the begin sits inside the existing `try`, so a failed `begin` still disconnects scan connections and publishes cardinality observations; `_ensureTransaction` is a no-op inside an explicit transaction, so `_execBatchAsTransaction` is unaffected. No defect found.
- **Correctness, statement path** — checked that `schedulerWrites` cannot go stale: `compile()` only installs a new plan after `invalidatePlan()` (which resets the flag together with `this.scheduler`) or on first compile, and the flag is computed in the same block that builds the scheduler. The begin runs after `validateCapturedSchemaObjects()` and inside the `try` whose `finally` tears down. No defect found.
- **Committed-read assertion** — agreed it should throw rather than skip: `_isConcurrentReadEligible` refuses any side-effecting node, so a hit means that gate is broken, and quietly opening a transaction on the mutex-free path would be worse. Left untested because it cannot be reached (testing it would mean mocking the gate).
- **Other plan runners** — every other `new Scheduler(...)` site (assertion residuals, materialized-view body/residual compilation, derived-row checks, constant evaluator, `scheduler_program` / `execution_trace` listing, debug program dump) runs a read-only plan: stored bodies refuse writes and the debug/listing sites never run. Nested writing statements (foreign-key cascades, alter-table backfill, `_execWithinTransaction`) go through `Statement._iterateRowsRawInternal`, so they begin too.
- **Comment accuracy (fixed)** — the three DML-emitter comments in `dml-executor.ts` said the emitters' `_ensureTransaction()` calls were "kept for nested statements run outside one". That was wrong: nested statements use the same statement path and begin first. Reworded: a no-op today because both plan runners begin first; kept as a guard for any other runner.
- **Stale docs (fixed)** — `Statement.get()` and `Statement.all()` still said "Transactions are started lazily (just-in-time) when needed"; the implementer updated `run()` but missed these two. Replaced with the same wording as `run()`. The DDL emitters' "lazy/JIT transaction start" comments remain accurate for DDL and were left alone. No other doc in `docs/` or the package README described the old timing.
- **DDL interaction** — checked `assertDdlTransactionPolicy`: it gates only explicit transactions, so an earlier implicit begin could not change its verdict even if a DDL plan ever contained DML (none does today).
- **Tests** — the four new tests pin the specified guarantee on real branching (write vs read-only plan, success vs rollback); kept. The update/delete arms of the `returning, set and where` test held before the change too; kept because they pin the documented guarantee and cost nothing measurable. The rewritten gate tests still exercise what they are about. No test added: the two fixes were comment-only.
- **Performance** — `findPlanWrite` runs once per `exec` statement (after a full optimize of the same plan, which costs far more) and once per scheduler build on the statement path. Not measured; no tripwire warranted.
- **Type safety / resource cleanup / error handling** — no `any`, no new resources, errors from `begin` propagate through the existing wrappers. Nothing found.
- **Tripwires / new tickets** — none; nothing conditional or out of scope surfaced.

Validation: `yarn workspace @quereus/quereus run lint` clean; `yarn workspace @quereus/quereus run test` 11191 passing, 23 pending. Other workspaces and `yarn test:store` were not re-run: this pass changed comments only, and the implement stage ran both green.
