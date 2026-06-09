description: Wire the `'full-rebuild'` materialized-view maintenance arm — the always-correct floor that re-evaluates a body in full and applies a transactional `replace-all`. Includes building the plan (body scheduler, backing PK from `keysOf`, bag/no-key reject) and dispatching it. Applied per-row here; per-statement deferral is the next ticket.
prereq: mv-rebuild-replace-all-op
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts (body-run pattern), packages/quereus/test/incremental/maintenance-equivalence.spec.ts, docs/incremental-maintenance.md
----

`FullRebuildPlan` exists as a stub and `applyMaintenancePlan` throws an `INTERNAL` guard for `'full-rebuild'`. This ticket makes the arm real: a body matching no bounded-delta shape is maintained by re-running it in full and replacing the backing transactionally. See `docs/materialized-views.md` § Full-rebuild floor and § `'full-rebuild'`.

**Plan shape.** Extend `FullRebuildPlan` (in `core/database-materialized-views.ts`) beyond the common identity fields with:

- `bodyScheduler: Scheduler` — the optimized body compiled once at registration (model on `compileResidual`, but with **no** `injectKeyFilter`), with the read-side MV rewrite suppressed (`withSuppressedMaterializedViewRewrite`) so the body reads its sources, not the backing it populates;
- `backingPkDefinition` — the backing table's physical PK;
- `sourceBases: string[]` — every source the body reads (so `planSourceBases` indexes the plan under each, and a write to any source triggers it).

**`buildFullRebuildPlan(mv, analyzed)`.** The fall-through builder when no bounded-delta arm matches:

- derive the backing key from the body's **provable unique key** (`keysOf` over the optimized body root). If the body has **no** unique key (a bag), **reject** with the relational "no provable unique key / must be a set" diagnostic (this is the bag reject in `docs/materialized-views.md` § Primary key inference — not a shape reject);
- run the whole-body **determinism** check; reject (hard) on a non-deterministic body unless `pragma nondeterministic_schema` is set, mirroring the per-arm determinism rejects;
- collect `sourceBases` from the analyzed body's table refs;
- compile `bodyScheduler`;
- record `chosenStrategy: 'full-rebuild'` + the cost inputs (the size-threshold reject lives in the eligibility-flip ticket, which is what routes bodies here — but `buildFullRebuildPlan` is the natural home for the pathological-size check; coordinate with that ticket so the check lands once).

**`applyFullRebuild(plan, connCache)`.** Run `bodyScheduler` to completion against live mid-transaction source state (reuse the `runResidual` execution pattern — fresh strict `RuntimeContext`, empty params — generalized to "no params"), collect the rows, build a single `{ kind: 'replace-all', rows }` op, apply via `getBackingConnection` + `applyMaintenanceToLayer`, and return the effective `BackingRowChange[]` for the cascade.

**Dispatch.** `applyMaintenancePlan`'s `'full-rebuild'` case calls `applyFullRebuild` instead of throwing. `planSourceBases` returns `plan.sourceBases` for a full-rebuild plan.

> In this ticket the arm may still be invoked per-row (correct, just not yet amortized). The per-statement deferral that makes it affordable is the next ticket; do not wire eligibility-fallthrough here (that ticket flips `buildMaintenancePlan`). To test the arm in isolation, construct/register a full-rebuild plan directly or temporarily route one shape.

## Edge cases & interactions
- **No-key (bag) body**: `select category from products` (dup-producing), `union all` of overlapping inputs → reject with the bag diagnostic. `select distinct …`, `union` (dedup), keyed joins/aggregates → have a key, accepted.
- **`keysOf` returning the all-columns fallback**: treat an all-columns "key" as a real key only if the body is provably a set (`isSet`); a bag with an all-columns pseudo-key must still reject (else duplicates collide on insert). Pin this distinction in tests.
- **Multi-source body**: `sourceBases` must list *every* base (set-op legs, >2-source join) so a write to any of them rebuilds; missing one would leave the MV stale on that source's writes.
- **Reads-own-writes**: the body run must see the current statement's source writes — confirm the residual/scheduler executes against the live transaction connection like `runResidual` does.
- **MV-over-MV producer**: a rebuilt producer's `replace-all` emits a delta; confirm the cascade drives a consumer (covered once deferral lands, but the change-emission must be correct here).
- **Determinism reject vs floor**: a non-deterministic body must hard-reject, not silently full-rebuild with drifting values.
- **Empty source**: body yields zero rows → `replace-all []` empties the backing (all-delete).

## TODO
- Extend `FullRebuildPlan` with `bodyScheduler` / `backingPkDefinition` / `sourceBases`.
- Implement `buildFullRebuildPlan` (keysOf-derived key, bag reject, determinism reject, scheduler compile).
- Implement `applyFullRebuild`; generalize the `runResidual` runner to a no-param "run whole body" path (or add a sibling helper).
- Replace the `applyMaintenancePlan` `'full-rebuild'` throw with `applyFullRebuild`; update `planSourceBases`.
- Tests: register/exercise a full-rebuild MV (e.g. a 2-leg `union`, a >2-source 1:1 join) and assert `read(MV) == evaluate(body)` after inserts/updates/deletes; assert the bag reject and the determinism reject fire.
- Update `docs/incremental-maintenance.md` with the full-rebuild arm mechanics.
