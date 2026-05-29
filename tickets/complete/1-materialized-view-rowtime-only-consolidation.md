description: Materialized views consolidated onto a single row-time maintenance model. The `manual` / `on-commit-incremental` policies, the `with refresh = '...'` DDL knob, the entire post-commit incremental/divergence/cascade subsystem, and the committed-base `applyMaintenance`/`deleteByPrefix` path are removed. Row-time eligibility is now the mandatory create-time gate; MV-over-MV bodies are rejected (cascade deferred). An MV is now "a plain view the engine caches and keeps honest, transactionally."
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/schema/table.ts, packages/quereus/src/index.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/planner/analysis/change-scope.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/materialized-view-diagnostics.spec.ts, packages/quereus/test/covering-structure.spec.ts, docs/materialized-views.md
----

## Outcome

Row-time is now the **sole** materialized-view maintenance model and the implementation
landed as designed. Every MV is row-time maintained synchronously inside the writing
transaction (reads-own-writes; rolls back with the write); a body that is not row-time
maintainable is rejected at `CREATE` by one mandatory gate. The entire asynchronous
subsystem (`manual`/`on-commit-incremental` policies, `RefreshPolicy`, `diverged`,
`DeltaExecutor` wiring, topo/overlay/cascade machinery, lateral-TVF fan-out, the
committed-base `applyMaintenance`/`deleteByPrefix`/`delete-by-prefix` op) is gone.
MV-over-MV bodies are rejected at create (cascade deferred to
`materialized-view-rowtime-mv-over-mv-cascade`).

Reviewed the full implement-stage diff (`ab79af06`) with fresh eyes against the
handoff. The work is correct, internally consistent, and well-tested. Findings below
were all **minor** and fixed inline; no major findings, so no new fix/plan tickets
were filed.

## Review findings

### Checked — clean

- **Build / lint / tests** (re-run after my inline fixes): `@quereus/quereus` build
  clean, lint clean, **3809 passing / 9 pending / 0 failing**; `@quereus/store`
  **274 passing**. (`yarn test:store` — the LevelDB logic re-run — was not run; it is
  not the agent default and is slower. The store *package* spec suite passed.)
- **Dead-reference sweep.** `grep -riE "diverged|on-commit|refreshPolicy|with refresh|
  applyMaintenance\b|delete-by-prefix|deleteByPrefix|runPostCommitMaterializedViews|
  MaintenanceFaultPhase|DEFAULT_REFRESH_POLICY"` over `src` → only the two stale
  JSDoc links below (fixed); all other hits were build artifacts (`dist/`,
  `.stryker-tmp/`) or unrelated English ("Seeding diverged", "refreshed projection").
- **MV-over-MV gate.** Confirmed `select … from <mv>` resolves (via `select.ts`) to
  the `_mv_`-prefixed backing table, and `getMaterializedViewByBackingTable` matches it,
  so the gate fires (`53 §8`). A join body that *includes* an MV source is caught
  earlier by the >1-source check — still rejected, different message. Acceptable.
- **`applyMaintenanceToLayer` switch** is exhaustive now that `MaintenanceOp` has only
  `delete-key`/`upsert` (the `delete-by-prefix` arm and its INTERNAL-throw are gone);
  build confirms exhaustiveness.
- **Resource cleanup.** `dispose()`/`releaseRowTime` correctly drop only the row-time
  plans + schema subscription; the `DeltaExecutor` (still shared by assertions/watchers)
  is no longer owned here, so nothing leaks.
- **change-scope / watch.** `resolveMaterializedViewSource` simplification is sound
  (every registered MV is row-time and carries `sourceScope`); the deleted "manual MV
  reports backing" test reflected removed semantics — its replacement covers the new
  reality.
- **`docs/incremental-maintenance.md`** historical blockquote is accurate (names
  `on-commit-incremental` only as "an earlier design", explicitly states MVs are now
  row-time-only and not a kernel consumer). Left as-is — correct context.
