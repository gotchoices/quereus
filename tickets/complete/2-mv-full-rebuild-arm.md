description: The wired `'full-rebuild'` materialized-view maintenance arm — the always-correct floor that re-evaluates a body in full and applies a transactional `replace-all`. Build (`buildFullRebuildPlan`) + dispatch (`applyFullRebuild`) landed and reviewed. Routing bodies to the floor (eligibility flip), per-statement deferral, and the size-threshold reject remain deferred to tickets `mv-statement-flush-deferral` (3) and `mv-eligibility-floor-fallthrough` (4).
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/incremental/maintenance-equivalence.spec.ts, packages/quereus/src/vtab/memory/layer/manager.ts, docs/incremental-maintenance.md, docs/materialized-views.md
----

## What landed (implement stage)

The `'full-rebuild'` arm is real (it previously threw a loud `INTERNAL` guard in `applyMaintenancePlan`). All production changes are in `core/database-materialized-views.ts`.

- **`FullRebuildPlan`** — `bodyScheduler` (whole optimized body, compiled once, read-side MV rewrite suppressed), `sourceBases` (every source the body reads; `planSourceBases` indexes the plan under each so a write to any source triggers a rebuild).
- **`buildFullRebuildPlan(mv, analyzed)`** — optimizes the body once, derives key + determinism + scheduler from the same optimized plan. Rejects: a **bag** (`keysOf(optimizedRoot).length === 0`, `StatusCode.UNSUPPORTED`), a **non-deterministic** body (`findNonDeterministic`, unless `pragma nondeterministic_schema`), and a body with no relational output. Cost-gate parity: `selectMaintenanceStrategy([], …)` ⇒ `'full-rebuild'` floor.
- **`applyFullRebuild(plan, cache)` + shared `runScheduler`** — `runResidual` refactored to delegate to `runScheduler`; `applyFullRebuild` runs the whole body (no params, reads-own-writes mid-txn), collects rows, applies one `{ kind: 'replace-all', rows }` op, returns the effective `BackingRowChange[]` for the cascade.
- **Dispatch** — `applyMaintenancePlan`'s `'full-rebuild'` case calls `applyFullRebuild`; no stubbed arms remain.

## Review findings

**Diff reviewed fresh before the handoff. Lint clean on the changed files; `yarn build` clean; full quereus suite green (5433 passing, 9 pending, 0 failing — includes the test added below).**

### Adversarial probe — floor-only shapes the swap tests cannot reach (implementer's suggested probe; run, confirmed, discarded)
Drove `buildFullRebuildPlan` directly over genuinely-floor-only bodies (a throwaway spec, not committed). All behaved correctly:
- `union` (distinct set) → **builds**, `sourceBases = [main.src]`;
- `union all` of overlapping inputs (bag) → **rejects** as bag (`keysOf` empty) — the no-provable-unique-key diagnostic fires on a true set-op bag, not just a key-dropping projection;
- `left join` → builds, `sourceBases = [main.t, main.p]`;
- 3-source join → builds, `sourceBases = [main.t, main.p, main.src]`;
- scalar aggregate `count(*)` (single global row) → builds (a one-row result is trivially a set).

