description: Review — materialized views collapsed onto a single row-time maintenance model. The `manual` / `on-commit-incremental` policies, the `with refresh = '...'` DDL knob, the entire post-commit incremental/divergence/cascade subsystem, and the committed-base `applyMaintenance`/`deleteByPrefix` path are removed. Row-time eligibility is now the mandatory create-time gate; MV-over-MV bodies are rejected (cascade deferred). An MV is now "a plain view the engine caches and keeps honest, transactionally."
prereq:
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/index.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, packages/quereus/test/logic/change-scope.spec.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/covering-structure.spec.ts, packages/quereus/test/declarative-equivalence.spec.ts, packages/quereus-store/test/unique-constraints.spec.ts, docs/materialized-views.md
----

## What landed

Row-time is now the **sole** materialized-view maintenance model. There is no
refresh policy and no `with refresh = '...'` DDL. Every MV is row-time maintained
synchronously inside the writing transaction (reads-own-writes; rolls back with the
write). Any body that is not row-time-maintainable is **rejected at `CREATE`** by a
single mandatory gate; the create emitter already rolls the half-built MV back on
throw, so an ineligible body errors cleanly and leaves the name free.

The entire asynchronous subsystem is gone: `manual`/`on-commit-incremental`
policies, the `RefreshPolicy` type + `DEFAULT_REFRESH_POLICY`, the
`refreshPolicy`/`diverged` schema fields, the post-commit `DeltaExecutor` wiring
(`compile`/`buildSubscription`/`runResidual`/`runPostCommit`), the
divergence/self-heal/fault-injection seam, the topo/overlay/cascade machinery, the
lateral-TVF fan-out path, and the committed-base `MemoryTableManager.applyMaintenance`
+ `deleteByPrefix` + the `delete-by-prefix` `MaintenanceOp` kind.

