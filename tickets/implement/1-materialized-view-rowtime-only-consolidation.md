description: Collapse materialized views onto a single maintenance model — row-time only. Remove the `manual` and `on-commit-incremental` refresh policies, the entire post-commit incremental/divergence/cascade subsystem, and the `with refresh = '...'` DDL knob. Make row-time eligibility the mandatory create-time gate (reject ineligible bodies up front, with diagnostics that steer to a plain view / `create table … as`). Reject MV-over-MV bodies for now (cascade is deferred). The end state: an MV is "a plain view the engine caches and keeps honest, transactionally."
prereq:
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/index.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/materialized-view-lateral-tvf.spec.ts, docs/materialized-views.md, docs/architecture.md, docs/incremental-maintenance.md
----

## Goal

Make **row-time** the sole materialized-view maintenance model. After this ticket
there is no refresh policy: every MV is row-time maintained synchronously inside
the writing transaction (reads-own-writes; rolls back with the write), and any
body that is not row-time-maintainable is **rejected at `CREATE`**. This collapses
the asynchronous on-commit incremental subsystem (delta residuals, the
divergence / two-tier self-heal recovery, MV-over-MV cascade) into ordinary
transactional rollback.

This ticket keeps row-time's eligibility **as it is today** (passthrough
projection, single source). Two scoped extensions land in chained follow-on
tickets that depend on this one:

- expression projections — `materialized-view-rowtime-expression-projections`
- per-statement batching — `materialized-view-rowtime-per-statement-batching`

The forward track for the broader rejected body shapes (single-source aggregates,
joins, lateral-TVF fan-out) is the existing `materialized-view-rowtime-general-bodies`
(plan/). MV-over-MV cascade is `materialized-view-rowtime-mv-over-mv-cascade` (backlog/).

## What stays vs. what goes

**Stays (contract unchanged, some simplify):**
- The row-time mechanism: the `dml-executor.ts` write-boundary hook
  (`maintainRowTimeStructures`), `applyMaintenanceToLayer` (privileged
  transactional write), `RowTimeMaintenancePlan` + `buildRowTimePlan`.
- Covering-structure link + coverage prover + row-time UNIQUE enforcement
  (`findRowTimeCoveringStructure`, `lookupCoveringConflicts`,
  `checkUniqueViaMaterializedView`, store-table parity path) — unchanged except
  they drop the now-impossible `diverged` check.
- `stale` (source *schema* change) and its read-path re-validation in `select.ts`.
- `sourceScope` change-scope projection (`Database.watch` on an MV → its sources).
- `REFRESH MATERIALIZED VIEW` — kept as an explicit full-rebuild/resync verb
  (no longer semantically required for currency, but useful after a `stale`
  structural break and as the drop-and-recreate-on-body-change implementation).
- `rebuildBacking` / `replaceBaseLayer` (used by create-fill and REFRESH).

**Goes (entirely):**
- `manual` and `on-commit-incremental` policies; the `RefreshPolicy` type,
  `DEFAULT_REFRESH_POLICY`, and `MaterializedViewSchema.refreshPolicy`.
- The `with refresh = '...'` DDL clause (parser, AST field, stringify).
- The on-commit incremental subsystem in `database-materialized-views.ts`:
  `compile`, `buildSubscription`, `runResidual`, `runPostCommit`,
  `applyMaintenanceAndCapture`, `buildDeleteKey`, the `DeltaExecutor`/
  `DeltaSubscription` wiring, the per-binding `'row'/'group'/'global'`
  classification, `computeDeleteKeyOrder`, the lateral-TVF fan-out path
  (`detectLateralTvf`, `computePrefixDeleteOrder`, `tvfBackingPortionIsSuperkey`,
  `collectTableFunctionCalls`, `collectOperandAttrIds`), the topo-rank / cascade
  machinery (`getTopoRanks`, `computeTopoRanks`, `getConsumedBackingBases`,
  `pendingDelta`, `globallyChangedBacking`, `overlayChangedTuples`, `overlayFor`,
  `markBackingRebuilt`, `synthesizeOverlayChange`), and the supporting
  interfaces (`CompiledIncrementalMV`, `ResidualArtifacts`,
  `PrefixDeleteDescriptor`, `OverlayChange`) and the `incremental` map.
