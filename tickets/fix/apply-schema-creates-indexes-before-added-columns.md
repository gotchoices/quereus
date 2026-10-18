description: A schema change that adds a column and an index on that column in the same "apply schema" fails, because the migration plan creates the new index before it adds the column. Hosts must split such a change across two schema versions.
architecture: docs/schema.md#migration-order
files: packages/quereus/src/schema/schema-differ.ts (`generateMigrationPlan` ~3166: `pushCreates(diff.indexesToCreate, 'index')` ~3236, the alter block ~3240, the "Assertion creates LAST" push ~3379), packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/apply-schema-restore.spec.ts (declared-index pattern ~224), docs/schema.md ("Migration Order" ~565-580)
difficulty: easy
repro: verified
----

# apply schema creates indexes before the columns it adds

Reported from Optimystic (`blocked/quereus-apply-schema-creates-indexes-before-added-columns`, found while adding catalog-only ADD COLUMN for Sereus control-schema migrations, gotchoices/sereus#46). Optimystic documents the two-version workaround in its plugin README; Sereus's migratability spec has to refuse the combination until this lands.

## Reproduction

Verified against the memory module at `ccf14a8b7` (v4.20.2):

```sql
declare schema main { table t { id integer primary key } }
apply schema main;
insert into t (id) values (1);
declare schema main { table t { id integer primary key, b text null } index t_b on t (b); }
apply schema main;
-- Failed to execute DDL: create index t_b on t (b)
-- Error: Column 'b' not found in table 't'
```

Applying the column in one version and the index in the next succeeds.

## Cause

`generateMigrationPlan` emits renames, drops, then `pushCreates` for tables, views and **indexes**, and only then the per-table alter block (`RENAME COLUMN` → `ADD COLUMN` → … → `DROP COLUMN`). An index on a column the same plan adds runs before that column exists. By the same order, an index declared on a column the plan renames is created under the new name before `RENAME COLUMN` runs (static; not run).

Assertion creates were already moved after the alter block for this reason. Index creates were not.

## Fix

Move `pushCreates(diff.indexesToCreate, 'index')` after the alter block and the maintained re-attaches, next to the assertion creates. Nothing in the alter block depends on a new index existing. `DROP INDEX` stays early, so a version that removes an index together with its column keeps working. A create's undo is a drop, so the undo journal is unaffected by where the step sits.

Rejected: splitting index creates into "on existing columns" (early) and "on added or renamed columns" (late). It adds a classification with no ordering benefit.

## TODO

- Move the index create push in `generateMigrationPlan`; update the comment beside it and the "Assertion creates LAST" comment so both name the reason.
- Test: one `apply schema` that adds a nullable column and an index on it succeeds, the index is used/maintained, and existing rows read back.
- Test: one `apply schema` that renames a column (with a rename hint) and adds an index on the new name succeeds.
- Test: a forced failure after the moved index create restores the pre-apply catalog (pattern in `apply-schema-restore.spec.ts`).
- Update `docs/schema.md` → "Migration Order": the list still says creates come third and alters last. State that index and assertion creates run after the alter block, and why.
