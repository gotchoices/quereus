---
description: A write that is supposed to roll back the whole transaction when it breaks a rule now does so, and a write that is supposed to keep its earlier rows now keeps them through the main execute call. Both now match the documented behaviour on the memory and store modules.
architecture: docs/sql-dml.md
files:
  - packages/quereus/src/core/database.ts (`_execBatchAutocommit`, `exec` doc comment)
  - packages/quereus/src/common/types.ts (`UpdateResult`, `isConstraintViolation`)
  - packages/quereus/src/common/errors.ts (new `constraintErrorForAction`)
  - packages/quereus/src/runtime/emit/dml-executor.ts (new `violationError`; insert, update and delete throws; `translateConflictError` comment)
  - packages/quereus/src/runtime/row-constraints.ts (`throwForAction` removed)
  - packages/quereus/src/runtime/emit/view-mutation.ts (third copy of the mapping removed)
  - packages/quereus/src/vtab/table.ts (`update` contract comment)
  - packages/quereus/src/vtab/memory/layer/manager.ts (`resolvePkConflict`, three unique-check helpers)
  - packages/quereus-store/src/common/store-table.ts
  - packages/quereus-store/src/common/store-table-constraints.ts
  - packages/quereus-isolation/src/isolated-table.ts
  - packages/quereus/test/core-api-transactions.spec.ts
  - packages/quereus/test/logic/47.2-replace-and-or-clauses.sqllogic
  - packages/quereus/test/runtime/or-fail-mid-row-registration-race.spec.ts
  - docs/module-authoring.md
  - docs/usage.md
repro: verified
---

# Conflict actions honoured through `db.exec` and for declared key constraints

`docs/sql-dml.md` says `or rollback` rolls back the enclosing transaction, implicit or explicit, and that `or fail` keeps the rows of the statement that succeeded before the violation. Its precedence is statement `or` clause, then the constraint's own `on conflict` clause, then ABORT. Two separate defects broke this.

## What changed

**`db.exec` finalization.** `_execBatchAutocommit` had its own commit-or-rollback logic that looked only at whether the transaction was implicit. It now calls `_finalizeImplicitTransaction`, the same function the `eval`, `run`, `get` and iterator paths use. The atomic form `exec(sql, params, { transaction: true })` is unchanged, because it already rolled back on any error.

**Declared action on a key.** The constraint arm of `UpdateResult` gained an optional `onConflict`, carrying the action the module resolved for that conflict. Memory, store and isolation all report it from every constraint result. The executor builds its error from it through the new `constraintErrorForAction`, which `row-constraints.ts` also uses. `translateConflictError` stays as the fallback for a module that omits the field and for plain `ConstraintError`s thrown inside `processRow`, such as the RESTRICT pre-check.

## Behaviour to validate

Each row was checked on memory and on store (LevelDB behind the isolation layer), through both `db.exec` and `db.eval`:

| Setup | Statement | Result |
|---|---|---|
| Inside `begin`, with a row staged | `insert or rollback` that violates a key or `not null` | `RollbackConflictError`, autocommit true, staged rows gone |
| Inside `begin`, `not null` or `check` declared `on conflict rollback` | violating insert | same |
| Inside `begin`, column primary key, table primary key or `unique` declared `on conflict rollback` | violating insert | same |
| Inside `begin`, `unique` or column primary key declared `on conflict rollback` | violating update | same; rows committed before `begin` remain |
| Autocommit | `insert or fail into t values (5, 5), (1, 5), (6, 6)` with `1` committed | `FailConflictError`, rows `1,5` |
| Autocommit | `insert or fail into t values (5, 5), (6, null), (7, 7)` on an empty table | `FailConflictError`, row `5` |

These were also checked on both modules, through `db.exec` only:

- `primary key on conflict rollback` with a plain `unique`: a UNIQUE conflict inside a transaction or a single statement still acts as ABORT, and the transaction stays open.
- `unique on conflict rollback` with a plain primary key: a conflict between two rows of one statement rolls back the transaction.
- `primary key on conflict rollback`: a duplicate of a key staged in the same transaction rolls back the transaction.
- An UPSERT whose `on conflict` target does not match the violated constraint raises under that constraint's declared action.

The table and this list ran in throwaway specs that were then deleted. The committed tests below cover a subset.

**Visible change for hosts.** After `db.exec` of a statement that resolves to ROLLBACK, the transaction is gone, so a following `db.commit()` throws `No transaction active`. `db.eval` already behaved this way.

## Tests

- `core-api-transactions.spec.ts`, "exec of insert or rollback inside begin ends the transaction and discards its rows": reproduces the `db.exec` half of the ROLLBACK defect.
- `core-api-transactions.spec.ts`, "exec of a multi-row insert or fail in autocommit keeps the rows before the violation": reproduces the `db.exec` FAIL defect.
- `47.2-replace-and-or-clauses.sqllogic` section 11: declared `on conflict rollback` on a column primary key, a table primary key and a UNIQUE constraint, for insert and update, plus `or abort` outranking the declared action. Runs in both memory and store mode.

**Existing test changed, please check this one.** `or-fail-mid-row-registration-race.spec.ts`, "autocommit OR FAIL with mid-row registration", asserted that a rollback reached the sibling connection after `db.exec` of `insert or fail`. That was the defect, so it now asserts exactly one `commit`. Its savepoint broadcast assertions, which are the point of that test, are unchanged.

I also corrected the comment in `core-api-transactions.spec.ts` that said `_finalizeImplicitTransaction` ends the transaction in the atomic batch path.

## Validation run

