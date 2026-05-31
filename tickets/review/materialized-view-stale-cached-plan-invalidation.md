description: Review the fix for stale-MV cached-plan invalidation — a synthetic backing-table `table_modified` event emitted on every qualifying source change, so cached prepared-statement plans reading an MV's backing table invalidate → recompile → re-hit the build-time `stale` guard.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/plan/materialized-view-plan.spec.ts, docs/materialized-views.md, packages/quereus/src/planner/building/select.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/schema/change-events.ts
----

## What the fix does

A `select <cols> from mv` resolves (in `building/select.ts` `buildFrom`) to a
`TableReference` against the backing table `_mv_<name>`, after an optional
**build-time** `stale` re-validation of the body. A compiled `Statement`
therefore records exactly one schema dependency — on `_mv_<name>`. The
`Statement` only recompiles when a `table_*` change event names a tracked
dependency. A **source** schema change marked the MV `stale` but emitted **no**
event naming the backing table, so a cached statement's backing-reference plan
re-ran and **bypassed the build-time guard**, silently serving stale rows. A
*fresh* prepare re-planned and errored correctly — proving the gap is
plan-caching-specific.

**Fix (Option A from the implement ticket — reuse the existing
dependency→`table_*`→recompile contract):** in
`MaterializedViewManager.subscribeToSchemaChanges`, after marking an MV stale +
releasing its row-time plan for a qualifying `table_removed` / `table_modified`
source event, call a new single-purpose helper `emitBackingInvalidation(mv)` that
emits a **synthetic `table_modified` event for the MV's backing table**
(`mv.backingTableName`, schema `mv.schemaName`) on the same notifier, passing the
backing `TableSchema` as both `oldObject`/`newObject`. The emit is
**unconditional per qualifying event** (NOT gated on the `false→true` stale
transition) so a plan compiled *while the MV is already stale* is invalidated by a
**subsequent** incompatible source change too.

Net change is ~20 LOC of behavior + a doc paragraph and two regression tests.

## Key correctness facets to verify

- **Payload-ignoring match.** The `Statement` listener (`core/statement.ts`
  `compile()`) maps `table_*` → `'table'` and matches on `type` + `objectName`
  (+ optional `schemaName`) only — it never reads `oldObject`/`newObject`. So
  passing the unchanged backing schema as both is sound. Confirm the dependency's
  `objectName` is exactly `mv.backingTableName` (`_mv_<name>`, lowercased) and the
  schema matches `mv.schemaName` — the two regression tests exercise this end to
  end.
- **Unconditional emit is load-bearing.** The second regression test
  (`re-validates a plan compiled while already stale on a later incompatible
  change`) fails if the emit is re-gated on the `!mv.stale` transition: a
  compatible `add column` flips `stale` true first, then the plan is compiled
  while stale, then a `drop column` must still invalidate it. Verify the test
  actually depends on the unconditional behavior (it does — the false→true
  transition already happened on the first alter).
- **No infinite loop / re-entrancy.** `notifyChange` iterates a `Set` with
  `for…of` and never mutates it during iteration; a nested `notifyChange` from
  within a listener is a fresh independent iteration. The synthetic event names
  the backing table, which is **not** in any *plain* MV's `sourceTables`, so the
  manager's own source-tracking listener no-ops on it.
- **MV-over-MV cascade (behavior change — please scrutinize).** Since MV-over-MV
  is now supported (a consumer MV's source *is* the producer's backing table),
  the synthetic backing event **does** match a consumer MV's `sourceTables` and
  cascades staleness down the chain (mark stale + release row-time + emit the next
  backing event). This terminates because the producer→consumer graph is a DAG (a
  consumer requires its producer to pre-exist). This is **new** behavior: a source
  schema change to `t` now transitively marks `mv2` (built on `mv1`) stale, not
  just `mv1`. It is conservative and arguably more correct, and no existing test
  exercised alter/drop on an MV-over-MV source so nothing broke — **but there is
  no positive test asserting it.** Consider adding one: create `t`→`mv1`→`mv2`,
  alter `t` incompatibly, assert both `mv1.stale` and `mv2.stale`, and that a
  cached `select from mv2` recompiles. (Note: `mv2`'s body reads `mv1`'s backing,
  whose schema is unchanged, so `mv2`'s re-validation *passes* and it serves its
  frozen snapshot — confirm that is the intended conservative outcome, not an
  error.)

