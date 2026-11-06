description: Adding a FOREIGN KEY inside a transaction only checks the rows the transaction can see, so a rollback can bring back a child row with no parent (or remove the parent a child needs) under the surviving constraint. The statement should also check every state a rollback could restore, pairing child and parent at the same rollback point, and refuse as retryable when one would break the rule.
prereq: check-constraint-judges-rollback-states
architecture: docs/module-authoring-transactions.md#ddl-inside-an-open-transaction
files:
  - packages/quereus/src/schema/constraint-builder.ts  # validateForeignKeyOverExistingRows — the shared engine scan both module arms call
  - packages/quereus/src/vtab/memory/layer/manager.ts  # addForeignKeyConstraint (skips validation when restoring)
  - packages/quereus-store/src/common/store-module-alter.ts  # alterAddConstraint foreignKey arm (skips validation when restoring)
  - packages/quereus/src/runtime/emit/add-constraint.ts  # runAddConstraintViaModule: pre-dispatch FK checks
  - packages/quereus/src/runtime/emit/alter-table.ts  # runAddColumn re-drives inline `references` through the addConstraint arm
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # the other caller of validateForeignKeyOverExistingRows
  - packages/quereus/src/vtab/rollback-states.ts
  - packages/quereus/test/logic/41.2.4-ddl-rollback-states.sqllogic
difficulty: hard
repro: verified
----

# A new FOREIGN KEY must hold in every state a rollback could restore

## The bug

Same class as `check-constraint-judges-rollback-states` (read it first: it adds the `restorableRowStates` module hook and the statement-scoped row-source override this ticket reuses). Verified on the memory backend and under `yarn test:store`:

```sql
pragma foreign_keys = true;
create table p (id integer primary key);
create table c (id integer primary key, pid integer null);
insert into p values (1);
insert into c values (1, 99), (2, 1);
begin;
delete from c where id = 1;
alter table c add constraint fk foreign key (pid) references p (id);  -- accepted; should be BUSY
rollback;
select * from c;  -- row 1 is back, an orphan under the surviving constraint
```

`validateForeignKeyOverExistingRows` runs `select 1 from <child> as _c where <fk cols not null> and not exists (select 1 from <parent> as _p where <match>) limit 1` over the effective rows only.

## Pairing child and parent

A rollback moves both tables to the same point, so a child's state must be judged against the parent's state at that same point, not against the parent's current rows. Judging against the current parent is wrong in both directions:

- missed violation: committed child row `(x, 5)` with no committed parent 5; the transaction inserts parent 5; the effective scan passes; rollback removes parent 5 and leaves the orphan. Here the child has no open work at all — only the parent does.
- false refusal: the transaction deletes parent 1 and its child row; rollback restores both together, which is consistent.

Rule: the rollback points are the whole-transaction rollback plus each open savepoint depth, from either table's `RestorableRowStates`. For each point, scan with the child's rows at that point and the parent's rows at that point, where a table with no states (hook returns undefined, or the module has no hook) contributes its current rows — no override for it. Both overrides go into one statement's `_rowSourceOverrides`, so the existing SQL is reused as is. A self-referencing FK has one table and one override, which reads parent and child from the same state, as it should. Skip a point whose two sides are both the current rows (that is the effective scan). An absent parent table needs no parent override (any fully non-NULL child row is an orphan at every point).

## Where the pass goes

Inside `validateForeignKeyOverExistingRows`, after its effective scan, through `judgeRestorableStates`. Reasons:

- Both module arms (memory `addForeignKeyConstraint`, store `alterAddConstraint`) already call it after their own preparation, and already skip it when `restoring` is set — the undo of a dropped constraint during a failed `apply schema` (`SchemaChangeInfo` `restoring`, docs/schema-undo-plan.md § Guards during an unwind). Putting the pass inside the helper covers that exemption in both arms with no new flag. Verify the store arm's `!change.restoring` gate still wraps the call.
- The effective scan stays first, so a visible orphan keeps `CONSTRAINT`.
- `add column … references` reaches it through the same arm.
- The `foreign_keys` pragma gate already at the top of the helper covers the new pass.

The hook is read-only and takes no latch, so calling it from inside the memory module's `addConstraint` latch is safe; by then `ensureSchemaChangeSafety` has drained, so committed head and base coincide. Resolve each table's hook from its catalog module (`requireVtabModule`), which is the isolation wrapper under `test:store`, not the store underneath.

The materialized-view derivation caller (`materialized-view-helpers.ts`) validates a derived image it built, not rows a rollback restores; give the helper an option so that caller does not run the pass, unless reading it shows its rows can roll back the same way.

`ddl` for the refusal: `add constraint <name> foreign key` (or `add foreign key` when unnamed); for the add-column path, `add column <name>`.

## Expected behavior

- A visible orphan keeps `CONSTRAINT`.
- An orphan that only exists at a rollback point (child row restored, or parent row removed, by `rollback` or `rollback to` an open savepoint) refuses with `BUSY`, leaving table, catalog and transaction untouched; `commit` followed by the same statement then lands it or fails with `CONSTRAINT`.
- Deleting a parent and its children together in the transaction does not block.
- No extra scans when neither table has open work.

## TODO

- Add the restorable-state pass to `validateForeignKeyOverExistingRows` with point pairing across child and parent, via the prereq's hook and row-source override; add the opt-out for the materialized-view caller.
- Confirm both module arms still skip the whole helper when `restoring` is set.
- Extend `test/logic/41.2.4-ddl-rollback-states.sqllogic`: deleted committed orphan (BUSY, rollback shows it, delete+commit then lands); parent inserted in the transaction rescuing a committed orphan (BUSY); parent and child deleted together (lands); orphan only at an open savepoint (BUSY); self-referencing FK; visible orphan (CONSTRAINT). One case per behaviour.
- Update docs/module-authoring-transactions.md, docs/memory-table.md rule 1 and docs/store.md to list `add constraint … foreign key` and describe the pairing rule.
- `yarn build`, `yarn test`, `yarn test:store`, `yarn lint`.
