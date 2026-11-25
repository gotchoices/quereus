description: A foreign-key or cross-table CHECK that waits until commit used to be checked against the row as first written, so a transaction that later deleted or corrected that row still failed at commit. Commit now checks only rows that still exist, using their latest values, and a row whose key an UPDATE changes keeps its checks.
architecture: docs/sql-constraints.md#76-foreign-key-constraint
files: packages/quereus/src/runtime/deferred-constraint-queue.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/core/database.ts, packages/quereus/src/runtime/row-constraints.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/core/derived-row-validator.ts, packages/quereus/src/core/database-materialized-views-plans.ts, packages/quereus/src/core/database-materialized-views-apply.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/planner/building/insert.ts, packages/quereus/test/logic/41.17-deferred-check-on-superseded-row.sqllogic, packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic, docs/sql-constraints.md, docs/runtime.md
----
## What changed

Deferred row checks are the child-side foreign-key existence check (docs/sql-constraints.md § 7.6) and row-level CHECKs that read other tables (§ 7.4.1). Each is queued at write time and evaluated at COMMIT. Before this change every queued copy was evaluated, so a row deleted or corrected later in the transaction still failed commit.

Rule now (documented in § 7.4.1 and § 7.6):

- A check queued by an INSERT or UPDATE carries a row identity: lowercase `schema.table` plus `encodeKeyTuple` of the NEW section's primary key (`newSectionRowIdentity`, deferred-constraint-queue.ts).
- At commit, `runDeferredRows(rowExists)` → `checksStillDue` keeps, per table bucket and constraint, every unkeyed entry, and for each keyed row only the highest-`seq` entry, and only if the row exists.
- `TransactionManager.changeLogRowExists` answers "exists" from the transaction change log: the newest savepoint layer holding the key decides (`insert`/`update` exists, `delete` gone), and a key no layer holds is gone.
- DELETE-time checks (`check on delete`) carry no identity and always run, as before.

Plumbing: `enqueue` / `Database._queueDeferredConstraintRow` take an options object (`connectionId`, `contextRow`, `contextDescriptor`, `rowIdentity`) instead of positional tails. Each entry gets a queue-wide `seq` that is never reset. `cloneAll` carries both new fields.

Maintained tables: `validateDerivedRowImage` keys its entries from `maintenanceChangeLogKey(plan)` (new, database-materialized-views-plans.ts). `recordMaintenanceChanges` now uses the same helper, so the queued check and the recorded write name one row by construction. I confirmed `validator.schemaName/tableName` equal `plan.backingSchema/backingTableName` (both are `mv.schemaName`/`mv.name`, plan-builders.ts), and that validation and recording are always paired (`postApplyBackingChanges` is the only caller of `validateDerivedChanges`).

Second change, as specified: an UPDATE builds child-side FK checks only for keys with at least one assigned column. Generated-column assignments count. See `assignedColumnIndices` in update.ts and the new `assignedColumns` parameter of `buildChildSideFKChecks`. The upsert `do update` arm stays unfiltered; there's a `NOTE:` in insert.ts.

### Deviation from the ticket: withdrawing checks for writes that never land

The ticket's rule "the newest check per row wins" had a hole the ticket didn't cover. Some queued checks belong to a write that never happens: an upsert resolved to `do nothing` or to its `do update` arm, a module returning no row, or a row a later constraint's IGNORE skipped. If that row's key was already written earlier in the transaction, the orphan check becomes the newest one and hides the real row's check. That is a missed violation, for example `insert (9, 99); insert (9, 1) on conflict (id) do nothing; commit` would commit the bad row. I confirmed it by disabling the fix: line 162 of 41.17 then commits.

Fix: `DeferredConstraintQueue.withdrawRowChecks(baseTable, afterSeq, rowIdentity?)` removes the entries queued after `afterSeq`.

- **Executor.** `runWithStatementSavepoints` records `lastQueuedSeq()` before each pull and passes it to `processRow` as `checksQueuedAfter`. `withdrawOwnRowChecks` (dml-executor.ts) withdraws by identity at three points:
  - the upsert branch, before either arm runs, so `do update`'s own checks queue afterwards and survive;
  - the insert path's `!result.row`;
  - the update path's `!result.row`.
- **row-constraints.ts.** `checkCheckConstraints` withdraws when a later constraint's IGNORE skips the row.

Withdrawal matches on identity, not just the sequence window, because a statement's source can run DML of its own (`insert … select … from (insert … returning)`), and those checks land in the same window.

### Case C as written could not pass

