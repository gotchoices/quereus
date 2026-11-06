description: A schema migration that removes a view or table and, in the same declaration, stops every CHECK or DEFAULT from reading it used to be refused. It now applies, while a declaration that keeps a rule reading the removed object is still refused before any table loses rows.
architecture: docs/schema-declarative.md#redefining-what-a-rule-reads
files:
  - packages/quereus/src/schema/schema-differ.ts # SchemaDiff.releasedDrops; dropsReleasedByDeclaration, declaredRuleExpressions, objectsRulesReach, declaredReachBodies, objectsNamedBySchema (beside recreatedObjectReachProbe); objectsReleasedByDiff (beside objectsRecreatedByDiff)
  - packages/quereus/src/runtime/emit/expression-drop-guard.ts # assertNoExpressionDependsOn: released branch + NOTE
  - packages/quereus/src/schema/expression-dependents.ts # findTableExpressionDependent: optional probesTable filter
  - packages/quereus/src/core/database.ts # _setSchemaReleasedObjects / _getSchemaReleasedObjects
  - packages/quereus/src/runtime/emit/schema-declarative.ts # holder set around runBatchedMigrationLoop; ruleStillReachingReleasedObject post-plan check
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic # sections 20 and 21 (appended at the end)
  - docs/schema-declarative.md # § Redefining what a rule reads
repro: verified
----

## What changed

`apply schema` turns a declaration into DDL steps. Table and view drops run early; a table's `DROP CONSTRAINT` / `SET DEFAULT` run later. The drop guard (`assertNoExpressionDependsOn`) judged each drop against the half-migrated catalog, where the rule the declaration removes still exists, so the drop was refused.

Now the differ computes `SchemaDiff.releasedDrops`: the tables and views the plan drops without recreating, when no rule of the schema after the plan reaches any of them. `apply schema` holds their keys on `Database._setSchemaReleasedObjects` (beside the existing recreated set, same set/restore-in-`finally` pattern). The guard, for a released key, ignores dependents on tables in the applied schema and still refuses one on another schema's table (`findTableExpressionDependent`'s new `probesTable` filter). After the last step, `ruleStillReachingReleasedObject` fails the apply if any rule still reaches a released object. `revalidateChecksOverRecreatedObjects` still reads only the recreated set. Plan text and `diff schema` output are unchanged.

## Deliberate deviations from the ticket's design — check these

- **All or nothing.** The ticket defined release per object. That loses data: removing table `t` and view `v` (over `t`) while CHECK `pc` keeps reading `v` would release `t` (no declared body reads it, since `v` is not declared), so `DROP TABLE t` passes and destroys rows, then `DROP VIEW v` is refused. Now one still-reached removed object releases nothing. Section 21 pins this case; with per-object release that test fails.
- **The catalog's generated expressions on kept tables count as end-state rules.** The differ never diffs a generated expression (verified: declaring `w … generated always as (5)` over a catalog `generated always as ((select s from v1))` plans only `DROP VIEW v1`). Without this, `v1` would be released and the table left reading a missing view. Section 21 pins it. Cost: a view removed together with a generated column that reads it, on a kept table, stays refused (as today). `NOTE:` at `dropsReleasedByDeclaration`; listed in the doc's known limits.
- **The post-plan check was implemented** (the ticket's "optional safety net"). The object-ref resolver does resolve a name whose object no longer exists (an unqualified miss keys under the home schema, `object-ref-resolver.ts` `forHomeSchema`), so `findTableExpressionDependent` finds direct references and references through surviving views. **No test reaches it**: I know of no declaration where the plan fails to converge after the two conservative rules above. If it ever fires after a released `DROP TABLE`, the apply reports partially migrated (rows already gone), so it is a backstop, not a guarantee. A reviewer who finds a convergence gap should fix the release computation, not lean on this.
- Other-schema bail-out: implemented as specified (`objectsNamedBySchema` reports a name outside the applied schema; `objectsRulesReach` returns `undefined`, releasing nothing). Pinned by section 21's `temp.d_w` case, which loses rows if the bail-out is removed.

## Use cases verified (memory and `yarn test:store` for 50.4)

Section 20 applies, each asserting the end state:
- view removed, CHECK removed (`DROP VIEW`, `DROP CONSTRAINT`), `diff schema` empty afterward;
- view removed, CHECK rewritten to `u <= 5`;
- view renamed by `quereus.previous_name` hint, CHECK moved to the new name;
- table removed while the view the CHECK reads moves to another table (the view is recreated, the table released);
- view removed, column DEFAULT changed to a literal.

Section 21:
- forced failure after a released `DROP VIEW` (a later `ADD CONSTRAINT d_qc` fails over the existing row): view and `d_pc` both back and enforced. This confirms the unwind order the ticket asked about: the undo `ADD CONSTRAINT d_pc` runs while the view is still missing and is accepted, because a CHECK added during the unwind is not judged against rows;
- refused, rows intact: table removed while the view and CHECK stay; table and view removed while the CHECK stays (all-or-nothing); CHECK moved to a `temp` view over the removed table (other-schema bail-out); generated column reading the view (catalog generated counted); a CHECK on a `temp` table reading `main.d_v9` (other-schema dependent still refuses).

I removed each of the three conservative rules (all-or-nothing, kept generated, other-schema bail-out) in turn. Each removal made the 50.4 file fail, then I put the rule back.

## Tests added

Only `50.4-declare-schema-apply-restore.sqllogic` sections 20–21, listed above. They are appended at the end rather than placed after section 14, so that sections 15–19 keep their numbers. The three spec files only got the new `releasedDrops: []` field in their `SchemaDiff` literals.

## Validation

- `yarn workspace @quereus/quereus test`: 11093 passing, 26 pending.
- `yarn workspace @quereus/quereus lint`: clean.
- `node test-runner.mjs --store --grep "50.4-declare|41.10.4"`: passing.

## Known gaps / for the reviewer

- `diff schema` output run by hand is still refused at the drop (the exception exists only inside `apply schema`). Already in the doc.
- While the migration is between a released drop and the later `DROP CONSTRAINT` / `SET DEFAULT`, the rule names a missing object. There is a `NOTE:` at the guard's released branch, and the doc's known limits list it.
- The parent-table foreign-key analogue is still open (`bug-apply-schema-refuses-parent-removed-with-its-foreign-key`, backlog). That case is refused by a different guard.
- Also edited `.release-notes.pending.md`. It is git-ignored, so the edit is local only. I removed this bug from "Known issues" and added a line under "`apply schema` and views".
