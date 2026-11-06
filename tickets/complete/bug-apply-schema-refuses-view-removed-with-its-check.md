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

## Summary

`apply schema` used to refuse a declaration that removes a view or table and, in the same declaration, drops or rewrites every CHECK or DEFAULT that reads it. Table and view drops run before a table's `DROP CONSTRAINT` / `SET DEFAULT`, so the drop guard (`assertNoExpressionDependsOn`) judged the drop against a half-migrated catalog where the rule still existed. The differ now records `SchemaDiff.releasedDrops`: the objects the plan drops without recreating, when no rule of the schema after the plan reaches any of them. `apply schema` holds these on `Database._setSchemaReleasedObjects`. For a released key, the guard ignores dependents on tables in the applied schema, but a dependent on another schema's table still refuses the drop. After the last step, `ruleStillReachingReleasedObject` fails the apply if any rule still reaches a released object. Landed in `ticket(implement): bug-apply-schema-refuses-view-removed-with-its-check`.

The implementation made three choices that are stricter than the fix ticket's design. All three are documented in `docs/schema-declarative.md` § Redefining what a rule reads:
- Release is all or nothing. If even one removed object is still reached, nothing is released. Without this, a released `DROP TABLE` could destroy rows and the plan would then be refused at a later view drop.
- Generated expressions from the catalog on kept tables count as end-state rules, because the differ never changes a generated expression.
- If a walk from a rule reaches an object in another schema, nothing is released.

Sections 20 and 21 of `50.4-declare-schema-apply-restore.sqllogic` pin the cases. Section 20 covers the applies that now succeed. Section 21 covers the unwind after a later step fails, and each refusal that keeps rows intact.

## Review findings

- **Diff read first** (`ticket(implement): …`): the differ's release computation, the guard branch, the holder on `Database`, the post-plan check, the `findTableExpressionDependent` filter, docs and tests.
- **Correctness of the release computation**: the lowercase keying of `reached`, the body maps and `dropped` all agree with `actualTables` and `declaredTables`, which are keyed lowercase. The all-or-nothing rule and the other-schema bail-out are pinned by section 21. No defects found.
- **Mid-plan steps between a released drop and the rule's removal**, checked by running them in a scratch script (since deleted). The table also had `ADD COLUMN … not null default` added, `SET DATA TYPE` on the checked column, `SET NOT NULL`, a primary key change, and a DEFAULT reading the view replaced together with a retype. I also tried an unnamed column-level CHECK (dropped as `_check_u`) and dropping the column that carries the CHECK or DEFAULT. Every case applied and left the expected end state. The combined retype + add-column + default case also passed under `--store` (LevelDB). An unnamed table-level CHECK is refused by the existing "cannot drop unnamed constraint" rule, with the view intact. That is the old behaviour and not affected by this change. This confirms the guard's existing `NOTE:` that no step in that stretch evaluates an existing table's CHECKs or DEFAULTs.
- **Batching**: `runBatchedMigrationLoop` runs the whole plan as one `runStepsWithUndoJournal` call. So the post-plan check (like the existing recheck of recreated objects) runs only after the last step, never between batches. No issue.
- **Interaction with assertions**: an assertion kept in the declaration that reads a released object is not counted by the differ. The assertion drop guard has no released exception, so it still refuses before any rows go. No issue.
- **Tripwire parked**: the guard ignores readers on every table in the applied schema, and that includes engine-managed tables (`quereus.engine_managed`), which the declaration never sees. None carries a CHECK or DEFAULT reading a user object today. I added a `NOTE:` at `expression-drop-guard.ts` `assertNoExpressionDependsOn`.
- **Untested backstop**: `ruleStillReachingReleasedObject` is not reached by any test. The handoff states this, and I found no declaration that fails to converge. I accept it as a backstop and filed no ticket.
- **DRY / source hygiene**: `objectsRulesReach` resembles `withViewsReached`, but it differs on purpose (it includes tables and bails on another schema), so I left it. Extracting `declaredReachBodies` removed one duplicate. The comments explain reasons, not statements. No change.
- **Tests**: the new sqllogic sections each pin a distinct behaviour (applies that now succeed, the unwind, and each conservative refusal). The handoff says removing any one of the three conservative rules fails the file. I cut nothing and added nothing. The spec-file edits only add the new field.
- **Docs**: `docs/schema-declarative.md` reflects the new behaviour and its known limits. No other doc or open ticket references the old limitation. The foreign-key analogue (`bug-apply-schema-refuses-parent-removed-with-its-foreign-key`, backlog) already says this fix does not cover it.
- **Validation**: `yarn workspace @quereus/quereus lint` clean; `yarn workspace @quereus/quereus test` gives 11093 passing, 26 pending.
- **Major findings / tickets filed**: none.