`delete from Entity where id in (2, 1)` with the default RESTRICT fails immediately: the scan visits 1 while 2 still references it. That happens with or without this change. The test deletes the child rows first. It also adds a row whose UPDATE does assign the key, so case C exercises the existence rule and not only the assigned-column filter.

## Tests

`41.17-deferred-check-on-superseded-row.sqllogic` (new). Each section has its own tables.

- **A**: set-null update then cascade delete. The reported bug; it was the first failure before the fix.
- **B**: the keyed-the-other-way variant. Still passes, which guards against dropping checks that matter.
- **C**: as above.
- **D**: insert, delete it, delete its parent.
- **F**: repoint a bad row to a real parent.
- **G**: insert a bad row, delete it.
- **Still fails**: an update that leaves the key alone.
- **Savepoint rollback** of the repointing UPDATE: fails.
- **Savepoint rollback** of the DELETE: fails.
- **Primary-key move** with a fixed parent: passes.
- **`do nothing` after a bad row**: fails. Depends on withdrawal (verified).
- **`do nothing` with bad values after a good row**: passes. Depends on withdrawal.
- **`do update` repointing the row**: passes.
- **Displaced-key move** (`primary key on conflict replace`) onto key 5 with a bad parent: fails.
- **H**: the subquery-CHECK version of D.
- **Maintained table**: repointed derived row passes, removed derived row passes, standing bad row fails. Depends on the MV keying (verified by un-passing `changeLogKey`).
- **IGNORE-skipped row** whose earlier-queued check would have hidden a bad row: fails. Depends on the row-constraints withdrawal (verified).

`41.11-deferred-fk-with-rename.sqllogic` § 11 (new): insert a bad row, rename the child, delete the row, commit. This still fails, per the design. The comment says why, so a future change-log rename shows up here.

43.2-deferred-check-new-on-delete.sqllogic is unchanged and passes.

Runs: `yarn test` (all workspaces) green, with quereus at 11186 passing. `yarn test:store` green: 11179 passing, 30 pending. `yarn workspace @quereus/quereus lint` clean.

## Known gaps / tripwires (each has a `NOTE:` at the site)

- **Drained statements withdraw nothing** (`withdrawOwnRowChecks`, dml-executor.ts). Only UPDATE drains, on modules without scan snapshot isolation (the store backend). Its only unwritten row is one the module couldn't find, and that row's check keeps today's behavior. If an INSERT source ever drains, the window needs carrying per row.
- **`withdrawRowChecks` walks each list back from its tail and stops at `afterSeq`.** That relies on queue order past that point. A rename merging into an existing bucket, or a drained statement under declared FAIL, appends out of order. The executor doesn't withdraw under drain; the rename case would need a withdrawal right after a freed-name-reuse rename merge.
- **Identity is the NEW section as checked; the change log keys the stored row** (`newSectionRowIdentity`). They agree for in-tree modules, which store `preCoerced` rows as given. A module that normalizes primary-key values on write would make the lookup miss and silently drop checks.
- **"Absent from the change log → gone"** is what makes G and the upsert cases pass. It also means any future enqueue site whose write isn't recorded would drop its checks. Today's sites: the constraint-check node feeding the DML executor, the upsert `do update` arm, and MV maintenance. All record.
- **Rename**: the change log and the identities both stay at write-time names. A row deleted after its table is renamed is still checked (41.11 § 11).
- **Same-table, same-key DML inside a statement's own source**, in the same window as a no-write row, would have its landed check withdrawn. This is contrived: it needs `insert into t … from (insert into t … returning)` hitting the same key.
- **Cost.** One `lastQueuedSeq()` read per DML row and per constraint-checked row. A `newSectionRowIdentity` encode per row that defers anything. A map pass per constraint list at commit. Not measured; I expect it to be small next to the existing per-row work.

## Things worth a reviewer's second look

- Whether withdrawing in the upsert branch before `executeUpsertUpdate` is always right when the `do update` arm's `where` filters the row out (`!updateResult`). Nothing is written then, so withdrawing seems correct.
- `checkCheckConstraints` withdraws without an identity: everything queued for that table since the call began. That assumes constraint evaluation never runs DML.

## Review findings

Read the implement diff (`ticket(implement): deferred-row-checks-judge-a-stale-copy-of-the-row`) first, then the handoff. Ran `yarn workspace @quereus/quereus lint` (clean), `yarn test` (all workspaces green; quereus 11186 passing, 23 pending) and `yarn test:store` (11179 passing, 30 pending).

### Major: fixed in this pass. Moving a row to a new key dropped its checks (verified, a missed violation)

