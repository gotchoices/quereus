description: When "apply schema" fails partway after adding a column that carries its own CHECK rule, the automatic rollback cannot remove that column, so the database is left half-migrated with an error saying it could not be restored.
architecture: docs/schema-undo-plan.md
files:
  - packages/quereus/src/schema/schema-differ.ts   # UndoRenderer.dropAddedColumn (~3411) — undo of ADD COLUMN is a bare DROP COLUMN
  - docs/schema-undo-plan.md                       # undo table row for ADD COLUMN (~line 24)
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Only bites when a later step of the same apply already failed, so the user is already looking at an error; but the result is a partially migrated schema the engine says it cannot restore.
----

# Undo of ADD COLUMN fails when the added column has an inline CHECK

The migration undo for `ALTER TABLE t ADD COLUMN d … check (d > 0)` is `ALTER TABLE t DROP COLUMN d` (`UndoRenderer.dropAddedColumn`). The engine refuses to drop a column a CHECK references — including the column's own inline CHECK — so the undo itself fails.

## Repro (memory, HEAD ad2a8add8)

```sql
declare schema s { table t { id integer primary key, b integer null } }
apply schema s;
insert into s.t values (1, 1), (2, 1);
declare schema s { table t { id integer primary key, b integer null, d integer null check (d > 0), constraint ub unique (b) } }
apply schema s;
```

Observed:

```
Failed to execute DDL: ALTER TABLE s.t ADD constraint ub unique (b)
Error: UNIQUE constraint failed: t (b)
The schema is partially migrated and could not be restored: undo statement `ALTER TABLE s.t DROP COLUMN d` failed (Cannot drop column 'd' from 't': it is referenced by CHECK constraint '_check_d').
```

Afterwards `t` has columns `id, b, d` — the added column stays.

Expected: the failed apply restores `t` to `id, b`.

Likely the same for an inline named CHECK (`d integer null constraint dpos check (d > 0)`) and possibly inline FK / UNIQUE, depending on what `DROP COLUMN` refuses. Fix direction (not decided): the undo of an ADD COLUMN drops the constraints its inline clauses created (by their stored names — `_check_<col>` etc., which the undo renderer would need to predict or read back) before the DROP COLUMN, mirroring the engine's own `revertAddColumn` in `runtime/emit/alter-table.ts`.
