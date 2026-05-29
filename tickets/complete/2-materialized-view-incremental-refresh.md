description: Incremental materialized-view maintenance — `with refresh = 'on-commit-incremental'` policy maintained at COMMIT via the reusable `DeltaExecutor` kernel, with per-binding delete-then-upsert apply and full-rebuild fallback. Reviewed and completed.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/planner/analysis/key-filter.ts, packages/quereus/src/core/database-assertions.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/parser/parser.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/planner/building/materialized-view.ts, packages/quereus/src/planner/nodes/materialized-view-nodes.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, docs/materialized-views.md, docs/incremental-maintenance.md, docs/optimizer.md
----

> **⚠ Superseded (2026-05-29) — feature removed.** Materialized views are being consolidated to a single **row-time** model by `materialized-view-rowtime-only-consolidation` (plan): the `manual` and `on-commit-incremental` refresh policies and the post-commit divergence / self-heal subsystem are removed. The work archived here is retained as historical record only.

## What shipped

A third consumer of the `DeltaExecutor` kernel: `on-commit-incremental`
materialized views maintained at COMMIT.

- **Refresh policy** — `MaterializedViewSchema.refreshPolicy`
  (`{kind:'manual'}` default | `{kind:'on-commit-incremental'}`); trailing
  `with refresh = '...'` clause, sibling to `with tags`, round-tripping through
  parser → AST → `CreateMaterializedViewNode` → create emitter → stored schema.
- **Manager** — `MaterializedViewManager` owns a `DeltaExecutor` and a
  `Database`-backed context; keeps the phase-1 staleness subscription and
  releases an MV's incremental subscription on source schema-change /
  `materialized_view_removed`.
- **Post-commit wiring** — `Database.runPostCommitMaterializedViews()` invoked
  in `database-transaction.ts` next to `runPostCommitWatchers()` (change log
  alive, errors swallowed, commit stands).
- **Write path** — `MemoryTableManager.applyMaintenance(ops)`: manager-level
  delete-key/upsert against the committed base layer under the SchemaChange
  latch, bypassing the user read-only boundary and the transaction machinery.
