description: A recursive WITH-clause query used twice in the same statement (for example joined to itself) never finishes and errors with an iteration-limit message; make it compute the recursion once and reuse the result at every reference so the query returns its rows.
files: packages/quereus/src/runtime/emit/recursive-cte.ts, packages/quereus/src/planner/nodes/recursive-cte-node.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/runtime/emit/cte.ts, packages/quereus/test/plan/cte-materialization.spec.ts
difficulty: medium
----

# Recursive CTE referenced twice: buffer once per execution, replay per reference

## The bug (confirmed)

```sql
WITH RECURSIVE cnt(x) AS (
	SELECT 1
	UNION ALL
	SELECT x + 1 FROM cnt WHERE x < 3
)
SELECT a.x AS ax, b.x AS bx
FROM cnt a JOIN cnt b ON a.x = b.x
ORDER BY a.x;
```

Expected: `(1,1) (2,2) (3,3)`.
Actual: `QuereusError: Recursive CTE 'cnt' exceeded maximum iteration limit (10000)`.

## Root cause (verified against the code)

- A recursive CTE builds **one** `RecursiveCTENode` (in `buildWithClause` →
  `buildRecursiveCTE`, stored in the CTE-name map). Each FROM-clause use makes a
  distinct `CTEReferenceNode` (cached by name+alias, so `cnt a` and `cnt b` are
  two nodes), but every reference's `.source` is that **same**
  `RecursiveCTENode` instance — same `plan.id`.
  (`src/planner/building/select.ts` ~line 353; `src/planner/building/with.ts`.)
- Emission is **not** memoized per node, so each `CTEReferenceNode` emits its own
  drive of the recursion via `emitPlanNode(plan.source)` → `emitRecursiveCTE`.
  Two references ⇒ two independent recursive drives.
- Each drive stores its semi-naïve working table in
  `RuntimeContext.tableContexts`, keyed by the CTE's `tableDescriptor`. Both
  drives share one descriptor (same node instance). Under a nested-loop join the
  two drives interleave (one per side); the second drive's
  `tableContexts.set/delete` on the shared descriptor clobbers the first drive's
  delta iterable, so the first drive never observes an empty delta, never
  terminates, and trips the 10000-iteration guard in
  `runtime/emit/recursive-cte.ts`.

## Fix: mirror the non-recursive shared-materialization path

Non-recursive multi-referenced CTEs already solved the "one source, many
references" problem: `MaterializationAdvisory.markCTEMaterialization` sets
`CTENode.materialize` when a CTE has ≥2 parents, and `emitCTE` drives the source
**once** into a per-execution buffer (`RuntimeContext.cteMaterializations`, keyed
by `plan.id`) that every reference replays. See `src/runtime/emit/cte.ts` and
`src/planner/cache/materialization-advisory.ts`. Do the same for recursive CTEs.

