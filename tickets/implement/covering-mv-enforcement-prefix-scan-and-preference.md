description: Replace the full backing-table scan in row-time covering-MV UNIQUE enforcement with a backing-PK prefix scan (O(log n + matches) instead of O(n)), and document the resolved auto-index-vs-MV preference decision for physical schemas.
prereq:
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/src/vtab/memory/layer/scan-plan.ts, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/plan-filter.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus-store/src/common/store-table.ts, packages/quereus/test/covering-structure.spec.ts, docs/materialized-views.md
----

## Problem

`MaterializedViewManager.lookupCoveringConflicts` (in `database-materialized-views.ts`)
answers every UNIQUE conflict check by **full-scanning** the covering MV's backing
table (`manager.scanLayer(startLayer, { indexName: 'primary' })`, matching the UC
values row by row). Because `MemoryTableManager.findIndexForConstraint` resolves the
covering MV **in preference to** the auto-index whenever a linked, non-stale row-time
covering MV exists, a *physical* table that carries such an MV resolves every UNIQUE
insert/update via that O(n) scan instead of the auto-index's O(log n) probe — a bulk
insert degrades to **O(n²)**. The store path (`store-table.ts
::findUniqueConflictViaCoveringMv`) calls the same `_lookupCoveringConflicts` surface,
so it inherits the same regression.

This was an intentional v1 choice (it makes the MV enforcement path live and testable
on physical schemas, where the auto-index would otherwise always win, and is the sole
structure in the future logical-schema/lens world where the auto-index is retired), but
the O(n) scan is a real regression. The implementer explicitly deferred the sound
optimization.

## Design

### Part 1 — Backing-PK prefix scan

**Why a prefix scan is sound here.** The backing-table primary key is seeded by the
MV body's `order by` columns followed by the remaining source-PK columns
(`computeBackingPrimaryKey` in `runtime/emit/materialized-view-helpers.ts`). The
coverage prover requires the `order by` columns to be a *permutation* of the UC columns
(`docs/materialized-views.md` § Ordering). Therefore the **leading `k =
uc.columns.length` backing-PK columns are exactly the UC columns** (as a set, possibly
reordered), and the trailing backing-PK columns are the source PK. A conflict check is
thus a prefix-equality scan on the backing primary index keyed by the UC values — it
yields exactly the backing rows sharing those UC values (each a candidate conflicting
source row), and the source PK is recovered from the trailing columns as today.

**Mechanism already present.** `scanLayer` (`vtab/memory/layer/scan-layer.ts`, primary
branch) supports prefix scans via `ScanPlan.equalityPrefix`: it seeks to the prefix and
**early-terminates** when the leading key columns stop matching the prefix
(`plan-filter.ts::planAppliesToKey` + the early-termination block in `scan-layer.ts`).
No new scan machinery is needed — only build the right `ScanPlan`.

**The inverse map must be in backing-PK order.** `lookupCoveringConflicts` already
builds `sourceColToBacking` from the passthrough projectors. The prefix must be ordered
by the **backing PK's column order**, not `uc.columns` order (the `order by` may
permute the UC columns). Invert the passthrough projectors to a `backingColToSource`
map, then for each of the leading `k` backing-PK entries take
`equalityPrefix[i] = newRow[ backingColToSource.get(backingPkDefinition[i].index) ]`.

**Fast-path gating — fall back to the existing full scan when any holds:**
- The leading `k` backing-PK columns do **not** map (via passthrough) to exactly the
  UC source-column set. (The covering-index shape guarantees they do; this is a
  defensive guard — if the linked structure is ever not leading-with-UC, full scan
  stays correct.)
- Any of the leading `k` columns has a **non-BINARY collation**. This is a *soundness*
  requirement, not just a perf choice: `planAppliesToKey` / the scan-layer
  early-termination compare prefix components with plain `compareSqlValues` (no
  collation), while the backing btree orders the PK by its *declared* collation. Under
  a non-binary collation, rows that are collated-equal but binary-different are
  contiguous in the tree, but the binary early-termination would `break` before
  reaching them → a **missed conflict**. (Threading per-column collation into
  `ScanPlan.equalityPrefix` matching is a larger, separable change — see "Deferred"
  below. For now, non-binary collation keeps the full scan, which is collation-correct
  because `lookupCoveringConflicts` re-compares with `compareSqlValues(..., coll)`.)
- A leading prefix column is **DESC** — *unless* implementation verification confirms
  the `equalityPrefix` seek positions correctly over a DESC-leading PK (equality on a
  column makes direction irrelevant to *grouping*, but the seek-start/iteration
  direction must be confirmed; the `equalityPrefix` branch in `scan-layer.ts` always
  seeks `safeIterate(tree, isAscending=true, [prefix])`). Gate on ASC by default;
  relax to allow DESC if the verification test (below) passes.

**Per-row body unchanged.** Keep recovering `sourcePk = pkBackingCols.map(...)`, the
self-exclusion against `newSourcePk`, and the push. The inner UC re-match loop is
redundant under binary-collation prefix equality but is harmless — keep it for
robustness (it also still runs on the full-scan fallback).

**Liveness contract preserved.** The prefix scan is still only a *candidate generator*;
the callers (`MemoryTableManager.checkUniqueViaMaterializedView` and store
`findUniqueConflictViaCoveringMv`) validate each candidate against the **live** source
row before acting, so a backing entry that lags an internally-deleted/updated source
row is skipped. The prefix scan only narrows candidates; it never changes validation.
Soundness reduces to "the prefix scan does not *miss* a live conflict", which the
collation gate guarantees.

