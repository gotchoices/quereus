---
description: A write that is supposed to roll back the whole transaction when it breaks a rule often only fails that one statement, leaving the transaction's earlier changes in place and the transaction still open, contrary to the documented behaviour.
architecture: docs/sql-dml.md
files:
  - packages/quereus/src/core/database.ts (~1125 `_execBatchAutocommit`; ~939 `_finalizeImplicitTransaction`, which holds the rollback rule but is only reached from the `eval` paths)
  - packages/quereus/src/vtab/memory/layer/manager.ts (~1106 `resolvePkConflict`)
  - packages/quereus/src/runtime/emit/dml-executor.ts (~893 `translateConflictError`)
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: The action is rarely used and callers can roll back themselves on seeing the error, so a maintainer may defer this, though the behaviour silently contradicts docs/sql-dml.md for anyone who relies on it.
---

# `ROLLBACK` conflict action does not roll back

`docs/sql-dml.md` says of `or rollback`: "Abort the current statement *and* automatically roll back the enclosing transaction (implicit or explicit). Any prior writes inside the transaction are discarded." Two separate paths do not do this.

Setup for both: `await db.exec('begin'); await db.exec('insert into t values (1, 1)');`, then the violating statement in its own `db.exec`, then read `t` and `db.getAutocommit()`. Expected: no rows, autocommit true. Observed: row 1 still there, autocommit false, in every case below.

## Arm 1 — `db.exec` ignores `RollbackConflictError`

| Table | Statement | Thrown |
|---|---|---|
| `id integer primary key, x integer not null` | `insert or rollback into t values (1, 5)` | `RollbackConflictError` (UNIQUE) |
| same | `insert or rollback into t values (2, null)` | `RollbackConflictError` (NOT NULL) |
| `… x integer not null on conflict rollback` | `insert into t select 2, null` | `RollbackConflictError` (NOT NULL) |

The right error is raised, but `_execBatchAutocommit` only rolls back an *implicit* transaction. The rule that also rolls back an explicit one lives in `_finalizeImplicitTransaction`, which the `eval` paths call and `exec` does not. `test/logic/47.2-replace-and-or-clauses.sqllogic` §8 passes and looks like it covers this, but the harness runs an error-expecting block's last statement through `db.prepare` (`test/logic.spec.ts` ~634), not `db.exec`, so it never exercises this path.

## Arm 2 — a key's declared `on conflict rollback` is not translated

`create table t (id integer primary key on conflict rollback, x integer)` with `insert into t values (1, 5)` colliding on the key throws a plain `ConstraintError`, not `RollbackConflictError`. `resolvePkConflict` handles REPLACE and IGNORE and returns a generic `constraint` status for the rest, and `translateConflictError` translates only from the statement-level `or` clause, so a declared ROLLBACK (and, read from the code but not run, a declared FAIL) acts as ABORT. Seen on the memory module; the store module's equivalent path was not checked.

## Expected

All cases above end with the transaction rolled back and the error surfaced. Pin it with a logic test for the declared forms, and a `db.exec`-level spec, since the logic harness cannot expose arm 1.
