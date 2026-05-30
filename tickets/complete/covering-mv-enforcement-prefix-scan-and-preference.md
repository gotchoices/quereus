description: Backing-PK prefix scan for row-time covering-MV UNIQUE enforcement (replaces the O(n) full backing scan with an O(log n + matches) prefix seek) plus the documented MV-in-preference decision. Reviewed and accepted.
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/covering-structure.spec.ts, docs/materialized-views.md, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/plan-filter.ts, packages/quereus-store/src/common/store-table.ts
----

## Summary of delivered work

`MaterializedViewManager.lookupCoveringConflicts` (`database-materialized-views.ts`)
now answers a covering-MV UNIQUE conflict check with a **backing-PK equality prefix
scan** keyed on `newRow`'s UC values (`scanLayer({ indexName: 'primary', descending:
false, equalityPrefix })`) instead of a full O(n) backing scan — O(log n + matches).
A new private helper `tryBuildCoveringPrefix(plan, uc, sourceSchema, newRow)` builds the
prefix in **backing-PK column order** (`prefix[i] = newRow[sourceCol(backingPk[i])]`),
gated to fire only when the leading `k = uc.columns.length` backing-PK columns map to
exactly the UC source-column set and every leading column (backing PK *and* its source
UC column) is BINARY-collated; otherwise it returns `undefined` and the code falls back
to the unchanged full layer scan. A module-level `isBinaryCollation` helper supports the
gate. The per-row matcher body (UC re-match, source-PK recovery, self-exclusion) is
unchanged. Part 2 (preference decision) is doc-only: the covering MV stays *in
preference* over the auto-index, now defensible because the prefix scan restores
O(log n) asymptotics. The store path inherits the optimization unchanged via
`store-table.ts::findUniqueConflictViaCoveringMv` → `Database._lookupCoveringConflicts`.

## Review findings

### What was checked

**Read the implement diff (fc21bab5) first, fresh, before the handoff.** Then read the
full `database-materialized-views.ts`, the full `scan-layer.ts` / `plan-filter.ts` /
`scan-plan.ts` (to independently verify the prefix-seek soundness rather than trust the
handoff), the new `covering-structure.spec.ts` tests, `store-table.ts`'s covering-MV
conflict path, and both touched docs.

- **DESC-seek soundness (the implement handoff's single flagged uncertainty) — VERIFIED
  sound, not just trusted.** Traced `scanLayer`'s `equalityPrefix` branch end to end:
  with `descending: false`, `isAscending` is always `true`, so the seek is always
  `safeIterate(tree, /*ascending*/ true, { value: [...prefix] })` and `seekFromUpper`
  (which only governs the *range* `else` branch) is irrelevant. The bare prefix key
  cracks immediately before the contiguous group of full keys sharing it under the
  tree's own comparator (the length-rule tiebreak — "shorter sorts first after equal
  elements" — is **not** direction-flipped), so the ascending walk lands at the group
  start and the binary `compareSqlValues` early-termination breaks the instant a leading
  column differs. Because equality on a column makes that column's sort *direction*
  irrelevant to *grouping* (the equal-valued rows are contiguous under ASC or DESC), this
  holds for a DESC-leading PK **and** for a mixed asc/desc composite prefix. The
  dedicated `order by x desc` enforcement test confirms the single-column case
  end-to-end; the mixed-direction case is covered by the same reasoning.
- **Prefix built in backing-PK order, not `uc.columns` order** — confirmed against the
  `order by y, x` (UC-permuted) test: `tryBuildCoveringPrefix` walks `backingPkDefinition`
  and pushes `newRow[projector.sourceCol]`, so a permuting `order by` still seeks the
  right block. The swapped-key negative (`(7,5)` distinct from `(5,7)`) guards against a
  uc-order prefix.
- **Collation gate (both backing-PK column *and* source UC column must be BINARY)** —
  sound and correctly conservative. Under BINARY the btree's declared-collation order,
  the binary early-termination, and the source-collation body re-match all coincide, so
  no matching row is skipped; any non-binary column bails to the collation-correct full
  scan. Gating on *both* columns is belt-and-suspenders but harmless.
- **Per-row body byte-for-byte unchanged** — confirmed in the diff; only the `scanPlan`
  construction differs. The body's source-collation re-match is redundant (but harmless)
  on the binary fast path and is the real matcher on the fallback path.
- **Gate condition 2 (leading-k = exact UC set)** — set-size + membership check is sound;
  a duplicate or non-UC leading column falls back safely (never silently wrong).
- **Store parity** — `findUniqueConflictViaCoveringMv` routes through the same
  `_lookupCoveringConflicts` and validates each candidate against the live store row
  (committed + pending overlay) via `readLiveRowByPk`; no store-side change was needed.
- **Docs** — `docs/materialized-views.md` § "Enforcement through a covering MV" now
  describes the prefix scan, the collation soundness gate, the DESC reasoning, and the
  fallback; the preference-tradeoff paragraph records the in-preference decision; the
  roadmap drops the delivered items and keeps collation-threading + isolation-routing.
  Accurate against the code. The `docs/incremental-maintenance.md` touch (5 lines) is an
  unrelated cross-reference tidy, consistent with the new wording.
- **Tests** — `covering-structure.spec.ts` § "row-time covering enforcement" adds:
  prefix-narrows (shared `x=1`, no false conflict + intra-block ABORT), correct-source-PK-
  among-shared-prefix (REPLACE evicts the right id), UC-permuted order-by, NOCASE
  fallback (asserts the *candidate generator* `_lookupCoveringConflicts`, not end-to-end),
  and single-column DESC. The pre-existing composite `order by x, y` suite is the ASC
  regression floor.

### Findings

- **Correctness: none.** No bug found in the prefix-scan logic, the gate, the prefix
  construction, the fallback, or the store routing. The one flagged-uncertain area
  (DESC) was independently verified sound.
- **Minor (reasoned-safe, left as optional follow-up coverage — not fixed inline because
  they would only add belt-and-suspenders tests and could not be executed/verified in
  this review session; see Validation):**
  - No dedicated test for a **mixed asc/desc composite** covering MV (e.g.
    `order by x asc, y desc`). The grouping argument above makes it sound; a test would
    only harden it.
  - No dedicated test for a **NULL UC value** on the new path. Reasoned safe: the prefix
    scan only narrows candidates and the per-row body is identical to the prior full-scan
    path, so behavior is unchanged versus before this ticket (any NULL-equality nuance is
    a pre-existing property of the unchanged body, not introduced here).
- **Major: none.** No new `fix/`/`plan/`/`backlog/` ticket filed. The two genuinely
  deferred items the handoff names are already real, tracked tickets and out of scope
  here: per-column collation threading into `ScanPlan.equalityPrefix`
  (so non-binary covering MVs also use the prefix scan — currently full-scan fallback,
  documented in the roadmap) and `covering-mv-isolation-layer-enforcement-routing`. The
  NOCASE end-to-end UNIQUE soundness gap is the separate, pre-existing
  `unique-constraint-honors-column-collation`; this ticket's NOCASE test correctly scopes
  its assertion to the candidate generator and does not regress end-to-end behavior.

### Validation

All three gates ran in this session and PASSED:

- **typecheck** — `yarn workspace @quereus/quereus typecheck` → exit 0.
- **lint** — `yarn workspace @quereus/quereus lint` → exit 0.
- **test** — `yarn workspace @quereus/quereus test` → **3965 passing, 9 pending, 0
  failing** (exit 0), matching the implement-stage count exactly.

`yarn test:store` (the slower LevelDB-store re-run) was **not** run in-session; the
optimization flows to the store path automatically (`store-table.ts` →
`Database._lookupCoveringConflicts`, no store-side change), and the implement stage
reported it green (3961 passing / 0 failing). A CI/human `test:store` run is the only
remaining confirmation, and it is low-risk given the shared code path. No
`.pre-existing-error.md` was written — no test failure was observed.

(Process note: an accidental oversized batch of duplicate file-reads early in the session
flooded the tool-result channel and briefly made shell commands return empty/hang; once
that backlog drained, all three gates above ran cleanly to completion.)
