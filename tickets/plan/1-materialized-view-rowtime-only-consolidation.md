description: Consolidate materialized views onto a single, semantically-transparent maintenance model — **row-time only**. Remove the `manual` and `on-commit-incremental` refresh policies (and the entire post-commit divergence / self-heal subsystem they required), drop the `with refresh = '...'` DDL knob, make row-time eligibility a mandatory create-time gate (reject non-maintainable bodies up front), and batch row-time maintenance per-statement rather than strictly per-row. The end state: an MV is "a plain view the engine caches and keeps honest, transactionally" — observably indistinguishable from its view, just faster.
prereq:
files: packages/quereus/src/parser/parser.ts, packages/quereus/src/parser/ast.ts, packages/quereus/src/emit/ast-stringify.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/schema/manager.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/planner/building/select.ts, packages/quereus/src/runtime/emit/dml-executor.ts, packages/quereus/src/runtime/emit/materialized-view.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, packages/quereus/test/logic/52-materialized-views-incremental.sqllogic, packages/quereus/test/logic/53-materialized-views-rowtime.sqllogic, packages/quereus/test/logic/54-covering-mv-enforcement.sqllogic, docs/materialized-views.md, docs/architecture.md, docs/incremental-maintenance.md
----

## Decision (human sign-off, 2026-05-29)

Eliminate the refresh-policy knob. A materialized view should be a *transparent
materialization cache*: it always reflects its sources from a reader's point of
view, exactly like the plain view it derives from — just served from stored rows.
The user should never reason about *when* an MV is consistent.

Three policies exist today (`manual → on-commit-incremental → row-time`). They are
not three implementations of one idea; they are three different **observable
contracts**:

- `manual` is not a maintained view at all — it is a snapshot frozen at the last
  `REFRESH`. Anything it offers is already available via `create table x as <body>`
  or a user-populated temp table. It is pure foot-gun (reads silently wrong until
  someone refreshes).
- `on-commit-incremental` is observably **stale within a transaction** (a source
  write is invisible to an MV read until COMMIT) — itself a semantic "switch" the
  user must model, even as the only policy. Its asynchrony is the entire reason the
  `diverged` / two-tier-recovery / cascading-divergence subsystem exists.
- `row-time` maintains the backing table **synchronously inside the writing
  transaction** (reads-own-writes; rolls back with the write). It is the only
  policy whose contract is "MV ≡ faster view."

**Resolution:** keep only `row-time`, as the sole and default model. Reject any
body that is not row-time-maintainable at `CREATE` (mandatory gate, no `manual`
escape hatch). This collapses an entire async-maintenance complexity subsystem
into ordinary transactional rollback, and makes the MV contract uniform.

The cost — accepted knowingly — is a **coverage regression**: the eligible body
set narrows to the covering-index-style shape (see Eligibility below). The broad
join / aggregate / recursive / set-op bodies that `on-commit-incremental` handles
are **rejected** until row-time grows to cover them
(`materialized-view-rowtime-general-bodies`). "row-time only, reject the rest" was
the explicit choice; the broader shapes are a forward track, not a regression to
paper over.

### Settled sub-decisions

- **DDL surface.** Drop the `with refresh = '...'` clause entirely. The grammar
  becomes `create materialized view mv [if not exists] [(cols)] [using …] as
  <body> [with tags (...)]`. No policy token, nothing to round-trip.
- **Batching.** Row-time maintenance batches at **statement boundaries**, not
  strictly per source row. Reads-own-writes still holds *between* statements within
  a transaction (the property that matters); a bulk insert amortizes maintenance
  and connection/layer lookup over the whole statement instead of paying per row.
- **Expression projections are in scope here.** Today's row-time gate rejects
  computed/expression columns ("known v1 gap"). As the *sole* shape that makes
  row-time-only nearly unusable, so this consolidation lifts that restriction:
  a deterministic expression projection over a single source is still a pure
  per-row (now per-statement) projection of the changed row — O(log n), no body
  re-execution. (Non-deterministic projections remain rejected, consistent with
  determinism enforcement elsewhere.)
- **Single-source aggregates, joins, recursion, set-ops stay rejected** for now —
  they are "the rest." Their row-time support is `materialized-view-rowtime-general-bodies`.

## What gets removed

**`manual` policy** — the snapshot semantics and the "expected to drift between
refreshes" framing. (`stale` no longer needs to carry a "supposed to drift" case.)

**`on-commit-incremental` policy — entirely.** In `database-materialized-views.ts`:
the `DeltaSubscription` writer/registration, the MV residual scheduler
(`runResidual` / `injectKeyFilter` for MV maintenance), the per-binding `'row'` /
`'group'` / `'global'` classification, `computeDeleteKeyOrder`, the lateral-TVF
`delete-by-prefix` path, the recursive-CTE / set-operation whole-MV global-rebuild
short-circuits, and the cost-fallback-to-global-rebuild demotion. The post-commit
maintenance pass is deleted.

**The divergence / self-heal subsystem — entirely.** `diverged` flag, the two-tier
self-heal recovery, the post-commit-window contract, cascading-divergence
propagation + the per-pass `pendingDelta` overlay, and the
`_setMaterializedViewMaintenanceFault` fault-injection seam. Under transactional
row-time maintenance there is no post-commit window and no source re-read during
maintenance, so a failed maintain simply rolls back with the user's write — there
is nothing to diverge. (The motivating "transient unreachable federated source"
scenario for self-healing was an artifact of on-commit residual re-execution; a
pure-projection row-time maintain never re-reads the source.)

