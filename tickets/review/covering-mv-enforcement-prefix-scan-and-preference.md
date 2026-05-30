description: Review the delivered backing-PK prefix scan for row-time covering-MV UNIQUE enforcement (replaces the O(n) full backing scan with an O(log n + matches) prefix scan) and the documented MV-in-preference decision.
prereq:
files: packages/quereus/src/core/database-materialized-views.ts, packages/quereus/test/covering-structure.spec.ts, docs/materialized-views.md, packages/quereus/src/vtab/memory/layer/scan-layer.ts, packages/quereus/src/vtab/memory/layer/plan-filter.ts, packages/quereus/src/runtime/emit/materialized-view-helpers.ts, packages/quereus-store/src/common/store-table.ts
----

## What was delivered

**Part 1 — backing-PK prefix scan.** `MaterializedViewManager.lookupCoveringConflicts`
(`database-materialized-views.ts`) no longer full-scans the covering MV's backing table
for every UNIQUE conflict check. It now builds a backing-PK **equality prefix** keyed on
`newRow`'s UC values and runs `scanLayer({ indexName: 'primary', descending: false,
equalityPrefix })`, which seeks to the matching block and early-terminates — O(log n +
matches) instead of O(n). No new scan machinery: the `ScanPlan.equalityPrefix` mechanism
(`scan-layer.ts` + `plan-filter.ts`) already existed.

- New private helper `tryBuildCoveringPrefix(plan, uc, sourceSchema, newRow)` builds the
  prefix in **backing-PK column order** (`prefix[i] = newRow[sourceCol(backingPkDefinition[i])]`),
  so a permuting `order by` (`order by y, x` over `unique(x, y)`) still seeks to the right
  block. Returns `undefined` (→ existing full-scan fallback) when the fast-path gate fails.
- New module-level helper `isBinaryCollation(coll)`.
- The per-row body (UC re-match, `sourcePk` recovery, self-exclusion, push) is **unchanged**
  and still runs on both paths — redundant under binary prefix equality but harmless, and it
  is the collation-correct matcher on the fallback path.

**Fast-path gate (all must hold, else full-scan fallback):**
1. `backingPkDefinition.length >= k` and each leading-`k` backing-PK column is a
   `'passthrough'` projector (defensive — the covering shape guarantees it).
2. The leading `k = uc.columns.length` backing-PK columns map (via passthrough) to **exactly**
   the UC source-column set.
3. Every leading column — **both** the backing-PK column's declared collation **and** its
   source UC column's collation — is BINARY. This is a **soundness** gate: the scan-layer
   early-termination / `planAppliesToKey` compare with plain `compareSqlValues` (binary),
   while the btree orders by declared collation and UNIQUE conflicts by source collation, so a
   non-binary collation could `break` before a collated-equal/binary-different conflict.
   (Gating on *both* the backing and source collation is belt-and-suspenders in case the body's
   output-column collation does not propagate to the backing column.)
4. DESC-leading prefixes are **allowed** (see verification below).

**Part 2 — preference decision (no code change).** Documented decision: the covering MV stays
**in preference** over the auto-index for physical schemas. The prefix scan makes this
defensible (O(log n + matches), same asymptotics as the auto-index probe; the former O(n²)
bulk-insert regression is gone). Residual cost is a bounded constant factor + the
maintained-but-unconsulted auto-index. `findIndexForConstraint` is untouched.

**Store path:** no store-side change — `store-table.ts::findUniqueConflictViaCoveringMv` calls
the same `_lookupCoveringConflicts`, so the optimization flows through automatically (confirmed
by `yarn test:store`).

**Docs:** `docs/materialized-views.md` updated in three spots (enforcement section now describes
the delivered prefix scan + collation gate + fallback; preference-tradeoff paragraph records the
decision; roadmap bullet drops the delivered items, keeps collation-threading + isolation-routing).

## Validation performed (all green)

- `yarn workspace @quereus/quereus test` — **3965 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus test:store` — **3961 passing, 13 pending, 0 failing** (store parity).
- `yarn workspace @quereus/quereus lint` — clean.
- `yarn workspace @quereus/quereus typecheck` — clean.

