---
description: A table rule that says a violation should stop the statement but keep the rows already written now does keep them, matching the same action written on the statement. Other rules on the same table still undo the whole statement when they are the one broken.
prereq: bug-rollback-conflict-action-not-honored
architecture: docs/sql-dml.md
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts (`DmlSavepointMode`, `selectSavepointMode`, `keepsEarlierRows`, `resolveDmlSourceRows`, `replayThenThrow`, `runWithStatementSavepoints`)
  - packages/quereus/src/schema/table.ts (new `tableDeclaresFailConflict`)
  - packages/quereus/test/logic/47.3-engine-or-fail.sqllogic (sections 6 to 12)
  - packages/quereus/test/runtime/or-fail-mid-row-registration-race.spec.ts (comments only)
  - docs/runtime.md
  - docs/sql-dml.md
  - docs/incremental-maintenance.md
  - docs/invariants.md
  - docs/mv-maintenance.md
repro: verified
---

# Declared `on conflict fail` keeps earlier rows

`docs/sql-dml.md` says `or fail` keeps the rows of the statement that succeeded before the violation, and that a constraint's own `on conflict` clause applies when the statement has no `or` clause. A declared FAIL raised the right error but lost those rows, because the savepoint choice looked only at the statement's `or` clause.

## What changed

The executor now picks one of three savepoint modes, `DmlSavepointMode`:

| Mode | When | Savepoints | On failure |
|---|---|---|---|
| `statement` | no FAIL possible, including any `or` clause other than `or fail` | statement | every row undone |
| `row` | `or fail` | one per row | failing row undone, earlier rows kept |
| `statementAndRow` | no `or` clause, and the table declares FAIL on any constraint | statement and one per row | `FailConflictError` keeps earlier rows; anything else undoes every row |

`runWithStatementSavepoints` now has two steps. The row loop either finishes, stops with a failure that keeps earlier rows, or rolls back and rethrows. Then a shared end-of-statement step runs the batched RESTRICT probe and the deferred maintenance flush and releases the statement savepoint, rolling back if any of that fails. A kept failure is raised after that step.

## Behaviour to validate

Each row below ran on memory and on store (LevelDB behind the isolation layer), through both `db.exec` and `db.eval`, with identical results in all four combinations. These ran in a throwaway spec, since deleted.

| Table declares | Statement | Error | Rows after |
|---|---|---|---|
| `x not null on conflict fail` | `insert (5,5), (6,null), (7,7)`, autocommit or inside `begin` | `FailConflictError` | `5`; transaction still open inside `begin` |
| `id primary key on conflict fail`, seeded `1` | `insert (5,5), (1,5), (6,6)`, autocommit or inside `begin` | `FailConflictError` | `1,5` |
| `primary key (a, b) on conflict fail`, seeded `(1,1)` | `insert (5,5), (1,1), (6,6)` | `FailConflictError` | `(1,1),(5,5)` |
| `x unique on conflict fail`, seeded `(1,1)` | `insert (5,5), (6,1), (7,7)` inside `begin` | `FailConflictError` | `1,5`; transaction still open |
| `x not null on conflict fail`, rows `1,2,3` | `update` with a NULL at row 2 | `FailConflictError` | row 1 updated; rows 2, 3 unchanged |
| `check on delete (x < 2) on conflict fail` | `delete from t`, row 2 fails | `FailConflictError` | row 1 gone; rows 2, 3 remain |
| `x not null on conflict fail` | `insert ... on conflict (id) do nothing`, a later row has a NULL | `FailConflictError` | rows before the NULL kept |
| `check (x > 0) on conflict fail` | `do update set x = -1` fires at row 2 | `FailConflictError` | earlier row kept, conflicting row unchanged |
| `x not null on conflict fail` | `insert or abort` | `ConstraintError` | none |
| `x not null on conflict fail` | `insert or ignore` | none | NULL row skipped, others kept |

Also checked in that spec:

- **User savepoints stay aligned** (memory and store): a declared FAIL inside `savepoint sp1`, then `rollback to savepoint sp1`, then more writes, `release` and `commit`.
- **Materialized view stays in step** (memory only): after a kept FAIL, an aggregate view matched the surviving rows.
- **Maintenance flush failure after a kept FAIL** (memory only, by replacing `_flushDeferredMaintenance` with a function that throws): the maintenance error surfaces, every row of the statement is undone, and `savepoint`, `release` and `commit` still work afterwards.
- **Cascades** (memory and store): with both tables declaring FAIL, the parent's earlier row and its cascade are kept and the failing row and its cascade are undone. An ABORT raised by a cascade undoes everything.

## Beyond the ticket

**Store UPDATE and DELETE lost the rows anyway.** The ticket did not cover this. A module without per-scan snapshot isolation reads all its source rows before writing any, and only memory sets that flag, so on the store module a NOT NULL or CHECK violation surfaced before any row was written. Under `statementAndRow`, `resolveDmlSourceRows` now applies the rows read before the error and then raises it from the loop.

