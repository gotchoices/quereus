description: A foreign-key or cross-table CHECK that waits until commit is checked against the row as it was first written, so a transaction that later deletes or corrects that row still fails at commit with a violation that no longer exists. Make commit check only rows that still exist, using their latest values.
architecture: docs/sql-constraints.md#76-foreign-key-constraint
files: packages/quereus/src/runtime/deferred-constraint-queue.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/core/database.ts, packages/quereus/src/runtime/row-constraints.ts, packages/quereus/src/core/derived-row-validator.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/foreign-key-builder.ts, packages/quereus/src/util/key-tuple-codec.ts, packages/quereus/test/logic/41.11-deferred-fk-with-rename.sqllogic, packages/quereus/test/logic/43.2-deferred-check-new-on-delete.sqllogic, docs/sql-constraints.md, docs/runtime.md
repro: verified
----
## The fault

Two kinds of row check wait until COMMIT: the child-side foreign-key existence check on INSERT/UPDATE (docs/sql-constraints.md § 7.6) and row-level CHECKs that read other tables (§ 7.4.1). `row-constraints.ts` (`checkCheckConstraints`) and `derived-row-validator.ts` (`validateDerivedRowImage`) hand each one to `Database._queueDeferredConstraintRow`, and `DeferredConstraintQueue.enqueue` stores a copy of the flat OLD|NEW row with it. `runDeferredRows` evaluates every stored copy at commit. Nothing connects a stored copy to what later happens to its row, so:

- a row deleted later in the transaction is still checked, and its foreign key to a parent the same transaction deleted fails;
- a row corrected later in the transaction (repointed from a missing parent to a real one) is still checked with its first values and fails.

Reproductions, all failing on commit 83d52e2 with `pragma foreign_keys = true`, each expected to pass:

| Case | Statements |
|---|---|
| A | `Entity(id pk, component_id references Entity(id) on delete cascade)`, `Line(entity_id pk references Entity(id) on delete cascade, path_id references Entity(id) on delete set null)`; `insert into Entity values (1, null), (2, 1), (3, 1); insert into Line values (3, 2); delete from Entity where id = 1` → `_fk_Line_entity_id` |
| C | `Entity(id pk, component_id references Entity(id), name)` with (1, null), (2, 1); `begin; update Entity set name = 'x' where id = 2; delete from Entity where id in (2, 1); commit` |
| D | same table with (1, null); `begin; insert (2, 1); delete id 2; delete id 1; commit` |
| F | `begin; insert (2, 99); update Entity set component_id = 1 where id = 2; commit` (1 exists, 99 does not) |
| G | `begin; insert (2, 99); delete id 2; commit` |
| H | `P(id pk)`, `C(id pk, p, constraint has_p check (exists (select 1 from P where P.id = new.p)))`, P has 1; `begin; insert into C values (1, 1); delete C 1; delete P 1; commit` |

Case B (case A with `insert into Line values (2, 3)`) passes today and must keep passing. In case A, the `set null` action updates `Line (3, 2)` to `(3, null)` before the cascade from deleting `Entity 3` removes that row, and the UPDATE queued a check for `entity_id` even though it didn't assign that column.

## Design

### Rule

At commit, a check queued by an INSERT or UPDATE concerns the row's state, not the write that queued it:

- If the row does not exist when the transaction commits, the check is dropped. A deleted row references nothing.
- If the row exists, only the most recently queued check of each constraint for that row is evaluated. The update that changed the row queued its own check with the newer values. Earlier copies are stale.

Checks queued by a DELETE (`check on delete`, see 43.2-deferred-check-new-on-delete.sqllogic) concern the delete itself. They are evaluated as today, never dropped or replaced, including when the same key is inserted again later. That settles the open question in the fix ticket. Record it in § 7.4.1.

"The row" means table plus primary key. Primary-key values are encoded with `encodeKeyTuple` (util/key-tuple-codec.ts), the codec the change log keys by, so the two agree on identity.

### Whether the row exists: read the transaction's change log

