description: When two existing tables each gain a foreign key to the other, and only one of those keys needs a brand-new column, the schema applies if the tables are written in one order and fails in the other, even though a working order exists.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # recordCrossTableReads, collectColumnDefReads, pushTableAlters
  - packages/quereus/src/schema/dependency-order.ts   # orderDependenciesFirst ignores every edge inside a cycle
  - docs/schema-declarative.md   # Migration Order, known limit "A cycle that exists only between tables"
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: The failure names the missing column and restores the catalog, and declaring either key as a named table-level foreign key applies in both orders, so a maintainer may keep this as a documented limit rather than add column-level ordering data to the plan.
----

# A cycle that exists only between tables still depends on the written order

Starting from `t (id integer primary key, b integer null)` and `u (id integer primary key, y integer null)` on the memory module:

```sql
declare schema main {
	table t { id integer primary key, b integer null, d integer null references u(z) }
	table u { id integer primary key, y integer null, z integer null references t(id) }
}
apply schema main;
```

```
Failed to execute DDL: ALTER TABLE t ADD COLUMN d integer null references u(z)
Error: Referenced column 'z' not found in table 'u'
```

Writing `u` first applies, and a re-diff is empty. `t.d` needs the new `u.z`, while `u.z` only names `t.id`, which already exists, so running `u`'s `ADD COLUMN` first always works.

The plan orders `ADD COLUMN` steps per table. Each table here refers to the other, so the sort sees a cycle, ignores both edges and keeps the written order.

## Expected behaviour

This declaration applies whichever table is written first, as the Migration Order section promises when some order of the plan's steps can reach the end state. A real cycle, where each new column names the other's new column, still fails in every order.

## What a fix has to keep

Ignoring the edge whenever the parent already has the named column is not enough. An `ADD COLUMN` with a foreign key and a default validates the current rows under the parent column's collation as it stands. Over a row `t.d = 'abc'`, this statement fails until `t.d` is `nocase`:

```sql
alter table u add column z text null default 'ABC' references t(d);
```

Today the edge runs `t`'s `SET COLLATE` first, so that declaration applies in both orders. It must keep doing so.

`diff schema` plans with no catalog, so any extra ordering data has to travel on `TableAlterDiff`.
