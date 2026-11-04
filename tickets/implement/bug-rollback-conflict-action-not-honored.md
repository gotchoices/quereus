---
description: A write that is supposed to roll back the whole transaction when it breaks a rule often only fails that one statement, and a write that is supposed to keep its earlier rows loses them when run through the main execute call. Both contradict the documented behaviour.
architecture: docs/sql-dml.md
files:
  - packages/quereus/src/core/database.ts (~1127 `_execBatchAutocommit`; ~941 `_finalizeImplicitTransaction`)
  - packages/quereus/src/common/types.ts (~213 `UpdateResult`, ~227 `isConstraintViolation`)
  - packages/quereus/src/vtab/table.ts (~178 `update` contract comment)
  - packages/quereus/src/runtime/emit/dml-executor.ts (~893 `translateConflictError`; constraint throws at ~1276 insert, ~1490 update, ~1657 delete)
  - packages/quereus/src/runtime/row-constraints.ts (~136 `throwForAction`)
  - packages/quereus/src/vtab/memory/layer/manager.ts (~1107 `resolvePkConflict`; constraint results at ~1494, ~1577, ~1647)
  - packages/quereus-store/src/common/store-table.ts (~459, ~561)
  - packages/quereus-store/src/common/store-table-constraints.ts (~291)
  - packages/quereus-isolation/src/isolated-table.ts (~1238, ~1654, ~1913)
  - packages/quereus/test/core-api-transactions.spec.ts
  - packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic
  - docs/module-authoring.md (~932 `UpdateResult`)
repro: verified
---

# Conflict actions lost on the way to the transaction

`docs/sql-dml.md` says `or rollback` aborts the statement and rolls back the enclosing transaction, implicit or explicit. It says `or fail` keeps the rows of the statement that succeeded before the violation. Its stated precedence is statement `or` clause, then the constraint's own `on conflict` clause, then ABORT.

Two separate defects break this. Each has one site to change.

## Reproduction

Each case ran on the memory module and on the store module (LevelDB behind the isolation layer), through both `db.exec` and `db.eval`, in a throwaway spec that was then deleted. The two modules gave the same result in every case.

Setup for the explicit-transaction rows: `begin`, then `insert into t values (1, 1)`, then the violating statement as its own call. The update rows also seed `(1, 1), (2, 2)` before `begin` and insert `(3, 3)` inside it.

| Table | Statement | Call | Error thrown | Autocommit | Rows |
|---|---|---|---|---|---|
| `id integer primary key, x integer not null` | `insert or rollback into t values (1, 5)` | exec | `RollbackConflictError` | false | `1` |
| same | same | eval | `RollbackConflictError` | true | none (correct) |
| same | `insert or rollback into t values (2, null)` | exec | `RollbackConflictError` | false | `1` |
| `… x integer not null on conflict rollback` | `insert into t select 2, null` | exec | `RollbackConflictError` | false | `1` |
| `… x integer check (x > 0) on conflict rollback` | `insert into t values (2, -1)` | exec | `RollbackConflictError` | false | `1` |
| `id integer primary key on conflict rollback, x integer` | `insert into t values (1, 5)` | both | `ConstraintError` | false | `1` |
| `id integer, x integer, primary key (id) on conflict rollback` | `insert into t values (1, 5)` | both | `ConstraintError` | false | `1` |
| `id integer primary key, x integer unique on conflict rollback` | `insert into t values (2, 1)` | both | `ConstraintError` | false | `1` |
| same | `update t set x = 1 where id = 2` | both | `ConstraintError` | false | `1,2,3` |
| `id integer primary key on conflict rollback, x integer` | `update t set id = 1 where id = 2` | both | `ConstraintError` | false | `1,2,3` |

Expected in every row above: `RollbackConflictError`, autocommit true, and only rows committed before `begin`.

`or fail` in autocommit, with `(1, 1)` committed first:

| Statement | Call | Error thrown | Rows | Expected rows |
|---|---|---|---|---|
| `insert or fail into t values (5, 5), (1, 5), (6, 6)` | exec | `FailConflictError` | `1` | `1,5` |
| same | eval | `FailConflictError` | `1,5` | `1,5` |

The `not null` form behaves the same way: `insert or fail into t values (5, 5), (6, null), (7, 7)` on an empty table leaves no rows through exec and row `5` through eval.

## Cause 1: `db.exec` does not finalize the way every other path does

`_execBatchAutocommit` has its own commit-or-rollback logic that looks only at whether the transaction is implicit. The rules for both error subclasses live in `_finalizeImplicitTransaction`, which the `eval`, `run`, `get` and iterator paths all call. So `exec` leaves an explicit transaction open on `RollbackConflictError`, and rolls back the surviving rows on `FailConflictError`.

