description: A maintained table that is BOTH renamed (via a rename hint) AND has its backing module moved in the same `apply schema` produces conflicting migration DDL (`ALTER TABLE old RENAME TO new; DROP TABLE old; CREATE … new`) that fails at apply with "already exists". The two destructive transitions (rename + module-move drop+recreate) both try to own the name transition. Surfaced reviewing `maintained-table-backing-module-migrate`.
files:
  - packages/quereus/src/schema/schema-differ.ts          # computeSchemaDiff table loop (module-move branch ~line 475-490); diff.renames push ~line 385; view reconcile uses tableRenames.renames ~line 562
  - packages/quereus/src/schema/schema-differ.ts          # generateMigrationDDL ordering (RENAME ~2360, DROP ~2384, table creates ~2399, view creates ~2400)
  - packages/quereus/test/declarative-equivalence.spec.ts # MV describe block (~line 1447+) — add a regression test here
difficulty: medium
prereq:
----

# Fix: maintained-table rename + backing-module move in one apply emits conflicting DDL

## Repro (confirmed)

```sql
declare schema main {
  table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
  materialized view mv as select id, x from t
}
apply schema main;
insert into t values (1,10),(2,20);

-- Rename mv → mv2 (previous_name hint) AND move the backing module, together:
declare schema main {
  table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
  materialized view mv2 using mem2() as select id, x from t
    with tags ("quereus.previous_name" = 'mv')
}
apply schema main options (allow_destructive = true);
-- Error: Materialized view 'main.mv2' already exists
```

The generated migration DDL is:

```
ALTER TABLE mv RENAME TO mv2      -- mv2 now exists
DROP TABLE IF EXISTS mv           -- no-op: mv was just renamed away
create materialized view mv2 …    -- FAILS: mv2 already exists
```

`computeSchemaDiff` records BOTH a table rename (`diff.renames` gets `mv→mv2`, pushed
in bulk before the table loop) AND a module-move drop+recreate (`tablesToDrop=['mv']`,
`tablesToCreate` has the `mv2` recreate, `maintainedModuleMigrations` has one entry).
At apply the rename lands first, so the subsequent `DROP mv` is a no-op and the
`CREATE mv2` collides with the just-renamed table.

## Root cause

The module-move branch in `computeSchemaDiff`'s table loop (added by
`maintained-table-backing-module-migrate`) routes a both-maintained name-match to
drop(actual)+recreate(declared) and `continue`s, but it does **not** account for the
case where that name-match was itself a *rename* match (`matchedActual.name !== name`).
The table rename op was already appended to `diff.renames` unconditionally (the bulk
`diff.renames.push(...tableRenames.renames)` ahead of the loop), so both the rename
primitive and the drop+recreate fire and fight over the name.

## Why this is not a trivial inline fix

Naively suppressing the table RENAME (and letting drop-old + create-new realize the
move) breaks **dependent views**: a view over `mv` whose definition is reconciled via
`tableRenames.renames` (NOT `diff.renames`) is deliberately NOT recreated on a pure
source-rename — it relies on the `ALTER TABLE … RENAME` primitive to retarget it in
the catalog. Remove the rename and the dependent view is left pointing at the dropped
old name. So the resolution has to coordinate three things at once: the rename (for
dependent retargeting), the destructive recreate (for the module move), and the
recreate ordering relative to dependents. This is the intersection of two destructive
transitions with dependent retargeting and needs a deliberate design, not a one-liner.

## Severity / scope

Exotic combination (a maintained table renamed *and* its backing module moved in a
single re-declaration). Pre-migration (before `maintained-table-backing-module-migrate`)
this silently ignored the module move and only renamed; now it is a hard apply failure.
Fail-loud is arguably better than silent-wrong, but the user still cannot express the
combined intent in one apply. Low real-world frequency; not a blocker for the shipped
feature, but a genuine correctness gap.

## Acceptance

- `apply schema … options (allow_destructive = true)` over a simultaneous maintained-table
  rename + backing-module move succeeds: the table ends up under the new name backed by
  the new module, rows re-materialized, dependents (views/indexes/FKs over it) intact.
- A regression test in `test/declarative-equivalence.spec.ts` covering the repro above,
  including at least one dependent view over the renamed+moved maintained table to pin
  the retargeting.
- Decide and document the resolution: either (a) make the rename + drop+recreate
  cooperate (rename to retarget dependents, then recreate in place under the new name —
  and recreate dependents if needed), or (b) reject the combination at diff time with a
  clear diagnostic ("rename and backing-module move in the same apply is unsupported;
  split into two applies"). Option (b) is the smaller, safe fix if (a) proves costly.
