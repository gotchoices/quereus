----
description: Unit-pin the view-dependency plan-invalidation path — (a) view-/MV-mediated writes record a `view` schema dependency, (b) `view_modified` / `materialized_view_modified` invalidates the cached prepared plan — plus the canonical-schema-name event fix if the case-differing schema-qualified ALTER misses.
files:
  - packages/quereus/test/plan/view-dependency-invalidation.spec.ts  # NEW spec (this ticket's deliverable)
  - packages/quereus/src/planner/building/view-mutation-builder.ts   # recordDependency funnel (lines ~52-65) — read-only reference
  - packages/quereus/src/core/statement.ts                           # compile() plan cache + schema-change listener (lines ~127-205) — read-only unless listener compare needs the fix
  - packages/quereus/src/schema/manager.ts                           # updateViewTags / updateMaterializedViewTags emitters (~line 901 / ~969) — possible one-line canonical-schema-name fix
  - packages/quereus/src/planner/planning-context.ts                 # BuildTimeDependencyTracker.getDependencies() — read-only reference
  - packages/quereus/src/core/database.ts                            # _buildPlan returns { plan, schemaDependencies } — read-only reference
  - packages/quereus/test/plan/view-tag-mutation-plan.spec.ts        # sibling spec (DROP-TAGS recovery) — do NOT duplicate its cases
----

# Unit-pin view-dependency plan invalidation

Restore behavioral observability of the `view` plan-dependency invalidation
path, which lost its end-to-end observable when the last behavioral reserved
tag was retired (`remove-view-default-for-tag`). Today, deleting the
`recordDependency` call in `buildViewMutation` or the `view_modified` /
`materialized_view_modified` wiring would fail **no test**. This ticket pins
both halves at the unit level, using existing internal APIs only — no
production code change is expected except possibly the one-line
canonical-schema-name event fix below.

## The two observables (no new production surface)

