description: |
  Review the fix for the streaming-aggregate stale-group-context bug: a grouped
  StreamAggregate was leaving the just-yielded group's representative-row context
  live in the shared runtime context while it pulled the next input row from its
  child, shadowing a directly-below Filter's own row slot (same source attribute
  IDs) so the WHERE predicate was evaluated against stale values and effectively
  dropped. Fix moves the deferred context teardown to run immediately after the
  mid-stream `yield` resumes, before the next child pull. Plus regression coverage
  (one sqllogic file + one plan-shape spec). Build, lint, typecheck, and full logic
  suite all green; both new tests were confirmed to FAIL on the unfixed code.
files:
  - packages/quereus/src/runtime/emit/aggregate.ts                        # THE FIX — emitStreamAggregate, GROUP BY branch (~lines 330, 427-438, post-loop)
  - packages/quereus/test/logic/07.4-group-by-filter-composite-pk.sqllogic # NEW regression: result-level coverage
  - packages/quereus/test/plan/streaming-aggregate-filter-shadow.spec.ts   # NEW regression: locks the bug-prone plan shape + correctness + HashAggregate control
  - packages/quereus/src/runtime/context-helpers.ts                        # reference only — docstrings already document the attributeIndex last-set-wins + reactivate() hazard (NOT edited)

# Streaming aggregate leaked group-representative context across the next child pull

## What changed (the fix)

In `emitStreamAggregate`'s GROUP BY branch (`aggregate.ts`), the deferred
`cleanupPreviousGroupContext()` teardown was being invoked at the **top of the next
loop iteration**. Because `for await (const row of sourceRows)` pulls the next
filtered child row **before** the loop body runs, the previous group's
representative-row descriptors (`scanRowDescriptor`, `combinedRowDescriptor`,
`groupSourceRowDescriptor` (+ relation variant)) stayed live in the context map
while the child Filter evaluated the next row. Those descriptors carry the SOURCE's
attribute IDs — the same IDs the child Filter's row slot publishes — and
`RowContextMap.attributeIndex` is last-`set`-wins, so the Filter's `column(r)`
resolved through the aggregate's STALE representative row instead of the child's
current row. (The child slot's `set()` only mutates a boxed ref; it does not
re-`set` the map, so it cannot reclaim the index — the exact hazard
`RowSlot.reactivate()` documents.)

Three edits, exactly as the implement ticket specified:
- Removed the top-of-loop `cleanupPreviousGroupContext()` invocation.
- Moved the teardown to run **immediately after `yield aggregateRow;` resumes**
  (with an explanatory comment), before the loop falls through to the next pull.
- Deleted the now-dead post-loop invocation (TypeScript flagged it `never`).

The final-group yield after the loop keeps its own `try/finally` teardown and is
unchanged. Semantics for consumers are preserved: the representative-row context
stays live for the entire `yield` suspension (when HAVING / correlated subqueries /
the projection read it) and is torn down only once the consumer resumes the
generator — at which point it is done with the previous row.

## How to validate

- Full logic suite (memory module): `yarn workspace @quereus/quereus test`
  → **4926 passing / 9 pending / 0 failing** (baseline was 4921; +5 = 1 new
  sqllogic block + 4 new plan-shape `it`s).
- Just the new specs:
  - `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/plan/streaming-aggregate-filter-shadow.spec.ts"`
  - `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "07.4-group-by-filter-composite-pk"`
- `yarn workspace @quereus/quereus run typecheck` → clean.
- `yarn workspace @quereus/quereus run lint` → clean.

### Reproduction proof (do this to convince yourself the tests guard the bug)
`git stash push -- packages/quereus/src/runtime/emit/aggregate.ts`, re-run the two
specs, observe both FAIL (`select d, sum(total) from bt where r=10 group by d`
returns `d=2 → 10` instead of `7`, and `d=3 → 100` instead of `1`), then
`git stash pop`. I performed this round-trip; the plan-shape *shape* assertions
correctly stay green on the unfixed code (the bug is runtime-only, the plan is
identical) while the *result* assertions fail — which is exactly why the plan-shape
spec exists: it keeps the sqllogic repro meaningful if the planner ever stops
producing the StreamAggregate+Filter shape.