- The divergence / self-heal subsystem: `MaterializedViewSchema.diverged`, the
  `select.ts` diverged read guard, the diverged clear in the REFRESH emitter, the
  `maintenanceFaultInjector` / `MaintenanceFaultPhase` seam,
  `Database._setMaterializedViewMaintenanceFault`, `recoveryRebuild`.
- The committed-base maintenance write `MemoryTableManager.applyMaintenance` and
  the `delete-by-prefix` `MaintenanceOp` kind + `deleteByPrefix` method — these
  were used **only** by the on-commit incremental path. (Verify: the row-time
  path uses `applyMaintenanceToLayer` and only the `delete-key` / `upsert` kinds;
  `rebuildBacking` uses `replaceBaseLayer`. Confirm no remaining caller before
  deleting.)

## Mandatory create-time gate (the contract change)

`registerMaterializedView` collapses to a single branch: **always** build the
row-time plan via `buildRowTimePlan`, which throws on an ineligible shape; the
create emitter already rolls the MV back on throw. There is no `manual` fallback
that accepts an ineligible body.

`buildRowTimePlan`'s `reject(detail)` diagnostic currently appends
*"use 'on-commit-incremental' or 'manual' refresh"* — that steer is now invalid.
Reword every rejection to name the unsupported shape and point at a plain
**`view`** (live re-evaluation) or **`create table … as <body>`** (one-off
snapshot). Keep eligibility otherwise identical to today (single source with a
PK; linear `TableReference → Filter? → Project → Sort?`; no aggregate / join /
DISTINCT / set-op / recursive CTE / TVF / LIMIT/OFFSET; passthrough projection
covering every source PK column; single-row-evaluable partial WHERE).

**Reject MV-over-MV (cascade deferral, option b).** After resolving the single
source base in `buildRowTimePlan`, reject when that source is itself another MV's
backing table (`schemaManager.getMaterializedViewByBackingTable(schema, table)`
returns an MV — backing names carry the reserved `_mv_` prefix). Rationale: a
write to a backing table goes through `applyMaintenanceToLayer` (privileged), not
the DML-executor hook that fires `maintainRowTime`, so a dependent MV would never
be maintained and would silently serve stale rows. Diagnostic should name the
shape and point at `materialized-view-rowtime-mv-over-mv-cascade`. (Today this
shape is silently accepted and broken — the gate must close it.)

## Post-commit wiring removal

`runPostCommit` / `runPostCommitMaterializedViews` are removed:
- `database-materialized-views.ts`: delete `runPostCommit`.
- `database.ts`: delete `runPostCommitMaterializedViews` and
  `_setMaterializedViewMaintenanceFault`; update `registerMaterializedView` /
  `unregisterMaterializedView` doc comments (no longer "on-commit-incremental").
- `database-transaction.ts`: drop `runPostCommitMaterializedViews` from
  `TransactionManagerContext` and remove its call in the commit path (the
  watcher post-commit pass stays). The MV is no longer a post-commit consumer.
- `MaterializedViewManagerContext` shrinks: the change-log members
  (`getChangedBaseTables`, `getChangedTuples`, `registerCaptureSpec`) existed only
  for the incremental `DeltaExecutor` — remove them from the MV context interface
  and from the context object built in `database.ts` (the Database keeps those
  methods for the assertion/watcher managers). Drop the now-unused imports
  (`DeltaExecutor`, `DeltaSubscription`, `BindingMode`/`PlanBindings`,
  `injectKeyFilter`, aggregate/join/TVF plan-node helpers) — keep
  `buildSourceUnionScope` (still used for `sourceScope`).

## File header / change-scope cleanup

