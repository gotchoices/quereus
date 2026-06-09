description: Thread the index column's declared collation into the memory vtab range/prefix seek so non-BINARY (NOCASE/RTRIM) range and BETWEEN seeks become usable instead of always declining to a scan + residual, via an opt-in `BestAccessPlanResult.honorsCollatedRangeBounds` capability (memory advertises it; store does not). Reviewed: found + fixed a major NULL-leak correctness bug exposed by enabling the seek (a bound seek over a nullable column yielded NULL rows because the dropped residual no longer caught them). Build + lint + typecheck pass; memory full suite 5470 passing, 9 pending.
files:
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts                  # boundCollation + equalityPrefixCollations on ScanPlan; resolveColumnCollation()
  - packages/quereus/src/vtab/memory/layer/plan-filter.ts                # bound/prefix compares pass collation; NULL-key exclusion for range bounds (review fix)
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts                 # range early-termination + prefix-mismatch compares pass the collation
  - packages/quereus/src/vtab/best-access-plan.ts                        # BestAccessPlanResult.honorsCollatedRangeBounds flag
  - packages/quereus/src/vtab/memory/module.ts                           # memory getBestAccessPlan stamps honorsCollatedRangeBounds: true
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # classifyConstraintCover range arm gated by the flag
  - packages/quereus/test/optimizer/range-seek-collation-bounds.spec.ts  # 15 tests (plan + seek≡scan), incl. 4 NULL regression tests added in review
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic         # cross-backend result-only cases
  - docs/optimizer.md                                                    # updated the collation-cover paragraph
  - tickets/backlog/store-range-seek-collation-bounds.md                 # follow-up: make the store's range filter collation-aware + advertise the flag
----

# Memory range/prefix seek now honours index collation

## What shipped

The memory scan layer previously walked an index in its declared collation order but
filtered range bounds (and prefix-equality keys) with a **BINARY** comparator, so the
planner's `classifyConstraintCover` declined **every** non-BINARY range seek → `SeqScan` +
residual. This ticket threads each relevant index column's declared collation onto the
`ScanPlan` (`boundCollation`, `equalityPrefixCollations`) and into the bound filter and
early-termination, then adds an opt-in `BestAccessPlanResult.honorsCollatedRangeBounds`
capability. `classifyConstraintCover`'s range arm now allows a non-BINARY range MATCH only
when the predicate's effective collation equals the index collation **and** the module
advertises the flag. The memory module sets it; the store (whose range filter is still
BINARY) leaves it off and keeps the conservative decline — byte-for-byte unchanged.

The collation resolution (`resolveColumnCollation` → `normalizeCollationName`) reads the
same `IndexColumnSchema`/`PrimaryKeyColumnDefinition.collation` that the memory index
btree comparator resolves via `resolveCollation`, so the walk order and the bound filter
stay consistent for any built-in collation.

## Review findings

**Diff reviewed first (commit `0cdf0ddb`), then the handoff.** Scrutinized for SPP, DRY,
type safety, resource cleanup, error handling, and — most importantly — correctness of the
seek≡scan equivalence the optimization now relies on (the MATCH cover drops the residual
`Filter`, so the scan layer alone must reproduce the predicate exactly).

### Major — found and FIXED inline (correctness)

- **NULL rows leaked by a bound seek over a nullable column.** `planAppliesToKey` returned
  `true` for a NULL bound-column key (the `!== null` guard skipped the bound check), and a
  MATCH cover drops the residual `Filter`, so a pure upper-bound (`< x` / `<= x`) ascending
  seek walked the leading NULL block and **yielded** it. Confirmed empirically: `name <
  'cherry'` over a nullable column returned `[1,2,3,5]` (NULL ids 3,5 leaked) vs the correct
  scan baseline `[1,2]`.
  - **Pre-existing for BINARY** (the BINARY range seek was already a MATCH that dropped its
    residual — the BINARY repro failed identically), but this ticket **regressed**
    NOCASE/RTRIM: before, a non-BINARY range declined to a correct `SeqScan` + residual;
    after, it used the buggy seek. Because the regression is squarely a consequence of this
    ticket and the fix is small and provably correct SQL semantics (`NULL <op> v` is never
    true), it was fixed in this pass rather than deferred.
  - **Fix** (`plan-filter.ts`): exclude a NULL bound-column value whenever a range bound is
    present, for both the plain-range and the prefix-range trailing column. `undefined`
    (column absent from a short key tuple) stays lenient. The fix also resolves the latent
    pre-existing BINARY leak.
  - **Tests added** (4, in the spec's new `NULL rows … excluded by the bound seek` block):
    NOCASE `<`, BINARY `<` (guards the pre-existing path), NOCASE `BETWEEN`, and a
    prefix-range with a NULL trailing range value — each asserting `IndexSeek` is chosen AND
    seek≡scan.

### Minor — noted, not changed (out of scope / not worth churn)

- **Pure upper-bound ascending seek walks the leading NULL block** before reaching data
  (no clean "first non-null" seek key). Perf only, pre-existing (BINARY had it), correctness
  is now right. Left as a possible future micro-optimization.
- **`boundCollation` variable shadowing** in `buildScanPlanFromFilterInfo` (a top-level
  `let boundCollation` plus branch-local `const boundCollation` in the multi-range and
  prefix-range early-return arms). Harmless (the arms return before the outer binding is
  used) and lint-clean; left as-is.
- **Store NULL-in-range handling not audited** — the store's `compareValues` range arms are
  a separate subsystem; whether they leak NULLs is independent of this memory ticket and was
  not investigated here. Filed work for the store's *collation* gap already exists
  (`store-range-seek-collation-bounds`).

### Verified clean (no action)

- **Capability-flag gating is a true no-op when off:** `predColl === indexColl && (predColl
  === 'BINARY' || honorsCollatedRangeBounds)` reduces to the old `BINARY && BINARY` when the
  flag is absent — store, legacy PK path, lamina/test modules unchanged. Confirmed the store
  still declines non-BINARY ranges (sqllogic `06.4.2` passes under `QUEREUS_TEST_STORE`).
- **Walk-order vs bound-collation consistency:** the btree comparator (`index.ts`,
  `primary-key.ts`) and the bound filter both resolve the same per-column declared collation;
  `compareSqlValues(undefined)` ≡ `'BINARY'` ≡ the btree's no-collation default.
- **Collation positions:** leading column for a plain/multi range, trailing column for a
  prefix-range — matches `extractRangeBounds` / the prefix builder. Covered by the
  "BINARY leading + NOCASE trailing" test.
- **DESC × collation orthogonality**, **explicit `COLLATE` on a BINARY column**, and the
  **mismatch-still-declines** negative case are all covered by the spec.
- **Equality cover unchanged** (the flag is ignored for equality in `classifyConstraintCover`);
  no equality-seek test shifted.

### Documented gaps carried forward (from the implementer, re-confirmed)

- Store path intentionally not optimized → `tickets/backlog/store-range-seek-collation-bounds.md`
  (well-formed, accurate).
- OR_RANGE non-BINARY still declines (`effectivePredicateCollation` resolves it to BINARY);
  the multi-range `boundCollation` threading is in place but only exercised if that resolution
  is later refined.
- Per-database-only (non-global) custom collations fall back to BINARY in both the btree and
  the bound compare — pre-existing, unchanged.

## Validation

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` (memory) — **5470 passing, 9 pending** (was
  5466; +4 NULL regression tests).
- `test/optimizer/range-seek-collation-bounds.spec.ts` — **15 tests** (11 original + 4 NULL).
- `test/logic/06.4.2-collation-extras.sqllogic` passes under both memory and store.
