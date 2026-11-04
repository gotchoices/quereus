---
description: A table rule that says a violation should stop the statement but keep the rows already written now does keep them, matching the same action written on the statement. Other rules on the same table still undo the whole statement when they are the one broken.
prereq: bug-rollback-conflict-action-not-honored
architecture: docs/sql-dml.md
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts (`DmlSavepointMode`, `selectSavepointMode`, `keepsEarlierRows`, `drainBeforeWriting`, `resolveDmlRowSource`, `runWithStatementSavepoints`)
  - packages/quereus/src/runtime/deferred-constraint-queue.ts (`RowScopedDeferredChecks`, `detachLayer`, `adoptChecks`)
  - packages/quereus/src/schema/table.ts (`tableDeclaresFailConflict`)
  - packages/quereus/test/logic/47.3-engine-or-fail.sqllogic (sections 6 to 15)
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

`runWithStatementSavepoints` has two steps. The row loop either finishes, stops with a failure that keeps earlier rows, or rolls back and rethrows. Then a shared end-of-statement step runs the batched RESTRICT probe and the deferred maintenance flush and releases the statement savepoint, rolling back if any of that fails. A kept failure is raised after that step.

On a module without per-scan snapshot isolation, UPDATE and DELETE read all their source rows before writing any. Under `statementAndRow` a failure during that read is raised only after the rows before it are applied, so a failure takes effect at its own row's position, as it does when streaming. The cost is that a non-FAIL failure there applies rows and then undoes them, on these tables only.

A foreign key cannot declare `on conflict` (the parser rejects it), so a RESTRICT failure is never a `FailConflictError`. The `foreignKeys` arm of `tableDeclaresFailConflict` can't be reached from SQL today; it stays because the field exists on the type and the ticket listed it.

## Review findings

Read the implement diff first, then probed it with a throwaway spec on memory and store (since deleted).

### Fixed in this pass

- **A row undone by FAIL made the batched RESTRICT probe fail.** Reproduced: `update p set id = id + 100, x = 11` where `x` is `unique on conflict fail` and a child references row 2. Row 2 fails in the module and is reverted, so its key is still in place and the child is valid. Its key had already been added to the batch, so the probe reported `FOREIGN KEY constraint failed` and undid row 1. Rows now add their key only after they complete (`processUpdateRow`, `processDeleteRow`). A row the module reports as not found also no longer contributes; it changed nothing, so it can't orphan a child. Section 12 covers this.
- **A row undone by FAIL left its deferred checks queued, so COMMIT rejected the transaction.** This was a regression from the ticket: before it, the statement rollback removed them. Reproduced on a child table with a foreign key and `primary key on conflict fail`: after `insert into c values (5, null), (1, 999)`, autocommit raised `CHECK constraint failed: _fk_c_pid` instead of the FAIL and lost row 5, and an explicit `commit` failed and lost the transaction. The source queues a row's checks as it is pulled, before the row's savepoint opens. `RowScopedDeferredChecks` now sets them aside and queues them with the savepoint open. On store, the same fix stops checks of rows read past the failing one from being queued. Section 13 covers this.
- **On store, an ABORT that undid a statement left its deferred checks queued (older than this ticket).** Reproduced with `update t set x = 11, a = 99` inside `begin`: the statement failed and was undone, then `commit` failed on a check for a value never written, and memory behaved correctly. The read ran before the statement savepoint opened, on the stated assumption that reads have no side effects. `drainBeforeWriting` now runs on the row loop's first pull, inside the savepoint, which also removes the separate `disconnect` guard. I fixed it here because it is the same function. Section 14 covers this.
- **Docs and comments.** Updated `docs/runtime.md` for the above, removed a stale "(for non-FAIL)" and reflowed one doc comment.

### Checked, no change

- **Savepoint alignment:** a declared FAIL inside `savepoint sp1`, then `rollback to`, more writes, `release`, `commit` is correct. This had no committed test, so I added section 15.
- **`row` mode cannot hit the deferred-check defect:** with `or fail` every check is evaluated immediately instead of waiting for COMMIT. `update or fail` does not parse, so `row` mode is INSERT only, and INSERT never drains.
- **Other forms of declaration:** a primary key column that gets FAIL from `not null on conflict fail`, a table-level composite key and `returning` all behave correctly.
- **Removing the double flush** in `row` mode is correct: a flush failure now propagates once.
- **Sharing the savepoint counter** across statement and row names is correct, and the race spec's assertions are unchanged.
- **Resource cleanup:** a drain failure now reaches the `finally` that disconnects the vtab. Early consumer exit is safe because a row's checks join its savepoint before the row is processed.
- **Type safety:** no new `any`. Lint and the type check are clean.

### Tests

Cut none. Sections 6 to 12 each exercise a distinct path, either a different error source or a different module behaviour. Added sections 13, 14 and 15 and one case in section 12. Each statement's shape failed in the probe before the fix, but I did not re-run the committed sections against the unfixed source.

### Tripwires and considered-and-left

- **FAIL reached through a cascade when the target table declares none:** undoes the whole statement, as before this ticket. The specification doesn't say which table's rule governs. It stays as the `NOTE:` on `DmlSavepointMode`, and I did not send it to `blocked/`: nothing is wrong today unless someone wants a cascaded FAIL to keep the parent's rows.
- **Per-row Map allocation in `RowScopedDeferredChecks`:** parked as a `NOTE:` on that class.
- **`dml-executor.ts` size:** 1758 lines by `wc -l`, down from 1766 at the start of review. Already large before this ticket, so no ticket filed here.

### Remaining gaps

- **The flush-failure branch has no committed test.** Provoking it needs a stub of `_flushDeferredMaintenance`, which is a module this repository owns. The implement-stage probe ran it on memory only.
- **The store-side view and flush-failure paths** were never run, on either pass.
- **The error class** isn't asserted by the sqllogic format, which checks messages and rows. The probes printed `FailConflictError` on both backends.
- **A third-party module that omits `onConflict`** produces a plain `ConstraintError` on a declared FAIL key, which undoes the statement. This is the documented fallback from the prerequisite.
- **The `DO UPDATE` arm's own write** still raises a plain `ConstraintError`, as documented in `docs/sql-dml.md`. Constraint checks in that arm do honour a declared FAIL.

## Validation

On the final source, apart from one comment-only `NOTE:` added afterwards:

- `yarn workspace @quereus/quereus test`: 10947 passing, 25 pending.
- `yarn test:store`: 10940 passing, 32 pending. The 15 `TransactionCoordinator` out-of-range warnings match earlier store logs.
- `yarn workspace @quereus/quereus lint`: exit 0.
- `tsc -b tsconfig.build.json`: clean.
- `@quereus/isolation` 445, `@quereus/store` 1986 and `@quereus/sync` 839 passing, against the rebuilt library.

Not run: root `yarn test` across every workspace, and the bundled app builds.
