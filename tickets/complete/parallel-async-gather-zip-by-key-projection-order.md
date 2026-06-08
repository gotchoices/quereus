description: Generalized `rule-async-gather-zip-by-key` to recognize full-outer-on-shared-key queries with arbitrary SELECT ordering / derived scalars over the merged key, folding them to `AsyncGatherNode(zipByKey)` under a thin reordering `Project` (canonical layout keeps the no-wrapper fast path). Reviewed and completed.
files: packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/test/optimizer/parallel-async-gather-zip-by-key.spec.ts, docs/optimizer.md, docs/architecture.md, packages/quereus/src/planner/nodes/async-gather-node.ts
----

## What shipped

`ruleAsyncGatherZipByKey` now folds full-outer-on-shared-key chains under **any**
projection ordering, not just the exact canonical layout:

- **Layout-independent gates** (chain flatten, equi-only ON, shared-key groups,
  concurrency-safe, uncorrelated, latency, collation-agreement, key-uniqueness)
  run once up front.
- **Fast path:** an exactly-canonical projection (`matchCanonicalProjections`)
  replaces the `Project` outright — no wrapper, `countOp(PROJECT)==0` preserved.
- **General path:** `buildReorderingGather` builds the gather in its natural
  `[merged keys][branch non-key]` layout (minting its own `outputKeyAttrs`) and
  wraps it in a `ProjectNode` reproducing the user's list. `rewriteMergedKeyRefs`
  rewrites each full-group `coalesce(...)` to a bare merged-key `ColumnReferenceNode`,
  forwards non-key refs unchanged (runtime resolves by `attributeId`), rebuilds
  surrounding pure scalar structure, and **declines** (returns null → no fold) on
  any branch-*key* reference outside a recognizing full-group coalesce — including
  inside a relational child (scalar subquery) via `subtreeReferencesKey`.
- `USING`/`NATURAL` full joins remain out of scope (no synthesized `ON`, so the
  chain walk declines them).

## Review findings

### Scope of review
Read the full implement-stage diff (583b3977) before the handoff: the rule, the
spec, `docs/optimizer.md`, and `AsyncGatherNode` (constructor, `validateZipByKey`,
`buildZipByKeyAttributes`, type/physical inference). Cross-checked
`ColumnReferenceNode` / `ProjectNode` constructors, and how the optimizer invokes
rules (both `registry.ts` — try/catch'd — and `pass.ts` — propagating).

### Checked — found sound
- **Correctness of the reorder path.** Group-order is internally self-consistent
  across `branchKeyAttrs`, `outputKeyAttrs`, and the rewrite's group lookup
  (`matchFullGroupCoalesce` returns the `groups`-array index `gi`; gather output
  position `gi` carries `outputKeyAttrs[gi]`). The merged-key `ColumnReferenceNode`
  is built with the right constructor arg order. Non-key forwarding by
  `attributeId` is confirmed correct empirically (reordered/subset/derived tests
  return exact expected rows; runtime resolves columns by id, not the stale
  `columnIndex` hint).
- **Idempotence / termination.** The wrapper's source is an `AsyncGatherNode`, not
  a `JoinNode`, so the matcher declines on re-fire in both rule frameworks; no
  infinite loop.
- **Gates hoisted ahead of projection matching** — correct, they are
  layout-independent.
- **`USING`/`NATURAL` decline** — verified via plan inspection (stays `JOIN`) and
  throws-at-emit.
- **Build** clean; **full suite** 3583 passing / 9 pending (was 3581 — +2 new
  tests, no regressions); **eslint** clean on both changed source/spec files.

### Found and fixed (minor, in this pass)
- **Untested `subtreeReferencesKey` / scalar-subquery path** (explicitly flagged
  in the handoff). Probed both directions and added two regression tests:
  - an **uncorrelated** subquery in the SELECT list (`(select count(*) from c)`)
    is carried through unchanged and the query **folds** (correct `cc=2`);
  - a subquery **correlated to a consumed branch key** (`… where c.k = a.k`)
    **declines** the fold, leaving an unsupported binary FULL JOIN that throws at
    emit.
- **Stale doc.** `docs/architecture.md` still described the `zipByKey` recognition
  rule as "parked in backlog (`parallel-async-gather-zip-by-key-rule`)" — corrected
  to point at the landed `rule-async-gather-zip-by-key.ts` and the reordering-Project
  generalization. `docs/optimizer.md` was already accurate (verified line by line).

### Flagged — pre-existing, no action (not introduced by this diff)
- **Affinity-mismatch on key positions is not pre-gated.** Only collation is
  gated in the rule; an affinity disagreement reaches `AsyncGatherNode.validateZipByKey`
  which **throws** (vs. declining gracefully like the collation gate does). This is
  identical for the canonical path, which also constructs the node — pre-existing,
  not introduced here. The reorder path widens the *projection shapes* that reach
  construction but not the affinity behavior for a given set of branches, and the
  query errors either way (mismatched-affinity shared key is degenerate). Low
  severity; a mirror-of-collation affinity gate would be a clean future polish but
  is out of this ticket's scope. **Not filed** (pre-existing, low severity, the
  query fails regardless).
- **`coalesce(a.k, b.k, 0)` (extra args over the key)** is intentionally not
  recognized as a merged key — it falls through to generic recursion, hits the
  bare branch-key refs, and blocks (hard emit error rather than fold). Deliberate
  non-goal, documented; the rewriter cannot know such an expression decomposes
  into "merged key, then literal".
- **Reversed coalesce arg order with collation-equal-but-byte-distinct keys.**
  `matchFullGroupCoalesce` matches a group by argument **set** (order-independent),
  so `coalesce(b.k, a.k)` folds to the merged key, which the emitter composes from
  the lowest-indexed *present branch* (branch 0 = `a`), not `b`-first. Diverges from
  `coalesce`'s left-to-right pick only for non-binary collations where keys are
  collation-equal but byte-distinct (e.g. NOCASE `'A'`/`'a'`). Pre-existing — the
  canonical matcher is equally set-based. Edge case, low severity.
- **Wrapper Project physical properties** (FD/key/ordering through the reordering
  Project) are exercised indirectly (results + node presence), not via a
  `query_plan` physical assertion. The propagation is standard shared `ProjectNode`
  code, not new logic; no downstream rule in the current tree depends on keys
  surviving this specific wrapper. Acceptable.

### Categories with nothing to report
- **Resource cleanup / error handling:** the rule is a pure plan transform (no I/O,
  no handles); declines return null cleanly. Nothing to clean up.
- **Type safety:** no `any`; `ScalarPlanNode` / `RelationalPlanNode` casts are
  guarded by `instanceof` / `isRelationalNode` checks. Clean.
- **New major issues warranting a fix/plan ticket:** none.

## Out of scope (unchanged)
`LEFT`/`RIGHT` outer chains (`zipByKey` is symmetric full-outer only).
