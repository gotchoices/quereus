description: Review the eager-begin fix: a writing statement in autocommit now opens its implicit transaction before any of its instructions run, so a scalar function in a `values` row sees the transaction the DML will commit.
architecture: docs/module-authoring-transactions.md#connection-lifecycle
files: packages/quereus/src/core/database.ts (`_executeSingleStatement`), packages/quereus/src/core/statement.ts (`_iterateRowsRawInternal`), packages/quereus/test/transaction-eager-begin.spec.ts, docs/module-authoring-transactions.md (`§ Connection lifecycle`)
----

# Review — eager implicit-transaction begin for writing statements

## What landed

Two call sites now start the implicit transaction BEFORE the scheduler runs when the compiled plan has `physical.readonly === false`:

1. **`packages/quereus/src/core/database.ts` → `_executeSingleStatement`** (just after `optimize(...)`, before building the emission context / scheduler). Guard: `PlanNode.hasSideEffects(optimizedPlan.physical)` → `await this._ensureTransaction()`.
2. **`packages/quereus/src/core/statement.ts` → `_iterateRowsRawInternal`** (just after `compile()`, before `scheduler.run`). Same guard, plus `!runtimeOverrides?.readCommitted` so the mutex-free committed-read path (`_iterateConcurrent`) never touches the transaction lifecycle. The serialized wrapper (`db._iterateSerialized`) holds the exec mutex and owns finalize/rollback, so the eager begin runs under the same mutex as the matching finalize.

The in-emitter `_ensureTransaction()` calls inside `runInsert`/`runUpdate`/`runDelete` and the DDL emitters stay as no-ops (they delegate to `transactionManager.ensureTransaction`, already a no-op inside an open transaction). Keeping them preserves the guarantee for any non-top-level caller that reaches these emitters.

`TransactionPlanNode` has no `computePhysical` override, inherits default `readonly: true`, so user `begin`/`commit`/`rollback`/`savepoint`/`release` are NOT treated as writes — no eager begin fires on top of them.

## Files to look at

- `packages/quereus/src/core/database.ts` — ~line 1117, right after the `optimize(...)` call: the new 3-line guarded `_ensureTransaction()`.
- `packages/quereus/src/core/statement.ts` — new `PlanNode` import near line 9, and the guarded `_ensureTransaction()` inside `_iterateRowsRawInternal` just after `compile()` (~line 546).
- `packages/quereus/test/transaction-eager-begin.spec.ts` — new file, 10 tests.
- `docs/module-authoring-transactions.md` § Connection lifecycle — one new paragraph after the three bullet points stating the eager-begin guarantee.

## Test results

- `node test-runner.mjs --grep 'Writing statement starts its implicit transaction before evaluating'` — 10 passing.
- `node test-runner.mjs` (full quereus suite) — **11195 passing, 23 pending, 0 failing** (~4 min).
- `yarn workspace @quereus/quereus run lint` — eslint + test-file tsc, clean (exit 0).

`yarn test:store` was NOT run (not required per the ticket; AGENTS.md says it is "only for store-specific diagnosis or release prep"). Store-backed DDL and DML already called `_ensureTransaction` inside their emitters; the eager begin shifts this call by a few lines without changing its semantics (transaction manager no-ops when a transaction is open).

## Tests added (one test per behaviour)

Every test in `transaction-eager-begin.spec.ts` registers a scalar probe function that captures `db.getAutocommit()` and `db._isImplicitTransaction()` at call time:

