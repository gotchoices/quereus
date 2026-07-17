description: A recursive WITH-clause query used twice (e.g. self-joined) hung and errored with an iteration-limit message; it now computes the recursion once, reuses it at every reference, and returns its rows.
files: packages/quereus/src/runtime/emit/recursive-cte.ts, packages/quereus/src/planner/nodes/recursive-cte-node.ts, packages/quereus/src/planner/cache/materialization-advisory.ts, packages/quereus/src/runtime/types.ts, packages/quereus/test/plan/cte-materialization.spec.ts, docs/runtime.md, docs/optimizer.md
difficulty: medium
----

# Review: recursive CTE referenced twice — buffer once, replay per reference

## What the bug was

```sql
WITH RECURSIVE cnt(x) AS (
	SELECT 1 UNION ALL SELECT x + 1 FROM cnt WHERE x < 3
)
SELECT a.x AS ax, b.x AS bx FROM cnt a JOIN cnt b ON a.x = b.x ORDER BY a.x;
```

Expected `(1,1)(2,2)(3,3)`; actual `QuereusError: Recursive CTE 'cnt' exceeded
maximum iteration limit (10000)`. Fixed — returns the expected rows.

## IMPORTANT: the real root cause diverged from the original ticket

The implement ticket assumed **both references share one `RecursiveCTENode`
instance** (same `plan.id`) and the only bug was emission not being memoized.
**That assumption is false.** I dumped the plans to confirm:

- **Built (pre-optimize):** ONE shared `RecursiveCTENode` (one `tableDescriptor`),
  referenced by two `CTEReferenceNode`s. (Matches the ticket.)
- **Optimized:** an **earlier optimizer pass duplicates** it into **two distinct
  `RecursiveCTENode` instances** with **distinct plan ids** but the **same
  `tableDescriptor`**, and they **share their recursive-case subtree**. (The
  non-recursive CTE path stays shared because its subtree isn't rewritten; the
  recursive path gets duplicated.)

So there were actually **two** defects stacked:

1. **Two independent recursive drives** (one per reference) racing on the shared
   `tableDescriptor` working table — each clobbers the other's semi-naïve delta,
   so neither terminates → iteration guard trips. (This is what the ticket
   described.)
2. **The shared recursive-case subtree has parentCount ≥ 2, so the
   materialization advisory wrapped it in a `CacheNode`** — which *freezes* the
   semi-naïve delta to the first iteration's rows. Even with defect (1) fixed
   (single drive), this alone breaks it: UNION DISTINCT terminated early with
   `[1,2]`, UNION ALL still ran away. This was **not** in the ticket.

Because the two references land on **distinct** node instances with the **same
descriptor**, the ticket's `plan.id`-keyed buffer and `parentCount>=2`-per-node
mark **could not work as written**. I keyed on the `tableDescriptor` instead.

## What I changed

**Runtime — `runtime/emit/recursive-cte.ts`**
- Extracted the recursion body into a helper async generator `driveRecursion`.
- `run`: if `!plan.materialize` → `yield* driveRecursion(...)` (unchanged
  single-reference streaming path). Else → buffer once per execution and replay,
  mirroring `emitCTE`'s idiom: first reference stores the buffer promise
  synchronously (before any await), drives `driveRecursion` fully inside a
  **detached async IIFE** into a `Row[]`, every reference awaits and yields
  per-consumer `[...row]` copies. **Keyed by `plan.tableDescriptor`** (the shared
  identity across the duplicated instances), NOT `plan.id`.

**Plan node — `planner/nodes/recursive-cte-node.ts`**
- Added `materialize: boolean = false`, threaded through the constructor and
  `withChildren` (preserved alongside `tableDescriptor`), surfaced in
  `toString` (`[buffered]`) and `getLogicalAttributes`.

**Optimizer — `planner/cache/materialization-advisory.ts`**
- New `recursiveRefsByDescriptor` map: **sums parent counts per
  `tableDescriptor`** so the true reference count is recovered even after the
  node is duplicated (each copy has parentCount 1).
- `markCTEMaterialization`: new branch marks every `RecursiveCTENode` whose
  descriptor is referenced ≥ 2 times. Gate is **descriptor-count only** — the
  `MATERIALIZED`/`NOT MATERIALIZED` hint is deliberately ignored (honoring
  `NOT MATERIALIZED` would re-open the runaway).
