---
description: Golden-plan regression harness now runs real comparisons (was dead code in a `before()` hook). Synchronous test registration, a Map-aware serializer over the physical-properties surface, a single optimized `.plan.json` per case, 3 committed goldens, and a test-only global-id-counter reset for offset-invariance. Reviewed and accepted; all checks pass.
files:
  - packages/quereus/test/plan/golden-plans.spec.ts
  - packages/quereus/test/plan/_helpers.ts
  - packages/quereus/test/plan/README.md
  - packages/quereus/test/plan/basic/simple-select.plan.json
  - packages/quereus/test/plan/aggregates/group-by.plan.json
  - packages/quereus/test/plan/joins/simple-join.plan.json
---

## Summary of landed work

The golden-plan corpus was a **no-op**: per-`.sql` `it()`s were registered from
inside a Mocha `before()` hook, which fires *after* the suite's test list is
fixed, so they never ran — and no golden JSON was committed. The implement stage
made it run for real:

1. **Synchronous registration** (`golden-plans.spec.ts`): `findTestCases()` is a
   synchronous `readdirSync` recursion called directly in the `describe` body;
   `it()`s are created at definition time. A guard `it('discovers at least one
   golden plan test case')` fails loudly on an empty corpus.
2. **Map-aware serializer** (`_helpers.ts`, `serializePlanForGolden`): walks
   `node.getChildren()` and emits `{ nodeType, op, detail, logical, physical,
   children }` via `safeJsonStringify`, so `Map`-valued physical/logical fields
   render as the bounded `{ $map: […], size }` summary (the EXPLAIN /
   `query_plan()` surface) instead of `[COMPLEX_OBJECT]`. `detail` is
   `node.toString()` with the unstable global id token stripped; top-level
   cost/`getTotalCost()`/node `id` are deliberately omitted; keys sorted and
   residual `id`/`timestamp` keys dropped.
3. **Single optimized artifact** (`{name}.plan.json`): `getPlan()`/`compile()`
   both return the optimized plan, so the old `.logical.json`/`.physical.json`
   split serialized the same tree twice. Collapsed to one file; a real
   logical-vs-physical pair would need a pre-`optimize()` accessor that isn't
   exposed (breadcrumb in README).
4. **Determinism** (`withDeterministicPlanIds`): `PlanNode` allocates `id` /
   attribute ids from process-global `private static` counters never reset
   per-database, so ids leak into the snapshot and are not offset-invariant. The
   harness resets the counters to 0 around each snapshot (reaching into the
   private statics via a test-only cast) and restores the high-water mark in
   `finally`.
5. **Committed goldens**: `basic/simple-select` (10 nodes), `joins/simple-join`
   (15 nodes), `aggregates/group-by` (19 nodes). **README** updated to the
   single-file convention and `$map`/physical surface.

## Review findings

### What was checked

- **Implement diff read fresh** (`golden-plans.spec.ts`, `_helpers.ts`) before
  the handoff summary.
- **Supporting code:** `safeJsonStringify`/`jsonStringify` `$map` path
  (`util/serialization.ts`), `Database.getPlan()` (returns the optimized plan —
  confirmed), `PlanNode.toString` / `physical` getter / `getLogicalAttributes` /
  `nextId`/`nextAttributeId` private statics.
- **Determinism harness logic** reasoned through end-to-end (reset, restore,
  collision safety, reentrancy, throw-path).
- **All three golden files** inspected node-by-node (attribute ids, detail
  strings with embedded attribute ids like `INNER HASH JOIN on [3=4]`, estimate
  fields).
- **Ran (this session, foreground/streamed):**
  - isolated `golden-plans.spec.ts` → **4 passing** (guard + 3 named cases), exit 0.
  - `yarn workspace @quereus/quereus run typecheck` → **0 errors**.
  - `yarn workspace @quereus/quereus run lint` → **clean**, exit 0.
  - full `yarn workspace @quereus/quereus test` → **4092 passing, 0 failing, 9
    pending**, exit 0. golden-plans runs mid-suite after thousands of ids are
    allocated, so this green run is the real offset-invariance proof.
