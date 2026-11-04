---
description: When a table rule declares that a violation should stop the statement but keep the rows already written, those earlier rows are thrown away anyway, so the declared rule behaves differently from the same action written on the statement.
prereq: bug-rollback-conflict-action-not-honored
architecture: docs/sql-dml.md
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts (~937 `runWithStatementSavepoints`; `isFailMode` at ~1104, ~1383, ~1574)
  - packages/quereus/src/schema/table.ts (~1366 `resolvePkDefaultConflict`; `checkConstraints`, `uniqueConstraints`, `foreignKeys`)
  - packages/quereus/test/logic/47.3-engine-or-fail.sqllogic
  - docs/runtime.md (~989 statement savepoint description)
repro: verified
---

# Declared `on conflict fail` does not keep earlier rows

`docs/sql-dml.md` says `or fail` keeps the rows of the statement that succeeded before the violation, and that a constraint's own `on conflict` clause applies when the statement has no `or` clause. So a declared FAIL should keep those rows too. It does not.

## Reproduction

Each case ran on the memory module and on the store module (LevelDB behind the isolation layer), through both `db.exec` and `db.eval`, with the same result across all four combinations, except where the "Call" column says otherwise. The throwaway spec was then deleted.

The statement is a multi-row insert whose middle row violates the constraint: `insert into t values (5, 5), (6, null), (7, 7)` for NOT NULL. The key tables are seeded with `(1, 1)` and use `(5, 5), (1, 5), (6, 6)` for the primary key and `(5, 5), (6, 1), (7, 7)` for UNIQUE.

| Declared on | Transaction | Error thrown | Rows | Expected rows |
|---|---|---|---|---|
| `x integer not null on conflict fail` | autocommit | `FailConflictError` | none | `5` |
| same | explicit | `FailConflictError` | none | `5`, transaction still open |
| `id integer primary key on conflict fail` | autocommit | `ConstraintError` | `1` | `1,5` |
| same | explicit | `ConstraintError` | `1` | `1,5`, transaction still open |
| `x integer unique on conflict fail` | explicit | `ConstraintError` | `1` | `1,5`, transaction still open |

The key rows raise `ConstraintError` until the prerequisite lands. After it they raise `FailConflictError`, and the rows stay wrong.

For comparison, `insert or fail` keeps the row through `db.eval`: the same NOT NULL statement written with `or fail` leaves row `5`. Its `db.exec` result is wrong for a different reason, which the prerequisite fixes.

## Cause

The three `isFailMode` checks in `dml-executor.ts` look only at `plan.onConflict`, the statement's `or` clause. Without one, `runWithStatementSavepoints` opens the statement-wide savepoint and rolls it back on any error, including `FailConflictError`, so the earlier rows are undone before the error reaches transaction finalization.

Treating a table with a declared FAIL as plain FAIL mode would be wrong. That mode has no statement savepoint, so a different constraint on the same table that resolves to ABORT would stop undoing the statement's earlier rows. Which action applies is only known when a row fails.

## Fix

When the statement has no `or` clause and the table declares FAIL on any constraint, open both savepoints: the statement-wide one and the per-row one. Then decide when the error arrives:

- `FailConflictError`: keep the earlier rows. The per-row savepoint has already undone the failing row. Flush deferred maintenance as the existing FAIL path does, then release the statement savepoint without rolling it back.
- Any other error: roll back the statement savepoint as usual.

A NOT NULL or CHECK failure raised from the source iterator arrives with no per-row savepoint open, but the failing row has written nothing at that point, so the same rule works.

Other cases stay as they are:

- A statement with an explicit `or` clause overrides the declared action, so it keeps today's path, including `insert or abort` on a table that declares FAIL.
- Tables with no declared FAIL pay no per-row savepoint cost.
- The batched foreign-key RESTRICT flush (`getBatchableRestrictFks`, `planner/building/foreign-key-builder.ts`) decides from the statement's `or` clause and requires a statement savepoint around its flush. This mode still has one, and a RESTRICT failure raised there is not a `FailConflictError` unless that foreign key declares FAIL. Check this case while implementing. It has not been run.

## TODO

- Add a helper next to `resolvePkDefaultConflict` in `schema/table.ts` that reports whether a table declares FAIL on its primary key, any column, or any CHECK, UNIQUE or foreign-key constraint.
- Have the three executors select the mode from the statement's `or` clause and that helper, and pass it to `runWithStatementSavepoints` in place of the `isFailMode` boolean, using a named mode rather than a second boolean.
- Update the savepoint logic and its doc comment for the combined mode, including the deferred-maintenance flush on the `FailConflictError` branch.
- Add sections to `47.3-engine-or-fail.sqllogic` for declared FAIL on NOT NULL, CHECK, a primary key and UNIQUE, and for an ABORT constraint on a table that also declares FAIL, where the earlier rows must be undone.
- Describe the combined mode in `docs/runtime.md` ~989.
- Run `yarn workspace @quereus/quereus test`, `yarn test:store` for the 47.x logic files, and `yarn lint`.