- **`noCacheNodes`**: collects every node inside each `RecursiveCTENode`'s
  `recursiveCaseQuery` subtree and skips cache recommendations for them — fixes
  defect (2). Helper `collectSubtree`.
- Rule 5a now excludes `RecursiveCTE` nodeType from `CacheNode` wraps too.

**Types — `runtime/types.ts`**
- Widened `cteMaterializations` key type to `Map<string | TableDescriptor, …>`
  (string keys = `emitCTE` plan ids; object keys = `emitRecursiveCTE`
  descriptors; the two key spaces never collide). Reuses the existing field, so
  the fork contract (`parallel-driver.ts`, `fork-contract.spec.ts`) is unchanged.

**Docs** — `docs/runtime.md` (§ Shared CTE materialization) and `docs/optimizer.md`
(§ Materialization Advisory) updated for the recursive path.

## How to validate / exercise

- **Use-case queries** (all should return the natural sequence):
  - self-join `cnt a JOIN cnt b` (UNION ALL and UNION DISTINCT),
  - triple self-join `a JOIN b JOIN c` (buffer replay beyond two consumers),
  - single-reference `nums … LIMIT 5` on an **unbounded** recursion — must stay
    streaming (`materialize === false`) and terminate at 5 (regression guard for
    the streaming path; if buffering leaked to single-reference this would hit
    the 10 000 guard).
- **Plan-shape assertion**: both `CTEReferenceNode.source` are `RecursiveCTENode`
  (not `CTENode`), both `.materialize === true`, and they **share one
  `tableDescriptor`**. (The test deliberately does NOT assert instance equality —
  the optimizer duplicates them; asserting `===` would be wrong.)

Commands run (all green):
- `packages/quereus/test/plan/cte-materialization.spec.ts` — 15 passing.
- `test/vtab/**/cte-multi-reference-scan-count.spec.ts` — 5 passing.
- Full `node test-runner.mjs` — **7043 passing, 13 pending, 0 failing**.
- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc -p tsconfig.test.json`).

## Known gaps / where to push (reviewer: treat tests as a floor)

- **`test:store` not run** (memory vtab only). Change is planner/runtime, not
  store-specific, so low risk — but not verified against the LevelDB store path.
- **Untested shapes**: nested recursive CTEs, a recursive CTE that references
  *another* recursive CTE, recursive-CTE double-reference in non-join contexts
  (correlated subquery, `UNION` of two SELECTs each referencing it), and >3
  references. The buffer is keyed per descriptor and first-drive-wins so these
  *should* work, but interleaving patterns differ from the self-join I tested.
- **`noCacheNodes` is conservative** (tripwire): it forbids caching *every* node
  inside a recursive-case subtree, including a subquery that does **not** touch
  the working table and could legitimately be cached. This trades a possible
  missed cache for guaranteed correctness. Parked as a NOTE at the collection
  site in `materialization-advisory.ts` (search `NOTE:` there). If a recursive
  case ever contains an expensive working-table-independent subquery that shows
  up as slow, narrow the exclusion to only working-table-dependent nodes.
- **Buffered recursion ignores an outer `LIMIT`** for the *multi-reference* case:
  a buffered drive runs to completion (bounded by `maxRecursion`) before the
  outer LIMIT can cut it. This matches `emitCTE`'s materialized semantics and is
  correct for a self-join (you can't LIMIT-cut a join input mid-stream), but a
  multi-referenced *unbounded* recursion under an outer LIMIT would now hit the
  iteration guard where... it also did before (it errored). No regression, but
  worth a reviewer's eye on whether that shape deserves a clearer error.

## Review findings

- **Root-cause divergence** (above): the fix does NOT match the original
  ticket's mechanism — buffer keyed on `tableDescriptor` not `plan.id`, mark
  gated on descriptor-summed ref-count not per-node `parentCount`, plus a second
  defect (recursive-case `CacheNode` freezing the delta) the ticket never
  mentioned. Verify the reasoning holds.
- **Tripwire — `noCacheNodes` over-broad**: recorded as a `NOTE:` in
  `materialization-advisory.ts` at the `noCacheNodes` collection loop; conditional
  perf concern only, not a queued task.
