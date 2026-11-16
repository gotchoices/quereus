description: When two existing tables each gain a foreign key to the other, and only one of those keys needs a brand-new column, the schema applies if the tables are written in one order and fails in the other, even though a working order exists.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # TableAlterDiff (~line 198), computeSchemaDiff pre-pass (~line 657), computeTableAlterDiff (~line 2318), recordCrossTableReads (~line 2614), collectColumnDefReads (~line 2813), alterStageTwoItem (~line 3656), pushTableAlters doc comment (~line 3624)
  - packages/quereus/src/schema/dependency-order.ts   # orderDependenciesFirst — no change expected; its preferred tiers already do what is needed
  - packages/quereus/test/apply-schema-alter-order.spec.ts   # reproduction already added (describe "two tables referring to each other where only one needs the other's new column")
  - docs/schema-declarative.md   # Migration Order stage 2 text and the "A cycle that exists only between tables" known limit
repro: verified
----

# Order a foreign key on an existing parent column as a preference, not a requirement

## The bug

Starting from `t (id integer primary key, b integer null)` and `u (id integer primary key, y integer null)` on the memory module:

```sql
declare schema main {
	table t { id integer primary key, b integer null, d integer null references u(z) }
	table u { id integer primary key, y integer null, z integer null unique references t(id) }
}
apply schema main;
-- Failed to execute DDL: ALTER TABLE t ADD COLUMN d integer null references u(z)
-- Caused by: Referenced column 'z' not found in table 'u'
```

Writing `u` first applies. Reproduced by `apply-schema-alter-order.spec.ts` › "two tables referring to each other where only one needs the other's new column" › "applies with t written first" (currently the only failing case in that file; run with `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js packages/quereus/test/apply-schema-alter-order.spec.ts` from the repo root).

## Cause

Stage 2 of `pushTableAlters` sorts one item per altered table (its `ADD COLUMN`, `ALTER COLUMN`, constraint renames/drops and `ALTER PRIMARY KEY`, run together). Each table's `runsAfter` is `TableAlterDiff.addedColumnReads`: every table or view an added column names in an inline foreign key, DEFAULT, CHECK or generated expression (`recordCrossTableReads` → `collectColumnDefReads`). All of those are hard edges. Here `t → u` (needs new `u.z`) and `u → t` (names `t.id`) form a cycle, and `orderDependenciesFirst` drops every edge inside a cycle and keeps the written order.

The `u → t` edge is not needed for `u.z` to exist: `t.id` is already there. It is still useful: an `ADD COLUMN … default … references t(d)` validates `u`'s existing rows under `t.d`'s collation as it stands, so it should follow `t`'s `SET COLLATE` when nothing forbids it. Verified: over `t.d = 'abc'` and one `u` row, `alter table u add column z text null default 'ABC' references t(d)` fails with `FOREIGN KEY constraint failed` until `t.d` is `nocase`. The spec's "still runs the parent's SET COLLATE first" cases pin that (they pass today and must keep passing).

## Fix

Split the cross-table reads of added columns into two strengths, both decided by `computeSchemaDiff` (which has the catalog) and carried on `TableAlterDiff`, because `diff schema` plans from the diff with no catalog.

- **Required** (existing `addedColumnReads`): everything recorded today, except the case below.
- **Preferred** (new field, e.g. `addedColumnPreferredReads?: string[]`, lowercased post-rename table names, omitted when empty): an inline foreign key that names its referenced columns explicitly, where the parent is a declared table matched to an existing catalog table (by name or rename hint) and every referenced column is a column that table already has (matched by name or by a column rename hint — stage 1 has renamed it by stage 2). A table that also appears in the required set stays only in the required set.

Keep as required:
- A foreign key with no column list (`references t`): it checks the parent's primary key as it stands, and `ALTER PRIMARY KEY` runs inside the parent's stage 2 item (pinned by "a column added ahead of the key change it relies on").
- A parent whose matched table moves backing module (`maintainedModuleMigration`): it is dropped and recreated, so it is not an existing table at stage 2. Also any parent that is not in the catalog.
- DEFAULT, CHECK and generated expressions: out of scope here; they stay required as today.

Then in `alterStageTwoItem` put the preferred reads in `prefersToRunAfter` (the first preferred tier, alongside a create's named tables). `orderDependenciesFirst` already adds a preferred edge only when it closes no cycle with the required edges and earlier preferences, so:

- the bug case: required `t → u`, preferred `u → t` closes a cycle → skipped → `u` runs first in both written orders;
- the collation case: only the preferred `u → t`, no cycle → kept → `t`'s `SET COLLATE` runs first in both orders;
- a true cycle (each new column names the other's new column) is still two required edges and still fails in every order, as documented;
- the existing "applies an inline foreign key naming a renamed column when the tables also refer to each other" case becomes two preferred edges; the first table's preference wins, which still applies.

Suggested shape: in the `computeSchemaDiff` pre-pass that builds `columnRenamesByTable` (it already calls `resolveColumnRenames` per matched declared table), also build a map from declared table name (lowercased) to the set of its declared column names that are matched to existing columns (`resolveColumnRenames(...).pairs` keys), skipping tables for which `backingModuleDrifted(...)` reports a move and MV-sugar tables with no declared columns. Pass it through `computeTableAlterDiff` into `recordCrossTableReads`, and have the foreign-key branch of `collectColumnDefReads` (or a sibling the FK branch calls) route an explicit-column FK whose columns are all in that set into the preferred set. Keep the functions small; the FK routing can be its own helper.

## Docs and comments to update

- `recordCrossTableReads`: replace the "an edge is per table, not per column" `NOTE:` with a description of the preferred edge.
- `TableAlterDiff.addedColumnReads` doc and the new field's doc.
- `pushTableAlters` doc comment, stage 2.
- `docs/schema-declarative.md` § Migration Order: stage 2 text (a table follows the tables its added columns name … a foreign key naming only columns the parent already has only prefers to follow it, giving way when the other order is needed), and remove the "A cycle that exists only between tables" known-limit bullet. The "Inline references that form a cycle" bullet stays.

## TODO

- Add the preferred-read field to `TableAlterDiff` and record it in `recordCrossTableReads` from the existing-columns map built in the `computeSchemaDiff` pre-pass.
- Feed it to `prefersToRunAfter` in `alterStageTwoItem`.
- Update the comments and `docs/schema-declarative.md` as listed above.
- Run `apply-schema-alter-order.spec.ts` (all four new cases must pass), then `yarn test` and `yarn lint` from the repo root. Consider `yarn test:store` only if a store-backed logic test touching declarative FK ordering fails.
