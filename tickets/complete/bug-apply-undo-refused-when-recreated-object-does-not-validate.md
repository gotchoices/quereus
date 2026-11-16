description: When "apply schema" removes a view or a table's maintained definition and then fails, the rollback now puts the object back without judging it, instead of refusing when the object was already broken or its rows would not pass a fresh check.
architecture: docs/schema-undo-plan.md#guards-during-an-unwind
files:
  - packages/quereus/src/planner/building/create-view.ts   # body planning moved into validateViewBody, skipped during an unwind
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation skips validateDeclaredConstraintsOverContents during an unwind
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts   # buildFullRebuildPlan skips the size reject during an unwind
  - packages/quereus/src/core/database.ts   # _setSchemaUnwinding docstring
  - packages/quereus/src/schema/schema-differ.ts   # NOTE at setMaintainedFrom; view-drop sort removed in review
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # section 22
  - packages/quereus/test/apply-schema-restore.spec.ts   # cross-schema view chain
  - docs/schema-undo-plan.md
repro: verified
----

# A rollback's recreated view or maintained definition is no longer judged as if it were new

An unwind of a failed `apply schema` returns to the pre-apply state, which already existed, so it judges nothing. Three more checks now stand down while `db._isSchemaUnwinding()` is set (held by `runJournalInReverse` only around the undo statements):

- `CREATE VIEW` does not plan its body (`validateViewBody` in `create-view.ts` runs only outside an unwind). The undo statement is parsed and planned fresh each time, so no plan built with the check skipped is reused.
- `SET MAINTAINED` does not scan the table's declared CHECKs and child-side foreign keys over the derived rows (`attachMaintainedDerivation`). Body compile, shape, derivation-cycle and row-set checks stay on.
- The full-rebuild size limit (`materialized_view_rebuild_row_threshold`) is not applied (`buildFullRebuildPlan`), covering any registration during an unwind. The determinism gate stays on.

A stale maintained table whose body no longer compiles still cannot be re-attached by an unwind; filed as `tickets/backlog/bug-apply-undo-cannot-reattach-stale-derivation.md`, with a `NOTE:` at `UndoRenderer.setMaintainedFrom`.

Tests: `50.4-declare-schema-apply-restore.sqllogic` § 22 (one failing declaration that drops a view over a dropped table, detaches a derivation whose rows break its foreign key, and detaches a full-rebuild derivation past a lowered threshold; runs on both backends), and `apply-schema-restore.spec.ts` › views built on other views › "restores a chain through another schema…".

## Review findings

Read the diff of `ticket(implement): bug-apply-undo-refused-when-recreated-object-does-not-validate` before the handoff.

**Correctness — checked, no defects.**
- `buildCreateViewStmt` produced nothing from the body plan beyond the two refusals, and `emitCreateView` stores the AST without planning it, so skipping the plan changes no stored state.
- Undo statements go through `_execWithinTransaction` → `_parseSql`, so a plan built under the flag is not cached for later use.
- The size-reject skip in `buildFullRebuildPlan` reaches every `registerMaterializedView` during an unwind (re-attach, rename restore, column-op re-registration). Each of those restores a derivation the pre-apply catalog had, which passed the reject when it was created, so the skip cannot admit a new one.
- The constraint-scan skip also applies to the undo of a same-shape re-attach. The reconcile then writes the old body's rows back; those are the pre-apply rows because the journal runs in exact reverse over unchanged sources.
- Section 22 resets the threshold to 10000, which is the default (`MAINTENANCE_REBUILD_ROW_THRESHOLD`), so it leaks no option.

**Stale code and docs — found and fixed.**
- `orderViewDropsDependentsFirst` in `schema-differ.ts` sorted `viewsToDrop` so that the reversed journal recreated a view only after the views it reads. Its docstring gave that as its only reason, and `docs/schema-undo-plan.md` described the cross-schema failure it could not prevent. With `CREATE VIEW` no longer planning its body during an unwind, the order no longer matters: forward view drops have no guard among views (views are deliberately left to break), and the undo does not plan. Confirmed by disabling the sort and running the schema/apply/declare test subset (1105 passing), then removed the function and its call. Plans that drop several views now list them in catalog order instead of dependents first.
- Rewrote the `docs/schema-undo-plan.md` paragraph on view-drop order to say any order is valid and why, and updated the comment in the new cross-schema spec test that cited the sort.
- Reflowed the `_setSchemaUnwinding` docstring, which had a broken line wrap.

**Tests — reviewed, none added or cut.** The three older view-chain tests in `apply-schema-restore.spec.ts` now exercise the same skip as the new cross-schema test rather than the removed sort; they are cheap and each covers a different chain shape, so they stay. The CHECK arm of the skipped scan and the same-shape re-attach undo have no dedicated test; both go through the same branch as the tested foreign key arm, so no test was added.

**Unverified, not filed.** Nothing asserts that the store's re-attach reconcile (`retireBackingForAttach` / `ensureBackingForAttach`) writes nothing for an unchanged source; section 22 passes under `yarn test:store`, and the fingerprint comparison would catch a wrong catalog. Whether the restore fingerprint tracks a derivation's stale flag matters only for the already-filed stale case.

**Other angles.** Resource cleanup, error handling and type safety: the changes are three boolean gates on an existing flag and one extracted function; nothing new to clean up or type. Performance: skipping work only. Source hygiene: comments at each gate state why, not what.

**Validation.** `yarn build`, `yarn workspace @quereus/quereus run lint`, `yarn test` (all workspaces, no failures) and `yarn test:store` (11195 passing) pass after the review changes.