This closes the white-box-tests caveat (KNOWN GAP #2): the keysOf-derived key, the bag reject, and `sourceBases` collection all behave on genuine set-op / outer-join / multi-way-join shapes, not only on bodies that are also bounded-delta shapes.

### Soundness checks (no defect)
- **`findNonDeterministic` reaches every scalar leaf.** `checkDeterministic` does *not* recurse — it inspects one node's `physical.deterministic`. Correctness therefore depends on the `getChildren()` walk reaching scalar leaves; confirmed it does (same walk `collectTableRefs`/`hasNodeType` use; `select id, random()` is rejected in test and probe).
- **Cost-gate floor throw is unreachable.** `selectMaintenanceStrategy([], …)` returns `'full-rebuild'` unconditionally (`planner/cost/index.ts:335`), so the builder's `chosenStrategy !== 'full-rebuild'` INTERNAL throw is genuine defensive code, not a latent build failure.
- **`runScheduler` refactor is behavior-preserving** — all residual/join/prefix equivalence suites stay green; `runResidual` is byte-equivalent (delegates with the same fresh-strict-`RuntimeContext`).
- **`replace-all` cascade / transactionality** — property suites (single-source, multi-source join driven from *both* sides, MV-over-MV producer) pass across random insert/update/delete + rollback.

### Minor findings — fixed inline
1. **Dead `backingPkDefinition` field on `FullRebuildPlan`.** It was assigned in `buildFullRebuildPlan` but **never read** by `applyFullRebuild` — the `replace-all` diff keys off the backing manager's own `primaryKeyFunctions`/`comparePrimaryKeys` (`vtab/memory/layer/manager.ts`), not the plan. The field's doc comment ("the key the `replace-all` diff matches against") was misleading since the plan never supplies it. **Removed** from the interface, the builder, and the unused mirror field in the test's `FullRebuildPlanLike` (the backing lookup stays — `backing.columns.length` still feeds `estimateMaintenanceStats`). Other plan types keep their own `backingPkDefinition` (they do consume it).
2. **Doc drift in `docs/materialized-views.md` — the per-statement flush described as current reality.** Lines 142, 332 (§ Synchronous, "Full-rebuild is the one deferred arm"), and 444 stated the floor "is flushed once per statement" / "is run once per statement" via a deferred-rebuild set — but that machinery is **not wired** (the arm runs per row today; KNOWN GAP #3). The implementer's `incremental-maintenance.md` correctly said per-row, but `materialized-views.md` (inherited from the prereq's forward-looking design) read as if the flush existed. **Added concise status caveats** marking the deferral as the planned design, not yet wired, pointing to ticket `mv-statement-flush-deferral` — naturally removed when that ticket lands. Design prose left intact (it is correct as a target).

### Minor findings — test coverage added
3. **Dedicated body-goes-empty floor test** (KNOWN GAP: only covered indirectly). Added `(full-rebuild floor, body goes empty)`: deleting every source row empties the backing (`replace-all []` → all-delete), and a later insert repopulates from an empty before-image (all-insert) — asserting both empty↔non-empty transitions end-to-end through the floor arm, not just at the layer level. Passes.

### Deferred work — already captured downstream (no new tickets filed)
All of the implementer's KNOWN GAPs are deliberate, ticket-scoped deferrals, not defects:
- **KNOWN GAP #1 (eligibility flip — routing bodies to the floor, removing shape rejects)** → `implement/4-mv-eligibility-floor-fallthrough.md`.
- **KNOWN GAP #3 (per-statement deferral / once-per-statement flush)** → `implement/3-mv-statement-flush-deferral.md`.
- **KNOWN GAP #4 (size-threshold reject + `materialized_view_rebuild_row_threshold` option)** → owned by ticket 4.
- **KNOWN GAP #5 (`sourceStats` representativeness — first-source vs largest-source)** → ticket 4 explicitly generalizes `isFullRebuildPathological` to the largest participating source. Confirmed acceptable as a placeholder until then (it is record-keeping only, not consulted at apply time).

Prereq chain intact: `mv-full-rebuild-arm` (this) → `mv-statement-flush-deferral` (3) → `mv-eligibility-floor-fallthrough` (4).

### Categories with nothing found
- **Resource cleanup** — nothing to flag: `applyFullRebuild` holds no resources beyond the cached `bodyScheduler` and the per-statement `BackingConnectionCache` (resolved via the shared `getBackingConnection`, released on the existing path).
- **Type safety** — no `any` introduced; the new `isScalarNode` narrow + `getChildren()` walk are typed; the test's white-box reach is confined to explicit `*Internals` interfaces.
- **Error handling** — rejects use `QuereusError` with `UNSUPPORTED` (relational/determinism) or `INTERNAL` (missing backing); no swallowed exceptions.

## Validation
- `yarn test` (quereus): **5433 passing, 9 pending, 0 failing**.
- `yarn build`: clean. `yarn eslint` on both changed files: clean.
- Suites exercised: `test/incremental/maintenance-equivalence.spec.ts` (full-rebuild floor: single-source, multi-source join, MV-over-MV cascade, body-goes-empty, build-time rejects), `test/vtab/maintenance-replace-all.spec.ts`.

## End
