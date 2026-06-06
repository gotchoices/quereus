description: |
  Correctness fix: a grouped StreamAggregate leaves its just-yielded group's
  representative-row context live in the shared runtime context map while it pulls
  the next input row from its child. That context is built from the SOURCE's
  attribute IDs, so it shadows a streaming child's own row slot (which uses the
  same attr IDs). A Filter sitting directly below the aggregate then resolves its
  predicate column references through the aggregate's STALE representative row
  instead of the child's current row — so the WHERE predicate is evaluated against
  the wrong values and effectively dropped. Move the deferred context teardown to
  run immediately after the mid-stream `yield` resumes (before the next child
  pull). Root cause fully diagnosed and the one-file fix verified against the full
  suite (4921 passing, 0 regressions); this ticket lands that fix plus regression
  coverage.
files:
  - packages/quereus/src/runtime/emit/aggregate.ts              # THE FIX — emitStreamAggregate, GROUP BY branch
  - packages/quereus/src/runtime/emit/filter.ts                 # the shadowed child (reference only; do not change)
  - packages/quereus/src/runtime/context-helpers.ts             # RowContextMap.attributeIndex semantics + reactivate() docstring (explains the shadowing)
  - packages/quereus/test/logic/07.3-group-by-extras.sqllogic   # sibling spec / format reference
  - packages/quereus/test/logic/                                # add new regression .sqllogic here

# Streaming aggregate leaks group-representative context across the next child pull

## Root cause (verified)

`emitStreamAggregate` (GROUP BY branch, `aggregate.ts`) processes its input with a
single async generator that is interleaved, pull-by-pull, with its child. When it
crosses a group boundary it:

1. builds the just-finished group's output row,
2. installs the PREVIOUS group's representative source row into the runtime context
   under three descriptors — `scanRowDescriptor`, `combinedRowDescriptor`, and
   `groupSourceRowDescriptor` (+ `groupSourceRelationRowDescriptor`) — so the
   consumer (HAVING / correlated subqueries / output projection) can read it while
   the generator is suspended at `yield`,
3. `yield`s the row, and
4. **defers** the teardown of those descriptors into a `cleanupPreviousGroupContext`
   closure that was being invoked at the **top of the next loop iteration**.

The defect is purely the *timing* of step 4. `for await (const row of sourceRows)`
pulls the next row from the child **before** the loop body runs, so the order on
resume was:

```
yield → (resume) → finally deletes scanRowDescriptor
      → for-await pulls next child row  ← child predicate evaluates HERE
      → loop body runs cleanupPreviousGroupContext()   ← too late
```

`combinedRowDescriptor` and `groupSourceRowDescriptor` are built from the source's
attribute IDs (e.g. `{26:.., 27:.., 28:..}` for `bt(d,r,total)`), the SAME IDs the
child Filter's `createRowSlot` publishes. `RowContextMap.attributeIndex` is a flat
`attrId → {rowGetter,columnIndex}` array where the **last `set` wins**
(`context-helpers.ts`). Because the aggregate's representative-row descriptors were
the most recent `set` and were still live, the child Filter's `column(r)` resolved
attr 27 through the aggregate's stale representative row, not through the child's
current row. (The child's `sourceSlot.set()` only mutates a boxed ref; it does
**not** re-`set` the map, so it cannot reclaim the index — this is exactly the
hazard `RowSlot.reactivate()` documents.)

Observed at runtime for `select d, sum(total) from bt where r=10 group by d` over
`bt(d,r,total)` PK `(d,r)` with rows `(1,10,150),(1,20,null),(2,10,7),(2,20,3)`:
the Filter correctly rejected `(1,20,null)` but, right after the `d=1` group was
yielded, evaluated `r=10` as **true** for `(2,20,3)` (r=20) because `column(r)`
returned the stale `10` from the `d=1` representative row → result `[2,10]` instead
of `[2,7]`.

### Why this exact shape triggers it
- **StreamAggregate (not Hash).** A composite PK provides ordering on `(d,r)`, so
  the IndexScan output is already sorted for `GROUP BY d`; the physical-selection
  rule (`rule-aggregate-streaming.ts`) picks StreamAggregate with **no interposed
  Sort**. A Sort (or HashAggregate) would fully drain the child before yielding, so
  no interleaving and no shadow.
- **Filter directly below the aggregate.** With a composite PK and the filter on a
  non-leading PK column absent from the GROUP BY (`r`), the index cannot seek `r`
  (`matchedClauses:0`, full scan) and the predicate stays as a standalone Filter
  node right under the StreamAggregate.
- The bug is independent of the constant-binding / `attributeDefaults` surface on
  the Filter (those are insert-default provenance — confirmed red herrings). A
  **range** predicate (`r>9 and r<11`, no constant binding) drops identically.

## The fix (verified — full suite green)

Move `cleanupPreviousGroupContext()` so it runs **immediately after the mid-stream
`yield` resumes**, before the loop falls through to the next child pull. Remove the
top-of-loop invocation and the now-dead post-loop invocation. Exact diff that was
verified (apply this):