- **Orphan / wiring check:** no stale `.logical.json`/`.physical.json` remain;
  only the 3 `.sql`+`.plan.json` pairs exist; `test:plans` glob still selects the
  spec; `serializePlanTree` still used by `materialized-view-plan.spec.ts` only.
- **`$map` coverage:** dedicated unit tests in `test/util/serialization.spec.ts`
  ($map summary, insertion order, numeric keys, nested bigint, nested Maps).
- **Docs:** README rewritten to the new convention; `docs/architecture.md:246`
  and `docs/optimizer.md:609` carry only generic golden-plan references that
  remain accurate; no doc still references the two-file convention.

### Verified correct (raised as concerns, found NOT to be problems)

- **`withDeterministicPlanIds` restore/collision safety.** The fresh `db` is
  closed in the `finally` *inside* the reset window, so the low-id (0..N) plan
  nodes created during the snapshot are dead before counters are restored; the
  `finally` sets each counter to `Math.max(saved, current)`, so subsequent specs
  continue from the original high-water mark and never reuse an id. Correct on the
  throw-path too (saved captured before reset). Non-reentrant, but never nested
  and Mocha is serial — documented.
- **Reaching into `private static` from test code.** Test-only cast; no
  production change. The 4092-passing full run is positive evidence it causes no
  id collisions elsewhere (the `finally` restore is doing its job).
- **Generation determinism.** The read-mode test reproduces the committed goldens
  byte-for-byte — the strongest available proof that snapshot generation is
  deterministic.
- **`physical ?? null`.** The `physical` getter always returns a value; the `??`
  is dead/defensive and documented as such — harmless.

### Minor findings (documented, intentionally NOT changed)

These are accepted as-is; fixing them would regenerate all 3 goldens for no
functional gain, or would diverge from documented design intent.

- **`op` is fully redundant with `nodeType`.** `op = nodeType.replace(/Node$/,
  '').toUpperCase()`, but **zero** `PlanNodeType` values end in `"Node"` (grep
  confirmed), so the `replace` is a no-op and `op` is always just
  `nodeType.toUpperCase()`. It also does *not* reproduce EXPLAIN's semantic `op`
  (SCAN/JOIN/…) — it is a naive uppercase. It is deliberate (mirrors the *shape*
  of EXPLAIN's column set), self-consistent, and deterministic. Left in place;
  flagged here as a future cosmetic-cleanup candidate, not churned now.
- **Estimate fields are baked into the goldens** (`estimatedRows`,
  `estimatedCost`/`filterInfo.estimatedCost`, `estimates.rows`). Stable only
  because the test tables are empty (rows = 0) and the index heuristic uses fixed
  constants (`1000.01` / `1000`). **Accepted** as part of the intentional thick
  physical-surface regression net — consistent with capturing `fds`, `ordering`,
  `monotonicOn`, etc., which are equally optimizer-derived. Real churn vector;
  documented so an intentional cost-model change knows to regenerate.
- **Thick snapshots churn on any optimizer / physical-property change.** This is
  the deliberate tradeoff (opposite of the assertion-based plan-shape specs that
  live alongside). Conscious sign-off: accepted.
- **The `$map` branch is structurally present but not exercised by any golden
  fixture** (grep `$map` → 0 hits in the corpus). It *is* covered by
  `serialization.spec.ts` unit tests, so the rendering is verified — only the
  end-to-end golden path is unproven. The follow-up `view-mutation-physical-
  lineage` work is expected to introduce the first Map-valued field. Documented
  gap, not a blocker.
- **`logical` is `getLogicalAttributes()` on the *optimized* node**, not a true
  pre-optimization logical plan — documented in the README.

### Major findings

None. No new fix/plan/backlog tickets filed.

### Disposition

All checks (isolated spec, typecheck, lint, full suite) pass. No inline fixes were
required: the verified-correct concerns are sound by construction, and the minor
findings are either intentional design choices or cosmetic items not worth
regenerating goldens for. Implementation accepted as landed.
