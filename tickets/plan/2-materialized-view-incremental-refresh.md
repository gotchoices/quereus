description: Phase 2 of materialized views — incremental maintenance via a new `DeltaSubscription` consumer registered with the shared `DeltaExecutor` kernel. `refresh policy` knob (manual / incremental-on-commit), per-binding delete-then-upsert apply, FD-coverage gate for eligibility, automatic full-refresh fallback for ineligible bodies and for the 50%-changed-rows cost cliff. Plug-in pattern is already documented (`docs/incremental-maintenance.md` § "Plug-in pattern for future consumers") — this ticket lights it up for MVs.
prereq: materialized-view-core
files: packages/quereus/src/runtime/delta-executor.ts, packages/quereus/src/core/database.ts, packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/schema/view.ts, packages/quereus/src/planner/analysis/binding-extractor.ts, packages/quereus/src/planner/analysis/change-scope.ts, docs/incremental-maintenance.md, docs/materialized-views.md, docs/optimizer.md
----

## Scope

Adds a second consumer to the `DeltaExecutor` kernel that maintains materialized-view backing tables incrementally on COMMIT. Mirrors `AssertionEvaluator` structurally; differs in that the `apply` callback **writes** (delete-then-upsert into the backing table) rather than asserting.

The kernel surface (`DeltaSubscription`, `BindingMode`, capture-spec registration, cost fallback) is already in place. No kernel changes are required. New surface is the per-MV manager that compiles the body, registers the subscription, and runs the apply.

## Design

### `refresh policy`

Extends `MaterializedViewSchema` (from `materialized-view-core`) with:

```ts
type RefreshPolicy =
  | { kind: 'manual' }                    // default; v1 phase-1 behavior
  | { kind: 'on-commit-incremental' };    // this ticket lights this up
```

Surface syntax (proposed; finalize in implement):

```sql
create materialized view mv as select ...
  with refresh = 'on-commit-incremental';
```