**(a) Dependency recording** — `db._buildPlan(asts)` (`@internal`, public on
`Database`) returns `{ plan, schemaDependencies: BuildTimeDependencyTracker }`;
`schemaDependencies.getDependencies()` returns `SchemaDependency[]`
(`{ type, schemaName, objectName, objectVersion }`). Parse SQL with
`new Parser().parseAll(sql)` (see `Statement`'s constructor) and assert the
returned deps contain / omit `{ type: 'view', … }` entries.
`buildViewMutation` records `{ type: 'view', schemaName: view.schemaName,
objectName: view.name }` at the funnel top (view-mutation-builder.ts:62-65),
**before** any path branching — so a per-shape dep assertion proves that write
shape dispatches into the funnel at all.

**(b) Invalidation** — `Statement.compile()` (`@internal`, public) returns the
cached `BlockNode` (`if (this.plan && !this.needsCompile) return this.plan`).
The schema-change listener installed at compile time (statement.ts:~156-190)
nulls the plan on a matching event, so **plan-object identity across
`compile()` calls** is the invalidation observable:

```ts
const stmt = db.prepare("insert into v (id) values (1)");
const p1 = stmt.compile();
expect(stmt.compile()).to.equal(p1);            // positive cache control — REQUIRED
await db.exec("alter view v set tags (display_name = 'x')");
const p2 = stmt.compile();
expect(p2).to.not.equal(p1);                    // event invalidated the cached plan
await stmt.run();                               // re-planned statement still executes
```

The cache-positive control (`compile() === compile()` with no intervening
event) is load-bearing: without it the `!==` assertion would pass vacuously if
compile never cached. Drive the events through real SQL (`alter view … set
tags`, `alter materialized view … add tags`) so the parser → `SetObjectTagsNode`
emitter → `SchemaManager.set/merge/dropViewTags` → notifier → statement-listener
chain is exercised end to end; use only **legal, non-reserved** tags (e.g.
`display_name`) — that is exactly the regime where a stale plan and a fresh
plan behave identically, which is why identity (not behavior) is the assert.

## Likely product fix: canonical schema name in the tag-setter events

`updateViewTags` / `updateMaterializedViewTags` (schema/manager.ts) fire
`schemaName: targetSchemaName` — the **raw** schema name from the ALTER
(`plan.schemaName` flows through `emitSetObjectTags` verbatim) — while the
plan dependency records the canonical `view.schemaName`, and the statement
listener compares **exactly**: `dep.schemaName === event.schemaName`
(statement.ts:~178). The *object* name is already canonicalized in these
emitters (`objectName: updated.name`, with a comment explaining the
case-differing-ALTER miss it prevents); the *schema* name is not. So
`alter view MAIN.v set tags (…)` on a view created in `main` is expected to
miss invalidation.

Write the test first; if it reproduces, fix by firing the canonical schema
name — `schema.name` from the `getSchemaOrFail(targetSchemaName)` result — in
**both** the view and MV tag emitters (extend the existing canonical-name
comment to cover it). Do not "fix" it by loosening the listener compare to
case-insensitive: the rest of the event surface (e.g. `table_modified` from
alter-table.ts) already fires canonical `schemaName` from the schema object,
so canonicalizing at the emitter keeps the convention uniform.

## Test cases (new spec: `test/plan/view-dependency-invalidation.spec.ts`)

Mocha + chai like its siblings in `test/plan/`; fresh `Database` per test,
`afterEach` closes it; `stmt.finalize()` prepared statements.

**Dependency recording (via `_buildPlan`):**
- Single-source view INSERT (`create view v as select id from t` →
  `insert into v (id) values (1)`) records `{ type:'view', schemaName:'main',
  objectName:'v' }`.
- MV-mediated INSERT (`create materialized view mv as select id from t`)
  records a `view` dep for `mv`.
- Multi-source inner-join view UPDATE records a `view` dep — SQL shape from
  `test/logic/93.4-view-mutation.sqllogic` (`par_mj`): two base tables, view
  `select c.cid, c.note, p.label from c join p on …`, `update vj set note=… where cid=…`.
  This proves the non-single-source branch enters the funnel (recording sits
  above the `analyzeJoinView`/decompose branching).
- Read-side negative: `select id from v` records **no** `type:'view'` dep
  (it will record the base `table` dep — assert specifically on the absence of
  `view`-typed entries, not on emptiness).

**Invalidation (via prepared-statement `compile()` identity):**
- Cache-positive control then `alter view v set tags (…)` invalidates a
  prepared `insert into v …` (the snippet above); statement still runs after.
- `alter materialized view mv add tags (…)` (→ `materialized_view_modified`)
  invalidates a prepared `insert into mv …`.
- Repeat-invalidation: after the recompile (`p2`), a second
  `alter view v add tags (…)` invalidates again (`compile() !== p2`) — pins
  that recompile re-subscribes a live listener (compile removes the old
  unsubscriber and installs a new one).
- Unrelated-object negative: `alter view other set tags (…)` (a second view
  over the same table) does NOT invalidate the prepared write through `v`
  (objectName mismatch; same-name cross-type confusion is covered by this
  too since event-type→`'view'` mapping is shared).
- Read-side negative: a prepared `select … from v` keeps its plan identity
  across `alter view v set tags (…)` (its deps carry the base table, so a
  listener IS installed — the assert proves the `view`-typed match is what
  gates, not listener absence).
- Canonical view-name match: `create view MyView …`, prepare
  `insert into myview …`, `alter view MYVIEW set tags (…)` invalidates (the
  emitter fires the stored `updated.name`).
- Schema-qualified: `alter view main.v set tags (…)` invalidates; and the
  case-differing `alter view MAIN.v set tags (…)` must too — apply the
  manager fix above if (expectedly) it does not. Mirror one MV case for the
  fixed MV emitter (`alter materialized view MAIN.mv …`).

## Edge cases & interactions

- **Vacuous-pass guard**: every `!==` identity assert must be preceded by a
  `===` cache control in the same test (or a dedicated cache-control test the
  others lean on).
- **Listener re-subscription across recompiles** — the repeat-invalidation
  case above; a leaked stale unsubscriber or a missing re-subscribe both fail it.
- **Schema-name compare in the listener** is exact; the dep records canonical
  `view.schemaName` — the `MAIN.v` case and emitter fix above. Note
  `BuildTimeDependencyTracker` keys are `type:schema:objectName:version` and a
  recorded empty schema parses back as `undefined` (listener then skips the
  schema check) — view deps always carry a schema, so the match must hold both
  fields.
- **MV vs view event independence**: `view_modified` and
  `materialized_view_modified` both map to dep-type `'view'`; disambiguation is
  by objectName only. A view and an MV deliberately cannot share a name in one
  schema, so this is fine — but the unrelated-object negative keeps it honest.
- **Do not duplicate** the DROP-TAGS recovery cases in
  `view-tag-mutation-plan.spec.ts` (failed-compile-not-cached is pinned there;
  those tests pass with or without invalidation and prove nothing about it —
  the reason this ticket exists). Cross-reference it in the new spec's header
  comment, and update the stale parenthetical in ITS header (lines ~13-16,
  "no longer a way to observe that invalidation") to point at the new spec.
- **Comment refresh**: if the manager fix lands, extend the canonical-name
  comments in `updateViewTags`/`updateMaterializedViewTags`; the structural
  comment in `buildViewMutation` (lines ~52-61) can gain a one-line pointer to
  the new spec so the structural pin and the test pin reference each other.
- The `.sqllogic` harness re-prepares per statement, so none of this is
  expressible there — the focused spec is the right home (same rationale as
  the sibling spec).

## TODO

- Write `packages/quereus/test/plan/view-dependency-invalidation.spec.ts` with
  the dependency-recording and invalidation cases above (controls included).
- Run it; if the case-differing schema-qualified ALTER misses invalidation,
  apply the canonical-schema-name fix in `updateViewTags` and
  `updateMaterializedViewTags` (fire `schema.name`, extend comments) and
  confirm the test passes.
- Update the stale header parenthetical in
  `test/plan/view-tag-mutation-plan.spec.ts` to reference the new spec; add
  the cross-pointer in `buildViewMutation`'s dependency comment.
- `yarn test` (workspace default) green; `yarn workspace @quereus/quereus run lint` clean.
