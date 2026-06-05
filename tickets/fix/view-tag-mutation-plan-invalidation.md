description: A cached/prepared statement that writes through an updatable view keeps stale `quereus.update.*` routing after `ALTER VIEW … SET TAGS`, because view tag changes fire no schema-change event and views are not tracked as plan dependencies.
files:
  - packages/quereus/src/schema/manager.ts                  # setViewTags / setMaterializedViewTags fire no change event
  - packages/quereus/src/core/statement.ts                  # plan invalidation maps table_/function_/module_/collation_ events to deps (no 'view')
  - packages/quereus/src/planner/planning-context.ts        # SchemaDependency.type union has no 'view'
  - packages/quereus/src/planner/building/insert.ts         # getView/getMaterializedView during view-mediated write (records no dependency)
  - packages/quereus/src/planner/building/update.ts         # same
  - packages/quereus/src/planner/building/delete.ts         # same
  - packages/quereus/src/schema/change-events.ts            # SchemaChangeEvent union (no view_modified)
  - packages/quereus/src/planner/mutation/mutation-tags.ts  # readDefaultFor — the behavioral tag consumed at plan time
----

# Fix: invalidate cached write-through plans after ALTER VIEW … SET TAGS

## Symptom (reproduced)

A view's `quereus.update.default_for.<column>` tag supplies an omitted-insert
default when writing through the view. After `ALTER VIEW v SET TAGS (...)` changes
that tag, an **already-prepared** statement that inserts through `v` keeps using
the *old* default — it serves a stale plan. A freshly `exec`'d (re-prepared)
statement routes correctly.

Reproduction (memory backend, on the branch where this was reviewed):

```js
const db = new Database();
await db.exec('create table t (id integer primary key, x integer not null, created integer not null)');
await db.exec("create view v as select id, x from t with tags (\"quereus.update.default_for.created\" = '100')");
const stmt = db.prepare('insert into v (id, x) values (?, ?)');
await stmt.run([1, 10]);                                                       // created = 100  ✓
await db.exec("alter view v set tags (\"quereus.update.default_for.created\" = '200')");
await stmt.run([2, 20]);                                                       // created = 100  ✗ (expected 200)
```

Observed: row 2 gets `created = 100` (stale). Expected: `200`.

## Root cause

Two gaps combine:

1. **No event.** `SchemaManager.setViewTags` / `setMaterializedViewTags` fire no
   schema-change event (deliberately mirroring the no-event view-create path —
   `materialized_view_added` would mislead listeners into re-registering
   maintenance, and there is no `*_modified` event for views/MVs).
2. **No dependency tracking for views.** A query that writes through a view is
   planned by expanding the view into its base table(s); the plan records a
   `SchemaDependency` on the **base table**, never on the view (the
   `SchemaDependency.type` union is `table | function | vtab_module | collation`
   — there is no `view`). `Statement`'s invalidation listener
   (`core/statement.ts`) only re-compiles on `table_/function_/module_/collation_`
   events matching a recorded dependency. An `ALTER VIEW` touches neither the base
   table nor any recorded dependency, so nothing invalidates the cached plan.

Contrast with `ALTER TABLE … SET TAGS`, which fires `table_modified` on a
*tracked* table dependency and therefore correctly invalidates dependents.

## Scope / impact

- Narrow but a real correctness bug: only bites a long-lived prepared statement
  that writes through an updatable view whose `quereus.update.*` tags are changed
  mid-life. `db.exec` (fresh prepare each call) is unaffected.
- Read-only `SELECT … FROM v` is unaffected (view tags do not change read
  results).
- Same shape applies to materialized-view write-through if MV `quereus.update.*`
  tags are mutated (MVs also route through `buildViewMutation`).
- A doc caveat was added in `docs/sql.md` §2.7 (SET TAGS on views) during the
  review pass pointing at this ticket; remove/soften it once fixed.

## Approach (sketch — confirm during implement)

Pick the lighter correct option:

- **Add a `view` dependency type + a view-modified event.** Record a `view`
  `SchemaDependency` when a plan resolves a view (read or write-through), add a
  `view_modified` (and MV-modified) `SchemaChangeEvent`, fire it from the
  setters, and map `view_` events to the `view` dependency type in
  `core/statement.ts`. Most precise; most surface.
- **Coarse invalidation.** Have the view/MV tag setters fire an event that bumps
  a global schema generation (or invalidates all cached plans). Simplest;
  over-invalidates but tag mutations are rare. May be acceptable given the
  narrowness.

Whatever is chosen, the setters' "no event" rationale (avoiding a spurious
`materialized_view_added` re-registration of maintenance) must be preserved — the
new event must be distinct from the create event.

## Acceptance

- The reproduction above yields `created = 200` for row 2 on the **same** cached
  statement after `ALTER VIEW … SET TAGS`.
- A regression test (memory backend) covering: prepared write-through INSERT,
  `ALTER VIEW SET TAGS` changing `default_for`, re-execute, assert new default.
- MV analogue if MV write-through with `quereus.update.*` is in scope.
- No spurious maintenance re-registration when MV tags change (the existing
  `declarative-equivalence` "MV tag-only drift … without a rebuild" test must
  still pass).
- Re-soften the `docs/sql.md` known-limitation note added during review.