- `database-materialized-views.ts` module header: rewrite to two responsibilities
  (staleness + row-time write-through); drop responsibility #2 (incremental).
- `statement.ts` `getChangeScope` → `resolveMaterializedViewSource`: with no
  policy, simplify to `return sm.getMaterializedViewByBackingTable(...)?.sourceScope`
  (every registered MV is row-time and carries `sourceScope`). Remove the
  `refreshPolicy?.kind` check.
- `vtab/memory/layer/manager.ts` `CoveringStructure` doc comment: drop the
  "`manual` / `on-commit-incremental` covering MV is NOT row-time consistent"
  sentence (no other kind exists now).

## Tests

- **Remove** `52-materialized-views-incremental.sqllogic` (the on-commit suite).
- **`53-materialized-views-rowtime.sqllogic`**: drop every `with refresh = 'row-time'`
  → bare `create materialized view … as …`. Remove the `d_ci` / "differential vs
  on-commit-incremental" case (lines ~98–127) and its framing. The `bad_expr`
  rejection (`select id, v + 1 …`) currently expects an error — leave it asserting
  rejection in THIS ticket (the expression-projections follow-on flips it to an
  acceptance + maintenance case). All other `bad_*` rejections stay (they assert
  the mandatory gate). Add a **MV-over-MV rejection** case (an MV whose body reads
  another MV) asserting the new create-time diagnostic.
- **`54-covering-mv-enforcement.sqllogic`**: drop `with refresh = 'row-time'`
  → bare DDL throughout.
- **`51-materialized-views.sqllogic`**: this suite frames MVs as `manual` snapshots
  ("source mutation does NOT update the MV until refresh", lines ~19–51). Under
  row-time, source writes are reflected immediately. Rewrite the affected cases to
  assert immediate currency (and keep `refresh` only as the explicit resync verb).
  The bag/duplicate cases (`mv_u`, lines ~163–174) assume a key-dropping body that
  row-time now rejects — replace with eligible bodies (project the PK).
