description: |
  Streaming-aggregate stale-group-context bug — FIXED and reviewed. A grouped
  StreamAggregate was leaving the just-yielded group's representative-row context
  live in the shared runtime context while it pulled the next input row from its
  child, shadowing a directly-below Filter's own row slot (same source attribute
  IDs) so the WHERE predicate was evaluated against stale values and effectively
  dropped. The fix moves the deferred context teardown to run immediately after
  the mid-stream `yield` resumes, before the next child pull. Regression coverage
  added (one sqllogic file + one plan-shape spec). Reviewed: fix mechanism
  verified against the context-map semantics, reproduction proof re-run, full
  suite + lint + typecheck green, extra adversarial probes (LIMIT early-exit,
  correlated subquery, HAVING) all correct.
files:
  - packages/quereus/src/runtime/emit/aggregate.ts                        # THE FIX — emitStreamAggregate GROUP BY branch (~lines 330, 427-438, post-loop)
  - packages/quereus/test/logic/07.4-group-by-filter-composite-pk.sqllogic # regression: result-level coverage
  - packages/quereus/test/plan/streaming-aggregate-filter-shadow.spec.ts   # regression: locks the bug-prone plan shape + correctness + HashAggregate control
  - packages/quereus/src/runtime/context-helpers.ts                        # reference — RowContextMap set/delete + attributeIndex last-set-wins; reactivate() hazard docstrings (unchanged)

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

Three edits:
- Removed the top-of-loop `cleanupPreviousGroupContext()` invocation.
- Moved the teardown to run **immediately after `yield aggregateRow;` resumes**
  (with an explanatory comment), before the loop falls through to the next pull.
- Deleted the now-dead post-loop invocation.

The final-group yield after the loop keeps its own `try/finally` teardown and is
unchanged. Consumer semantics are preserved: the representative-row context stays
live for the entire `yield` suspension (HAVING / correlated subqueries / the
projection read it there) and is torn down only once the consumer resumes the
generator — at which point it is done with the previous row.

## Review findings

### Scope of the review
Read the implement diff (`64687fdc`) with fresh eyes before the handoff prose,
then traced the fix against the context-map machinery it depends on.

### What was checked

- **Fix mechanism — verified against `context-helpers.ts`.** `RowContextMap.set`
  overwrites `attributeIndex[attrId]`; `delete` removes the entry and **rebuilds**
  the affected attr-IDs from the remaining map contexts (insertion-order forward,
  newest-wins). Confirmed `scanRowDescriptor` (built at emit time via
  `buildRowDescriptor(sourceAttributes)`, `aggregate.ts:83`) is a **distinct object**
  from the child Filter's own slot descriptor that shares the same attr IDs — so the
  aggregate's `delete(scanRowDescriptor)` removes only the aggregate's entry and the
  rebuild correctly re-points the index back at the child's slot. This is exactly the
  property the fix relies on. ✔
- **Reproduction proof — re-run independently.** Reverted `aggregate.ts` to
  `64687fdc~1`; **both** new tests fail (`07.4` → `d=2,s=10` expected `7`; plan-shape
  result assertion → `d=2→10, d=3→100`). Restored; both pass. The plan-shape *shape*
  assertions correctly stay green on unfixed code (runtime-only bug, identical plan) —
  which is the documented reason that spec exists. ✔