```diff
@@ emitStreamAggregate GROUP BY branch
 			// Process all rows
 			for await (const row of sourceRows) {
-				if (cleanupPreviousGroupContext) {
-					cleanupPreviousGroupContext();
-					cleanupPreviousGroupContext = null;
-				}
-
 				// Set the current row in the runtime context for Filter and GROUP BY evaluation
 				ctx.context.set(scanRowDescriptor, () => row);
@@ after `yield aggregateRow;` in the group-change block
 						yield aggregateRow;
 
+						// Tear down the just-yielded group's representative-row context
+						// BEFORE pulling the next source row. These descriptors are built
+						// from the source's attribute IDs, so leaving them live would shadow
+						// a streaming child's own row slot (same attr IDs) when the child
+						// evaluates the next row — e.g. a Filter directly below would read
+						// the stale representative row instead of its current row.
+						if (cleanupPreviousGroupContext) {
+							cleanupPreviousGroupContext();
+							cleanupPreviousGroupContext = null;
+						}
+
 						// Reset for new group
@@ after the `for await` loop (delete the now-dead block)
-			if (cleanupPreviousGroupContext) {
-				cleanupPreviousGroupContext();
-				cleanupPreviousGroupContext = null;
-			}
-
 			// Yield the final group if any rows were processed
```

Semantics are unchanged for consumers: the representative-row context stays live for
the entire `yield` suspension (when HAVING / correlated subqueries / the projection
read it) and is only torn down once the consumer resumes the generator — at which
point it is done with the previous row. The final-group yield (after the loop) keeps
its own `try/finally` teardown and is unaffected. After this change the variable is
assigned-then-cleared entirely within the group-change block; TypeScript flags the
old post-loop block as dead (`Type 'never' has no call signatures`) — that block is
deleted above. `cleanupPreviousGroupContext` remains a `let` declared before the
loop (captured by the closure); leave the declaration in place.

### Alternatives considered (rejected — documented so the reviewer needn't re-litigate)
- **Make the child Filter call `sourceSlot.reactivate()` after each `set()`.** Treats
  the symptom, not the cause; would have to be applied to every streaming node class
  that can sit under an aggregate; and re-`set`s the map every row, defeating
  `createRowSlot`'s set-once optimization.
- **Give the representative context distinct attribute IDs.** Impossible —
  HAVING / correlated / output consumers resolve source columns by their real attr
  IDs, so the representative context must reuse them.

## Edge cases & interactions (write these as tests; the reviewer will check them)

Add a new sqllogic regression file under `packages/quereus/test/logic/` (e.g.
`07.4-group-by-filter-composite-pk.sqllogic`; same `sql` then `→ [json]` format as
`07.3-group-by-extras.sqllogic`). Cover:

- **Primary bug — equality filter on a non-leading composite-PK col absent from
  GROUP BY.** `bt(d,r,total)` PK `(d,r)`, rows `(1,10,150),(1,20,null),(2,10,7),(2,20,3)`:
  `select d, sum(total) from bt where r=10 group by d` → `[{d:1,...:150},{d:2,...:7}]`
  (NOT `[2,10]`). `d=2` is the tell; `d=1` reads 150 either way because the dropped
  row contributes `null` to `sum`.
- **Range filter** (no constant binding): `... where r>9 and r<11 group by d` → same
  expected rows. Proves the fix is not specific to the `r=const` pin.
- **More than two groups, groups of size 1**, so the group-change teardown fires
  repeatedly and each group's first post-yield child row is the stress point. E.g.
  add `(3,10,1),(3,20,99)` and assert `d=3 → 1`.
- **A group whose first row is filtered out** (the previous-group rep row's filtered
  column value differs from the boundary) — ensures the stale read can't accidentally
  pass. Construct rows so the dropped row would be wrongly kept if the bug regressed.
- **HAVING over the filtered rollup** — confirms the representative-row context is
  still readable during the yield: `... where r=10 group by d having sum(total) > 100`
  → only `d=1`.
- **count(\*) and count(col)** (no-arg / nullable-arg aggregates) under the same
  filter shape.
- **DISTINCT aggregate** under the same shape (`sum(distinct total)`), to exercise the
  per-group distinct-tree reset path adjacent to the edited code.
- **ORDER BY downstream** of the aggregate (`... group by d order by d desc`) —
  consumer reads aggregate output after resume; must stay correct & ordered.
- **Controls that must remain correct (lock the boundary):**
  - same query with **no GROUP BY** (`select d,r,total from bt where r=10`) — scalar
    branch, never affected;
  - **single-column-PK** analogue — filter is pushed into the seek / no standalone
    Filter under the aggregate;
  - empty result / zero matching rows.
- **HashAggregate path** (`92-hash-aggregate-edge-cases.sqllogic` neighbourhood): add
  a control asserting the same logical query is correct when the planner picks
  HashAggregate (it drains the child before yielding, so it is expected to be
  unaffected — but assert it, don't assume).

## TODO

- [ ] Apply the `aggregate.ts` diff above (move teardown after the mid-stream
      `yield`; delete the top-of-loop and post-loop invocations).
- [ ] Add the new `packages/quereus/test/logic/*.sqllogic` regression file covering
      the cases above (equality + range + multi-group + size-1 groups + dropped-first-row
      + HAVING + count + distinct + ORDER BY + controls).
- [ ] `yarn workspace @quereus/quereus test` — full logic suite green (baseline before
      fix: 4921 passing / 9 pending; the new specs add to passing).
- [ ] `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows).
- [ ] Hand off to review noting that the broader "does any other streaming emitter
      leave output context live across a child pull?" audit is tracked separately in
      backlog (`streaming-emitter-deferred-context-audit`) and the MV rollup-residual
      relaxation that depends on this fix is `2-relax-mv-rollup-residual-filter`.
