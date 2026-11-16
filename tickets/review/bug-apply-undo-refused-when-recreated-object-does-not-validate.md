description: When "apply schema" removes a view or a table's maintained definition and then fails, the rollback now puts the object back without judging it, instead of refusing when the object was already broken or its rows would not pass a fresh check.
architecture: docs/schema-undo-plan.md#guards-during-an-unwind
files:
  - packages/quereus/src/planner/building/create-view.ts   # body planning moved into validateViewBody, skipped during an unwind
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts   # attachMaintainedDerivation skips validateDeclaredConstraintsOverContents during an unwind
  - packages/quereus/src/core/database-materialized-views-plan-builders.ts   # buildFullRebuildPlan skips the size reject during an unwind
  - packages/quereus/src/core/database.ts   # _setSchemaUnwinding docstring
  - packages/quereus/src/schema/schema-differ.ts   # NOTE at setMaintainedFrom (stale derivation)
  - packages/quereus/test/logic/50.4-declare-schema-apply-restore.sqllogic   # section 22
  - packages/quereus/test/apply-schema-restore.spec.ts   # cross-schema view chain
  - docs/schema-undo-plan.md
repro: verified
----

# A rollback's recreated view or maintained definition is no longer judged as if it were new

Same rule as the completed `bug-apply-undo-refused-when-re-added-constraint-does-not-validate`: an unwind returns to the pre-apply state, which already existed, so it judges nothing. All three skips test `db._isSchemaUnwinding()`, which `runJournalInReverse` holds only around the undo statements.

## What changed

- **`CREATE VIEW` during an unwind does not plan its body** (`buildCreateViewStmt`). The planning, which rejects a DML body and checks an explicit column list's arity, moved into `validateViewBody` and runs only outside an unwind. The undo statement is parsed fresh each time (`_execWithinTransaction` → `_parseSql`), so no plan built with the check skipped is cached for later use.
- **`SET MAINTAINED` during an unwind does not scan the table's declared CHECKs and child-side foreign keys over the derived rows** (`attachMaintainedDerivation`). Body compile, shape, derivation-cycle and row-set (`assertDerivedRowsAreSet`) checks stay on.
- **The full-rebuild size limit is not applied during an unwind** (`buildFullRebuildPlan`, reached from `registerMaterializedView` inside the attach). The ticket asked to check this gate. It is easy to reach: lower `materialized_view_rebuild_row_threshold` after creating a maintained table with a full-rebuild-only body (e.g. `select distinct v from sz`), and the undo re-attach was refused. The skip is inside `buildFullRebuildPlan`, so it covers any registration during an unwind, not only the attach. Every registration during an unwind restores a pre-apply derivation.
- The determinism gate in the same builder was not stood down. The probe found no way to reach a pre-apply maintained table with a non-deterministic body: a projected `random()` is refused even with `pragma nondeterministic_schema = true`.
- Docs: `_setSchemaUnwinding` docstring; `docs/schema-undo-plan.md` § Guards during an unwind gets two bullets (view body, re-attach scans + size limit) and a paragraph on what a re-attach still checks and the stale-derivation limit.

## Found and not fixed (filed)

A **stale** maintained table whose body no longer compiles (source dropped, or a column it reads dropped) is a reachable pre-apply state. A plan that detaches it and then fails cannot re-attach it, because the re-attach derives the rows from the body. Verified on memory. Filed as `tickets/backlog/bug-apply-undo-cannot-reattach-stale-derivation.md`, with a `NOTE:` at `UndoRenderer.setMaintainedFrom` (`schema-differ.ts`) and a paragraph in the doc.

## Tests added

- `50.4-declare-schema-apply-restore.sqllogic` § 22: one declaration that fails on `ub` after dropping a view whose source is gone (`v` over dropped `g`), detaching `m` (rows break its foreign key `c`) and detaching `sz_m` (full-rebuild body over a source past a threshold lowered to 2 after creation). It asserts the error names `ub`, `diff schema main` plans all three again, the orphan row in `m` survives, and the restored derivation is live with its foreign key enforced on a new derived row. Runs on both backends. With any one of the three skips removed, this section fails (checked for the size gate by toggling it off; the view and FK arms were confirmed by the probe before the fix).
- `apply-schema-restore.spec.ts` › views built on other views › "restores a chain through another schema, recreating a view before the view it reads": the `s.V1` / `main.M` / `s.V3` chain from the ticket; asserts the step's own error (`create view s.Bad`), no "could not be restored", and `select D from s.V3` → `[{ D: 10 }]`.

## Validation

`yarn build`, `yarn workspace @quereus/quereus run lint`, `yarn test` (all workspaces) and `yarn test:store` all pass.

## For the reviewer

- On the store, `retireBackingForAttach` / `ensureBackingForAttach` run on the detach/re-attach route. Section 22 passes under `yarn test:store`, but nothing asserts directly that the store's re-attach reconcile writes nothing for an unchanged source. The doc claims the diff is empty because the forward detach kept the rows.
- The undo of a same-shape re-attach (`undoSetMaintained` → `setMaintainedFrom`) also runs under these skips. There the reconcile does write rows back to the pre-apply body's output. No test covers that arm with a judged constraint.
- The CHECK arm of `validateDeclaredConstraintsOverContents` was not exercised by a test. It is skipped by the same branch as the foreign key arm.
- Whether the restore fingerprint tracks a derivation's stale flag was not checked. It matters only for the filed stale case.
