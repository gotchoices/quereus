----
description: Unit pins for view-dependency plan invalidation — dependency recording via `_buildPlan`, invalidation via `compile()` plan identity — plus the canonical-schema-name fix in the view/MV tag emitters. Reviewed; one schemaName-gating negative test added; cross-cutting casing bugs verified and spun off to `schema-event-name-casing-invalidation-misses`.
files:
  - packages/quereus/test/plan/view-dependency-invalidation.spec.ts  # NEW spec — 13 tests (12 from implement + 1 added in review)
  - packages/quereus/src/schema/manager.ts                           # fix: updateViewTags / updateMaterializedViewTags fire canonical `schema.name`
  - packages/quereus/test/plan/view-tag-mutation-plan.spec.ts        # header parenthetical refreshed to point at the new spec
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # cross-pointer added to the dependency comment
----

# Complete: unit pins for view-dependency plan invalidation

## What landed

New spec `test/plan/view-dependency-invalidation.spec.ts` pinning both halves
of the `view` plan-dependency invalidation path, previously at zero behavioral
coverage:

- **Dependency recording** (4 tests via `db._buildPlan` →
  `schemaDependencies.getDependencies()`): single-source view INSERT, MV
  INSERT, multi-source join-view UPDATE each record exactly one
  `{type:'view'}` dep; a read-only `select from v` records no view dep (while
  the base `table` dep is asserted present).
- **Invalidation** (9 tests via `Statement.compile()` plan-object identity,
  each `!==` preceded by a `===` cache-positive control): ALTER VIEW/MV TAGS
  invalidate cached write-through plans; recompile re-subscribes (second ALTER
  invalidates again); unrelated-object negative (objectName gating);
  same-named-view-in-`temp` negative (schemaName gating — added in review);
  read-side negative (listener installed via table dep, `view` match gates);
  case-differing view name; schema-qualified + case-differing schema qualifier
  for both view and MV.

Product fix (test-first reproduced by the two case-differing schema-qualified
cases): `updateViewTags` / `updateMaterializedViewTags` (schema/manager.ts) now
fire canonical `schemaName: schema.name` instead of the raw ALTER qualifier,
matching the dep's exact compare in statement.ts. The listener compare was
deliberately left exact (canonicalize-at-the-emitter convention).

## Review findings

**Checked:** the implement diff with fresh eyes (spec, manager.ts emitters,
comment refreshes); the statement listener compare (statement.ts ~176-180);
dep-recording sites (schema-resolution.ts, view-mutation-builder.ts); every
manager/emit `notifyChange` site touching `table_modified` / `view_modified` /
`materialized_view_modified` casing; CREATE-side stored `schemaName` for
tables/views/MVs; docs (`docs/schema.md`, `docs/materialized-views.md`,
`docs/change-scope.md`, `docs/progressive-optimizer.md`) for contradicted
claims; lint; the new spec, its sibling, and the full workspace suite.

**Minor (fixed inline):**
- The spec had an objectName-gating negative but no **schemaName-gating**
  negative (the `dep.schemaName === event.schemaName` branch of the listener
  was unreachable by any test). Added: a same-named view in `temp` —
  `alter view temp.v … tags` must not invalidate a write through main's `v`,
  with a positive control that main's `v` still invalidates. 13/13 passing.

**Major (spun off → `fix/schema-event-name-casing-invalidation-misses`):**
the handoff flagged two unverified gaps; review verified both with throwaway
repros (deleted after) and corrected one claim:
- **Verified real:** `createIndex` (manager.ts ~2069) fires `table_modified`
  with the raw statement's `tableName`/`targetSchemaName` — `create index i on
  T (x)` fails to invalidate a cached `select … from t` plan (control with
  exact casing invalidates).
- **Verified real (inverse direction):** `create view MAIN.v` stores raw
  `'MAIN'` (buildCreateViewStmt → emit), so the dep records `'MAIN'` while the
  fixed emitters fire canonical `'main'` — a subsequent `alter view v … tags`
  never invalidates the cached write-through plan.
- **Handoff claim corrected:** the suspected `ALTER TABLE … TAGS` gap
  (`commitTagUpdate` firing raw `targetSchemaName`) is NOT a bug — the runtime
  tag emitters pass the **stored** `tableSchema.schemaName` through
  (alter-table.ts `runSetTableTags` et al.), so dep and event always agree.
  Repro confirmed `alter table MAIN.t … tags` invalidates correctly. The
  `ALTER INDEX … TAGS` path, however, passes the raw plan qualifier
  (emit/set-object-tags.ts) into the same `commitTagUpdate` — same class as
  the verified misses; flagged for audit in the fix ticket.

**Empty categories, explicitly:** no docs updates needed — no doc makes claims
about event-payload name casing or this invalidation observable (checked the
four docs above). No resource-cleanup/error-handling/type-safety issues found
in the spec: fresh `Database` per test with `afterEach` close, `finalize()` on
every statement, no `any`, deps typed as `SchemaDependency`. No DRY issue with
the sibling spec — its DROP-TAGS recovery cases pin the behavioral half, this
spec pins identity; the headers cross-reference each other correctly.

## Validation

- `view-dependency-invalidation.spec.ts`: 13/13; sibling
  `view-tag-mutation-plan.spec.ts`: 6/6.
- `yarn test`: all packages green — quereus 5676 passing / 9 pending
  (pending pre-existing).
- `yarn workspace @quereus/quereus run lint`: clean.
