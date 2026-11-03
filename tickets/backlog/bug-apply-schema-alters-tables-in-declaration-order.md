description: Whether a schema can be applied can depend on the order its tables are written in. If one table gains a rule pointing at a column another table is gaining in the same migration, the apply fails when the first table is written ahead of the second.
architecture: docs/schema.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # generateMigrationPlan, the per-table alter loop over diff.tablesToAlter
  - docs/schema.md   # Migration Order
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The failure is clean and restored, and writing the referenced table first works, so a maintainer may defer this; ordering the alters by dependency or splitting the alter block into cross-table phases is real planner work, and any new order also has to unwind correctly in reverse.
----

# Apply schema alters tables one at a time, in declaration order

The plan runs all of one table's alters before the next table's, in declaration order. `ALTER` validates what it refers to, so a table written ahead of the one it refers to is refused when the referenced column is being added in the same migration.

Over applied `t (id integer primary key, b integer null)` and `u (id integer primary key, y integer null)`, on memory at HEAD 3f2606d87:

```sql
declare schema main {
	table u { id integer primary key, y integer null, constraint fu foreign key (y) references t(d) }
	table t { id integer primary key, b integer null, d integer null unique }
}
apply schema main;
```

```
Failed to execute DDL: ALTER TABLE u ADD constraint fu foreign key (y) references t(d)
Error: Referenced column 'd' not found in table 't'
```

The same refusal, with the same forward order, comes from three other spellings on `u`:

- a CHECK subquery: `constraint cu check (y > (select max(d) from t))` gives `Column not found: d`
- an inline foreign key: `z integer null references t(d)`
- a DEFAULT subquery: `z integer null default ((select max(d) from t))` gives `Column not found: d`

The catalog was restored in all four. Writing `t` ahead of `u` applied in the foreign-key form, the only form run that way.

The run that produced these also declared a `t` constraint that would have failed later, but `u`'s step failed first and comes from plan order alone.

Expected: the end state is reachable, so a declarative schema applies whichever order its tables are written in.

This is the alter-to-alter sibling of `bug-apply-schema-creates-views-before-added-columns`, which is about the separate view-create phase and would not fix this.
