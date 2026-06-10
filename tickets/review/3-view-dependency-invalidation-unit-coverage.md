----
description: Review the new unit pins for view-dependency plan invalidation — dependency recording via `_buildPlan`, invalidation via `compile()` plan identity — plus the canonical-schema-name fix applied to the view/MV tag emitters.
files:
  - packages/quereus/test/plan/view-dependency-invalidation.spec.ts  # NEW spec — 12 tests, the deliverable
  - packages/quereus/src/schema/manager.ts                           # fix: updateViewTags / updateMaterializedViewTags now fire canonical `schema.name`
  - packages/quereus/test/plan/view-tag-mutation-plan.spec.ts        # header parenthetical refreshed to point at the new spec
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # one-line cross-pointer added to the dependency comment
  - packages/quereus/src/core/statement.ts                           # unchanged — listener compare left exact, per ticket guidance
----

# Review: unit pins for view-dependency plan invalidation

## What was implemented

New spec `test/plan/view-dependency-invalidation.spec.ts` (Mocha + chai, fresh
`Database` per test) pinning both halves of the `view` plan-dependency
invalidation path, which previously had **zero** behavioral coverage — deleting
the `recordDependency` call in `buildViewMutation` or the `view_modified` /
`materialized_view_modified` listener wiring failed no test before this.

**Dependency recording** (4 tests, via `db._buildPlan(new Parser().parseAll(sql))`
→ `schemaDependencies.getDependencies()`):
- Single-source view INSERT records `{type:'view', schemaName:'main', objectName:'v'}`.
- MV-mediated INSERT records a `view` dep for the MV.
- Multi-source inner-join view UPDATE (the `par_mj` shape from
  `test/logic/93.4-view-mutation.sqllogic`) records a `view` dep — proves the
  non-single-source shape enters the funnel (recording sits above branching).
- Read-side negative: `select id from v` records NO `view`-typed dep, while the
  base `table` dep IS present (asserted on absence-of-view, not emptiness).

**Invalidation** (8 tests, via `Statement.compile()` plan-object identity; every
`!==` assert is preceded by a `===` cache-positive control in the same test):
- `alter view v set tags (…)` invalidates a prepared `insert into v …`; the
  re-planned statement still executes and the row lands.
- `alter materialized view mv add tags (…)` invalidates a prepared MV insert.
- Repeat-invalidation: after recompile, a second ALTER invalidates again —
  pins live listener re-subscription across recompiles.
- Unrelated-object negative: `alter view other …` does not invalidate a write
  through `v` (objectName gating).
- Read-side negative: a prepared `select … from v` keeps plan identity across a
  view tag change — a listener IS installed (table dep), so this proves the
  `view`-typed match gates, not listener absence.
- Canonical view-name: `alter view MYVIEW …` invalidates a write through
  `create view MyView` (emitter fires stored `updated.name`).
- Schema-qualified `alter view main.v …` invalidates; case-differing
  `alter view MAIN.v …` also invalidates (required the product fix below).
- MV mirror: `alter materialized view MAIN.mv …` invalidates.

## Product fix applied (predicted by the ticket; test-first reproduced)

Before the fix, the two case-differing schema-qualified tests failed exactly as
the ticket predicted: `updateViewTags` / `updateMaterializedViewTags`
(schema/manager.ts) fired `schemaName: targetSchemaName` — the raw casing from
the ALTER — while the plan dep records canonical `view.schemaName` and the
statement listener compares schema names exactly (statement.ts ~178). Fix: both
emitters now fire `schemaName: schema.name` (the canonical name off the
`getSchemaOrFail` result), and the existing canonical-`objectName` comments were
extended to cover the schema field. The listener compare was deliberately NOT
loosened to case-insensitive, keeping the canonicalize-at-the-emitter convention.

Comment refreshes per the ticket: the stale "no longer a way to observe that
invalidation" parenthetical in `view-tag-mutation-plan.spec.ts`'s header now
points at the new spec, and `buildViewMutation`'s dependency comment gained a
one-line pointer back.

## Validation performed

- New spec: 12/12 passing (was 10/12 before the manager fix — the two
  case-differing schema-qualified cases were the reproductions).
- Sibling `view-tag-mutation-plan.spec.ts`: 6/6 still passing (no duplication —
  its DROP-TAGS recovery cases were left alone).
- `yarn test` (workspace default): green — quereus 5675 passing / 9 pending
  (pending pre-existing), all other packages green.
- `yarn workspace @quereus/quereus run lint`: clean.

## Known gaps / reviewer attention

- **Same wrinkle exists for table-typed deps, out of scope here**:
  `commitTagUpdate` (manager.ts ~690 — `ALTER TABLE/CONSTRAINT/INDEX … TAGS`)
  and `createIndex` (~2070) still fire `table_modified` with the raw
  `targetSchemaName`. A case-differing schema-qualified `alter table MAIN.t set
  tags (…)` likely misses invalidating a cached statement whose `table` dep
  recorded canonical casing — unverified, no test written. The ticket scoped the
  fix to the two view/MV tag emitters only; reviewer should decide whether to
  spawn a fix/backlog ticket for the table-side emitters.
- **CREATE-side raw casing not covered**: `buildCreateViewStmt` stores
  `stmt.view.schema || 'main'` verbatim, so a view created as
  `create view MAIN.v` would store (and the dep would record) `'MAIN'` while the
  fixed emitters now fire canonical `'main'` — the inverse miss. No test pins
  this; arguably the CREATE path should canonicalize the stored `schemaName`.
  All tests here create views unqualified (canonical `'main'`), matching real
  usage.
- The invalidation observable is plan-object identity, not behavior — by design
  (legal non-reserved tags are exactly the regime where stale and fresh plans
  behave identically). A reviewer wanting belt-and-braces could note the
  behavioral half (invalid-tag surfacing on a cached statement) is pinned by the
  sibling spec's DROP-TAGS recovery cases.
- The spec relies on `@internal`-but-public surfaces (`db._buildPlan`,
  `stmt.compile()`) per the ticket's explicit design; no production surface was
  added.