## Test coverage map (use cases)

`07.4-group-by-filter-composite-pk.sqllogic` over `bt(d,r,total)` PK `(d,r)`,
rows `(1,10,150),(1,20,null),(2,10,7),(2,20,3),(3,10,1),(3,20,99)`:
- **Primary bug** — equality filter on a non-leading composite-PK col absent from
  GROUP BY: `where r=10 group by d` → `[{d:1,150},{d:2,7},{d:3,1}]` (d=2/d=3 are
  the tells; bug gives 10/100).
- **Range filter** (`r>9 and r<11`) — proves it is not specific to the `r=const` pin.
- **count(\*) + count(col)** — catch the wrong-keep directly (bug would count a 2nd
  row per group).
- **DISTINCT aggregate** (`sum(distinct total)`) — exercises the per-group
  distinct-tree reset adjacent to the edited code.
- **HAVING** over the filtered rollup — confirms rep-row context still readable in
  the yield.
- **Dropped-first-row-of-a-later-group** (`where r=20`) — boundary's stale r=20
  would wrongly pass `(3,10,1)` (real r=10); also covers `sum` over all-NULL (d=1).
- **ORDER BY desc** downstream of the aggregate.
- **Controls:** scalar aggregate (no GROUP BY), plain projection (Filter standing
  alone), single-column-PK seek (no standalone Filter under the aggregate), empty
  result, and a **HashAggregate path** (PK on `id`, GROUP BY `d` unsorted → drains
  the child, unaffected — asserted, not assumed).

`streaming-aggregate-filter-shadow.spec.ts` (plan-shape):
- Asserts the primary query plans to STREAMAGGREGATE with a standalone FILTER
  **directly below it** (via `isDescendantOf`), with **no SORT** and **no
  HASHAGGREGATE** — i.e. the exact interleaving hazard.
- Asserts the range variant keeps the same shape.
- Asserts StreamAggregate+Filter results are correct.
- Asserts the HashAggregate control query actually picks HASHAGGREGATE and is correct.

## Things for the reviewer to probe (honest gaps)

- **Only memory-module suite was run** (`yarn test`), not `yarn test:store`. The fix
  is purely in the runtime emit layer (`aggregate.ts`) and is storage-agnostic, so
  store mode should be unaffected — but I did not run it (it is the slower path).
  Worth a spot-check if the reviewer wants belt-and-suspenders.
- **Double-delete of `scanRowDescriptor`.** When a group boundary fires, the deferred
  cleanup deletes `scanRowDescriptor` (the rep-row descriptor) and then the loop's
  `finally` deletes it again for the same iteration. This is harmless —
  `RowContextMap.delete` is idempotent and rebuilds `attributeIndex` from the
  remaining (child) entries — but it is worth a glance to confirm it is not masking
  an intended invariant. The full suite passing (incl. correlated-subquery and
  HAVING tests) is the evidence it is fine.
- **Generality.** The fix addresses StreamAggregate specifically. Whether any OTHER
  streaming emitter (window, merge-join, etc.) defers output-context teardown across
  a child pull is **out of scope here** and tracked in
  backlog `streaming-emitter-deferred-context-audit`. HashAggregate is known-safe
  (it drains the child before yielding; its yield uses `try/finally`).
- **`context-helpers.ts` not edited.** Its docstrings already document the
  `attributeIndex` last-set-wins semantics and the `reactivate()` hazard that this
  bug is an instance of; the implement ticket listed it as reference-only and I
  agreed — no behavioral change there. Confirm you concur the prose is adequate.

## Related / downstream

- **`2-relax-mv-rollup-residual-filter`** (in `implement/`, `prereq:` on this slug)
  removes an MV query-rewrite forgo that existed purely to dodge this bug. It depends
  on this fix landing.
- **`streaming-emitter-deferred-context-audit`** (in `backlog/`) — the broader sweep.
