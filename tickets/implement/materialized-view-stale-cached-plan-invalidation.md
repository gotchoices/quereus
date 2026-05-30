description: A cached prepared-statement plan that reads a materialized view bypasses the build-time `stale` re-validation guard, silently serving stale backing rows after a source schema change. Fix by emitting a backing-table schema-change event whenever a source change (re)marks the MV stale, so dependent cached plans invalidate → recompile → re-hit the guard.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/schema/change-events.ts, packages/quereus/test/plan/materialized-view-plan.spec.ts
----

## Problem (confirmed by reproduction)

A `select <cols> from mv` is resolved in `select.ts` `buildFrom` to a
`buildTableReference` against the **backing** table `_mv_<name>` (after an
optional build-time `stale` re-validation of the body). The compiled `Statement`
therefore records exactly one table dependency — on `_mv_<name>` — via
`resolveTableSchema` (`schema-resolution.ts`).

The `Statement` recompiles only when the schema-change notifier emits a `table_*`
event whose `objectName` matches a tracked dependency (`statement.ts` →
`schemaChangeUnsubscriber` listener, `needsCompile`). When a **source** table is
altered/dropped, `MaterializedViewManager.subscribeToSchemaChanges`
(`database-materialized-views.ts`) sets `mv.stale = true` and releases the
row-time plan, but emits **no** event naming the backing table. So the cached
statement is never invalidated: its backing-reference plan re-runs and bypasses
the build-time `stale` guard, returning rows against a structurally-changed
source with no error/re-validation.

A *fresh* `db.eval('select … from mv')` re-plans, hits the guard, and errors
correctly — proving the gap is plan-caching-specific.

### Reproduction (verified failing on current HEAD)

```ts
const db = new Database();
await db.exec(`
  create table t (x integer primary key, y text);
  insert into t values (1, 'a');
  create materialized view mv as select x, y from t;`);

const stmt = await db.prepare('select x, y from mv order by x');
for await (const _ of stmt.iterateRows()) { /* plan cached */ }

await db.exec('alter table t drop column y;');          // -> mv.stale === true
// A fresh prepare here errors with /stale/ (control).

await stmt.reset();
let errored = false;
try { for await (const _ of stmt.iterateRows()) {} } catch (e) { errored = /stale/i.test(e.message); }
// BUG: errored === false — cached plan served the backing read, bypassing the guard.
```

## Root-cause facets

1. **Missing invalidation signal.** Marking `stale` does not notify the
   statement-cache machinery, and the statement's only dependency is the backing
   table — which the *source* event does not name.

2. **The guard is not baked into the cached plan.** The `select.ts` `stale` guard
   re-validates the body at *build* time, then resolves to the same backing
   reference either way. It does **not** add a runtime stale-recheck to the
   emitted plan. Consequence: a plan compiled *while the MV is already stale* is
   equally vulnerable to a **subsequent** incompatible source change. Therefore
   the invalidation must fire on **every** source change that (re)marks an MV
   stale — not only the `false → true` transition.

## Chosen fix (Option A — reuse the existing invalidation contract)

In `MaterializedViewManager.subscribeToSchemaChanges`
(`database-materialized-views.ts`), when a `table_removed` / `table_modified`
event names a table in an MV's `sourceTables`, after setting `mv.stale = true`
and releasing the row-time plan, **emit a synthetic `table_modified` event for
that MV's backing table** (`mv.backingTableName`, schema `mv.schemaName`) on the
same notifier (`this.ctx.schemaManager.getChangeNotifier()`).