Eligibility is **unchanged from before** (single keyed source; linear
`TableReference → Filter? → Project → Sort?`; passthrough projection covering every
source PK column; single-row-evaluable partial WHERE) **plus one new rejection**:
MV-over-MV bodies (a source that is itself another MV's backing table) are rejected
— a write to a backing table bypasses the DML-executor hook that fires row-time
maintenance, so a dependent MV would silently serve stale rows. Cascade is deferred
to `materialized-view-rowtime-mv-over-mv-cascade` (backlog).

`buildRowTimePlan`'s rejection diagnostic was reworded: every rejection now names
the unsupported shape and steers to a plain `create view` (live re-evaluation) or
`create table … as <body>` (one-off snapshot). It never mentions a refresh policy.
Format: `materialized view '<name>' cannot be materialized: <shape>. A materialized
view must be row-time maintainable … use a plain 'create view' … or 'create table
... as <body>' …`.

## Kept intact (verify these still hold)

- Row-time mechanism: `applyMaintenanceToLayer` (privileged transactional write,
  `delete-key`/`upsert` only), `maintainRowTime`, `RowTimeMaintenancePlan`,
  `buildRowTimePlan`, the DML write-boundary hook.
- Covering-structure link + coverage prover + row-time UNIQUE enforcement
  (`findRowTimeCoveringStructure` — now drops the impossible `diverged` check, keeps
  the `stale` check; `lookupCoveringConflicts`; store-table parity).
- `stale` (source *schema* change) + read-path re-validation in `select.ts`.
- `sourceScope` change-scope projection (`Database.watch` on an MV → its sources);
  `statement.ts` `resolveMaterializedViewSource` simplified to
  `getMaterializedViewByBackingTable(...)?.sourceScope` (every registered MV is
  row-time and carries `sourceScope`).
- `REFRESH MATERIALIZED VIEW` (explicit full rebuild), `rebuildBacking`/`replaceBaseLayer`.

## ⚠ Cross-ticket interaction the reviewer MUST scrutinize

The recently-landed `coverage-prover-inner-join-fk-preservation` /
`coverage-prover-qualified-name-resolution` work added support for **join-body**
covering MVs (the prover proves a join body covers a single-table UNIQUE constraint,
and the create path eager-links it). **This consolidation makes join-body MVs
uncreatable** (the row-time gate rejects joins; joins are deferred to
`materialized-view-rowtime-general-bodies`, plan/). The ticket's file list did not
anticipate this. I resolved it as follows (please confirm the call is right):

- The **coverage prover itself is untouched** — its join logic still exists and is
  still correct; it is simply not reachable from a real `CREATE` until general-bodies
  lands. `covering-structure.spec.ts` join/LIMIT/PK-drop coverage tests were
  converted to prove against the *planned (unmaterialized)* body via the existing
  `proveUnmaterialized` stub path (and `prove` now falls back to a parsed-body stub
  when the MV is not registered). This preserves all prover-behavior coverage.
- The three **eager-link-on-create** join tests test a now-impossible scenario
  (creating a join-body covering MV). I converted one into a positive assertion that
  a join body is **rejected at create and rolls back cleanly** (no MV, no
  `coveringStructureName`), and removed the other two (redundant once no join MV can
  be created). **Net coverage loss: the create-time eager-link of a *join* body is
  no longer exercised — because that capability is removed by this ticket.** If the
  reviewer wants that capability preserved, this ticket and
  `coverage-prover-inner-join-fk-preservation` are in direct conflict and need a
  human design call.

## Tests changed beyond the ticket's stated list (flagged for honesty)

The ticket listed the MV-specific suites. These additional files referenced removed
concepts (`with refresh`, `on-commit-incremental`) or created now-ineligible bodies
and **would have failed to parse / failed at the gate**, so I had to touch them:

- `test/covering-structure.spec.ts` — see the cross-ticket note above; also the
  "resolver: manual / on-commit are not row-time" test was rewritten (no such
  policies now → "a row-time covering MV is enforcement-ready; a table without one is
  not"), and "non-row-time covering MV falls through to auto-index" was reframed to
  "a bare-DDL covering MV is row-time and is used for enforcement".
- `test/logic/change-scope.spec.ts` — the "manual MV reports backing / incremental
  MV reports source" pair collapsed into one "an MV reports the SOURCE" test; the
  remaining `WITH refresh = 'on-commit-incremental'` cases became bare DDL.
- `test/declarative-equivalence.spec.ts` — deleted the "MV over a compound select
  (self-contained, no source table)" round-trip case (no-source / set-op bodies are
  now ineligible; round-trip is still covered by the source-table cases).
- `packages/quereus-store/test/unique-constraints.spec.ts` — dropped one
  `WITH refresh = 'row-time'` → bare DDL.
- Src **comment-only** cleanups so the sanity grep is clean (no behavior change):
  `planner/analysis/change-scope.ts`, `schema/table.ts`, `schema/manager.ts`,
  `vtab/memory/layer/manager.ts`, `core/database-transaction.ts`.

## Validation performed

- `yarn workspace @quereus/quereus build` — clean (EXIT 0). The type system surfaced
  every dangling `refreshPolicy`/`diverged` reference; all resolved.
- `yarn workspace @quereus/quereus lint` — clean (EXIT 0).
- `yarn test` (all workspaces) — green: quereus **3808 passing / 9 pending / 0
  failing**, store **274 passing**, plus quoomb/sync/etc. all passing (EXIT 0).
- Sanity grep: `grep -riE "diverged|on-commit|refreshPolicy|with refresh"
  packages/quereus/src` → no matches.

## Use cases to re-validate (reviewer floor — my tests are a floor, not a ceiling)

Eligible body (reads-own-writes + transactional rollback) — `53 §1–6`:
- `create materialized view ix as select x, id from t order by x;` then autocommit
  INSERT/UPDATE/DELETE on `t` is reflected immediately; mid-transaction reads see the
  pending write; `rollback` discards the backing delta with the source write; a failed
  multi-row statement reverts both source + backing.
- Partial WHERE scope transitions (a row entering/leaving `where x > 0`).
- Compound-PK source; two MVs over one source; multi-row reads-own-writes.

Mandatory gate — each errors at create with a shape diagnostic that does **not**
mention `refresh` (`53 §7–8`, `materialized-view-diagnostics.spec.ts`):
aggregate, join, set-op, recursive-CTE, TVF, LIMIT/OFFSET, DISTINCT, non-PK-projection,
computed/expression projection, **MV-over-MV**, and (new) **no-source / VALUES-style**
bodies. Confirm the rollback leaves the MV name free.

Covering enforcement — `54-covering-mv-enforcement.sqllogic`,
`covering-structure.spec.ts` (memory) + `quereus-store/.../unique-constraints.spec.ts`
(store): INSERT ABORT/IGNORE/REPLACE + UPDATE conflict resolution routes through the
row-time covering MV's backing table; partial covering MV skips out-of-scope rows;
PK-only UPDATE is not a self-conflict.

Staleness still works (`51 §8`): a `drop table` / incompatible `alter` on a source
errors the next MV reference with the staleness diagnostic; `findRowTimeCoveringStructure`
returns `undefined` for a `stale` MV (falls through to the auto-index).

## Known gaps / things to scrutinize

- **Eligibility wording.** `buildRowTimePlan`'s `reject(...)` detail strings (in
  `database-materialized-views.ts`) are new prose — confirm each reads naturally and
  none leak the `_mv_` backing-table name. The MV-over-MV detail points at
  `materialized-view-rowtime-mv-over-mv-cascade`.
- **MV-over-MV detection** relies on `getMaterializedViewByBackingTable(schema, name)`
  resolving the single source. Confirm an MV body referencing another MV by its public
  name resolves (via `select.ts`) to the `_mv_`-prefixed backing table the gate checks.
- **`docs/incremental-maintenance.md`** intentionally retains a historical
  blockquote that names `on-commit-incremental` while explaining MVs are *not* a
  kernel consumer. Left as accurate context (it is in `docs/`, outside the src sanity
  grep). Confirm that framing is acceptable.
- **`yarn test:store`** (the LevelDB logic re-run) was **not** run here (slower; not
  the agent default). The store *package* spec suite (`@quereus/store test`) passed.

## Obsoleted backlog tickets to delete (per the source ticket)

These describe the deleted on-commit-incremental subsystem and are moot. The source
ticket says the review pass should delete them (I left them in place):
`materialized-view-incremental-join-bodies`, `-recursive-cte`, `-set-ops`,
`-tvf-sources`, `-cascading-convergence`, `-apply-failure-visibility`,
`-bag-body-duplicates`, `2-materialized-view-incremental-refresh`,
`2.6-materialized-view-incremental-changescope`. Verify each truly describes only
removed work before deleting.