- **Build/lint/typecheck/tests.** `typecheck` clean, `lint` clean, full memory logic
  suite **4926 passing / 9 pending / 0 failing** (matches the handoff's claimed count).
  Targeted runs of both new specs pass. ✔
- **Adversarial probes beyond the committed tests** (correct on the fixed code):
  - **LIMIT 1 and LIMIT 2** over the hazard shape — early generator termination
    mid-stream — return correct filtered rollups.
  - **Correlated subquery in the projection** (`(select count(*) ... where b2.d = bt.d)`)
    reading across group boundaries — correct (`cnt=2` per group while the filtered
    sums stay correct, e.g. `d=2→7` not `10`).
  - **HAVING** over the filtered rollup — correct.
- **Test helpers** (`isDescendantOf`, `planRows`, `planOps`, `allRows`) exist and are
  correct (`test/plan/_helpers.ts`). ✔
- **Docs.** No doc references this internal emit behavior; the `context-helpers.ts`
  docstrings already document the `attributeIndex` last-set-wins + `reactivate()`
  hazard this bug is an instance of. Docs reflect reality — no update needed. ✔
- **Downstream chain intact.** `2-relax-mv-rollup-residual-filter` (implement/) and
  `streaming-emitter-deferred-context-audit` (backlog/) both present. ✔

### Findings — disposition

**Correctness bugs: none found.** The fix is minimal, targeted, and correct; the
only behavioral change is that the previous group's context is torn down one step
earlier (after the consumer resumes, before the next child pull).

**Minor — analyzed, no action taken:**
- *Early-termination context residue (pre-existing, non-observable).* If the consumer
  abandons the generator (`LIMIT`/`.return()`/`.throw()`) while suspended at the
  group-boundary `yield`, the moved cleanup and `cleanupPreviousGroupContext` are both
  skipped on unwind; only the `for await` body's `finally` deletes `scanRowDescriptor`,
  so `combinedRowDescriptor` + `groupSourceRowDescriptor` are left in `ctx.context`.
  This is **pre-existing** (the old top-of-loop cleanup was equally skipped on early
  return) and **non-observable**: `RuntimeContext` is per-execution and discarded once
  the generator is abandoned, and nothing else runs in that execution after early
  termination. Empirically confirmed `LIMIT 1`/`LIMIT 2` return correct results. Not
  introduced or worsened here; the broader teardown-on-unwind hardening, if wanted, is
  appropriately scoped to the backlog audit ticket below, not this fix.
- *Double-delete of `scanRowDescriptor` on a boundary iteration* (deferred cleanup
  deletes it, then the loop `finally` deletes it again). Confirmed harmless: `delete`
  is idempotent and rebuilds `attributeIndex` from the remaining (child) entries each
  time. The `finally` delete cannot be removed — it is the only teardown on the
  non-boundary path. Cost is a redundant index rebuild per boundary; negligible.

**Deferred (documented, consistent with project guidance):**
- *Store mode (`test:store`) not run.* The fix is purely in the runtime emit layer and
  is storage-agnostic — the store only changes the data source feeding the aggregate,
  not how StreamAggregate manages context. AGENTS.md scopes `test:store` to
  store-specific diagnosis / release prep, so skipping it here is the documented norm.

**Filed as separate work (already in flight, not raised by this review):**
- `streaming-emitter-deferred-context-audit` (backlog/) — sweep for any OTHER streaming
  emitter (window, merge-join, etc.) that defers output-context teardown across a child
  pull. HashAggregate is known-safe (drains child before yielding; `try/finally` yield).

No finding rose to the level of a new fix/plan ticket.

## Test coverage map

`07.4-group-by-filter-composite-pk.sqllogic` over `bt(d,r,total)` PK `(d,r)`:
primary bug (equality filter on non-leading composite-PK col absent from GROUP BY),
range filter, `count(*)+count(col)`, DISTINCT aggregate, HAVING, dropped-first-row-of-
a-later-group (`where r=20`, incl. sum-over-all-NULL), ORDER BY desc, empty result;
controls: scalar aggregate, plain projection, single-column-PK seek (no standalone
Filter), and a HashAggregate path. `streaming-aggregate-filter-shadow.spec.ts`
(plan-shape): asserts STREAMAGGREGATE + standalone FILTER directly below, no SORT, no
HASHAGGREGATE; range variant same shape; result correctness; HashAggregate control
picks HASHAGGREGATE and is correct.

## How to re-validate

- `yarn workspace @quereus/quereus test` → 4926 passing / 9 pending / 0 failing.
- `yarn workspace @quereus/quereus run typecheck` / `run lint` → clean.
- Reproduction: `git checkout 64687fdc~1 -- packages/quereus/src/runtime/emit/aggregate.ts`,
  re-run the two specs (both FAIL), `git checkout HEAD -- ...` to restore.

## Related / downstream

- `2-relax-mv-rollup-residual-filter` (implement/, `prereq:` on this slug) — removes an
  MV query-rewrite forgo that existed purely to dodge this bug; depends on this fix.
- `streaming-emitter-deferred-context-audit` (backlog/) — the broader sweep.

## End
