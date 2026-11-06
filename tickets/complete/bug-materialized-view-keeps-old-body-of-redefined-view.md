description: A materialized view built on an ordinary view kept computing from that view's old definition after the view was dropped or redefined; dropping a view a materialized view reads now marks the materialized view stale, just as dropping one of its source tables does.
architecture: docs/mv-schema-change.md
files:
  - packages/quereus/src/schema/derivation.ts # TableDerivation.sourceViews (new, required)
  - packages/quereus/src/core/database.ts # getPlan now delegates to new _getPlanWithDependencies
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts # BackingShape.sourceViews, collectSourceViews, buildTableDerivation, describeSourceDrift, adoptShapeSources, reshape + recompile + restore sites
  - packages/quereus/src/runtime/emit/materialized-view.ts # refresh fast path now records the re-planned sources
  - packages/quereus/src/core/database-materialized-views.ts # view_removed arm; listener's stale transition folded onto markMaterializedViewStale
  - packages/quereus/test/logic/53.5-materialized-view-over-view-redefine.sqllogic # regression
  - packages/quereus/test/view-mv-ddl-persistence.spec.ts # two literal derivations gained sourceViews: []
  - packages/quereus/src/runtime/emit/drop-view.ts # comment: view_removed consumers
  - docs/mv-schema-change.md, docs/materialized-views.md, docs/invariants.md
----

## Summary

A materialized view's derivation now records the plain views its body inlines (`TableDerivation.sourceViews`, lowercased `schema.view`, transitive), collected from the build's `view_read` dependencies via a new `Database._getPlanWithDependencies` (`getPlan` now delegates to it). The materialized-view manager's schema-change listener gained a `view_removed` arm that marks every MV whose `sourceViews` names the dropped view stale; the listener's inline stale sequence was folded onto `markMaterializedViewStale` (gained an optional log `reason`). The source-agreement checks (`describeSourceDrift`, formerly `sameSourceTables`) cover views too, and refresh records the re-planned sources on both its fast path and its reshape path (`adoptShapeSources`). Implemented in `ticket(implement): bug-materialized-view-keeps-old-body-of-redefined-view`.

Regression: `test/logic/53.5-materialized-view-over-view-redefine.sqllogic`. Docs: `docs/mv-schema-change.md`, `docs/materialized-views.md`, `docs/invariants.md`.

## Review findings

Checked:

- **Every path that removes or redefines a view fires `view_removed`, or can't reach this bug.** `Schema.removeView` callers: `drop-view.ts` (fires the event), `lens-compiler.ts` (fires nothing; the implementer already filed this as `bug-lens-redeploy-keeps-materialized-view-on-old-lens-body` in backlog, with triage fields), and `SchemaManager.dropView` (has no callers). The parser has no `create or replace view`. `alter view` only changes tags (`set-object-tags.ts`), so a view can't be renamed and `sourceViews` never needs the re-keying that table renames apply to `sourceTables`. DETACH (`SchemaManager.removeSchema`) fires no event for views or tables. That gap already existed and this change doesn't widen it; not filed.
- **Collection.** `view_read` is recorded at one site (`select.ts` view inlining), which also covers subquery FROMs. The tracker stores keys in a Set and both the recorded and event names are lowercased, so each view appears once and matching agrees. The `:`-in-name parsing weakness is pre-existing and was noted by the implementer.
- **Interaction with table renames.** A table rename re-keys `sourceTables` and rewrites the view's body in place (`view_modified`, view name unchanged), so `sourceViews` stays correct, and `restoreUnaffectedMaterializedViews`' view-set check can't misfire there.
- **Refreshing the record on the fast path** (`materialized-view.ts`). Correct and needed: without it, a recreated view over different tables would leave `sourceScope` and the source sets keyed off the old body.
- **Folding the stale transition onto `markMaterializedViewStale`.** It is the same sequence as before (set flag + log, release the row-time plan, emit backing invalidation), still idempotent, and the comments moved with it.
- **Tests.** The one new sqllogic file reproduces the bug and pins its recovery. It is the right layer and nothing is redundant. The two `sourceViews: []` literals in `view-mv-ddl-persistence.spec.ts` are needed because the field is required. Nothing cut, nothing added.
- **Docs.** The three docs the change touches describe the new behaviour accurately, including the `apply schema` drop-and-recreate outcome.

Found and fixed inline (minor):

- The `drop-view.ts` comment said `view_removed` exists so a store catalog can forget the view. It now also names the MV manager as a consumer.

Not filed:

- An MV body's `with defaults (…)` clause subquery is probably planned outside the body's plan, so a view (or table) read only there may be missing from both source sets. Not verified; it is the same gap for `sourceTables` and not something this ticket introduced. No tripwire, because there is no single site to put one on and I haven't confirmed it.
- No major findings and no tripwires otherwise.

Validation: `yarn workspace @quereus/quereus lint` clean; `yarn workspace @quereus/quereus test` 11101 passing, 26 pending. `yarn test:store` wasn't re-run in review (the implementer's run passed with 11094 passing; the only review edit is a comment).
