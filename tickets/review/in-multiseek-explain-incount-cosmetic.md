description: Plan-time dedup + NULL-drop of literal IN-list values in the memory-vtab multi-seek builders (plan=5), so the emitted `inCount` reflects the effective distinct non-null seek count instead of the raw literal-list length. Pure subset of the runtime set-membership fix already in scan-layer.ts — result semantics are unchanged.
prereq:
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts (single-column multi-seek builder, composite multi-seek builder, new helpers: reduceLiteralSeekValues / reduceLiteralSeekTuples / createEmptyResultNode), packages/quereus/test/optimizer/in-multiseek-incount.spec.ts (new regression), packages/quereus/src/vtab/memory/layer/scan-plan.ts + scan-layer.ts (runtime authority — unchanged, read for invariants)
----

## What was implemented

`WHERE col IN (v1..vn)` on an indexed memory-vtab column compiles to a multi-seek
`IndexSeekNode` (plan=5). The planner previously materialized the **raw** literal
list (including duplicates and NULLs) into the node, so the `inCount=` token on the
emitted `FilterInfo.idxStr` overstated the real work — e.g. `v in (5, null, 5, 9)`
advertised `inCount=4` when the runtime performs only 2 distinct non-null seeks.

The fix, in `selectPhysicalNodeFromPlan` (`rule-select-access-path.ts`), reduces the
**literal** IN list at plan time:

- **Single-column builder:** when the IN constraint is pure-literal (`valueExpr` is
  not an array), `reduceLiteralSeekValues` drops NULLs and collapses duplicate
  literals (compared under the default binary comparator). `seekKeys`, the per-value
  EQ constraints, and `inCount` are all derived from the reduced list so they stay
  consistent. Mixed/dynamic IN lists (from OR-collapse) keep their raw shape.
- **Composite builder:** when **every** seek column is pure-literal
  (`valueExpr === undefined` for all), the cross-product is built from actual values,
  then `reduceLiteralSeekTuples` drops any tuple with a NULL component (mirrors
  runtime `seekKeyHasNull`) and collapses duplicate tuples; `inCount`/`seekWidth`
  follow. If any column is dynamic, the original index-based cross-product is kept.
- **All-NULL edge:** if reduction empties the list (every literal is NULL, or every
  composite tuple is NULL-bearing), the builder returns an `EmptyResultNode` instead
  of a zero-key multi-seek. This is required for correctness, not just cosmetics:
  `inCount=0` would parse back (in `scan-plan.ts`) to no `equalityKeys` and degrade
  to an unbounded full-index walk. EmptyResult yields zero rows — same as the
  runtime would for an all-NULL multi-seek — so semantics are unchanged.

Plan-time dedup is deliberately a **strict subset** of the runtime dedup: it only
collapses values equal under the binary comparator, because the column's collation
is unknown at plan time. The runtime `scan-layer.ts` remains the authority and may
collapse further (e.g. NOCASE case-variants `'A'`/`'a'` that hit one index entry —
`inCount=2` is still advertised, runtime collapses to 1 row). Never an under-count,
never a wrong result.

## How to validate

- `cd packages/quereus && yarn test` — full suite was green (4437 passing, 9 pending)
  after the change. `yarn typecheck` and `eslint` on the two touched files are clean.
- New regression: `test/optimizer/in-multiseek-incount.spec.ts` pins `inCount` by
  reading it off the optimized `IndexSeekNode.filterInfo.idxStr`:
  - single-column: `(5,7,9)→3`, `(5,5,9)→2`, `(5,null,9)→2`, `(5,null,5,9)→2`,
    `(5,5,5)→1`, `(null,null)→EmptyResult` (+ result is `[]`).
  - composite: `a in (1,1,2) and b in (10,null) → 2`, `a in (1,2) and b in (10,20) → 4`.
- Result-correctness coverage that must keep passing (unchanged by design):
  `test/logic/07.9-in-value-list.sqllogic` and the "IN multi-seek set membership"
  block in `test/optimizer/secondary-index-access.spec.ts`.

## Reviewer notes / known gaps (treat tests as a floor)

- **`inCount` is NOT visible through `query_plan()` / EXPLAIN output.** The ticket
  framed this as "EXPLAIN advertises inCount", but in practice the `detail` and
  `properties` columns come from `node.toString()` and `getLogicalAttributes()`, and
  `getLogicalAttributes` surfaces `indexInfoOutput.idxStr` (which stays `'fullscan'`),
  **not** the `filterInfo.idxStr` that carries `inCount`. So the reduced `inCount`
  lives only in the `FilterInfo` string handed to `xFilter`/`scan-plan.ts`; the test
  inspects the optimized plan node directly rather than via `query_plan()`. If a
  reviewer wants the honest count to actually show up in EXPLAIN, that's a small
  follow-up to `IndexSeekNode.getLogicalAttributes()`/`toString()` — out of scope
  here, and arguably worth a separate ticket if EXPLAIN visibility is desired.
- **Cost estimate:** `accessPlan.cost` is still forwarded verbatim to the
  `IndexSeekNode`; the ticket allowed the cost to drop with `inCount`, but the
  module's cost was not recomputed from the reduced count (the memory module does not
  scale cost by IN-list length today). No behavior depends on it; flagging that the
  "any cost estimate derived from it" clause is effectively a no-op here.
- **Adjacent pre-existing bug found (separate ticket filed):** while characterizing
  NULL handling I confirmed that single-value `WHERE v = null` and `WHERE v IN (null)`
  on an indexed column return **all rows** instead of none (the plan=2 / length-1
  equality-seek-with-NULL-key path falls through to a full walk with the constraint
  marked handled, so no residual filter rejects the rows). This is **pre-existing and
  outside this ticket** — those branches were not touched here — but it is a real
  correctness bug. Filed as `tickets/fix/in-null-equality-returns-all-rows.md`.
- **Test surface is narrow on purpose:** the new spec only asserts `inCount` on the
  memory module's multi-seek. It does not exercise dynamic/mixed IN lists' `inCount`
  (intentionally left at raw length), nor blob/bigint literal dedup edge cases — a
  reviewer could add those if worried about `compareSqlValues` equality semantics
  across logical types.
