description: Make a maintained-table rename + backing-module move in the same `apply schema` cooperate instead of emitting conflicting DDL. The module-move drop+recreate must target the NEW (declared) name while the table RENAME primitive is preserved (so dependents retarget), turning the current hard "already exists" apply failure into a clean rename-then-recreate-in-place.
files:
  - packages/quereus/src/schema/schema-differ.ts          # module-migration branch in computeSchemaDiff table loop (~line 475-491); diff.renames bulk push (~line 385); orderDropsByFKDependency (~line 2316); generateMigrationDDL RENAME/DROP/CREATE ordering (~line 2360/2384/2399)
  - packages/quereus/test/declarative-equivalence.spec.ts # MV describe block — add regression test near the backing-module-move tests (~line 1447-1640)
difficulty: medium
prereq:
----

# Implement: maintained-table rename + backing-module move cooperate in one apply

## Problem

A maintained table that is BOTH renamed (via a `quereus.previous_name` hint) AND has
its backing module moved in the same `apply schema` emits conflicting migration DDL:

```
ALTER TABLE mv RENAME TO mv2      -- mv2 now exists
DROP TABLE IF EXISTS mv           -- no-op: mv was just renamed away
create materialized view mv2 …    -- FAILS: "Materialized view 'main.mv2' already exists"
```

`computeSchemaDiff` records BOTH a table rename (`mv→mv2`, pushed in bulk into
`diff.renames` before the table loop, `schema-differ.ts:385`) AND a module-move
drop+recreate. The module-migration branch (`schema-differ.ts:475-491`) adds the
**actual/OLD** name to `dropSet` (`dropSet.add(matchedActual.name…)`) and pushes the
recreate under the **new** name — but it does not account for `matchedActual` being a
*rename* match. At apply the rename lands first, so `DROP mv` is a no-op and
`CREATE mv2` collides.

## Resolution: option (a) — cooperate (rename retargets, recreate-in-place under new name)

Investigation confirms this is the smaller, correct fix (NOT the heavier redesign the
fix ticket feared, and preferable to option (b) reject-at-diff):

1. **Keep the table RENAME op.** Dependent views over the renamed maintained table are
   reconciled via `tableRenames.renames` and deliberately NOT recreated on a pure
   source-rename (`reconciledDeclaredViewDefinition`, `schema-differ.ts:562-563`); they
   rely on the `ALTER TABLE … RENAME` primitive to retarget their stored definition in
   the catalog. Removing the rename strands them. So the rename must stay.

2. **Drop the NEW (declared) name, not the old.** In the module-migration branch, when
   the match is a rename (`matchedActual.name.toLowerCase() !== name`), add the
   **declared** key `name` to `dropSet` instead of `matchedActual.name`. The recreate
   already renders under `name`.

Resulting DDL (correct):

```
ALTER TABLE mv RENAME TO mv2          -- dependents retargeted to mv2
DROP TABLE IF EXISTS mv2              -- drop the just-renamed live incarnation
create materialized view mv2 using mem2() …  -- recreate under new name + new module
```

### Why this is safe (verified during fix research)

- **No cascade-drop / RESTRICT block on dependent views.** `dropTable`
  (`manager.ts:1281+`) and `dropMaintainedTable` (`materialized-view.ts:dropMaintainedTable`)
  guard only **inbound FKs** (`assertNoReferencingChildrenForDrop`), not dependent
  views. View bodies resolve lazily at plan time, so the momentary window between
  `DROP mv2` and `CREATE mv2` does not error — the dependent view `v` (retargeted to
  `mv2` by the rename) resolves cleanly once `mv2` is recreated under the same name.
- **Orphan-drop loop does not double-drop the old name.** `mv` is in
  `tableRenames.consumedActuals`, so the orphan loop (`schema-differ.ts:519-522`) skips
  it — `dropSet` ends up with only `mv2`.
- **`orderDropsByFKDependency` tolerates a name absent from `actualTables`**
  (`schema-differ.ts:2328` `if (table)` guard) — the new name `mv2` is not in the actual
  catalog and simply contributes no FK edges. No change needed there.
- **DDL ordering already correct:** renames run first (`schema-differ.ts:2360`), then
  table drops (`:2384`), then creates (`:2399`). After the rename, `mv2` exists, so
  `DROP TABLE IF EXISTS mv2` succeeds, then the recreate runs.
- **Existing non-rename module-move test is unaffected** (`declarative-equivalence.spec.ts:1472`
  asserts `tablesToDrop === ['mv']`): for a non-rename match `name === matchedActual.name`,
  so the dropped name is identical under old and new logic.

### Scope note for the implementer

The branch currently `continue`s after handling the module migration, so the existing
`if (matchedActual.name.toLowerCase() !== name) { alterDiff.tableName = … }` block below
it (`schema-differ.ts:492-495`) is bypassed — fine, the recreate already carries the new
name. The only behavioral change is which name lands in `dropSet`.

## Acceptance

- `apply schema … options (allow_destructive = true)` over a simultaneous
  maintained-table rename + backing-module move succeeds: the table ends up under the
  new name backed by the new module, rows re-materialized, and a dependent plain view
  over it stays intact (queryable, correct rows).
- Regression test added (see TODO) covering the confirmed repro, including a dependent
  view over the renamed+moved maintained table to pin the retargeting.
- `yarn workspace @quereus/quereus test` (or `yarn test`) green; lint clean.

## Confirmed repro (from fix stage)

```sql
declare schema main {
  table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
  materialized view mv as select id, x from t
  view v as select id, x from mv            -- dependent
}
apply schema main;
insert into t values (1,10),(2,20);

declare schema main {
  table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
  materialized view mv2 using mem2() as select id, x from t
    with tags ("quereus.previous_name" = 'mv')
  view v as select id, x from mv2
}
apply schema main options (allow_destructive = true);
-- BEFORE fix: Error: Materialized view 'main.mv2' already exists
-- AFTER fix: succeeds; mv2 rows = {1,10},{2,20}; v rows = {1,10},{2,20}
```

## TODO

- In `computeSchemaDiff`'s module-migration branch (`schema-differ.ts:482`), drop the
  **declared** name on a rename match: when `matchedActual.name.toLowerCase() !== name`,
  `dropSet.add(name)`; otherwise keep `dropSet.add(matchedActual.name.toLowerCase())`.
  Leave the bulk `diff.renames.push(...tableRenames.renames)` untouched (the rename op
  must survive). Update the branch comment to explain the rename-coincident case.
- Add a regression test in `test/declarative-equivalence.spec.ts` (MV describe block,
  near the existing backing-module-move tests ~line 1447-1640) mirroring the confirmed
  repro above. Register `mem2` via `new MemoryTableModule()` (see the existing tests).
  Assert at the **diff** level (`computeSchemaDiff`): `diff.renames` contains the
  `mv→mv2` table rename, `diff.tablesToDrop` deep-equals `['mv2']` (the new name), the
  recreate string matches `/create\s+materialized\s+view\s+mv2\b/i` with `mem2`, and
  `diff.maintainedModuleMigrations` records the move. Then assert end-to-end via
  `apply` + `db.eval`: `select id,x from mv2 order by id` and `select id,x from v
  order by id` both return `[{id:1,x:10},{id:2,x:20}]` after the destructive apply.
  Use the `for await (const r of db.eval(...))` row-reading pattern (see
  `declarative-equivalence.spec.ts:1614`).
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`
  (single-quote globs on Windows); fix any fallout.
