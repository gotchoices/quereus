description: Thread the index column's declared collation into the memory vtab range/prefix seek so non-BINARY (NOCASE/RTRIM) range and BETWEEN seeks become usable instead of always declining to a scan + residual. Adds an opt-in `BestAccessPlanResult.honorsCollatedRangeBounds` capability so the (module-agnostic) access-path collation-cover guard relaxes ONLY for modules whose runtime actually honours collated bounds (memory does; store does not — it stays on the conservative decline path). Build + lint + typecheck pass; memory full suite 5466 passing; the collation logic file passes under both memory and store.
files:
  - packages/quereus/src/vtab/memory/layer/scan-plan.ts                  # NEW: boundCollation + equalityPrefixCollations on ScanPlan; resolveColumnCollation() from resolved index schema
  - packages/quereus/src/vtab/memory/layer/plan-filter.ts                # planAppliesToKey bound + prefix compares now pass the collation
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts                 # range early-termination + prefix-mismatch compares pass the collation (primary + secondary walks)
  - packages/quereus/src/vtab/best-access-plan.ts                        # NEW BestAccessPlanResult.honorsCollatedRangeBounds flag
  - packages/quereus/src/vtab/memory/module.ts                           # memory getBestAccessPlan stamps honorsCollatedRangeBounds: true
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # classifyConstraintCover range arm gated by the flag; threaded through classifyCollationCover + all call sites
  - packages/quereus/test/optimizer/range-seek-collation-bounds.spec.ts  # NEW 11 tests (plan + seek≡scan)
  - packages/quereus/test/logic/06.4.2-collation-extras.sqllogic         # appended cross-backend result-only cases
  - docs/optimizer.md                                                    # updated the collation-cover paragraph
  - tickets/backlog/store-range-seek-collation-bounds.md                 # NEW follow-up: make the store's range filter collation-aware + advertise the flag
----

# Memory range/prefix seek now honours index collation

## What changed

Before: the memory scan layer walked an index in its declared collation order but then
filtered range bounds (and prefix-equality keys) with a **BINARY** comparator
(`compareSqlValues` with the default collation) in `planAppliesToKey` and early-terminated
the walk with a BINARY compare in `scanLayer`. To stay correct, the planner's
`classifyConstraintCover` declined **every** non-BINARY range seek (even a collation-matched
one) → `SeqScan` + residual. Correct, but a missed optimization.

After:
1. **Runtime threading.** `buildScanPlanFromFilterInfo` resolves each relevant index
   column's collation from the resolved index schema and stamps it on the `ScanPlan`:
   - `boundCollation` — the range-bound column (leading column for a plain range, the
     trailing column for a prefix-range; the leading column for a multi-range).
   - `equalityPrefixCollations` — parallel to `equalityPrefix`, one per prefix column.
   `planAppliesToKey` (plan-filter.ts) and the early-termination / prefix-mismatch logic
   (scan-layer.ts, both primary and secondary walks) pass these into `compareSqlValues`.
   An absent collation falls through to BINARY (the `compareSqlValues` default), so the
   change is a no-op wherever a plan is built without collations — notably the
   `delete-by-prefix` maintenance op, which constructs its `ScanPlan` directly and stays
   on a BINARY prefix compare (its documented "binary-prefix contract").
2. **Capability flag.** `BestAccessPlanResult.honorsCollatedRangeBounds` (default off). The
   memory module sets it true; `classifyConstraintCover`'s range arm allows a non-BINARY
   range MATCH only when the predicate's effective collation equals the index collation
   **and** the module advertises the flag. With the flag off the condition reduces to
   exactly the old `predColl === 'BINARY' && indexColl === 'BINARY'` — so every non-opted-in
   module (store, lamina adapter, test modules, legacy PK path) is byte-for-byte unchanged.

## Why the flag matters (read this first when reviewing)

