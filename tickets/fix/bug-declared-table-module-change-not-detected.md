---
description: Changing the storage module named on an existing table in a schema declaration does nothing and reports nothing, so the table stays on its old module while the declaration claims otherwise.
architecture: docs/sql-ddl.md#diffing-and-applying
files:
  - packages/quereus/src/schema/schema-differ.ts   # computeTableAlterDiff, backingModuleDrifted
  - docs/sql-ddl.md                                # the allow_destructive bullet and the plain-table bullet after it
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Moving a plain table between modules has no in-place primitive and has to copy or drop its rows, so honoring the change needs a destructive-change decision, and declining to do so and only reporting the mismatch may be enough.
---

# Declared module change on a plain table is not detected

## Observed

With a second module registered (`db.registerModule('mem2', new MemoryTableModule())`):

```sql
declare schema main { table t (id integer primary key) using memory }
apply schema main;
-- table t is on memory

declare schema main { table t (id integer primary key) using mem2 }
diff schema main;   -- returns no rows
apply schema main;  -- succeeds; table t is still on memory
```

The leading form (`table t using mem2 () (…)`) behaves the same way, and was already this way before the trailing form was honored.

## Expected

A declaration is the desired end state, so a table whose declared module differs from its live module must not pass silently. `diff schema` should show the mismatch, and `apply schema` should either carry it out or refuse with an error.

## Where

`computeTableAlterDiff` only compares modules through `backingModuleDrifted`, and only when both sides are maintained tables. That path already handles this for maintained tables: it treats the move as destructive and requires `options (allow_destructive = true)`. A plain table has no equivalent branch.

A declaration with no `using` needs a defined meaning here: it may mean the schema's `default_vtab_module`, or "whatever the table is on now". The comparison also has to treat module arguments the same way, since a table could keep its module and change its arguments.