`TransactionManager` already keeps a change log (`changeLog` + `changeLogLayers`, database-transaction.ts) mapping `schema.table` (lowercased) → encoded primary key → net change (`insert` / `update` / `delete`). `mergeRecordInto` folds repeated writes to one key (insert then delete removes the entry; delete then insert becomes update; a primary-key-moving update records delete-old + insert-new). The layers follow savepoint rollback and release. Every successful write records into it: the DML executor's insert/update/delete/eviction/replace paths, FK actions (they run as DML), and materialized-view maintenance (`recordMaintenanceChanges`).

Use it rather than giving the queue its own tracking. A queue-side "row was deleted" marker gets the order wrong. The executor queues a row's checks before the row's write is recorded, and an UPDATE that moves a row onto a key it displaces records the displaced row's delete (dml-executor.ts, the `result.replacedRow` branch of the update path) after the moving row's check for that same key was queued. The change log's merged net result for the key (delete, then insert from the move) still says the row exists. A sequence-based marker would drop the check and let a violation through.

Lookup, as a new `TransactionManager` method (exposed to the queue through `runDeferredRows`' caller, which is `TransactionManager` itself at database-transaction.ts:392):

- walk the layers from the top (`changeLogLayers` newest first, then `changeLog`); the first layer holding the key decides: `insert` / `update` → exists; `delete` → gone;
- no layer holds the key → gone. A queued INSERT/UPDATE check whose key has no net change means the row was inserted and deleted again, or its write never happened (a vtab-level IGNORE returning no row, the upsert arm resolving to a different key or to `do nothing`). In each case there is no row to check, so this also fixes those shapes.

When the change log misses a write, the result is today's behavior (the check runs), never a missed violation. One example: an ingested external delete with `captureChanges` off (database-external-changes.ts) doesn't record. The ingestion path queues no row checks of its own.

### Table name across a rename

The change log is not renamed by `alter table … rename to`; the queue's buckets are (`notifyTableRename`). So each keyed entry stores the table key it was queued under, which is the key the change log recorded that write under. Look up by that stored key, not by the bucket. After a mid-transaction rename the worst outcome is again today's behavior: a delete recorded under the new name is not seen, and the check runs. Leave a `NOTE:` at `notifyTableRename` and at the change log's declaration. If the change log ever gets renamed on rename, the entries' stored table key must move with it, or the lookup would miss and drop a check.

### Entry shape

`DeferredConstraintRow` gains an optional row identity, set only for INSERT/UPDATE checks:

```ts
/** Set for checks queued by an INSERT or UPDATE; absent for DELETE-time checks and unkeyed callers. */
rowIdentity?: {
	/** Lowercase `schema.table` as the change log recorded the write — NOT re-pointed by renames. */
	tableKey: string;
	/** `encodeKeyTuple` of the NEW section's primary-key values. */
	primaryKey: string;
};
```

Entries without `rowIdentity` behave exactly as today. `cloneAll` must carry the field.

Where it is set:

- `row-constraints.ts` `checkCheckConstraints`: when `scope.operation` is INSERT or UPDATE, encode `tableSchema.primaryKeyDefinition` indices from the NEW section (`flatRow[numCols + index]`). `metadata.baseTable` is already `schema.table`, the same form the executor's `tableKey` uses. Compute the key once per row, not per constraint.
- `derived-row-validator.ts` `validateDerivedRowImage`: key the entry only if the table key it passes (`${validator.schemaName}.${validator.tableName}`) is the same string `recordMaintenanceChanges` records under (`backingBase`) and the key columns are the same as `plan.mv.primaryKeyDefinition`. Confirm both by reading `database-materialized-views-apply.ts:174` and its caller. If either differs, leave these entries unkeyed and add a `NOTE:` saying why.

The `_queueDeferredConstraintRow` / `enqueue` parameter lists are already eight positional arguments. Pass the new data as part of an options object instead of a ninth positional argument (fold `connectionId`, `contextRow`, `contextDescriptor` into it while there). Update docs/runtime.md § Deferred Constraints to match.

### Commit-time pass

In `runDeferredRows`, after `cloneAll` (which yields each constraint's list in queue order: base store, then layers in order, each in push order; `merge` and `adoptChecks` append, so queue order is chronological):

- per table bucket and constraint, walk the list newest first, keeping a set of seen `primaryKey` values. A keyed entry whose key was already seen is stale and skipped.
- a surviving keyed entry is skipped when the change-log lookup for `(rowIdentity.tableKey, rowIdentity.primaryKey)` says gone.
- everything else is evaluated in the original order, as now.

Keep this as small named functions (say `latestPerRow` and a row-exists predicate parameter), not inline in the loop. Pass the predicate in (`runDeferredRows(rowExists)`) so the queue does not import `TransactionManager`.

### Second change: UPDATE checks only foreign keys it assigns

`buildUpdateStmt` (update.ts:280) builds a child-side check for every foreign key of the table. A foreign key none of whose columns the UPDATE assigns keeps its values, which were valid or already queued when last written, and the parent side (RESTRICT / CASCADE / SET NULL / SET DEFAULT) covers the parent going away. SQLite also checks an UPDATE's child-side keys only when their columns change. Give `buildChildSideFKChecks` an optional set of assigned column indices and skip a foreign key whose columns are all outside it. Build the set from update.ts's `assignments`. That list already includes the implicit generated-column assignments (`isGenerated: true`), so a foreign key over a generated column whose inputs change is still checked. Leave the upsert `do update` arm (`buildUpsertUpdateValidation`, insert.ts) unfiltered. One validation there serves every `do update` clause, so it has no single assignment set. Put a `NOTE:` there.

This cuts the work of every `set null` action and keeps the queue small. The first change is what makes the cases pass. This one alone would fix only case A.

## Tests

New `packages/quereus/test/logic/41.17-deferred-check-on-superseded-row.sqllogic` (number after 41.16), each case in its own tables:

- cases A, C, D, F, G, H above: commit passes; then `select` shows the expected surviving rows (A: `Entity` and `Line` empty; F: row 2 has `component_id` 1).
- case B: passes (guards against over-dropping).
- still fails: `begin; insert (2, 99); update set name = 'x' where id = 2; commit` → `-- error: constraint` (latest check still sees 99).
- savepoint: `begin; insert (2, 99); savepoint s; update set component_id = 1 where id = 2; rollback to s; commit` → error (the rollback restores the stale-but-current copy).
- savepoint the other way: `begin; insert (2, 99); savepoint s; delete id 2; rollback to s; commit` → error.
- primary-key move: `begin; insert (2, 99); update set id = 5, component_id = 1 where id = 2; commit` → passes (old key gone, new key valid). And moving onto a displaced key with a bad parent still fails.
- rename: extend 41.11-deferred-fk-with-rename.sqllogic with insert-bad-row, rename child, delete row, commit. Record what it does: per the rename section it still fails, matching today. Assert the actual outcome and comment why, so a later change-log rename shows up here.
- delete-time checks: 43.2-deferred-check-new-on-delete.sqllogic keeps passing unchanged.

Run `yarn test` and `yarn test:store` (the store backend is where a queued check reading the wrong state shows up as a false violation; see the 41.11 header).

## TODO

- Add `rowIdentity` (and the options object) to `DeferredConstraintRow`, `enqueue`, `Database._queueDeferredConstraintRow`; carry it through `cloneAll`.
- Add the change-log lookup method on `TransactionManager` (top layer first; absent → gone) and pass it to `runDeferredRows`.
- Implement the newest-first supersession and the existence filter in `runDeferredRows` as named helpers.
- Set `rowIdentity` in `row-constraints.ts` for INSERT/UPDATE entries (NEW-section primary key, encoded once per row).
- Check the derived-row-validator table key against `backingBase` and key those entries, or leave them unkeyed with a `NOTE:`.
- `NOTE:` tripwires at `notifyTableRename` and the change-log declaration about the stored write-time table key.
- Assigned-column filter for child-side FK checks in `buildChildSideFKChecks` / `buildUpdateStmt`; `NOTE:` at the upsert arm.
- Write 41.17 and extend 41.11 as above; run `yarn test`, `yarn test:store`, `yarn lint`.
- Docs: sql-constraints.md § 7.6 child-side bullet (checked against the row as it stands at commit; a row deleted by then is not checked; UPDATE checks only keys whose columns it assigns) and § 7.4.1 (same rule for deferred CHECKs; DELETE-time checks always run; an `on insert`-only check judges the inserted values, since a later UPDATE doesn't re-queue it); runtime.md § Deferred Constraints (queue signature, commit-time pass).
