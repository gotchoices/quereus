---
description: scanLayer seek-start now derives from the physical walk direction (seekFromUpper = isAscending === isDescFirstColumn) across all four primary/secondary combinations, fixing the latent descending-range row-drop. Reviewed and completed.
files: packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/test/vtab/scan-layer-descending.spec.ts, packages/quereus/test/logic/05.1-composite-pk-range-scan.sqllogic
---

## What shipped

`scanLayer` now selects its seek **start** key from the *physical* walk
direction rather than the key's declared direction alone. The rule
`seekFromUpper = (isAscending === isDescFirstColumn)` is applied symmetrically in
both the primary and secondary-index branches: seek from `upperBound` when
`seekFromUpper`, else `lowerBound` (falling back to the tree end `safeIterate`
picks for the direction); terminate early at the complementary bound. This
replaces the prior 4-way branching with one unified rule and removes the
`isAscending` gate on early termination (which previously never fired on a
descending walk).

This closes the latent defect where a descending walk over a DESC-leading key
seeked from the wrong end of the physical order and dropped front-of-order rows.
The descending path remains **not reachable through SQL** (no emitter produces
`plan.descending = true`); it is exercised by constructing `ScanPlan`s directly
in a unit test. No SQL-reachable descending emitter was added — deliberately
deferred (see below).

## Review findings

### Checked

- **Read the implement diff first** (commit `c6a48df6`): `scan-layer.ts`, the new
  `scan-layer-descending.spec.ts`, and the `05.1` sqllogic case — before reading
  the handoff summary.
- **Traced the `seekFromUpper` rule** through `safeIterate` (start = `tree.find`
  + `moveNearest`; walk via `moveNext`/`movePrior`) and the BTree comparators for
  all four `{isAscending}×{isDescFirstColumn}` combinations. The seek lands at the
  bound-nearest crack, the walk is monotonic in the leading column, and
  termination at the complementary bound is sound for both walk directions.
- **Validated the early-termination "pure optimization" claim**: the break sits
  inside the `!planAppliesToKey(...)` block, and `plan-filter.ts`
  `planAppliesToKey` keys off the leading column only (`key[0]`) for non-prefix
  plans — so the seekFromUpper-complement termination can never cut a still-matching
  row. Assumption holds.
- **Regression-guard efficacy**: reverted `scan-layer.ts` to its pre-fix parent
  and re-ran the new spec with `--no-bail`. **5 of 7 unit cases fail** on the
  pre-fix source; the 2 that pass (DESC-leading lower-bound-*only*, and the
  ascending parity case) are exactly the ones the direction analysis predicts
  involve no seek skip / no change. The unit spec is a genuine guard for the core
  fix.
- **Composite comparator** (`index.ts` `createCompositeColumnKeyFunctions`):
  confirmed a bare scalar seek key makes `arrA[0]` resolve to `undefined`, so the
  seek sorts to a constant tree extreme independent of data.
- **Lint** (`yarn lint`) → 0. **Typecheck** (`yarn typecheck`) → 0.
  **Tests** (`node test-runner.mjs`) → **3591 passing, 9 pending, 0 failing**.
- **Docs**: `docs/memory-table.md` and the other `docs/` hits describe scan
  behavior at a level unaffected by this internal seek-start change; nothing
  overstated or now-stale. No doc edit required.

### Found & fixed inline (minor)

- **The "bonus reachable fix" sqllogic case was mischaracterized.** The
  implementer added `select id from idx_d where k <= 25` (DESC-leading composite
  secondary, ascending walk, seek-from-upper) and described it as guarding a
  *reachable row-drop bug* caused by the old scalar (un-wrapped) seek. Verified
  directly: **this case passes on both the pre-fix and post-fix source.** Because a
  bare scalar seek sorts to a constant tree extreme, for the ascending +
  DESC-leading + upper-seek combination it lands at the *start* of the forward
  walk — a full scan that is **inefficient but still correct** (no row drop). The
  array wrap is therefore an efficiency/consistency improvement, not a
  correctness fix, and the test is a result-correctness assertion, not a
  regression guard. **Corrected the misleading comment** in
  `05.1-composite-pk-range-scan.sqllogic` to state this accurately.

### Major findings

None. The core fix is correct, DRY (one rule replacing four branches), symmetric
across primary/secondary, type-safe, and well-guarded by the unit spec. No new
fix/plan tickets filed.

### Deferred (not a defect — explicitly out of scope)

- **No SQL-reachable descending emitter.** `rule-select-access-path.ts` emits
  only `plan ∈ {0,2,3,5,6,7}` and never sets `ordCons = DESC`, so
  `plan.descending` is always false in the live engine. This fix makes a future
  emitter safe but does not add one; that is a separate feature (plan=4 /
  `ordCons=DESC` / reverse-walk-for-ORDER-BY). Not filed as a ticket — it is a
  speculative feature with no current driver, and the prior ticket chain already
  documents the trail. The `equalityPrefix` (plan=7) descending sub-branch is
  likewise untouched (never emitted descending).
- **`yarn test:store` not run** (memory-module change; prior related tickets set
  the same precedent). The added sqllogic case would also run under the store
  harness — a release-prep reviewer may want to confirm there.
