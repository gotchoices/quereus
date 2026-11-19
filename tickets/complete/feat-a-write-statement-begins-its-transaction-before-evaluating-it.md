description: In autocommit, a writing statement now opens its implicit transaction before any of its instructions run, so a scalar function in a `values` row (or an `update`/`delete` expression) sees the transaction the DML will commit.
architecture: docs/module-authoring-transactions.md#connection-lifecycle
files: packages/quereus/src/core/database.ts (`_executeSingleStatement`), packages/quereus/src/core/statement.ts (`_iterateRowsRawInternal`), packages/quereus/test/transaction-eager-begin.spec.ts, docs/module-authoring-transactions.md (`§ Connection lifecycle`)
----

# A write statement begins its transaction before evaluating it — landed

Fixes the Optimystic-reported case where `insert … values (StampId(), …)` saw no open transaction because the DML's own `_ensureTransaction` ran after the scheduler evaluated the `values` row. See `ticket(plan): …` and `ticket(implement): …` for the design and implementation history.

## What landed

- `Database._executeSingleStatement`: after `optimize(…)`, before building the emission context, call `_ensureTransaction()` when `PlanNode.hasSideEffects(optimizedPlan.physical)`. Covers `exec` / `_execBatchAutocommit` / the `eval` multi-statement prelude / schema-declarative replay.
- `Statement._iterateRowsRawInternal`: after `compile()`, before `scheduler.run`, same guarded call, additionally gated on `!runtimeOverrides?.readCommitted`. Covers `iterateRows` (serialized), `_evalGenerator`'s terminal statement, and the nested-trace entrypoint.
- `_ensureTransaction()` calls inside `runInsert` / `runUpdate` / `runDelete` and the DDL emitters are kept unchanged as defence-in-depth no-ops.
- `docs/module-authoring-transactions.md § Connection lifecycle`: one new paragraph after the three consequence bullets documenting the guarantee.
- `packages/quereus/test/transaction-eager-begin.spec.ts`: 10 tests, one per distinct behaviour (single-row `values`, multi-row `values`, `insert … select` regression guard, upsert do-update arm, `insert … returning`, `update … set col = fn()`, `delete … where col = fn()`, read-only `select probe()`, write-expression throw with rollback, `begin; …; commit;` batch does not misclassify `TransactionPlanNode`).

## Verification

- `node packages/quereus/test-runner.mjs --grep 'Writing statement starts its implicit transaction before evaluating'` — 10 passing.
- `node packages/quereus/test-runner.mjs` (full quereus suite) — 11195 passing, 23 pending, 0 failing (~4 min).
- `./node_modules/.bin/eslint 'packages/quereus/src/**/*.ts' 'packages/quereus/test/**/*.ts'` — clean.
- `tsc -p packages/quereus/tsconfig.test.json --noEmit` — clean.

## Review findings

### Correctness of the guard

Checked: `PlanNode.hasSideEffects(physical)` returns `physical.readonly === false`. `BlockNode.computePhysicalFromChildren` ANDs children's `readonly` — any writing statement in the block flips the block to `readonly: false`. `TransactionPlanNode` extends `VoidNode` with no `computePhysical` override, is a leaf (no children), so inherits `DEFAULT_PHYSICAL.readonly === true`; a bare `begin`/`commit`/`rollback`/`savepoint`/`release` plan is NOT misclassified as a write. Verified by inspection and by test #10.

Found: nothing.

### Coverage of execution entrypoints

Checked: every top-level user-visible `scheduler.run(runtimeCtx)` call site. Two entry points run user statements against user data: `Database._executeSingleStatement` (line 1151) and `Statement._iterateRowsRawInternal` (line 612). Both are now guarded. Other `scheduler.run` sites (`database-assertions.ts`, `database-materialized-views-*`, `derived-row-validator.ts`, `const-evaluator.ts`, `internal-statement-cache.ts`) run inside an already-open transaction or at plan time, so they do not need the eager-begin.

Found: nothing.

### `_execBatchAutocommit` rollback-on-throw flow