`test/logic/47.2-replace-and-or-clauses.sqllogic` §7 and §8 pass without covering this, because the logic harness runs the last statement of an error-expecting block through `db.prepare` (`test/logic.spec.ts` ~634). The atomic form `exec(sql, params, { transaction: true })` is correct already, since `_execBatchAsTransaction` rolls back on any error.

Fix: make `_execBatchAutocommit` call `_finalizeImplicitTransaction(true)` after a statement succeeds and `_finalizeImplicitTransaction(false, err)` on failure, then rethrow. `TransactionManager.commitTransaction` clears its own state when it fails, so a failed commit that reaches the catch does not roll back twice. Statements inside an explicit transaction still stay open on success, because the finalizer's commit is gated on the transaction being implicit.

If the commit that `or fail` triggers itself fails, for example on a deferred constraint, the commit's error replaces the conflict error. The `Statement` paths already behave this way, since they finalize in a `finally`.

## Cause 2: the action a storage module resolved is thrown away

Modules already work out the effective action for each UNIQUE or PRIMARY KEY conflict (statement `or`, then the constraint's default, then ABORT). IGNORE and REPLACE are acted on there. Every other action comes back as `{ status: 'constraint', … }` with no record of which action it was. The executor then raises a plain `ConstraintError`, and `translateConflictError` can only look at the statement's `or` clause. A declared ROLLBACK therefore acts as ABORT.

NOT NULL and CHECK do not have this problem, because `row-constraints.ts` raises the right subclass itself.

Fix: add an optional field to the constraint arm of `UpdateResult`, carrying the action the module resolved:

```typescript
| { status: 'constraint'; constraint: ConstraintType; message?: string; existingRow?: Row; onConflict?: ConflictResolution };
```

The executor builds its error from that field, so FAIL gives `FailConflictError`, ROLLBACK gives `RollbackConflictError`, and anything else gives `ConstraintError`. Reuse the mapping in `throwForAction` rather than writing a second copy. Keep `translateConflictError` as the fallback for a module that does not report the field, and for plain `ConstraintError`s thrown from inside `processRow`, such as the RESTRICT pre-check.

Alternatives rejected:

- Having the executor work out the action from the schema: a `unique` result does not say which UNIQUE constraint fired, and each one can declare its own action.
- Having modules throw the subclass directly: the `update()` contract requires returning violations, because UPSERT needs `existingRow`.

The `DO UPDATE` arm of an upsert (`executeUpsertUpdate`, ~854) passes an explicit `onConflict: ConflictResolution.ABORT`, so a declared action does not govern it. Leave that as it is. Passing the declared action through would let IGNORE and REPLACE outcomes reach code that does not handle them. This was read from the code, not run.

After this ticket, a declared `on conflict fail` on a key raises `FailConflictError` but still loses the statement's earlier rows, the same as a declared `not null on conflict fail` today. `bug-declared-fail-conflict-discards-earlier-rows` covers that.

## TODO

- Route `_execBatchAutocommit` through `_finalizeImplicitTransaction` and update its doc comment.
- Add the optional `onConflict` field to the constraint arm of `UpdateResult`. Have `isConstraintViolation` use `Extract` instead of repeating the shape, and keep the import type-only.
- Document the field in the `update()` comment in `vtab/table.ts` and in `docs/module-authoring.md`, including the fallback to the statement's `or` clause for modules that omit it.
- Report the resolved action from every constraint result: memory (`resolvePkConflict` and the three unique-check helpers), store (`store-table.ts` two sites, `store-table-constraints.ts`), isolation (`isolated-table.ts` three sites).
- In `dml-executor.ts`, build the error from the reported action at the insert, update and delete throws. Share one helper with `row-constraints.ts`.
- Add a spec in `test/core-api-transactions.spec.ts` that `db.exec` of `insert or rollback` inside `begin` leaves autocommit true and discards the transaction's rows.
- Add a spec in the same file that `db.exec` of a multi-row `insert or fail` in autocommit keeps the rows before the violation.
- Add a section to `47.2-replace-and-or-clauses.sqllogic` for declared `on conflict rollback` on a column primary key, a table primary key and a UNIQUE constraint, for both insert and update. Logic tests also run in store mode.
- Correct the comment at `test/core-api-transactions.spec.ts` ~449. It says `_finalizeImplicitTransaction` ends the transaction before the batch's catch runs, but `_execBatchAsTransaction` does not call it.
- Run `yarn workspace @quereus/quereus test`, the isolation and store package tests, `yarn test:store` for the 47.x logic files, and `yarn lint`.
