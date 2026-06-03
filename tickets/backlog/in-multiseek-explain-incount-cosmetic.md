description: EXPLAIN/query_plan reports the raw IN-list length (including duplicate and NULL literals) as `inCount` for a memory-vtab multi-seek (plan=5), even though those elements contribute no extra seeks at runtime. Purely cosmetic — the runtime correctness fix (set-membership dedup + NULL-skip) already lands; this only makes the plan's advertised `inCount` honest.
prereq:
files: packages/quereus/src/planner/rules/access/rule-select-access-path.ts (single-column multi-seek builder ~line 338, composite builder ~line 374 — where the literal IN value list is materialized into the IndexSeekNode and inCount is derived), packages/quereus/src/vtab/memory/layer/scan-plan.ts (consumes inCount/seekWidth into equalityKeys), packages/quereus/src/vtab/memory/layer/scan-layer.ts (the runtime fix that already dedups/NULL-skips — this work must remain a pure subset of that behavior)
----

## Background

`WHERE col IN (v1..vn)` on an indexed memory-vtab column compiles to a multi-seek
`IndexSeekNode` (plan=5). The runtime fix in `scan-layer.ts` already makes the seek
set-membership-exact: duplicate seek keys collapse (dedup by primary key) and
NULL/NULL-containing seek keys are skipped. So `in (5, null, 5, 9)` correctly seeks
only the distinct non-null values at runtime.

However, the **planner** still materializes the raw literal list (length 4 in that
example, including the NULL and the duplicate 5) into the IndexSeekNode, so
`EXPLAIN` / `query_plan()` advertises `inCount=4`. This is misleading: the effective
number of seeks is 2.

## Scope / expected behavior

Dedup and NULL-drop the **literal** IN values at plan time, in the single-column
(`rule-select-access-path.ts` ~line 338) and composite (~line 374) multi-seek
builders, so the emitted `inCount` reflects the effective distinct non-null seek
count.

Hard constraints:

- This is a **pure subset** of the runtime behavior already in `scan-layer.ts`. It
  must not change result semantics — only the advertised `inCount` (and any cost
  estimate derived from it).
- It applies to **literal** values only. Dynamic / parameter seek values are unknown
  at plan time, so the runtime dedup/NULL-skip in `scan-layer.ts` remains the
  authority and must not be removed or weakened. Do not attempt to dedup dynamic
  values at plan time.
- Composite cross-product: a tuple with any NULL component is droppable (it can never
  match a row-value comparison); duplicate tuples collapse. Mirror the runtime
  `seekKeyHasNull` semantics exactly.

## Notes

- No existing plan-shape test asserts `inCount`, so this is currently unobserved by
  the suite. A test that pins `inCount` for a dup/NULL-bearing literal IN list would
  be the natural regression to add alongside the change.
- Low priority — cosmetic/clarity only. The runtime correctness bug this stems from is
  already fixed (see `complete/in-value-list-duplicate-or-null-row-multiplication`).