Why this works end-to-end:
- The cached `Statement`'s dependency is `{type:'table', schemaName:
  mv.schemaName, objectName: '_mv_<name>'}`. The `Statement` listener maps
  `table_*` → `'table'` and matches on `type` + `objectName` +
  (`schemaName` optional) → sets `needsCompile = true`, clears the cached plan.
- Next execution recompiles, re-entering `buildFrom`, which re-hits the
  build-time `stale` guard and either errors (body no longer plans) or serves
  correct rows (compatible change).

Emit on **every** qualifying source change (not gated by `!mv.stale`) so the
"compiled-while-already-stale" facet is covered. Keep the existing
transition-only logging if desired, but the emit itself must be unconditional per
qualifying event.

### Re-entrancy / safety notes (validated against current code)

- `SchemaChangeNotifier.notifyChange` (`schema/change-events.ts`) iterates a
  `Set` with `for…of` and never mutates the set during iteration. Calling
  `notifyChange` again from *within* a listener is a fresh, independent
  iteration — safe, no structural mutation of the outer set.
- **No infinite loop.** The synthetic event names the backing table
  (`_mv_<name>`). The MV manager's own listener checks
  `mv.sourceTables.includes(changed)`; backing tables are never in any MV's
  `sourceTables` (sources are user tables; MV-over-MV is rejected at create
  today), so the nested event is a no-op for the MV manager. It only invalidates
  statements depending on the backing table — exactly the target set.
- `TableModifiedEvent` requires `oldObject`/`newObject: TableSchema`. Fetch the
  backing schema via `this.ctx.schemaManager.getTable(mv.schemaName,
  mv.backingTableName)` and pass it as both (the statement listener ignores the
  payload — it matches on type/name only). The backing table still exists even
  when the *source* was dropped. If the backing lookup unexpectedly returns
  `undefined`, skip the emit (the MV is already in a broken state) rather than
  fabricate a partial event.

### Alternative considered (Option B — runtime guard) — rejected

Moving the guard to the emit/runtime layer (check the live `stale` flag when the
backing scan runs) is immune to plan caching but more invasive: the backing-scan
emitter has no MV context, and a correct runtime check would need to re-plan the
body on each scan (the current diagnostic comes from re-planning). Option A
reuses the already-understood dependency→`table_*`→recompile contract and keeps
the single diagnostic site in `select.ts`.

## Regression test

A prepared-statement caching scenario cannot be expressed in `.sqllogic` (each
statement re-plans), so add a focused `.spec.ts` case. Suggested home:
`packages/quereus/test/plan/materialized-view-plan.spec.ts` (it already covers MV
plan-shape + stale-but-valid resolution), or a new
`test/runtime/materialized-view-stale-cached-plan.spec.ts`.

Assertions:
- Prepare + iterate `select x, y from mv` (caches the plan).
- `alter table t drop column y` → assert `mv.stale === true` precondition.
- Re-`reset()` + re-iterate the **same** statement → must throw `/stale/i`
  (currently does not — this is the regression guard).
- (Control) a freshly prepared statement also throws `/stale/i`.
- Optional second facet: a *compatible* alter (`add column z`) on a fresh MV,
  prepare+cache while stale, then a follow-up *incompatible* alter, and assert
  the cached plan re-validates — covers the "compiled-while-already-stale" path
  and justifies the unconditional emit.

## Validation

- `node test-runner.mjs --reporter spec --grep "<new test name>"` from
  `packages/quereus` to run the new case quickly.
- `yarn test` (memory vtab) for the full suite. The fix touches only the schema
  notifier + MV manager; the store path shares the same notifier, so memory
  coverage is representative. Note any deferral of `yarn test:store` rather than
  running it inline.
- `yarn workspace @quereus/quereus lint` (single-quote globs on Windows).

## TODO

- In `database-materialized-views.ts` `subscribeToSchemaChanges`: after marking
  an MV stale + releasing its row-time plan for a qualifying source event, emit a
  `table_modified` event for `mv.backingTableName` (schema `mv.schemaName`) on
  `this.ctx.schemaManager.getChangeNotifier()`, using the backing `TableSchema`
  as old/new. Emit unconditionally per qualifying event (not gated on the
  `!mv.stale` transition). Guard against a missing backing schema by skipping the
  emit.
- Decompose into a small helper (e.g. `emitBackingInvalidation(mv)`) to keep the
  listener body single-purpose (per AGENTS.md).
- Add the regression `.spec.ts` case(s) described above.
- Confirm no nested-notification regression: run the existing MV suites
  (`test/plan/materialized-view-plan.spec.ts`,
  `test/logic/51-materialized-views.sqllogic`,
  `test/logic/53-materialized-views-rowtime.sqllogic`,
  `test/logic/54-covering-mv-enforcement.sqllogic`,
  `test/covering-structure.spec.ts`).
- If a brief note is warranted, update `docs/materialized-views.md` where the
  `stale` read-state guard is described, mentioning that cached plans are
  invalidated via a backing-table schema-change event.