On the final tree: `yarn workspace @quereus/quereus test`, `yarn test:store` filtered to 47.x, `tsc -b tsconfig.build.json` and `yarn lint`. Before the final comment and docs edits: `yarn test` across all workspaces, which includes the isolation, store and sync packages. All passed.

## Known gaps and judgment calls

- **The fallback for a module that omits `onConflict`.** `translateConflictError` itself did not change. The race spec's module omits the field, and review tightened that spec to assert the resulting error type.
- **`on conflict fail` declared on a key is only half fixed, as the ticket expected.** It now raises `FailConflictError` but still loses the statement's earlier rows, because the per-row savepoint mode keys off the statement's `or` clause only. `bug-declared-fail-conflict-discards-earlier-rows` covers that.
- **The `DO UPDATE` arm of an upsert is unchanged.** `executeUpsertUpdate` passes an explicit ABORT and still throws a plain `ConstraintError`. Review ran this and documented it; see the findings below.
- **The isolation layer gives its overlay the primary key's action.** A conflict the overlay reports would therefore carry the primary key's action rather than the UNIQUE constraint's own. The merged UNIQUE check runs first and caught every conflict in the cases above, so I did not find a way to reach this. It was tested for the cases listed, not proven unreachable.
- **Beyond the ticket's file list.** I removed the third copy of the error mapping in `view-mutation.ts`. I corrected `docs/usage.md`, which said `exec` runs a batch atomically and contradicted the same file's Implicit Transactions section. I also added a sentence on the two conflict actions to the `exec` doc comment.
- **`throwForAction` is gone rather than reused.** The mapping now lives in `common/errors.ts` as a function that returns the error, which lets the executor and `row-constraints.ts` share it. `errors.ts` now imports `constants.ts` at runtime; `constants.ts` has no imports, so this adds no cycle.

## Review findings

Reviewed `ticket(implement): bug-rollback-conflict-action-not-honored` from the diff first, then the handoff. A throwaway spec, since deleted, ran the probes marked "ran" below on the memory module only.

**Checked, no defect**

- `db.exec` finalization: `TransactionManager.commitTransaction` clears its state in a `finally`, so a failed commit that reaches the catch does not commit or roll back twice. The state stays correct for later statements in a batch that started with `begin`, and for an autocommit batch whose earlier statement already committed (ran).
- Other entry points under a declared rollback: `stmt.run`, `stmt.get`, and an insert through a view (ran).
- OR clause precedence: `insert or ignore` and `insert or replace` override a declared rollback on the primary key (ran).
- Upsert target matching: a conflict on the named constraint takes `do nothing`, and a conflict on another constraint raises under that constraint's declared action (ran).
- Deferred-style CHECK with a subquery under `db.exec`, with and without `or fail` (ran). It did not hit the commit-failure path, because both forms raised during the statement.
- Every constraint result in memory, store and isolation reports its resolved action (read). Other `isConstraintViolation` callers, in `alter-migration.ts` and `flush.ts`, do not raise conflict errors and are unaffected (read). `enforceSecondaryUniqueOnMaintenance` always checks under ABORT and throws its own error (read).
- Consumers of the error subclasses: only `_finalizeImplicitTransaction` reads them, and nothing matches on the error name `ConstraintError` (grep).
- `errors.ts` importing `constants.ts` at runtime adds no cycle, and `constraintErrorForAction` is not exported from the package index.
- Docs: `docs/usage.md`, `docs/module-authoring.md` and `docs/runtime.md` match the new behaviour.
- Implementer's tests: the two `core-api-transactions.spec.ts` tests and section 11 of `47.2` each reproduce a defect in this ticket, and the changed race-spec assertion is correct. None were cut.

**Found and fixed in this pass**

- Undocumented behaviour, now confirmed by running it: a UNIQUE conflict from a `DO UPDATE` arm's own write raises a plain `ConstraintError` for declared `rollback`, `fail`, `ignore` and `replace`, while a plain `UPDATE` honours each one. `docs/sql-dml.md` said the arm validates "exactly as" a plain `UPDATE` and did not mention this exception. The fix-stage ticket chose to leave the code alone, so I kept that decision, added the exception to `docs/sql-dml.md`, and added a case to `47.2` that pins it on memory and store.
- Handoff claim corrected: it said no test reaches the fallback for a module that omits `onConflict`. The module in `or-fail-mid-row-registration-race.spec.ts` omits it, but the test only asserted that some error was thrown. It now asserts `FailConflictError`.
- Duplication: `checkCheckConstraints` kept a REPLACE branch that `constraintErrorForAction` already covers, so I removed the branch.

**Tripwires parked**

- `NOTE:` at the explicit ABORT in `executeUpsertUpdate` (`dml-executor.ts`): what honouring declared actions on the arm would require.
- `NOTE:` at `effectiveOR` in `isolated-table.ts`: the overlay enforces UNIQUE under the primary key's action. This is harmless while the merged UNIQUE check runs first.

**Major findings:** none, so no tickets were filed. `bug-declared-fail-conflict-discards-earlier-rows` already covers declared FAIL losing earlier rows, and it is on the board in `implement/`.

**For a human to weigh:** the `DO UPDATE` exception is now written into the spec as current behaviour. If declared `rollback` or `fail` should govern that arm, this sentence and the `47.2` case are what would change.

**Validation on the final tree:** `yarn workspace @quereus/quereus test` (10947 passing, 25 pending), `yarn lint`, `tsc -b tsconfig.build.json`, store-mode logic tests filtered to 47.x (9 passing), `@quereus/isolation` tests (445 passing), `@quereus/store` tests (1986 passing). The full `yarn test` across all workspaces was not re-run in review. The sync package, which the implement stage covered, was not re-run because no source it depends on changed apart from the two comment and one branch edits above.