1. `insert … values (probe(), 'a')` — probe sees `autocommit=false, implicitTx=true`. This is the motivating case (regression proof for Optimystic `StampId()` returning null).
2. `insert … values (probe(),…), (probe(),…)` — multi-row values; both calls see the same open implicit transaction.
3. `insert … select probe(), 'c'` — regression guard for the already-working `select` path.
4. `insert … on conflict(id) do update set body = … probe() …` — upsert do-update arm sees the open transaction.
5. `insert … returning id` — `returning` wrapper does not disable the eager begin (ReturningNode's physical aggregation carries `readonly: false`).
6. `update t set body = … probe() …` — UpdateNode's write triggers the eager begin.
7. `delete from t where id = probe()` — DeleteNode's write triggers it.
8. `select probe()` in autocommit — read-only leaves autocommit intact; probe sees `autocommit=true, implicitTx=false`; `getAutocommit()` is still `true` after.
9. A `values`-row expression that throws (`fails()`) — probe confirms implicit transaction was open at throw time; `_execBatchAutocommit`'s existing catch rolls it back; no row stored.
10. `begin; insert … probe() …; commit;` batch — probe sees the user's **explicit** transaction (`autocommit=false, implicitTx=false`), confirming `TransactionPlanNode` does not trigger an eager implicit begin on top of the explicit one.

The upsert test (#4) uses `cast(probe() as text)` on the do-update side; it exercises the on-conflict arm because the preceding `insert into t(id, body) values (10, 'u')` sets the conflicting row.

## Known gaps / things a reviewer should second-guess

- **Store-backend parity not exercised locally.** `yarn test:store` not run. DDL emitters that previously called `_ensureTransaction` first-thing still do so; the eager begin only shifts the call a few lines earlier. Low risk, but a reviewer with cycles can run `yarn test:store` to be sure.
- **Scheduler eagerness and `values`-row evaluation order.** The core claim is "rows of `insert … values (fn(),…)` are evaluated by the scheduler **before** `runInsert`'s `_ensureTransaction`." I did NOT independently trace the scheduler to confirm this ordering today — I took it from the plan ticket's measured repro. The new test #1 is itself the proof: it would have failed before the fix (and passes now), so the ordering claim is at least operationally correct.
- **Edge case — write statement that fails mid-expression under the nested-trace path (`_iterateRowsNestedWithTrace`).** The ticket says this executes inside an outer statement that already holds the mutex, and nothing in the new code finalizes anything. Verified by inspection (new call only calls `_ensureTransaction`, never `_finalize…`), not by a dedicated test.
- **`BEGIN; …; COMMIT` as a single multi-statement `exec` batch.** Test #10 covers this at the `db.exec` level. Each individual statement still goes through `_executeSingleStatement` under one mutex hold inside `_execBatchAutocommit`; the `begin` statement opens the explicit transaction, and subsequent `insert`s skip the eager begin because `_ensureTransaction()` is a no-op inside an open transaction. Confirmed by the test assertion `implicitTx=false`.
- **Cartesian not blown up.** The upsert test exercises only the conflict arm (I pre-inserted the conflicting row). A separate non-conflict run was not added because it is the same path as test #1. If a reviewer wants a dedicated non-conflict arm test, add one; I'd argue it is cosmetic duplication under the "Tests must pay for themselves" rule.
- **`.yarnrc.yml` was created locally** (gitignored) to force `nodeLinker: node-modules` so the repo's `test-runner.mjs` could find `node_modules/mocha/bin/mocha.js`. Not part of the change; mentioned here only because a reviewer running locally for the first time may hit the same issue.

## Things explicitly NOT changed (per the ticket's out-of-scope list)

- `_ensureTransaction()` calls inside `runInsert`/`runUpdate`/`runDelete` and DDL emitters — kept as defence-in-depth no-ops.
- `DatabaseInternal` public interface — unchanged (no new `ensureTransaction()` export).
- `_iterateConcurrent` (committed-read path) — unchanged; guarded against via `!runtimeOverrides?.readCommitted`.
- `database-external-changes.ts` external-change seam — unchanged.

## Suggested reviewer checks

- Does `PlanNode.hasSideEffects(optimizedPlan.physical)` correctly capture every DDL node and every DML / returning-wrapper combination the project supports today? The project's `readonly: false` audit lives in `planner/framework/characteristics.ts` and the various plan-node overrides; a drift there is the realistic failure mode.
- Is there a code path that compiles a block with `physical.readonly === false` where the block ALSO contains an explicit `begin` as its first statement? That combination would still work (the `_ensureTransaction()` no-ops inside the already-open transaction), but if a reviewer finds the scenario, it is worth a dedicated test.
- Confirm the docs paragraph belongs where I put it — folded into the `## Connection lifecycle` section, right after the three consequence bullets, before the "commits one connection ahead" paragraph.