`classifyConstraintCover` lives in `rule-select-access-path.ts` and is **module-agnostic** —
it applies to any module that advertises `indexName` + `seekColumnIndexes`. The store module
DOES reach it (it advertises `_primary_` + the leading PK column for a PK range), but its
`StoreTable.compareValues` filters range bounds (LT/LE/GT/GE) with a **BINARY** JS comparator
(only EQ is NOCASE-aware). So relaxing the guard *unconditionally* would have under-fetched
case/space variants on store-backed NOCASE/RTRIM PK ranges — a silent correctness
regression. The capability flag is the fix: only memory (which implemented the runtime
threading) opts in. The store keeps the conservative decline and remains correct.

## Validation performed (this is a floor, not a ceiling)

- `yarn workspace @quereus/quereus run typecheck` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` (memory) — **5466 passing, 9 pending**.
- New optimizer spec `test/optimizer/range-seek-collation-bounds.spec.ts` — **11 tests**:
  single-column NOCASE `>` / `>=` / BETWEEN; explicit `COLLATE NOCASE` on a BINARY column;
  DESC NOCASE index range; RTRIM `>` / BETWEEN; prefix-range with a NOCASE **leading**
  column (`name = 'bob' AND year >= 2024`); prefix-range with a NOCASE **trailing** range
  column (BINARY leading); and the negative case (NOCASE predicate over a BINARY index still
  declines to scan + residual). Each asserts BOTH the plan (`IndexSeek` chosen) AND that the
  seek returns the same rows as a twin un-indexed table (the sequential-scan baseline).
- `test/logic/06.4.2-collation-extras.sqllogic` appended with result-only NOCASE PK range,
  NOCASE secondary range, and RTRIM range cases; **passes under both memory and store**
  (ran `QUEREUS_TEST_STORE=true ... --grep 06.4.2-collation-extras` → 1 passing) — confirms
  the store's conservative decline path still returns the collation-correct rows.

## Use cases / what to exercise when reviewing

- `select … where name > 'BOB'` / `BETWEEN` over a `name TEXT COLLATE NOCASE` column (PK or
  secondary index): should be an `IndexSeek` on memory and return all NOCASE-correct rows
  (including case variants whose BINARY bytes sort the other side of the bound).
- Same for `COLLATE RTRIM` (trailing-space-insensitive bounds).
- A predicate carrying its own `COLLATE NOCASE` over a NOCASE index (collation match via the
  predicate rather than the column) — also seeks.
- Collation **mismatch** (BINARY predicate over NOCASE index, or NOCASE predicate over BINARY
  index): must still decline to `SeqScan` + residual and return the predicate-correct rows.
- Composite-index prefix-range with the non-BINARY collation on the leading prefix column
  AND (separately) on the trailing range column.

## Known gaps / honest limitations (reviewer: probe these)

- **Store path NOT optimized (intentionally).** Filed `tickets/backlog/store-range-seek-collation-bounds.md`.
  The store stays correct (conservative decline) but does not use the index for non-BINARY
  ranges. I validated the store only for the one collation logic file under
  `QUEREUS_TEST_STORE=true`, not the whole `yarn test:store` suite — the change is a provable
  no-op for the store, but a reviewer wanting belt-and-suspenders could run the full store
  suite.
- **OR_RANGE never benefits in practice.** `effectivePredicateCollation` resolves an OR_RANGE
  constraint to BINARY (its source is an OR `BinaryOpNode` whose operands are booleans), so a
  non-BINARY OR_RANGE is still declined. The multi-range `boundCollation` threading is in
  place and consistent, but only exercised if OR_RANGE predicate-collation resolution is later
  refined. Not tested with a non-BINARY collation (would currently decline anyway).
- **Custom (user-registered) collations.** The runtime bound compare uses
  `compareSqlValues(a, b, name)` → the GLOBAL `resolveCollation`, the same resolver the memory
  index tree comparator uses (`vtab/memory/index.ts`), so walk order and bound filter stay
  consistent for any collation. A collation registered per-database-only (not in the global
  registry) would fall back to BINARY in BOTH the tree and the bound compare — a pre-existing
  limitation, not introduced here, and untested.
- **Equality cover unchanged.** The equality `MATCH` / `COARSER_SAFE` arms are untouched and
  not gated by the flag (store already handles NOCASE equality). Verify no equality-seek test
  shifted.