New tests in `covering-structure.spec.ts` → `row-time covering enforcement`:
- **Behavior parity:** the whole pre-existing suite (composite `order by x, y`) now runs through
  the prefix scan unchanged — it is the ASC happy-path regression floor.
- **Prefix narrows correctly:** seed `(1,1),(1,2),(2,1)`; insert `(1,3)` succeeds (shared x=1 prefix,
  no false conflict — exercises early-termination); insert `(1,2)` ABORTs.
- **Correct source PK among shared-prefix rows:** `insert or replace (9,1,2)` evicts id=2 (not id=1).
- **UC-permuted order-by** (`order by y, x`): the `(5,7)` duplicate is caught and the swapped `(7,5)`
  is distinct — proves the prefix is built in backing-PK order, not `uc.columns` order.
- **Non-binary collation:** asserts the *candidate generator* `_lookupCoveringConflicts` still
  returns the conflicting source PK for a NOCASE covering MV (see the gap note below).
- **DESC verification** (`order by x desc`): conflicts still resolve through the prefix seek.

## DESC verification outcome

DESC-leading prefixes **use the fast path** (the gate does not exclude DESC). Reasoning:
equality on a column makes its order direction irrelevant to *grouping* (binary-equal rows stay
contiguous), and `scanLayer`'s `equalityPrefix` branch always seeks `safeIterate(tree,
isAscending=true, [prefix])`; the length-rule crack positioning + ascending `moveNearest` lands at
the group start regardless of the column's `desc` flag, and the binary early-termination breaks on
leaving the group. The `order by x desc` enforcement test confirms it end-to-end. **Reviewer:
please sanity-check this reasoning** — it is the one place the ticket flagged as needing
verification, and it is verified only by a single-column DESC test (a mixed asc/desc composite is
covered by reasoning, not by a dedicated test).

## Known gaps / things to scrutinize

- **Deferred (intentionally, per the ticket):** threading per-column collation into
  `ScanPlan.equalityPrefix` matching (`plan-filter.ts` / `scan-layer.ts`). Until then, a
  non-binary-collation covering MV always takes the full-scan fallback. Noted as a follow-up in
  the docs roadmap bullet. Not done here.
- **NOCASE end-to-end enforcement is a *separate* pre-existing soundness gap**, tracked by the
  implement-stage ticket `unique-constraint-honors-column-collation`. Its root-cause note #2
  confirms `lookupCoveringConflicts` (the candidate generator I changed) is already
  collation-aware, but the downstream validator `checkUniqueViaMaterializedView` (memory) /
  `findUniqueConflictViaCoveringMv` (store) re-compares with BINARY and drops the candidate. So
  an end-to-end `insert 'Foo'` / `insert 'foo'` does **not** raise today regardless of this
  change. My nocase test therefore asserts the **candidate generator** only
  (`_lookupCoveringConflicts` returns the right source PK), which is the surface this ticket
  governs — not end-to-end enforcement. Reviewer should confirm this scoping is acceptable and not
  mistake the unchanged end-to-end NOCASE behavior for a regression.
- **NULL UC values** are not covered by a dedicated test. Reasoned safe: a NULL UC value cannot
  conflict (SQL UNIQUE NULL semantics), the prefix scan only narrows candidates, and partial
  NULL-skip MVs hold no NULL backing rows. Worth a skeptical pass if the reviewer wants belt-and-
  suspenders coverage.
- **Gate condition 2 (leading-k = UC set)** relies on `computeBackingPrimaryKey` seeding the
  backing PK with the `order by` columns (= permutation of UC) ahead of the remaining source PK.
  If that seeding ever changes, the gate falls back safely (never silently wrong), but the
  fast path would stop firing — worth confirming the invariant is documented where it matters
  (`materialized-view-helpers.ts::computeBackingPrimaryKey`).

## Suggested reviewer focus

1. Soundness of the collation gate (both backing + source) and whether the binary-only
   restriction is correctly conservative.
2. The DESC seek reasoning above (single most-uncertain area).
3. The backing-PK-order prefix construction in `tryBuildCoveringPrefix` vs the UC-permuted test.
4. That the per-row fallback body is genuinely unchanged (the diff keeps it byte-for-byte).