`begin; insert into t values (11, 99); update t set id = 12 where id = 11; commit;` committed a row whose parent 99 does not exist. The UPDATE assigns no foreign-key column, so the new assigned-column filter queues no key check for it. The change log records key 11 as deleted, so commit dropped the insert's check as "row gone", but the row lives on at key 12. The same happened with an `on insert`-only cross-table CHECK, which an UPDATE never queues again, and it did not depend on the filter. Both committed before this fix and failed at HEAD~1, so this was a regression.

Root cause: a primary-key move means the old key is gone in the change log, and nothing linked the row's earlier checks to its new key. Fix at that one place: `DeferredConstraintQueue.carryMovedRowChecks` (deferred-constraint-queue.ts). It is called by `carryMovedRowChecks` in dml-executor.ts after an UPDATE lands and after an upsert's `do update` arm. Per constraint, it re-queues the row's latest check from before the row's pull under the new key. It skips this when the move queued its own check for that constraint.

- The copy goes in the **active savepoint layer**, so `rollback to` the move discards it and leaves the original where it was. Moving the entry in place would have survived the rollback and dropped the check.
- It gets a **fresh `seq`**, so it outranks a check left at the new key by a row that the move displaced (`on conflict replace`). The original `seq` would let the displaced row's good check hide the moved row's bad one.
- **Drained sources** (store-module UPDATE) use the statement's start as the cut-off. Their rows' own checks all queue before any write. To support that, the executor's per-row `checksQueuedAfter: number | undefined` became a `RowCheckWindow { rowStart, statementStart }`.
- `rowIdentity()` (plain row) joins `newSectionRowIdentity()`; both share `rowIdentityAt`.

Tests added to 41.17:
- key move leaving the parent alone, then commit: fails (verified that it commits with the carry disabled);
- the same move inside a savepoint that is rolled back: fails;
- a move onto a displaced row that has a good check: fails;
- the `on insert` CHECK variant, `sr_hi`: fails.

A scratch case where `do update set id = …` moves the key was not kept. That arm re-checks every foreign key anyway, so it does not exercise the carry. Docs: § 7.4.1 in sql-constraints.md (moved rows keep their checks) and runtime.md (the carry mechanism).

Tripwire: `carryMovedRowChecks` scans every queued entry of the table for each moved row, so it is quadratic for bulk key rewrites of a table with many queued checks. Recorded as a `NOTE:` at the method.

### Checked, no change needed

- **`changeLogRowExists` across savepoint layers.** I walked insert/delete/re-insert sequences split across layers, before and after RELEASE. An insert followed by a delete only erases a key from a layer when the key did not exist at that layer's start, so falling through to a lower layer always gives the right answer. Change-log recording is not gated; autocommit statements record too, which case B shows.
- **Implementer's open question 1.** Withdrawing before `do update` when the arm's `where` filters the row out (`!updateResult`) is correct, because nothing is written.
- **Open question 2.** The identity-less withdrawal in `checkCheckConstraints` is sound. Between `queuedBefore` and the IGNORE, only that call's deferrals enqueue; immediate constraint evaluation is read-only.
- **Error paths.** A failing row under FAIL (`statementAndRow`) rolls back its adopted checks with the row savepoint. Withdrawal only touches entries queued during the row's pull, which sit in the current statement or row layer, so a rollback cannot resurrect them.
- **Generated and stored-row identity.** The handoff's `NOTE:`s at `newSectionRowIdentity` (module normalizing primary keys) and `notifyTableRename` (change log not renamed) still hold, and the new carry builds identities the same way: OLD section from the scan, NEW section as checked.
- **The upsert assigned-column `NOTE:`** in insert.ts is accurate. I left it alone.
- **Implementer's tests.** Each 41.17 section reproduces a defect or pins a rule from § 7.4.1 / § 7.6. 41.11 § 11 pins the documented rename behaviour. None restates the implementation, so none was cut.
- **Hygiene.** dml-executor.ts is 1826 lines (`wc -l`; it was 1800 at the implement commit, and this pass added the window type and one helper). It was already large before this ticket. No new ticket: no open ticket claims a split, and nothing here makes one more urgent.
- **Type safety and lint.** Clean; no `any`.

### Not changed

- **Remaining tripwires.** The handoff's other tripwires (drained statements withdraw nothing, tail-walk ordering in `withdrawRowChecks`, absent-means-gone, same-key DML inside a statement's own source) are recorded as `NOTE:`s at their sites and are conditional. No tickets filed.
- **Carried `on insert` checks** judge the inserted values, including the old key value if the CHECK reads `new.id`. That matches § 7.4.1 ("judges the inserted values").