The recursion is buffered eagerly in a **detached async IIFE** (as `emitCTE`
does) so it drains independently of how the join pulls — this is what avoids the
nested-loop deadlock (owner reference can't yield row 1 until its drive finishes,
and the drive doesn't depend on downstream pulls).

### Why gated on reference count, not "always"

A single-reference recursive CTE must keep the current **streaming** behavior.
Streaming is what lets an unbounded recursion terminate under an outer LIMIT:

```sql
WITH RECURSIVE nums(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM nums)
SELECT x FROM nums LIMIT 5;   -- returns 1..5 today; must keep working
```

If we always buffered, this would drive the recursion to the 10000-iteration
guard before the outer LIMIT could cut it off. So buffer **only** when the
`RecursiveCTENode` has ≥2 references; single-reference stays on the streaming
path untouched.

### Reference count is already available

`ReferenceGraphBuilder` counts distinct parents. The two `CTEReferenceNode`s are
two distinct parents of the shared `RecursiveCTENode`, so its `parentCount` is 2
for the repro. (The recursive self-reference inside the body is a separate
`InternalRecursiveCTERefNode` keyed by `tableDescriptor`, **not** a
`CTEReferenceNode` pointing at the `RecursiveCTENode`, so it does not inflate the
count.)

### Materialization hint handling

For **recursive** CTEs, gate the mark purely on `parentCount >= 2` and ignore the
`materializationHint`. Reason: honoring `NOT MATERIALIZED` on a multi-referenced
recursive CTE would mean two interleaved streaming drives sharing one
`tableDescriptor` — i.e. re-introduce this exact runaway bug. Correctness wins
over the hint here. Document this in the advisory comment.
(Non-recursive `NOT MATERIALIZED` is unaffected — that path already returns
correct results per reference, just re-executed.)

## TODO

### Plan node — carry the mark
- Add a `materialize: boolean` field to `RecursiveCTENode` (default `false`),
  threaded through the constructor and `withChildren` (preserve it, alongside the
  existing `tableDescriptor` / `recursiveCaseQuery` preservation). Include it in
  `toString` / `getLogicalAttributes` for plan-dump visibility, matching how
  `materializationHint` is surfaced.
- Keep `tableDescriptor` identity stable across the mark rewrite (the internal
  recursive ref resolves the working table by that descriptor).

### Optimizer — set the mark
- In `MaterializationAdvisory.markCTEMaterialization`, add a branch: when
  `node instanceof RecursiveCTENode && !node.materialize && (refGraph.get(node)?.parentCount ?? 0) >= 2`,
  rebuild it with `materialize: true`, preserving every field (name, columns,
  base/recursive case, isUnionAll, materializationHint, maxRecursion,
  tableDescriptor, limit/offset). Reuse the same identity-keyed `memo` so both
  `CTEReferenceNode` parents keep pointing at the **one** rewritten instance —
  the per-execution buffer key (`plan.id`) only matches across references if the
  instance is shared. (This is the same invariant the CTENode comment on
  lines 100–108 already spells out.)
- Update the `shouldMaterializeCTE` doc comment (it currently says recursive CTEs
  are excluded) — recursive CTEs now get marked via the new branch, on a
  ref-count-only rule.

### Runtime — buffer and replay
- In `emitRecursiveCTE`, extract the current recursion body (base case + semi-naïve
  loop + LIMIT/OFFSET gate) into a helper async generator
  `driveRecursion(rctx, baseCaseResult, recursiveCaseCallback, ...rest)`.
- `run`:
  - if `!plan.materialize` → `yield* driveRecursion(...)` (unchanged streaming path).
  - else → reuse the `emitCTE` buffer idiom against
    `rctx.cteMaterializations` (same `Map<string, Promise<Row[]>>`), keyed by
    `plan.id`: synchronously (before any await) get-or-create the buffer promise;
    the first (owner) reference runs `driveRecursion` fully inside a detached
    async IIFE, pushing `[...row]` copies into an array; attach the no-op
    `.catch()` (unhandled-rejection guard); every reference `await`s the promise
    and yields per-consumer `[...row]` copies. Copy semantics must match
    `emitCTE` exactly.
- Note the shared buffer map means recursive and non-recursive materializations
  coexist in `rctx.cteMaterializations` — fine, keys are distinct `plan.id`s.

### Tests — `test/plan/cte-materialization.spec.ts`
- Rework the existing `'never marks a recursive CTE for shared materialization,
  even when referenced twice'` test (it encodes the pre-fix assumption). Replace
  with:
  - both references share **one** `RecursiveCTENode` instance
    (`refs[0].source === refs[1].source`),
  - that instance is a `RecursiveCTENode` (still **not** a `CTENode`),
  - `(refs[0].source as RecursiveCTENode).materialize === true`,
  - the query returns exactly `[{ax:1,bx:1},{ax:2,bx:2},{ax:3,bx:3}]`
    (the NOTE pointing at this ticket goes away).
- Add a **regression guard** for single-reference streaming: an unbounded
  recursive CTE under an outer `LIMIT` returns the limited rows and does **not**
  hit the iteration guard, and its `RecursiveCTENode.materialize` is `false`.
  Use the `nums … LIMIT 5` shape above. (Confirm this passes on `main` first, so
  the guard is meaningful.)
- Consider a UNION DISTINCT double-reference case and a triple-reference case to
  exercise the buffer beyond two consumers.

### Validate
- `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/rcte.log; tail -n 60 /tmp/rcte.log`
  — watch the whole `cte-materialization` suite plus the `vtab/cte-multi-reference-scan-count`
  suite (shares the materialization machinery).
- `yarn lint` (type-checks spec call sites too).
- Update `docs/` if recursive-CTE materialization is described anywhere
  (grep `docs/` for recursive CTE / materialization).
