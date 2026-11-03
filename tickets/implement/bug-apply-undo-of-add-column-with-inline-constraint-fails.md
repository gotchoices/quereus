description: When "apply schema" fails partway after adding a column that carries its own CHECK rule, the automatic rollback cannot remove that column, so the database is left half-migrated. The rollback must remove the column's CHECK rules first.
architecture: docs/schema-undo-plan.md
files:
  - packages/quereus/src/schema/schema-differ.ts   # UndoRenderer.dropAddedColumn (~3570) and its one call site (~3198)
  - packages/quereus/src/schema/constraint-builder.ts   # extractColumnLevelCheckConstraints, the forward path's name mint
  - packages/quereus/src/schema/table.ts   # collectDeclaredConstraintNames, shiftSchemaIndicesForDrop
  - packages/quereus/src/runtime/emit/alter-table.ts   # runAddColumn (taken-name set ~736), revertAddColumn (~1057, comments to correct)
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # add the both-backends repro
  - packages/quereus/test/schema/differ-undo-plan.spec.ts   # add the name-prediction case
  - docs/schema-undo-plan.md   # undo table row for ADD COLUMN (~line 24)
repro: verified
----

# Undo of ADD COLUMN must drop the column's inline CHECKs first

## The defect

The undo the planner records for `ALTER TABLE t ADD COLUMN d … check (d > 0)` is only `ALTER TABLE t DROP COLUMN d` (`UndoRenderer.dropAddedColumn`). `DROP COLUMN` refuses a column a CHECK names (`assertNoCheckConstraintNamesColumn`), and that includes the column's own inline CHECK, so the undo statement itself fails.

Repro on memory at HEAD c78d2229a:

```sql
declare schema main { table t { id integer primary key, b integer null } }
apply schema main;
insert into t values (1, 1), (2, 1);
declare schema main { table t { id integer primary key, b integer null, d integer null check (d > 0), constraint ub unique (b) } }
apply schema main;
```

```
Failed to execute DDL: ALTER TABLE t ADD constraint ub unique (b)
Error: UNIQUE constraint failed: t (b)
The schema is partially migrated and could not be restored: undo statement `ALTER TABLE t DROP COLUMN d` failed (Cannot drop column 'd' from 't': it is referenced by CHECK constraint '_check_d').
```

Expected: the apply's own UNIQUE error alone, and `t` back to `id, b`.

## Which inline kinds are affected (ran each one)

The failing step was always a later `ADD constraint ub unique (b)` over duplicate rows.

| column declaration | memory | store |
| --- | --- | --- |
| `check (d > 0)` | not restored | not restored |
| `constraint dpos check (d > 0)` | not restored | not run |
| `check (d > 0) check (d < 100)` | not restored | not run |
| `check (d > b)` (names another column too) | not restored | not run |
| `unique check (d > 0) references p(id)` | not restored | not run |
| `references p(id)` | restored | restored |
| `constraint dfk references p(id)`, `references t(id)` | restored | not run |
| `constraint du unique` | restored | restored |
| `unique` | restored | not run |
| plain, `generated always as (b + 1)` | restored | not run |

So only CHECK needs a change. `shiftSchemaIndicesForDrop` (`schema/table.ts`), which both modules call from `dropColumn`, already removes a UNIQUE or foreign key over the dropped column. CHECK is not removed there, which is why the guard exists.

## Correction

`dropAddedColumn` already parses the column definition. It should also work out the name each inline CHECK was stored under and emit one `DROP CONSTRAINT` per CHECK before the `DROP COLUMN`. Run by hand on memory, `drop constraint` for each CHECK followed by `drop column` returned the restore fingerprint to its pre-add value, on a column that also declared a UNIQUE and a foreign key.

The undo stays plain SQL text computed at plan time (see the doc's opening section), so the name has to be predicted, not read back. Predict it with the same code the forward path uses, so the two cannot drift. `runAddColumn` does:

```ts
const inlineTakenNames = collectTableConstraintNames(tableSchema);
for (const declared of collectDeclaredConstraintNames([columnDef], undefined)) inlineTakenNames.add(declared);
const inlineChecks = extractColumnLevelCheckConstraints(columnDef, inlineTakenNames);
```

The renderer does the same over a taken-name set it keeps per table:

- Seed it on first use from the pre-apply catalog through `tableNow(table)`: every `namedConstraints[].name` and every defined `unnamedConstraints[].name`, lowercased. Nothing ahead of `ADD COLUMN` changes a table's constraint names (constraint renames, drops and adds all come after it in the phase order, `schema-differ.ts` ~3177), so the pre-apply names are the live ones.
- Keep the set across calls for that table, because each later `ADD COLUMN` in the plan sees the constraints the earlier ones installed. The mint registers its own results in the set. `collectDeclaredConstraintNames` covers user-written inline names of any class.
- `dropAddedColumn` needs the table's current name as a new argument (`alter.tableName`) for the lookup.

Measured behaviour the prediction has to match (memory, by running it):

- A column rename does not change a stored auto-name: after `rename column x to y` the CHECK is still `_check_x`, and a re-added `x` with a CHECK mints `_check_x_2`.
- A user constraint named `_check_d` pushes new mints to `_check_d_2`, `_check_d_3`.
- An earlier column's `constraint _check_d unique` pushes the mint to `_check_d_2`.
- A `create unique index _check_d` also pushes the mint to `_check_d_2`, because the UNIQUE it derives counts as taken but is left out of the catalog's constraint lists. `CatalogIndex` has no unique flag. Do not chase this one: the undo would then fail on a wrong name and the apply reports "not restored", which is honest. Park it as a `NOTE:` at the seed site.

`schema-differ.ts` does not import `constraint-builder.ts` today, and that module pulls in planner analysis code. Check that the new import creates no load-order problem. If it does, move `extractColumnLevelCheckConstraints` somewhere lighter rather than duplicating the mint.

## TODO

- Change `UndoRenderer.dropAddedColumn` and its call site as above, with the `DROP CONSTRAINT` statements first (newest first, mirroring `revertAddColumn`).
- Add a section to `50.4-declare-schema-apply-restore.sqllogic`, which runs on both backends: an added column with an unnamed CHECK, a named CHECK and an inline UNIQUE, followed by a failing `ADD constraint`. Assert the original error, the rows without the column, and that re-diffing reproduces the plan.
- Add one case to `differ-undo-plan.spec.ts` pinning the name prediction: a table with an existing `_check_d`, an added column with two unnamed CHECKs, expecting drops of `_check_d_3`, `_check_d_2`, then the column.
- Update the `ADD COLUMN` row of the table in `docs/schema-undo-plan.md`.
- Correct the comments in `alter-table.ts` that say modules do not prune a foreign key over a dropped column (inside the install loop ~954 and `revertAddColumn`'s doc comment ~1032; the comment at ~895 only describes which names are tracked, so check it reads correctly afterwards). `shiftSchemaIndicesForDrop` filters foreign keys over the column. Only the comments change; the explicit by-name drop in `revertAddColumn` stays harmless.
- Run `yarn test`, `yarn test:store` and `yarn lint` in `packages/quereus`.