Checked: `_execBatchAutocommit` wraps each `_executeSingleStatement` in `try { … } catch (err) { await this._finalizeImplicitTransaction(false, err); throw err; }`. A throw from the eager `_ensureTransaction()` itself, from the scheduler, or from a scalar function inside a `values` row is caught and rolled back. Verified by inspection and by test #9 (`fails()` throwing from inside `values` leaves `getAutocommit() === true` and no row stored).

Found: nothing.

### `Statement` serialized path finalize

Checked: `_iterateSerialized` wraps `_iterateRowsRawInternal` in `_iterateFinalizing`, which `finally`-runs `_finalizeImplicitTransaction(!failed, failure)`. A throw from the eager `_ensureTransaction()` propagates up through the `try { yield* body(); } catch (e) { failed = true; … throw }` and the `finally` rolls back. Correct.

Found: nothing.

### `BEGIN` upgrade interaction

Checked: if a user prepared a single compiled batch containing both DML and `begin`/`commit` (e.g. `prepare("begin; insert … values(fn(),…); commit;").iterateRows()`), the eager-begin would now open an implicit transaction before the block's `begin` runs. `TransactionManager.beginTransaction('explicit')` on an already-open implicit transaction upgrades (does NOT throw), clearing the change log. The `clearChangeLog` is pre-existing behaviour; the equivalent sequence (first DML inside a prepared batch opening the implicit transaction via `runInsert` then `begin` upgrading) exists on the current `main` without the eager-begin. No new semantic change.

Found: nothing new. Existing NOTE at `database-transaction.ts:219–223` already called out this edge; it remains accurate.

### `_isConcurrentReadEligible` interaction

Checked: the committed-read path (`_iterateConcurrent`) is explicitly gated with `!runtimeOverrides?.readCommitted` on the Statement side. A writing plan is also ineligible for committed-read routing by `_isConcurrentReadEligible` (checked at compile time). Two independent guards — intentional defence-in-depth, documented at the call site.

Found: nothing.

### Comment hygiene

Checked: both new comment blocks say WHY (the non-obvious scheduling order where expression evaluation precedes the DML's own `_ensureTransaction`, plus the non-obvious consequence that `TransactionPlanNode`'s default inheritance prevents misclassification). Length is consistent with the project's surrounding comment style in `database.ts` / `statement.ts`. No narration-of-statement.

Found: nothing.

### Documentation

Checked: `docs/module-authoring-transactions.md § Connection lifecycle` got one paragraph after the three consequence bullets, before the "commits one connection ahead" paragraph. Accurate and placed where a module author reading the lifecycle section will meet it. Enumeration of what counts as "writes" (`insert/update/delete`, DDL, `returning`) and what does not (`select`, `pragma`, non-DML `values`) matches the implementation. No other docs reference `_ensureTransaction` in a way this change would invalidate (`runtime-dml.md`, `sql-dml.md`, `sql-txn.md`, `progressive-optimizer.md` — all unchanged; none describe the begin-timing).

Found: nothing.

### Tests

Checked: 10 tests, one per distinct branch, no cosmetic duplication. Test #3 (`insert … select`) is a thin regression guard for the already-working path — the implementor flagged it as debatable under "Tests must pay for themselves". Kept — a separate branch of the DML executor (pull-based rather than scheduler-eager values), and the cost is one `exec` call. Test #5 (`insert … returning`) uses `db.eval` (the `_iterateRowsRawInternal` side) rather than `exec`, exercising the second guard. Test #10 is the critical negative test for the `TransactionPlanNode` classification.

Found: nothing.

### Lint and typecheck

Checked: eslint on `src/**/*.ts` and `test/**/*.ts` clean. `tsc -p tsconfig.test.json --noEmit` clean. Full Mocha suite (11195 passing, 0 failing) clean.

Found: nothing.

### Things done inline

Nothing. No minor fixes were required.

### Things filed as tickets

None.

### Tripwires recorded

None. No concerns demoted to `NOTE:` comments.