- **Cross-ticket join-body concern (the flagged scrutiny item).** Verified
  `proveCoverage` reads **only** `mv.selectAst` (coverage-prover.ts lines 259/361/368/375),
  so the `covering-structure.spec.ts` parsed-body stub fallback faithfully exercises the
  prover's join/LIMIT/PK-drop logic. The coverage prover itself is untouched and still
  correct; it is simply unreachable from a real `CREATE` until
  `materialized-view-rowtime-general-bodies` lands. The net coverage loss (create-time
  eager-link of a *join* body) is an inherent, intended consequence of removing join-MV
  creation — **not** a conflict requiring a human design call. The implementer's
  resolution (convert one eager-link test to a "join body rejected + clean rollback"
  assertion, drop the two now-impossible ones) is the right call.

### Found and fixed inline (minor)

1. **Dangling JSDoc `{@link applyMaintenance}` (×2)** in
   `vtab/memory/layer/manager.ts` (`applyMaintenanceToLayer` doc) — the linked method
   was deleted by this ticket. Reworded the doc to stand on its own (no behavior change).
2. **`docs/materialized-views.md` overstated projection eligibility.** The Eligibility
   section claimed a projection may be "passthrough **or deterministic expressions**",
   but the gate (`resolveSourceCol`) accepts only passthrough columns (bare refs /
   renames) and rejects *all* expression columns — confirmed by `bad_expr` (`53 §7`).
   Rewrote the bullet to match the gate and point deferred expression support at the
   correct active ticket (`materialized-view-rowtime-expression-projections`, not
   `general-bodies`).
3. **Stale remedy advice in `materializedViewNotASetError`** (`materialized-view-helpers.ts`).
   The set-contract diagnostic suggested adding `distinct` or `group by` — both of which
   the new gate now *rejects* ("cannot be materialized"). Updated it to steer
   consistently with the gate: project the source PK, or use a plain `create view` /
   `create table … as`.
4. **Restored lost regression coverage.** This ticket repurposed *both* tests of the
   genuine "must be a set" path (deleted `51 §9`, converted the diagnostics-spec test to
   the gate) while the `materializedViewNotASetError` code path stays live (fill +
   refresh). Added a focused test to `materialized-view-diagnostics.spec.ts` covering a
   true bag body → set-error: names the MV + contract, never leaks `_mv_`, steers to
   view/create-table, and the failed create rolls back so the name is reusable.

### Observations (no action taken)

- **Two rejection messages for an ineligible body**, depending on whether it also
  duplicates: a bag body that drops the PK hits `materializedViewNotASetError` at *fill*
  ("must be a set") before reaching the gate ("cannot be materialized"). This is a
  pre-existing fill-before-gate ordering artifact; both messages now steer to the same
  remedies after fix #3, so it is cosmetic. Not worth reordering fill/gate for.
- **Coverage-prover join logic is now reachable only from unit tests** (no real CREATE
  exercises it) until general-bodies lands. Intentional; retained for that ticket.

### Deviation from the source ticket — flagged for a human, not actioned

The source (plan) ticket directed this review pass to **delete** nine "obsoleted backlog
tickets" describing the removed on-commit-incremental subsystem
(`materialized-view-incremental-{join-bodies,recursive-cte,set-ops,tvf-sources,
cascading-convergence,apply-failure-visibility}`, `materialized-view-bag-body-duplicates`,
`2-materialized-view-incremental-refresh`, `2.6-materialized-view-incremental-changescope`).
I did **not** delete them, because the directive contradicts their actual state:

- All nine live in `tickets/complete/` (the finished-work archive), **not** `backlog/`.
- Each already carries an explicit `> ⚠ Superseded … retained as historical record only`
  blockquote — they were deliberately annotated as kept records, presumably during the
  implement pass. Deleting them would erase that record and contradict the annotation.
- Git history already captures the code removal; the archives document that the subsystem
  existed, which is useful context for the deferred `-general-bodies` /
  `-mv-over-mv-cascade` follow-ups.

Recommend a human decide whether to prune `complete/` archive history; that is a
destructive, irreversible-by-intent action I was not comfortable taking on a relayed
directive whose targets had moved out of `backlog/`.

## Follow-ups (already filed; unaffected by this review)

- `materialized-view-rowtime-general-bodies` (plan) — single-source aggregates,
  inner/cross-join row-preserving bodies, lateral-TVF fan-out.
- `materialized-view-rowtime-expression-projections` (implement) — lift the
  passthrough-only restriction to deterministic expression projections.
- `materialized-view-rowtime-mv-over-mv-cascade` (backlog) — cascade for an MV whose
  source is another MV's backing table.