**Store path:** no store-side change — `store-table.ts` calls the same
`_lookupCoveringConflicts`, so the optimization flows through automatically.

### Part 2 — Preference decision (DECIDED: keep MV-in-preference)

**Decision: keep the existing resolution — the covering MV outranks the auto-index for
physical schemas.** The prefix scan in Part 1 is what makes this defensible: it removes
the O(n) backing scan that turned the preference into an O(n²) bulk-insert regression.
With the prefix scan, a physical table's UNIQUE check is O(log n + matches) — the same
asymptotics as the auto-index probe. The residual cost is a bounded constant factor
(backing-connection resolution — already amortized per statement via
`BackingConnectionCache` on the maintenance path, and deterministically re-resolved on
the cold enforcement path — plus per-candidate live-source validation) and the
auto-index being maintained-but-unconsulted.

This is accepted for v1 because:
1. it keeps the covering-MV enforcement path **live and exercised on physical schemas**
   (the existing `covering-structure.spec.ts` "row-time covering enforcement" suite),
   which is the original v1 rationale; and
2. it is **identical to the sole enforcement path in the logical-schema/lens world**
   (auto-index retired), so no preference flip is needed when that lands — the MV
   simply becomes the only structure.

**Documented alternative (not taken):** flip to auto-index-wins for physical schemas,
gated by a tuning flag so the MV enforcement path stays test-reachable. Rejected for v1
because it adds a flag and risks the MV enforcement path becoming dead/untested before
the lens world exists. Revisit if profiling shows the constant factor matters on
physical workloads.

No code change to `findIndexForConstraint` is required for this decision — it is a
documentation update plus the perf fix in Part 1.

### Docs

Update `docs/materialized-views.md`:
- § "Enforcement through a covering MV (delivered)": replace the "v1 is a full backing
  scan; a backing-PK prefix scan is a sound later optimization in
  `covering-mv-enforcement-prefix-scan-and-preference`" clause (~line 514) with the
  delivered prefix-scan description, including the binary-collation fast-path condition
  and the full-scan fallback.
- "The preference tradeoff" paragraph (~line 519): record the decision — MV stays in
  preference, now O(log n) via the prefix scan, residual constant-factor cost accepted,
  alternative documented.
- Roadmap "Covering-structure enforcement follow-ups" bullet (~line 599): drop the
  prefix-scan item (delivered); keep/forward any remaining follow-ups (e.g. collation
  threading, isolation-layer routing).

## Key tests (TDD)

- **Behavior parity:** existing `covering-structure.spec.ts` "row-time covering
  enforcement" must pass unchanged — only the scan strategy changes, not results.
- **Prefix narrows correctly (no false conflict on shared partial prefix):** `t(id pk,
  x, y, unique(x,y))` covered by `select x, y, id from t order by x, y`; seed (1,1),
  (1,2), (2,1). Insert (1,3) → succeeds (no conflict; same-x different-y must not be a
  false conflict — exercises early-termination). Insert (1,2) on a fresh row →
  ABORT/IGNORE/REPLACE resolve against the (1,2) row's correct source PK.
- **UC-permuted order-by:** `unique(x,y)` but MV `... order by y, x` → confirms the
  prefix is built in backing-PK order, not `uc.columns` order (a wrong-order prefix
  would seek to the wrong block and miss/falsely-report conflicts).
- **Non-binary collation fallback:** UNIQUE on a text column declared `collate nocase`
  → insert a case-differing duplicate ('Foo' vs 'foo') and assert the conflict is still
  caught (verifies the full-scan fallback is collation-correct and the fast path was
  correctly bypassed).
- **DESC verification:** MV `... order by x desc` → assert conflicts still resolve. Use
  this to decide whether DESC-leading prefixes can use the fast path or must fall back.
- **Store parity:** the store path shares `_lookupCoveringConflicts`; correctness is
  covered by `yarn test:store` (slower — run it for this change or note deferral to CI
  per the store-test guidance in AGENTS.md).

## TODO

- Invert the passthrough projectors to `backingColToSource` in `lookupCoveringConflicts`
  and compute the leading-`k` UC-coverage / binary-collation / ASC gate.
- Build `equalityPrefix` in backing-PK column order from `newRow`; scan with
  `{ indexName: 'primary', descending: false, equalityPrefix }`. Keep the existing
  per-row recovery/self-exclusion/push body.
- Add a private helper (e.g. `tryBuildCoveringPrefix(plan, uc, sourceColToBacking, newRow)`
  returning the prefix or `undefined`) so the fast-path gating is isolated and unit-clear;
  `undefined` → existing full-scan loop.
- Verify the `equalityPrefix` seek behaves correctly for a DESC-leading backing PK
  (write the DESC test first); relax or keep the ASC gate accordingly.
- Add the tests above to `covering-structure.spec.ts`.
- Update `docs/materialized-views.md` (three spots listed under "Docs").
- Run `yarn workspace @quereus/quereus test` (and lint); run/note `yarn test:store` for
  store parity.
- (Deferred, do **not** do here unless trivial) Threading per-column collation into
  `ScanPlan.equalityPrefix` matching (`plan-filter.ts` / `scan-layer.ts`) to let
  non-binary-collation covering MVs also use the prefix scan — note as a follow-up in
  the review handoff if not done.