## What stays

- **The row-time mechanism** (`dml-executor.ts` write-boundary hook,
  `applyMaintenanceToLayer` privileged transactional write, the
  `RowTimeMaintenancePlan` cache), the **covering-structure link**, the
  **coverage prover**, and **row-time UNIQUE enforcement routing** — all unchanged
  in contract (some simplify; see below).
- **`stale`** — a source *schema* change (drop / alter) can still structurally
  break a body. That is not data drift; it keeps its existing read-path
  re-validation. (Note the cached-plan bypass is now `stale`-only — see
  `materialized-view-state-flags-bypass-cached-plans`.)
- **Change-scope source projection** — the backing table is still maintained off
  the user change log, so `Database.watch` on an MV must still project to its
  sources. Unchanged.
- **`REFRESH MATERIALIZED VIEW`** — kept as an explicit full-rebuild / resync verb
  (cheap, useful after a `stale` structural break, and the implementation of
  drop+recreate on body change). It is no longer *semantically required* for
  currency, but it is not removed.

## New eligibility gate (mandatory at CREATE)

Today's row-time eligibility (`coverage-prover`-adjacent shape, in
`buildRowTimePlan`) becomes the **only** accepted MV shape, with expression
projections added:

- a **single** source table `T` with a primary key (no joins / self-joins);
- a row-preserving linear body `TableReference → optional Filter → Project →
  optional Sort` — no aggregate, set operation, `DISTINCT`, recursive CTE,
  table-valued function, or `LIMIT`/`OFFSET`;
- a projection that is either passthrough **or deterministic expressions** over
  single-source columns (this consolidation lifts the passthrough-only limit);
- the projection includes **every** PK column of `T`;
- a partial `WHERE`, if present, evaluable on a single source row.

Any other body is rejected at `CREATE` with a diagnostic that names the
unsupported shape and points the user at a plain `view` or `create table … as`
(for a one-off snapshot). There is no `manual` fallback to accept it.

## Open design points (resolve in plan → implement)

- **Cascading MV-over-MV under row-time.** The on-commit cascade machinery is
  removed. A row-time MV whose source is *another* MV's backing table is not
  maintained today, because the maintenance write goes through
  `applyMaintenanceToLayer` (privileged), not the DML-executor hook that triggers
  row-time. Decide: (a) drive dependents from the maintenance write too
  (synchronous cascade within the statement, DAG-ordered), or (b) reject an MV
  whose source is itself an MV backing for now and defer cascade to a follow-up.
  Lean (b) for this consolidation (keep scope tight); file the cascade follow-up.
- **Per-statement batching mechanics.** Where the statement boundary fires
  (autocommit vs explicit txn vs savepoint), how the batch accumulates/dedupes
  per-source deltas, and how it interacts with the existing lazily-registered
  backing connection. Reuse the savepoint replay path the row-time backing
  connection already rides.
- **REFRESH retention.** Confirm `REFRESH` stays (recommended) vs. is also dropped.

## Documentation (must land with the code)

- `docs/materialized-views.md` — major rewrite: single contract, drop the
  refresh-policy spectrum / `manual` / `on-commit-incremental` / incremental-refresh
  / apply-failure-recovery / cascading-divergence sections; reframe the intro and
  the covering-structure / enforcement sections to "row-time is the model" rather
  than "row-time is the strongest of three."
- `docs/architecture.md` — rewrite the **Materialized Views** key-design bullet.
- `docs/incremental-maintenance.md` — the MV is no longer a consumer of the
  post-commit `DeltaExecutor` kernel; update the "third consumer" framing
  (assertions / watchers remain).

## Key tests (TDD targets)

- A `create materialized view` over an ineligible body (join / aggregate /
  set-op / recursive / TVF / non-deterministic projection) is rejected at create
  with the right shape-specific diagnostic.
- An eligible body with an **expression projection** maintains correctly through
  insert / update / delete (new — previously rejected).
- Reads-own-writes across statements in a transaction; a bulk multi-row statement
  produces correct backing contents (per-statement batching) and rolls back fully
  on statement/transaction rollback.
- `with refresh = '...'` is now a parse error (or silently dropped — decide);
  `52-materialized-views-incremental.sqllogic` is removed/repurposed and the
  `53` / `54` row-time + enforcement suites pass with the bare DDL.
- No `diverged` code path remains (the fault-injection seam and its diagnostics
  spec are gone).

## TODO (implement phase — after plan breakdown)

- Parser/AST/stringify: remove the `with refresh` clause and the policy enum.
- `schema/view.ts`: drop `diverged` and the policy field from `MaterializedViewSchema`;
  keep `stale`, `sourceScope`, covering-structure link.
- `database-materialized-views.ts`: delete the on-commit `DeltaSubscription` path,
  the residual/binding/global-rebuild machinery, the divergence/recovery/cascade
  code, and the fault seam. Make row-time eligibility the mandatory create gate;
  add expression-projection support; add per-statement batching.
- `select.ts`: remove the `diverged` read guard; keep `stale` re-validation.
- `dml-executor.ts`: convert the per-row row-time hook to a per-statement flush.
- Remove the on-commit sqllogic suite; extend `53`/`54`; update specs.
- Rewrite the three docs.