- **Bindings synthesized, not extracted** — single-source row body → `'row'` on
  source PK; single-source aggregate over bare `GROUP BY` columns → `'group'` on
  those columns. The synthesized `BindingMode` map drives the same unchanged
  kernel. (This is the central, deliberate divergence from the ticket's "reuse
  `extractBindings`; reject `'global'`" premise — see Review findings.)
- **Apply** — per-binding delete-then-upsert; `globalRelations` (cost fallback /
  `'global'` source) → full `rebuildBacking` (shared with manual refresh).
  Delete key mapped onto the backing physical PK via attribute provenance;
  unclean mapping (e.g. `order by`-seeded PK, `DISTINCT`) → full rebuild.
- **Eligibility gate** — set-ops (non-`union all`) + recursive CTEs rejected
  structurally in the builder; whole-table aggregate / non-column `GROUP BY` /
  multi-source rejected in the manager at create (rolls MV + backing table back).
- **DRY** — `injectKeyFilter` lifted from `database-assertions.ts` into
  `planner/analysis/key-filter.ts`; assertions import it (behavior-preserving).
- **Docs** — `materialized-views.md` (§ Incremental refresh), `incremental-maintenance.md`
  (§ Third consumer), `optimizer.md` cross-ref.

## Review findings

### Verdict

Implementation is sound and ships green. Build, lint (clean), and the full
suite pass — **3747 passing, 9 pending**. (The incremental corpus is a single
sqllogic case, so the added §§ 9–12 assertions strengthen it without changing
the case count.) No major code defects found; the deltas from the ticket text
are deliberate, correct, and documented. Findings below are coverage gaps
closed inline plus deferred-scope items filed as new backlog tickets.

### Checked — and what was found

- **Synthesized-bindings soundness (the #1 thing to scrutinize).** Re-derived
  from first principles: binding on *source identity* (PK for row-preserving
  bodies, group key for bare-`GROUP BY` aggregates) is the correct notion for
  maintenance, and the divergence from the ticket's `extractBindings`-classification
  premise is justified (that classification is equality-pinned and would reject
  both headline bodies). The synthesized `BindingMode` map feeds the unchanged
  kernel correctly. **Verified by new tests** (see below) rather than taken on
  faith. ✅ Sound.

- **`applyMaintenance` in-place base mutation vs. concurrent reads.** Initially
  flagged as a possible regression (manual refresh uses `replaceBaseLayer`, which
  builds a fresh immutable layer precisely to avoid mutating under in-flight
  scans). Confirmed **safe**: `scan-layer.ts` reads via `safeIterate`, which
  recovers from tree mutation by re-finding the stored current key; and
  `applyMaintenance` performs all tree mutations + index rebuild in one
  synchronous block (no `await` between ops), so an externally-suspended async
  scan resumes only after the whole batch lands. The "atomic from the event
  loop's perspective" comment holds. ✅ No issue.

- **Delete-then-recompute correctness across shapes.** Verified by new corpus
  sections (`52-...sqllogic` §§ 9–12): WHERE-filter row *leaving* and *entering*
  the predicate via UPDATE (MV row deleted / inserted); compound-PK source
  (multi-column delete key); multi-column `GROUP BY`; two independent incremental
  MVs over one source maintained from a single mutation. All pass — these were
  the implementer's suggested adversarial probes plus the compound/multi-col
  cases. ✅ Fixed inline (tests added).

- **NULL group keys.** New §10: `group by` over a nullable column with NULL rows
  — insert into and delete from the NULL group both recompute it correctly via
  the NULL-safe residual filter (inherited from `injectKeyFilter`) and a
  NULL-valued delete key. No duplicate NULL row, correct sums. ✅ Fixed inline
  (test added) — this closes the gap the handoff flagged.

- **Cost-fallback path actually triggers.** Default `deltaPerRowFallbackRatio`
  is `0.5`; §5 changes 8 rows against a ~10-row table (ratio ≈ 0.8 ≥ 0.5), so the
  rebuild branch is genuinely exercised and the result is asserted correct.
  ✅ Correctness covered. The white-box probe distinguishing "rebuilt" from
  "per-row patched" remains a coverage *nicety*, not a correctness gap — left as
  documented.

- **Eligibility + diagnostics.** Whole-table aggregate, set-ops, recursive CTE,
  and (newly) multi-source bodies all rejected at create with clear messages;
  the same body under `manual` is allowed; rollback of MV + backing table on
  throw verified in the create emitter. ✅ Good.

- **Schema-change invalidation.** Dropping a source detaches the subscription
  and makes MV reads error "stale" (§8). ✅ Good.

- **DRY extraction (`injectKeyFilter`).** Diffed the moved code against the
  assertion original — verbatim, behavior-preserving; assertions still green.
  ✅ Good.

- **Docs.** Read every changed doc against the shipped code: `materialized-views.md`
  § Incremental refresh, `incremental-maintenance.md` § Third consumer, and the
  roadmap/cross-refs accurately describe eligibility, the apply contract,
  bindings-are-derived, the delete-key provenance + rebuild fallback, and the
  log-and-skip error policy. Anchor `#third-consumer-materializedviewmanager`
  resolves. ✅ Accurate. **One dangling reference found and resolved** — the docs
  cite `materialized-view-incremental-cascading-convergence` as "Tracked" but no
  such ticket existed (handoff said the reviewer may file it); now filed (below).

### Filed as new backlog tickets (major / deferred scope)

- **`materialized-view-incremental-cascading-convergence`** — MV-over-MV lags one
  commit per nesting level because a leaf MV's post-commit backing write is not in
  the current change log. Was referenced by docs but unfiled; now tracked.
- **`materialized-view-incremental-join-bodies`** — multi-source / join bodies are
  rejected at create in v1 (binding synthesis assumes one source). The plan
  envisioned join MVs; explicitly deferred. (Distinct from the existing narrower
  `materialized-view-incremental-tvf-sources`.)
- **`materialized-view-incremental-apply-failure-visibility`** — a mid-apply
  maintenance failure silently skips that commit's delta and the MV diverges
  permanently (until manual refresh) with no staleness flag and no read error.
  Matches the implementing ticket's explicit log-and-skip policy, so this is a
  *policy refinement* (mark stale / self-heal / surface a signal), not a defect —
  filed so the silent-divergence consequence gets a deliberate decision.

### Fixed inline this pass

- Extended `test/logic/52-materialized-views-incremental.sqllogic` with §§ 9–12
  (WHERE-filter transitions, nullable NULL group key, two MVs over one source,
  compound-PK + multi-column `GROUP BY`), with self-contained setup/teardown.

### Not done (with reason)

- **No white-box `replaceBaseLayer` vs `applyMaintenance` spy test** — correctness
  of the fallback is asserted via §5; distinguishing the *mechanism* is a
  diagnostic nicety the handoff already flagged, and adding a `test/runtime/`
  spy harness is disproportionate to the risk. Left documented.
- **No fault-injection test for the apply-failure path** — forcing a deterministic
  apply error needs a seam that does not exist yet; folded into the
  `...-apply-failure-visibility` backlog ticket, which proposes adding the seam.
- **Phase D change-scope projection** — already split to
  `materialized-view-incremental-changescope` (implement/, prereq this slug);
  out of scope here.