## Cross-listener side effects (verified benign; reviewer should sanity-check)

The synthetic `table_modified` on `_mv_<name>` is also seen by the other two
`table_*` subscribers:
- `core/database-assertions.ts` bumps `schemaGeneration++` (assertion plan-cache
  invalidation). An alter already bumps it once for the source; now it bumps once
  more per dependent MV. Extra cache churn → recompile; correctness-neutral.
- `core/database-watchers.ts` calls `invalidateForTable('_mv_<name>')`. Watchers
  on an MV project to the *source* (`sourceScope`), never to the backing table, so
  this invalidates nothing — effective no-op.
- `planner/analysis/assertion-hoist-cache.ts` reacts only to `assertion_*` — not
  affected.

Worth a moment's thought: is there any *other* present-or-future listener that
treats `table_modified` as "the schema actually changed" and does expensive or
incorrect work given an event whose old/new schemas are identical? None found
today; the full suite (assertions + watchers included) is green.

## Tests added

`packages/quereus/test/plan/materialized-view-plan.spec.ts` — new describe block
`Materialized view stale invalidation of cached plans`:
1. **incompatible source change** — prepare + iterate `select x, y from mv`
   (caches the backing-reference plan), `alter table t drop column y` (assert
   `mv.stale === true` precondition), control fresh `db.eval` errors `/stale/i`,
   then the **same cached** statement after `reset()` must also recompile + error
   `/stale/i`. This is the core regression guard (fails on HEAD before the fix).
2. **compiled-while-already-stale** — compatible `add column z` marks stale,
   prepare + iterate while stale (plan caches, body still plans), then a
   subsequent `drop column y` must invalidate the cached plan → `/stale/i`. Guards
   the unconditional-emit facet.

Both assert against `/stale/i` (the diagnostic substring), matching the
build-time guard's wording in `building/select.ts`
(`… is stale; a source changed in an incompatible way — drop and recreate …`).

## Known gaps / honesty notes (treat the tests as a floor)

- **No MV-over-MV staleness-cascade test** (see facet above) — the most valuable
  addition a reviewer could make. The cascade path is exercised structurally by
  the existing row-time cascade oracle, but not for the *schema-change* path my
  emit newly drives.
- **No assertion that the cached plan was actually re-emitted vs. re-validated.**
  The tests assert the observable outcome (error on the cached statement), not the
  internal `needsCompile`/`plan=null` transition. That is intentional (black-box),
  but a reviewer wanting white-box coverage could assert `stmt`'s recompile
  directly.
- **Store path not run inline.** The change touches only the schema notifier + MV
  manager; the LevelDB store path shares the *same* `SchemaChangeNotifier`, so
  memory coverage is representative. `yarn test:store` was **deferred** (slow;
  not agent-runnable inline) — a reviewer/CI should run it if they want store
  confirmation, but no store-specific code was touched.
- **`oldObject === newObject` identity.** Both point at the same `TableSchema`
  instance (not a clone). No consumer mutates the payload today, but if a future
  listener diffs old vs new by reference it would see "no change" — acceptable for
  this synthetic event whose only job is name-based invalidation, but noted.

## Validation run (all green)

- `node test-runner.mjs --grep "stale invalidation of cached plans"` → 2 passing.
- `node test-runner.mjs --grep "[Mm]aterialized"` → 72 passing (cascade oracle,
  covering-index/aggregate/lateral-TVF equivalence, sqllogic 51/53/53.1, gate
  diagnostics, plan-shape — all green).
- `yarn workspace @quereus/quereus test` (full memory suite) → **4086 passing, 9
  pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` → clean (exit 0).
- `docs/materialized-views.md` § Schema-change staleness updated: the build-time
  guard is now noted as build-time-only, and a **Cached-plan invalidation**
  paragraph documents the synthetic backing-table event (replacing the former
  "known limitation" note that tracked exactly this bug).
