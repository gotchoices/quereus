description: When two existing tables each gain a foreign key to the other, and only one of those keys needs a brand-new column, the schema now applies in either written order instead of failing when the tables are written in the wrong one.
architecture: docs/schema-declarative.md#migration-order
files:
  - packages/quereus/src/schema/schema-differ.ts   # TableAlterDiff.addedColumnPreferredReads, computeSchemaDiff pre-pass (existingColumnsByTable), recordCrossTableReads, collectColumnDefReads, recordForeignKeyParent, movesBackingModule, alterStageTwoItem, pushTableAlters doc
  - packages/quereus/src/schema/dependency-order.ts   # unchanged; its preferred tiers do the work
  - packages/quereus/test/apply-schema-alter-order.spec.ts
  - docs/schema-declarative.md   # Migration Order stage 2 text; removed the "A cycle that exists only between tables" known limit
repro: verified
----

# Order a foreign key on an existing parent column as a preference, not a requirement

## What changed

`apply schema` sorts stage 2 of the table alters (per table: `ADD COLUMN`, `ALTER COLUMN`, constraint renames/drops, `ALTER PRIMARY KEY`) so a table follows the tables its added columns name. Every such name used to be a hard ordering edge, so `t.d references u(z)` (needs the new `u.z`) beside `u.z references t(id)` (names the existing `t.id`) read as a cycle, the sorter dropped both edges, and written order decided: `t` first failed with `Referenced column 'z' not found in table 'u'`.

Now an added column's inline foreign key that **lists its referenced columns** and whose columns the parent **already has** (matched by name or by a column rename hint, since `RENAME COLUMN` runs in stage 1) makes a *preferred* edge, carried on the new `TableAlterDiff.addedColumnPreferredReads` and fed to `prefersToRunAfter` in `alterStageTwoItem`. `orderDependenciesFirst` adds a preferred edge only when it closes no cycle, so:

- bug case: required `t → u` plus preferred `u → t` → the preference is skipped → `u` runs first in both written orders;
- collation case (`u.z text default 'ABC' references t(d)` while `t.d` gains `collate nocase`): only the preferred edge, no cycle → kept → `t`'s `SET COLLATE` still runs first;
- a true cycle (each new column names the other's new column) stays two required edges and still fails in every order (documented known limit, unchanged).

Still required (unchanged behaviour): a foreign key with no column list (`references t`, it checks the parent's primary key as it stands, which the parent's own `ALTER PRIMARY KEY` may change); a parent that is not a matched existing table; a parent being dropped and recreated by a backing-module move (`movesBackingModule`, excluded when the existing-columns map is built); DEFAULT, CHECK and generated expressions. A table named both ways stays only in the required set.

The existing-columns map (`existingColumnsByTable`: declared table name → its declared columns that match existing ones) is built in the same `computeSchemaDiff` pre-pass that already calls `resolveColumnRenames` per matched table, and threaded through `computeTableAlterDiff` → `recordCrossTableReads` → `collectColumnDefReads` → `recordForeignKeyParent`. It is decided at diff time because `diff schema` plans with no catalog.

## Tests

- `apply-schema-alter-order.spec.ts` › "two tables referring to each other where only one needs the other's new column" — the four cases were added by the fix stage as the reproduction; "applies with t written first" failed before and passes now; the two "still runs the parent's SET COLLATE first" cases pin that the edge is a preference, not removed.
- Changed `› "applies an inline foreign key naming a renamed column when the tables also refer to each other"`: with the fix, both of its foreign keys named existing columns and became preferences, so `t` ran first and the test no longer depended on `RENAME COLUMN` running ahead of every `ADD COLUMN`. `t.x` now references a new `u.w`, which makes `t → u` required, so `u` runs first and `u.z references t(b2)` again needs the stage-1 rename. Comment updated to match.
- No new tests beyond that.

Validation: the spec file (44 passing), `yarn test` (all workspaces green), `yarn lint` (exit 0). `yarn test:store` not run — no store-backed test failed and nothing store-specific changed.

## Known gaps / things to look at

- Recorded as a `NOTE:` on `recordForeignKeyParent`: when the preferred edge gives way to a cycle, the child's `ADD COLUMN … references t(d)` validates its existing rows against `t.d` before `t`'s `SET COLLATE` / `SET DATA TYPE` runs. No order satisfies both there without splitting the parent's stage 2 steps; before this change the same declaration either failed outright or depended on written order.
- Alter preferences share the first preferred tier with a new view's / maintained table's preference for the tables its body names, and alters are added first. A preferred alter edge can therefore block a create's preference in a three-way cycle (table → table → view → table). I reasoned that every such case already resolved the same way when the alter edge was required, so there should be no regression, but I did not write a test for it.
- The parent's referenced columns being UNIQUE/PK is not considered: `resolveReferencedColumns` (`schema/table.ts`) resolves explicit column lists by name only, so the ordering does not depend on the parent's key for that form.
