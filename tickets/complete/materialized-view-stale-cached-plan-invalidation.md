description: A synthetic backing-table `table_modified` event invalidates cached prepared-statement plans that read a stale MV's backing table, forcing recompile → re-hit of the build-time `stale` guard. Reviewed and completed.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/plan/materialized-view-plan.spec.ts, docs/materialized-views.md, packages/quereus/src/planner/building/select.ts, packages/quereus/src/core/statement.ts, packages/quereus/src/schema/change-events.ts
----

## What shipped

`MaterializedViewManager.subscribeToSchemaChanges` now calls a single-purpose
`emitBackingInvalidation(mv)` helper after marking an MV stale + releasing its
row-time plan for a qualifying `table_removed` / `table_modified` source event.
The helper emits a **synthetic `table_modified` event for the MV's backing table**
(`_mv_<name>`) on the same `SchemaChangeNotifier`, passing the backing
`TableSchema` as both `oldObject`/`newObject`. A cached `Statement` whose only
schema dependency is the backing table matches that event (the listener keys on
`type` + `objectName` + optional `schemaName`, ignoring the payload), drops its
cached plan, and recompiles on next execution — re-hitting the build-time `stale`
re-validation guard in `building/select.ts` that a fresh prepare would hit.

The core fix is correct and load-bearing. The review revised the *rationale* (one
prominent claim in the implement handoff was empirically false — see below),
corrected the misleading comments/docs, and added the MV-over-MV cascade test the
handoff itself flagged as the most valuable missing coverage.

## Review findings

### Checked — code correctness (SPP / type safety / resource cleanup / re-entrancy)
- **Payload-ignoring match** — confirmed `core/statement.ts` (lines ~157-187) maps
  `table_*` → `'table'` and matches on `type`/`objectName`/optional `schemaName`
  only; passing the backing `TableSchema` as both old/new is sound. The backing
  dependency's `objectName` is exactly `mv.backingTableName` and `schemaName` is
  `mv.schemaName` (recorded via `resolveTableSchema` → `recordDependency`).
  Verified end-to-end by the first regression test.
- **No infinite loop / re-entrancy** — `notifyChange` iterates a `Set` with
  `for…of` and listeners never mutate the set during iteration (the `Statement`
  listener only flips flags; `compile()` add/remove happens on a later execution,
  outside notify). Nested notifies (the cascade) are independent iterations.
  MV-over-MV chains terminate (producer→consumer DAG; a consumer requires its
  producer to pre-exist). `notifyChange` swallows listener exceptions *with* a log
  (pre-existing) — acceptable.
- **Silent skip** — `emitBackingInvalidation`'s `if (!backing) return` was a silent
  early-return; **fixed inline** to emit a debug `log(...)` (AGENTS.md: don't skip
  without at least logging).

### MAJOR finding (rationale was wrong; code is still correct) — handled inline
The implement handoff claimed the **unconditional** emit (firing on every
qualifying event, not only the `stale` false→true transition) is *load-bearing*,
and that the second regression test ("compiled while already stale") **fails if the
emit is re-gated on the transition**. **This is false.** Verified three ways:
- Re-gating the emit inside `if (!mv.stale)`: **both** regression tests still pass.
- Removing the emit entirely: only the *first* test fails (proving the emit itself
  is load-bearing); the second test still passes.
- Full MV + assertion + watcher suite with the emit re-gated: 120 → all green.

Root cause: a plan compiled **while the MV is already stale** runs the build-time
guard at compile, whose body re-validation (`buildSelectStmt(parentContext, …)`)
resolves the body's **source** tables through the *same* `schemaDependencies`
tracker — recording a **direct** dependency on the source table (transitively
through nested MV guards for MV-over-MV). So a later source change invalidates
those plans through the ordinary dependency path, with no synthetic emit needed.
The emit is genuinely load-bearing only for plans compiled **while not stale** (no
guard ran → backing-only dependency) and for **re-propagating the MV-over-MV
cascade**. The unconditional aspect is therefore *defensive redundancy* for the
single-level compiled-while-stale case, not a correctness requirement.

Disposition: the code is correct and conservative, so the **unconditional emit was
kept** (not re-gated — that would be a behavior/perf change, not a bug fix). The
**false rationale was corrected inline** in three places:
- the call-site comment and `emitBackingInvalidation` JSDoc in
  `database-materialized-views.ts`,
- the second test's docstring + inline comment (now states it is covered by the
  direct source dependency and does *not* exercise the emit),
- `docs/materialized-views.md` § Cached-plan invalidation.

### Test coverage — gap closed inline
- The handoff flagged **no MV-over-MV cascade test** as "the most valuable
  addition." **Added** `cascades staleness + cached-plan invalidation down an
  MV-over-MV chain`: `t → mv1 → mv2`, an incompatible `alter table t drop column y`
  asserts **both** `mv1.stale` and `mv2.stale`, and a cached `select from mv2`
  recompiles to the staleness diagnostic. This test is **load-bearing on the emit**
  — with the emit removed, the cascade never reaches `mv2` (`mv2.stale` stays
  `false`) and the test fails.
- Corrected the handoff's secondary claim that "mv2's re-validation passes and it
  serves its frozen snapshot." It does **not**: the `mv2` reference re-validates its
  body (`select from mv1`), which recursively re-hits `mv1`'s stale guard, so an
  incompatible source change surfaces as a staleness **error**, not a silent
  snapshot. The new test pins this.

### Empty / not-done categories (explicit)
- **No re-gating of the emit.** Deliberate: the unconditional form is correct and
  conservative; changing it is an optimization outside this ticket's scope.
- **No white-box recompile assertion.** The genuine marginal difference of the
  *unconditional* aspect (re-invalidating an already-stale consumer's
  compiled-while-stale plan in an MV chain) is output-identical and only
  white-box-observable; the black-box cascade test + corrected docs capture the
  contract without coupling tests to `Statement` internals.
- **`yarn test:store` not run.** No store-specific code touched (the LevelDB store
  shares the same `SchemaChangeNotifier`); deferred to CI per the handoff. Not a
  regression risk for this change.

### Latent (not filed — speculative, not constructible today)
Multi-source MV bodies are currently incremental-ineligible (cannot be created), so
no MV "diamond" (`mv3` reading both `mv1` and `mv2`, both reading `t`) is
constructible. If multi-source MVs ever land, the **unconditional** emit would
re-fire a shared consumer's backing event once per producer per source change —
redundant cascade churn that a transition-gated emit would naturally dedup. Noted
here for whoever lands multi-source MVs; nothing to do now.

## Validation (all green, memory backend)
- `node test-runner.mjs --grep "stale invalidation of cached plans|cascades staleness"` → 3 passing.
- `node test-runner.mjs --grep "[Mm]aterialized|[Aa]ssertion|[Ww]atch"` → 121 passing.
- `yarn workspace @quereus/quereus test` → **4087 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` → exit 0.
