description: Maintained-table rename + backing-module move now cooperate in one `apply schema`. The module-move drop targets the NEW (declared) name when the match is a rename, so the preserved table RENAME op retargets dependents and the recreate lands in-place instead of colliding.
files:
  - packages/quereus/src/schema/schema-differ.ts          # module-migration branch, rename-coincident drop-name (~line 482-494)
  - packages/quereus/test/declarative-equivalence.spec.ts # regression tests in the MV describe block (~line 1630, 1772+)
  - docs/schema.md                                         # rename-coincident module-move note (~line 647)
----

# Complete: maintained-table rename + backing-module move cooperate in one apply

## What shipped

A maintained table that is BOTH renamed (via a `quereus.previous_name` hint) AND has its
backing module moved in the same `apply schema` previously emitted conflicting migration DDL
and failed at apply with `Materialized view 'main.mv2' already exists`.

The fix (option (a), "cooperate") is a single-line behavioral change plus comments in the
`computeSchemaDiff` module-migration branch (`schema-differ.ts` ~line 493): when the match is a
rename (`matchedActual.name.toLowerCase() !== name`), the module-move drop targets the
**declared** name `name` instead of the OLD `matchedActual.name`. The recreate already renders
under `name`, and the table RENAME op in `diff.renames` is left intact so dependent views
retarget via the `ALTER … RENAME` primitive. For a plain name match the two names coincide, so
non-rename module moves are unaffected.

Resulting DDL (correct, in the order `generateMigrationDDL` emits):
```
ALTER TABLE mv RENAME TO mv2          -- dependents retargeted to mv2
DROP TABLE IF EXISTS mv2              -- drop the just-renamed live incarnation
create materialized view mv2 using mem2() …  -- recreate under new name + new module
```

## Review findings

### What was checked

- **Fix correctness (re-derived from the diff, fresh eyes).** Read the implement commit
  `7ccd4e76` diff before the handoff summary. Verified the comparison `matchedActual.name
  .toLowerCase() !== name` is sound: `name` is the `declaredTables` map key, which is
  **always lowercased** at every insertion site (`schema-differ.ts:280`, `:319`→`:351`), so the
  mixed-case `matchedActual.name` is correctly lowercased before comparison and `dropName` is
  lowercase in both branches — consistent with how the orphan-drop loop populates `dropSet`
  (from `actualTables`, lowercased at `:355`).
- **Drop-ordering tolerance.** Confirmed `orderDropsByFKDependency` (`:2328`) handles `mv2`
  being absent from `actualTables` — the `if (table)` guard (`:2341`) skips FK-edge expansion
  and the name is pushed with no edges. No crash, no spurious edge.
- **DDL apply order.** Confirmed `generateMigrationDDL` emits renames (`:2372`) → table drops
  (`:2396`) → creates (`:2411`), so `ALTER … RENAME` lands before `DROP` before `CREATE` — the
  exact order the fix relies on.
- **Orphan-drop interaction.** The old name `mv` is in `tableRenames.consumedActuals`, so the
  orphan loop (`:531`) skips it; `dropSet` ends with only the new name `mv2` — no double-drop.
- **Non-rename path unchanged.** Existing test "a backing-module change on a maintained table
  schedules a destructive drop+recreate" still asserts `tablesToDrop === ['mv']`; the
  single-name path is provably unaffected (identical names).
- **Lint + full suite.** `yarn workspace @quereus/quereus lint` clean. Full quereus suite
  **6014 passing, 9 pending, 0 failing** (6012 → 6014 with the two new tests below).

### What was found / done

- **Minor — coverage gaps closed inline (3 tests now, up from 1).** The implementer flagged
  several untested surfaces. Two of the highest-value ones were added as passing regression
  tests in the MV describe block of `declarative-equivalence.spec.ts`:
  - *Declared-shape maintained table (`table … maintained as`) + rename + module move* — the
    fix is shape-agnostic (drops a name, doesn't touch the recreate render); now pinned on the
    `create table … maintained as` recreate path, asserting the rename survives, the drop
    targets the new name `mvt2`, the recreate carries `mem2`, and rows re-materialize E2E.
  - *Dependent **materialized view** (not just a plain view) over the renamed+moved table* —
    pins that the retarget machinery works for a maintained dependent, not only a data-less
    plain view. The dependent MV `mvdep` over `mv`/`mv2` returns correct rows after the
    destructive apply.
- **Minor — docs updated.** `docs/schema.md` (§ View / materialized-view definition-change
  detection, ~line 647) previously described the backing-module-move drop+recreate but not the
  rename-coincident drop-name subtlety. Added a concise note documenting that the RENAME op is
  preserved and the drop retargets to the new name.

### Empty / not-actioned categories (with reasons)

- **No new fix/plan/backlog tickets filed — no major findings.** The single-line fix is
  correct under scrutiny; nothing rose to the "major" bar.
- **Remaining coverage gaps deliberately NOT pinned (low value, would be over-testing).** The
  fix changes only the *dropped name* and is shape- and dependent-agnostic, so these exercise
  no new fix code path: multiple dependents, a chain of dependents, a dependent that itself
  renames in the same apply, and FK-parent/inbound-FK interaction on the renamed+moved table
  (the `orderDropsByFKDependency` reasoning already shows the new name contributes no edges).
  Left as documented potential follow-ups rather than blocking work.
- **`store` module path not run.** Validation used the default memory-backed vtab
  (`yarn test`), not `yarn test:store`. The drop-name / DDL-ordering logic is module-agnostic
  at the differ level (it manipulates names and statement order, not module behavior), so the
  store path adds no differ-level coverage; deferred to CI / release validation per the
  agent-runnable time budget.
- **No `.pre-existing-error.md` written** — no test failures surfaced.

## Acceptance (met)

- `apply schema … options (allow_destructive = true)` over a simultaneous maintained-table
  rename + backing-module move succeeds: table ends under the new name backed by the new
  module, rows re-materialized, dependent view(s) intact and correct. ✔
- Regression tests cover the confirmed repro (plain-view dependent), the declared-shape
  surface, and a maintained-view dependent. ✔
- Full quereus suite green (6014 passing, 0 failing); lint clean. ✔
- Docs reflect the new rename-coincident behavior. ✔