Default stays `manual` so a v1 MV's behavior is preserved bit-for-bit when this ticket lands. A future `on-commit-full` policy is an obvious knob; it is **not** in this ticket's scope (an MV that can't be maintained incrementally either errors at `create` under `on-commit-incremental`, or stays `manual` — see eligibility below).

### Eligibility gate

Not every body is incrementally maintainable. An MV qualifies for `on-commit-incremental` when **every** source `TableReferenceNode` in the optimized body classifies as `'row'` or `'group'` (not `'global'`) under `extractBindings` — i.e. the binding-extractor finds a key/group cover for each source.

`create materialized view ... with refresh = 'on-commit-incremental'` on an ineligible body **errors at create time** with a diagnostic naming each `'global'`-classified source. This is the same eligibility signal `getChangeScope()` already exposes; reusing it keeps the surface coherent.

### `MaterializedViewSubscription` consumer

The new manager (`src/core/database-materialized-views.ts`, structurally parallel to `database-assertions.ts`):

1. Owns its own `DeltaExecutor` instance (post-commit phase — failed apply logs and skips the MV; it does **not** roll the user's commit back, identical to `database-watchers.ts`'s contract).
2. For each `on-commit-incremental` MV at compile/create time:
   - Run `extractBindings(optimizedBody)`.
   - Register capture demand for non-PK columns referenced by group/row keys, via `db.registerCaptureSpec`.
   - For each `'row'`/`'group'` binding, inject a key-filter on the source `TableReferenceNode` and pre-compile a **residual scheduler** that runs *the MV's body, restricted to one binding tuple's worth of source rows*.
   - Build a `DeltaSubscription` whose `apply`:
     - For each per-relation tuple batch: bind the residual params, run the residual scheduler, **delete** any backing-table rows whose MV-PK matches the affected binding's projection, then **insert** the residual's output rows. (The combined effect is a per-binding delete-then-upsert; for `'group'` bindings the delete-key is the group key.)
     - For `globalRelations` entries (cost fallback fired, or `'global'` binding present): re-run the full body and swap the base layer (identical to the manual-refresh path from `materialized-view-core`).
3. On schema changes (`table_modified` / `table_removed`) touching any source: invalidate the cached subscription + residuals.

### Subtleties to nail down in implement

- **Delete-key for `'group'` bindings.** The MV-PK is derived from the *body*'s keysOf; the binding's `groupColumns` are coordinates in the *source*'s output space. The delete predicate must translate source-group-key → MV-PK via the body's projection. For a `group by x, y → sum(z)` MV, the binding tuple `(x, y)` becomes the MV's PK directly (the common case). For body shapes where the MV-PK is a strict superset of the binding's group key, the delete is by a *prefix* of the MV-PK — handle via a range delete on the backing table (memory vtab path supports this through scan-plan; verify the API surfaces what's needed).
- **OLD/NEW group transitions.** When an UPDATE moves a row between groups, the change-capture layer emits both OLD and NEW projections (already documented in `incremental-maintenance.md`). Both must drive the apply so the OLD group's MV row is recomputed (possibly deleted) and the NEW group's row is recomputed (possibly inserted).
- **Join bodies.** A two-source equi-join MV gets two `'row'` bindings (one per source) on the joined key. The apply must, for each affected outer-row, recompute the join's contribution for that outer row only — using the existing fan-out-per-binding residual. This is exactly the `injectKeyFilter` pattern from assertions, applied at the source-table level.
- **Aggregate bodies with HAVING.** The `having` predicate is post-aggregate; the binding extractor's `'group'` classification correctly captures the source's group cover. Apply is delete-then-conditional-insert (the recomputed group may now fail HAVING and be omitted).
- **DISTINCT / set ops.** DISTINCT becomes the trivial case (`'group'` over all columns). UNION/INTERSECT/EXCEPT are trickier — set semantics require knowing the full source state per binding. For v1, **reject** `on-commit-incremental` on bodies containing set ops with bag semantics other than `union all`; document and file the rest as a backlog item.
- **`order by` in body.** Ordering is a layout property of the backing table; the apply must reinsert at the correct position. The memory vtab handles this through the backing table's PK ordering — verify there's no double-sort.
- **Cost fallback.** The kernel's `deltaPerRowFallbackRatio` already demotes per-binding to global re-eval when the changed-tuple ratio is high. For MVs the "global" path is "fall back to manual-refresh's full rebuild" — the same code path the explicit `refresh materialized view` invokes.

### Manual refresh interaction

`refresh materialized view mv_name` works regardless of `refresh policy`. For an `on-commit-incremental` MV, manual refresh is the resync escape valve when an external concern (debugging, suspected divergence) wants a clean rebuild.

### `getChangeScope()` for MV references

A `select` from an `on-commit-incremental` MV now has a meaningful source dependency: the MV's `ChangeScope` is the **union of its sources' scopes** (computed once at MV create time and cached). A `Database.watch` against an `on-commit-incremental` MV fires whenever any source changes that the incremental-maintenance path would touch.

Manual-refresh MVs continue to report just the backing table — their "change cadence" is `refresh`, not source mutations.

### Cascading MVs

MVs over MVs are well-defined: source-table changes drive the leaf MV's refresh; the leaf's backing table change drives the next MV's refresh; the kernel walks subscriptions in registration order. Topological ordering across cascading refreshes is a polish follow-up if a workload surfaces a reproducible "non-converged at commit" case — v1 documents the limitation and files it as backlog if it bites.

## Resolved Open Questions

None new — all material for this ticket is downstream of decisions made in `materialized-view-core` and the kernel design.

## Out of scope (file in backlog/ after this lands)

- **Set-op bodies with bag-distinguishing semantics.** UNION (set), INTERSECT, EXCEPT incrementally are research-grade; defer.
- **Recursive CTE bodies** — likewise.
- **`on-commit-full` policy** — could be a one-liner over the cost-fallback path, but adds a third dimension of MV semantics; only build it when a workload demands it.
- **Lateral / table-valued-function source contributions to the apply key.** TVFs already advertise relational facts via `relationalAdvertisement` (`docs/optimizer.md`); whether that's enough to bind them remains to be proven.

## Implementation Surface

- `packages/quereus/src/core/database-materialized-views.ts` (new) — manager class structurally parallel to `database-assertions.ts`. Owns a `DeltaExecutor` instance. Compiles + registers one subscription per `on-commit-incremental` MV. Handles schema-change invalidation.
- `packages/quereus/src/core/database.ts` — wire the new manager (post-commit phase like `database-watchers.ts`, not pre-commit like assertions).
- `packages/quereus/src/schema/view.ts` — add `refreshPolicy: RefreshPolicy` to `MaterializedViewSchema`.
- `packages/quereus/src/parser/parser.ts` + `ast.ts` — `with refresh = '...'` clause on `create materialized view`.
- `packages/quereus/src/planner/building/create-materialized-view.ts` (extend) — read `refreshPolicy`; run eligibility gate; error at create time on `'global'` bindings under `on-commit-incremental`.
- `packages/quereus/src/planner/analysis/binding-extractor.ts` — no kernel changes; this ticket exercises but does not modify it. Add unit coverage for MV-body shapes.
- `packages/quereus/src/planner/analysis/change-scope.ts` — extend MV reference's change-scope projection to source-union when `on-commit-incremental`.
- `docs/materialized-views.md` — extend with the "incremental refresh" section (apply contract, eligibility, OLD/NEW transitions, cost fallback).
- `docs/incremental-maintenance.md` — move MV from "still to come" to "live consumers"; document the manager. Update the kernel-pipeline diagram.

## Key Tests (TDD seeds for implement stage)

- **Eligibility gate.** `create materialized view ... with refresh = 'on-commit-incremental' as select * from t cross join (select 1)` errors at create time naming the `'global'` source.
- **Per-row apply for keyed body.** `create materialized view ... as select id, x+1 from t with refresh = 'on-commit-incremental'`. Insert/update/delete on `t` updates MV at commit; reads see new state without manual refresh.
- **Per-group apply for aggregate body.** `create materialized view ... as select x, sum(y) from t group by x`. Insert into `t` with new `x=k` creates an MV row at commit; delete the only row for `x=k` removes the MV row.
- **OLD/NEW group transition.** Update `t` changing its group-by value: both OLD and NEW group keys' MV rows recompute. Add to the existing OLD/NEW test surface in `test/runtime/`.
- **Cost fallback fires.** Insert > 50% of `t`'s row count in one transaction; manager falls back to full rebuild (assert backing-table layer is swapped, not patched).
- **Manual refresh still works.** `refresh materialized view mv` on an `on-commit-incremental` MV resyncs from sources.
- **Schema-change invalidation.** Drop source table → subscription is detached cleanly; MV reads error with "stale" until dropped/recreated.
- **`getChangeScope()` for incremental MV.** Reports source tables, not the backing table; a `Database.watch` on the MV fires on source mutations.
- **Post-commit error policy.** Inject a body that errors mid-apply at commit; assert the manager logs and drops (does NOT roll the user's commit back), matching `database-watchers.ts`'s contract.

## TODO (implement stage)

Phase A — manager skeleton
- New `database-materialized-views.ts`; mirror `database-assertions.ts` structurally. Subscribe to schema-change events; own a `DeltaExecutor` instance.
- Wire the post-commit phase in `database.ts` (alongside the `database-watchers.ts` invocation).

Phase B — subscription compilation
- Eligibility gate at MV create time; surface refresh-policy parsing.
- For each `on-commit-incremental` MV: run `extractBindings`, register capture demand, build per-relation residuals (the `injectKeyFilter` analog, adapted to write to a backing table instead of asserting).

Phase C — apply path
- Per-binding delete-then-upsert into backing table.
- OLD/NEW group transition handling.
- Cost-fallback → full rebuild reuse of `materialized-view-core`'s refresh code path.

Phase D — change-scope + docs + tests
- Extend MV reference's `ChangeScope` projection to source-union for `on-commit-incremental`.
- Update `docs/materialized-views.md` and `docs/incremental-maintenance.md`.
- Test corpus per "Key Tests" above (sqllogic + targeted unit tests in `test/runtime/`).