- **`materialized-view-diagnostics.spec.ts`**: delete the second `describe`
  ("incremental-apply failure visibility") entirely — `diverged`,
  `_setMaterializedViewMaintenanceFault`, and the two-tier recovery are gone. The
  first `describe` (create diagnostics) uses bodies that are no longer eligible
  (`select status from orders`, `select distinct status …`); rework so the
  "rollback leaves the name free after a failed create" guarantee is proven with
  a row-time-ineligible body that the gate rejects, then an eligible body that
  succeeds. (The "must be a set" duplicate-key path is structurally unreachable
  for an eligible body — per docs — so assert the gate's shape diagnostic instead.)
- **`materialized-view-lateral-tvf.spec.ts`**: delete — lateral-TVF fan-out was an
  on-commit-incremental-only path; row-time rejects TVF bodies. (Its scenarios
  migrate to `materialized-view-rowtime-general-bodies` when that lands.)
- The existing `fix/materialized-view-rowtime-test-coverage` and
  `fix/materialized-view-state-flags-bypass-cached-plans` tickets are related; do
  not fold them in, but ensure this ticket does not contradict them (the latter
  expects the cached-plan bypass to be `stale`-only, which this ticket realizes by
  removing `diverged`).

## Obsoleted backlog tickets (flag for removal)

These describe the deleted on-commit-incremental subsystem and are moot after this
consolidation. The reviewer should delete them (do not silently leave them as live
work): `materialized-view-incremental-join-bodies`, `-recursive-cte`, `-set-ops`,
`-tvf-sources`, `-cascading-convergence`, `-apply-failure-visibility`,
`-bag-body-duplicates`, `2-materialized-view-incremental-refresh`,
`2.6-materialized-view-incremental-changescope`. (Listed here so the review pass
can clean them up; this ticket need not delete them, but may.)

## Docs

The three docs are **already** written to the row-time-only target. Only minor
edits remain:
- `docs/materialized-views.md`: delete the `> **Status.**` blockquote (lines
  ~17–23) now that removal has landed; spot-check that no stray "in progress"
  wording remains.
- `docs/architecture.md` + `docs/incremental-maintenance.md`: already reflect the
  target ("Materialized views are *not* a kernel consumer"); verify no remaining
  `on-commit` / `diverged` references and fix any that slipped through.

## Validation

- `yarn workspace @quereus/quereus build` clean (the type system catches every
  dangling `refreshPolicy` / `diverged` reference — work through them).
- `yarn workspace @quereus/quereus lint` clean (single-quote globs on Windows).
- `yarn test` green. Stream output: `yarn test 2>&1 | tee /tmp/mv.log; tail -n 80 /tmp/mv.log`.
- Sanity: `create materialized view` over a join / aggregate / set-op / recursive /
  TVF / non-PK-projection / MV-over-MV body each errors at create with a
  shape-specific diagnostic that does **not** mention `refresh` policies; an
  eligible body reflects source insert/update/delete immediately (reads-own-writes)
  and rolls back fully on rollback; `grep -ri "diverged\|on-commit\|refreshPolicy\|with refresh" packages/quereus/src` returns nothing.

## TODO

### Phase 1 — DDL surface removal
- Remove the `with refresh` clause from `parser.ts` (the `WITH REFRESH` branch in
  the create-MV WITH loop + `parseRefreshPolicyValue`); keep `with tags`.
- Remove `refreshPolicy` from `CreateMaterializedViewStmt` (`ast.ts`).
- Remove the `with refresh = '...'` emission from `createMaterializedViewToString`
  (`ast-stringify.ts`).
- Remove the `refreshPolicy` ctor param from `CreateMaterializedViewNode`
  (`materialized-view-nodes.ts`) and stop threading it in
  `building/materialized-view.ts`.

### Phase 2 — schema + emitter
- `schema/view.ts`: delete `RefreshPolicy`, `DEFAULT_REFRESH_POLICY`,
  `MaterializedViewSchema.refreshPolicy`, `MaterializedViewSchema.diverged`.
  Rewrite the doc comments. Remove the `RefreshPolicy` re-export from `index.ts`.
- `runtime/emit/materialized-view.ts`: delete `refreshPolicyKind` + the
  `RefreshPolicy` import; construct the MV record without `refreshPolicy`; remove
  the `mv.diverged = false` clear in the REFRESH emitter.

### Phase 3 — manager removal + mandatory gate
- `database-materialized-views.ts`: delete the incremental subsystem, the
  divergence/recovery/fault seam, the cascade/topo/overlay machinery, and
  `runPostCommit` (see "What goes"). Rewrite the module header. Collapse
  `registerMaterializedView` to always build the row-time plan; reword
  `buildRowTimePlan`'s rejection diagnostics; add the MV-over-MV rejection.
  Shrink `MaterializedViewManagerContext`. Drop `diverged` checks in
  `findRowTimeCoveringStructure`.
- `database.ts`: delete `runPostCommitMaterializedViews`,
  `_setMaterializedViewMaintenanceFault`; update register/unregister doc comments;
  drop the removed members from the MV-manager context object.
- `database-transaction.ts`: remove `runPostCommitMaterializedViews` from the
  context + commit path.

### Phase 4 — read path
- `select.ts`: remove the `diverged` read guard; keep the `stale` re-validation.
- `statement.ts`: simplify `resolveMaterializedViewSource` to drop the policy check.

### Phase 5 — memory manager
- `vtab/memory/layer/manager.ts`: remove `applyMaintenance` (committed-base) +
  `deleteByPrefix` + the `delete-by-prefix` `MaintenanceOp` variant (after
  confirming no remaining callers). Update the `CoveringStructure` doc comment.

### Phase 6 — tests + docs
- Update/remove the sqllogic suites and mocha specs per "Tests".
- Trim the `> Status` note from `docs/materialized-views.md`; verify
  `architecture.md` / `incremental-maintenance.md`.
- Build + lint + `yarn test` green.
