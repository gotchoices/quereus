description: Review the fix that makes a maintained-table rename + backing-module move cooperate in one `apply schema`. The module-move drop now targets the NEW (declared) name when the match is a rename, so the preserved table RENAME op retargets dependents and the recreate lands in-place instead of colliding.
files:
  - packages/quereus/src/schema/schema-differ.ts          # module-migration branch in computeSchemaDiff table loop (~line 475-502)
  - packages/quereus/test/declarative-equivalence.spec.ts # new regression test in the MV describe block (~line 1630)
difficulty: medium
prereq:
----

# Review: maintained-table rename + backing-module move cooperate in one apply

## What changed

A maintained table that is BOTH renamed (via a `quereus.previous_name` hint) AND has its
backing module moved in the same `apply schema` previously emitted conflicting migration
DDL and failed at apply with `Materialized view 'main.mv2' already exists`.

Root cause: `computeSchemaDiff` records BOTH a table rename (`mv→mv2`, pushed in bulk into
`diff.renames`) AND a module-move drop+recreate. The module-migration branch added the
**actual/OLD** name to `dropSet` and pushed the recreate under the **new** name. At apply the
rename lands first (`ALTER TABLE mv RENAME TO mv2`), so `DROP mv` no-op'd and `CREATE mv2`
collided.

The fix (option (a), "cooperate") is a **single-line behavioral change** plus comments:

- `schema-differ.ts` module-migration branch (~line 482): when the match is a rename
  (`matchedActual.name.toLowerCase() !== name`), drop the **declared** name `name` instead of
  `matchedActual.name`. The recreate already renders under `name`. The table RENAME op in
  `diff.renames` is left untouched (it must survive so dependent views retarget). For a plain
  name match the two names are identical, so non-rename module moves are unaffected.

Resulting DDL (correct):
```
ALTER TABLE mv RENAME TO mv2          -- dependents retargeted to mv2
DROP TABLE IF EXISTS mv2              -- drop the just-renamed live incarnation
create materialized view mv2 using mem2() …  -- recreate under new name + new module
```

## Why it's safe (from fix research, re-confirmed during implement)

- The table RENAME op must stay: dependent views over a pure source-rename are reconciled via
  `tableRenames.renames` and deliberately NOT recreated; they rely on the `ALTER … RENAME`
  primitive to retarget their stored catalog definition. Removing the rename would strand them.
- No cascade-drop / RESTRICT block on dependent views — `dropTable` / `dropMaintainedTable`
  guard only inbound FKs, not dependent views. View bodies resolve lazily at plan time, so the
  momentary `DROP mv2` → `CREATE mv2` window does not error.
- The orphan-drop loop skips the old name (`mv` is in `tableRenames.consumedActuals`), so
  `dropSet` ends with only `mv2` — no double-drop.
- `orderDropsByFKDependency` tolerates a name absent from `actualTables` (the `if (table)`
  guard) — `mv2` is not in the actual catalog and contributes no FK edges.
- DDL ordering already correct: renames first, then table drops, then creates.

## How to validate

Run the targeted spec, the full quereus suite, and lint (all green at handoff):

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/declarative-equivalence.spec.ts" --grep "cooperate" --colors
yarn workspace @quereus/quereus test
yarn workspace @quereus/quereus lint     # single-quote globs on Windows
```

Results at handoff: targeted test passes; full quereus suite **6012 passing, 9 pending, 0
failing**; lint clean.

## Regression test added

`declarative-equivalence.spec.ts`, MV describe block (~line 1630):
"a maintained-table RENAME + backing-module move in one apply cooperate (rename retargets,
recreate-in-place under new name)". Mirrors the confirmed repro:

- Declares `t`, `mv` (MV over t), `v` (plain view over mv); applies; inserts `(1,10),(2,20)`.
- Re-declares with `mv2 using mem2() … with tags ("quereus.previous_name" = 'mv')` and `v`
  over `mv2`.
- **Diff-level asserts:** `diff.renames` contains the `mv→mv2` table rename;
  `diff.tablesToDrop` deep-equals `['mv2']` (the NEW name); a recreate string matches
  `/create\s+materialized\s+view\s+mv2\b/i` with `mem2`; `diff.maintainedModuleMigrations`
  deep-equals `[{ name: 'mv2', fromModule: 'memory', toModule: 'mem2' }]`.
- **End-to-end asserts** after `apply … options (allow_destructive = true)`: `mv2` is backed
  by `mem2`; `select id,x from mv2 order by id` and `select id,x from v order by id` both
  return `[{id:1,x:10},{id:2,x:20}]` (rows re-materialized, dependent view retargeted intact).

## Use cases to exercise during review

- **Core repro** — the test above. Confirm the diff-level and end-to-end assertions hold.
- **Non-rename module move unaffected** — existing test "a backing-module change on a
  maintained table schedules a destructive drop+recreate" still asserts
  `tablesToDrop === ['mv']`. Confirm the single-name (non-rename) path is unchanged.

## Known gaps / things a reviewer should probe

- **Single-dependent, single-rename coverage only.** The new test exercises ONE dependent
  plain view and ONE renamed+moved MV. Not covered: a dependent **MV** (vs plain view) over the
  renamed+moved table; multiple dependents; a chain of dependents; a dependent that itself
  renames in the same apply. These rely on the same retarget machinery but are untested here.
- **Declared-shape maintained table (`table … maintained as`) + rename + module move.** The
  test uses the MV-sugar form. The declared-shape surface (covered separately for plain module
  moves at `declarative-equivalence.spec.ts` ~line 1660) is NOT exercised with a coincident
  rename. The fix is shape-agnostic (it only changes the dropped name), but it's untested on
  that surface.
- **No FK interaction tested.** A renamed+moved maintained table that is itself an FK parent,
  or has inbound FKs, is not covered. The `orderDropsByFKDependency` reasoning argues `mv2`
  contributes no edges (absent from the actual catalog), but a populated-FK case isn't pinned.
- **`store` module path not run.** Validation used the default memory-backed vtab
  (`yarn test`), not `yarn test:store`. The DDL ordering / drop semantics are module-agnostic
  at the differ level, but the store path was not exercised.
- **previous_name-only (rename, no module move)** and **module-move-only (no rename)** are the
  two halves that already worked; the test does not re-pin them in combination beyond the
  existing single-axis tests.

## Acceptance (met)

- `apply schema … options (allow_destructive = true)` over a simultaneous maintained-table
  rename + backing-module move succeeds: table ends under the new name backed by the new
  module, rows re-materialized, dependent plain view intact and correct. ✔
- Regression test added covering the confirmed repro incl. a dependent view. ✔
- `yarn workspace @quereus/quereus test` green; lint clean. ✔
