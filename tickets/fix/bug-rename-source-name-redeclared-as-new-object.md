description: A schema declaration that renames a column and also declares a new column under the old name gets a migration that never adds the new column, so "apply schema" reports success with the column missing, or fails with a confusing "not found" error.
architecture: docs/schema-rename-detection.md
files:
  - packages/quereus/src/schema/schema-differ.ts   # resolveRenames ~1051, the nameMatch branch; computeTableAlterDiff's column-add loop ~2366 reads its pairs
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Moving a name onto a new object in the same migration as renaming the old one is rare and a two-step apply works around it, so a maintainer may defer this; honouring it rather than refusing it also means checking that every later phase handles a name that changes meaning partway through a plan.
----

# A rename's old name declared again as a new object

`resolveRenames` pairs a declared name with the existing object of that name without checking whether another declared object's rename hint claims the same existing object. The declared new object is then treated as already present, so nothing creates it. Both declaration orders behave the same, because the name match does not mark the existing object as consumed and the rename does not check for a name match on the object it consumes.

## Measured on the memory backend

Column level, starting from `create table t (id integer primary key, x integer)` with one row:

```sql
declare schema main { table t { id integer primary key, y integer with tags ("quereus.previous_name" = 'x'), x integer } }
```

- The plan is only `ALTER TABLE t RENAME COLUMN x TO y`.
- The first `apply schema` succeeds and the table holds `id, y`. The declared `x` is missing and nothing reports it.
- A re-diff then gives `ALTER TABLE t ADD COLUMN x integer`, so the declaration takes two applies to reach. In this example the second apply fails on the existing row, because `x` is not null with no default.

If the declared `x` also differs from the old `x`, the plan refers to a column that the rename has moved away:

- Declaring `x integer null` adds `ALTER TABLE t ALTER COLUMN x DROP NOT NULL`, which fails with `Column 'x' not found in table 't'`.
- Declaring `x integer check (x > 1)` adds `ALTER TABLE t ADD constraint _check_x_2 check (x > 1)`, which fails with `Column not found: x`.

Table level, the same function gives the same shape. Starting from `create table a (id integer primary key)`:

```sql
declare schema main {
	table b { id integer primary key } with tags ("quereus.previous_name" = 'a')
	table a { id integer primary key, extra integer null }
}
```

The plan is `ALTER TABLE a RENAME TO b` then `ALTER TABLE a ADD COLUMN extra integer null`, which fails with `Table 'a' not found` and is restored. No apply can reach this declaration.

Views, indexes and constraints go through `resolveRenames` too, and were not measured.

## Expected

Either honour the declaration (rename, then create the new object under the freed name) or refuse it at diff time with the existing `Rename conflict` error. What must not happen is an apply that reports success while a declared column is absent.

`docs/schema-rename-detection.md` says `resolveRenames` makes "every new name absent from the actual catalog while every old name is present", which holds for rename chains but does not rule this shape out. Update that passage with the fix.

## Related

The undo of `ADD COLUMN` already predicts the right name for this shape: the seed of `UndoRenderer.constraintNamesHeld` includes the renamed column's stored `_check_x`, so a re-added `x` predicts `_check_x_2`. That matches the forward mint when the two statements are run by hand, and no plan can produce the sequence until this ticket lands.