This covers every drain error in that mode, not only FAIL, so a failure takes effect at its own row's position as it does when streaming. A FAIL at row 2 therefore still beats an ABORT the drain met at row 3. The cost is that a non-FAIL drain failure now applies rows and then undoes them, on these tables only.

**The foreign-key question the ticket asked me to check.** A foreign key cannot declare `on conflict` at all: the parser rejects it with `Expected DELETE or UPDATE after ON.`, at column and table level, so a RESTRICT failure is never a `FailConflictError`.

The real risk was different. The batched RESTRICT probe runs at statement end, so a FAIL that stopped the loop could have skipped it and left a kept row with its child orphaned. The shared end-of-statement step prevents that: the probe runs on the kept path too, and a violation undoes the statement. I first excluded these tables from batching in `getBatchableRestrictFks`, then reverted that once a mutation run showed it was redundant. The gate is unchanged, as the ticket expected, so these tables keep batching and report the same RESTRICT message as any other table.

## Departures from the ticket's TODO, please check

- **The mode is not passed to `runWithStatementSavepoints`.** It is selected once in `emitDmlExecutor`, and that generator reads it from the closure, as it already does with `plan`. This replaces three copies of the old `isFailMode` line.
- **The helper's foreign-key arm can't be reached from SQL**, since nothing sets `ForeignKeyConstraintSchema.defaultConflict` from a parsed statement. I kept it because the ticket lists it and the field exists on the type.
- **Per-row savepoint names now share the module-scope counter.** Nested per-row savepoints are newly reachable through a cascade between two tables that declare FAIL. Duplicate names would have worked, because lookup searches from the top of the stack, but the comment on the counter says names must be unique. This is why the race spec's comments changed; its assertions did not.
- **`row` mode no longer flushes twice after a failed flush.** The old catch re-ran `_flushDeferredMaintenance` when the end-of-statement flush itself threw. The original error now propagates directly. No test covers this.

## Known gaps

- **A FAIL reached through a cascade, when the target table declares no FAIL, undoes the whole statement.** It raises `FailConflictError` with no rows kept; in autocommit the implicit transaction then commits with nothing in it. This matches the behaviour before this ticket. The specification does not say which table's rule governs here, and the outcome differs if the parent happens to declare FAIL on something unrelated. Parked as a `NOTE:` on `DmlSavepointMode`. A reviewer who thinks this should be settled should send it to `blocked/`.
- **A third-party module that omits `onConflict` from its constraint result** produces a plain `ConstraintError` on a declared FAIL key, which undoes the statement. This is the documented fallback from the prerequisite ticket.
- **The `DO UPDATE` arm's own write** still raises a plain `ConstraintError` regardless of declared action, as documented in `docs/sql-dml.md`. Constraint checks in that arm do honour a declared FAIL (see the table above).
- **The store-side view and flush-failure paths were not run**; those two probes ran on memory only.
- **No committed test covers** the flush-failure branch, the savepoint alignment case, or the error class. The sqllogic format asserts messages and rows only.

## Tests

All added to `47.3-engine-or-fail.sqllogic`, which runs on memory and store:

- Section 6: declared FAIL on NOT NULL, autocommit and inside `begin`. Reproduces the ticket's defect for a violation raised by the source.
- Section 7: declared FAIL on CHECK.
- Section 8: declared FAIL on a primary key, autocommit and inside `begin`. Reproduces it for a violation raised by the module during the write.
- Section 9: declared FAIL on UNIQUE inside `begin`.
- Section 10: on a table that also declares FAIL, an ABORT raised by the source, an ABORT raised by the module, and `insert or abort` each undo the earlier rows.
- Section 11: declared FAIL on UPDATE, plus a FAIL at row 2 ahead of an ABORT at row 3. These reproduce the drained-source defect on store.
- Section 12: a kept row still faces the batched RESTRICT probe, and the same statement keeps the row once nothing references it.

I confirmed these catch regressions by temporarily disabling each part of the fix and restoring the source afterwards:

| Disabled | Run on | Failed at |
|---|---|---|
| The `statementAndRow` selection | memory | section 6 |
| `keepsEarlierRows` checking the error type | memory | section 10 |
| Replaying a drain failure | store | section 11, first case |
| Replaying non-FAIL drain failures | store | section 11, second case |
| The RESTRICT probe on the kept path | memory and store | section 12 |

## Validation run

On the final tree:

- `yarn workspace @quereus/quereus test`: 10947 passing, 25 pending.
- `yarn test:store`: 10940 passing, 32 pending.
- `yarn workspace @quereus/quereus lint`: clean.
- `tsc -b tsconfig.build.json`: clean.
- `@quereus/isolation` 445, `@quereus/store` 1986 and `@quereus/sync` 839 passing, against the rebuilt library.

I did not run the root `yarn test` across every workspace, or the bundled app builds.
