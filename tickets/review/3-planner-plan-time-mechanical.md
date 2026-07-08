description: Landed the two low-risk speedups from the plan-time performance investigation — swap two hand-rolled attribute-id lookups for an existing cached lookup, and add a regression test proving the optimizer's output didn't change.
files: packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/test/plan/basic/multi-filter-keyed.sql, packages/quereus/test/plan/basic/multi-filter-keyed.plan.json
----

## What changed

Two mechanical swaps from `PlanNode.getAttributeIndex()` (an existing per-instance-cached
`attrId -> index` map, `plan-node.ts:758-768`) replacing hand-rolled equivalents that redid the
same work on every call:

1. `filter.ts:59-70` (`FilterNode.computePhysical`) — was building a fresh `Map<number,number>`
   from `sourceAttrs` on every call; now reuses `this.source.getAttributeIndex()`.
2. `rule-async-gather-zip-by-key.ts:573-590` (`branchesKeyUnique`) — was doing an O(n)
   `attrs.findIndex(a => a.id === id)` scan per key attr per branch; now does an O(1)
   `branches[b].getAttributeIndex().get(id)` lookup.

Neither changes any optimizer decision — both are drop-in replacements for structurally
identical lookups (verified below).

## What did NOT change (and why)

The third TODO item — memoizing `FilterNode`'s `createTableInfoFromNode` + `extractConstraints`
covered-key check (filter.ts, was lines 131-139) across source-only re-mints — was **not**
implemented. Investigating the proposed cache key surfaced a real correctness problem, not just
awkwardness:

- `tableInfo.relationKey` (the key the ticket suggested using) embeds the source node's
  per-instance id (`constraint-extractor.ts:1572`, `` `${relName}#${node.id}` ``). Since a fresh
  source instance gets a fresh id on every re-mint, keying on `relationKey` would never hit
  across the exact re-mint scenario the cache exists for — it degrades to "only hits the same
  object," which the existing per-instance `.physical` cache already provides for free.
- Dropping the instance id and keying on `uniqueKeys` shape alone isn't sound either: the
  covered-key result also depends on `tableInfo.fds`/`equivClasses` (both consumed inside
  `computeCoveredKeysForConstraints`, `constraint-extractor.ts:174-176`), which are
  physical-strategy-dependent — two structurally-identical re-mints of "the same table" can
  carry different FDs/ECs depending on which access path was chosen underneath. A key that
  omits them risks returning a stale answer.

Per the ticket's own escape hatch ("acceptable to land only the index swaps and drop the
memoization... if the key turns out awkward"), I left this alone and documented the analysis as
a `NOTE:` comment at the call site (filter.ts, right above `createTableInfoFromNode(this.source)`)
so a future attempt starts from the right place instead of re-deriving this.

**Also explicitly left alone, per ticket scope:** `rule-async-gather-zip-by-key.ts:601-619`
(`keyCollationsAgree`) has the same `attrs.findIndex(a => a.id === attrId)` shape as the fixed
`branchesKeyUnique`, but the ticket's TODO named only `branchesKeyUnique` (line 581). I left it
untouched rather than silently widening scope — flagging here in case the reviewer wants a
follow-up.

## Validation

- **Correctness of the swap itself:** generated a new golden-plan regression fixture
  (`test/plan/basic/multi-filter-keyed.sql` — a two-level filter/alias over a PK'd `users` table,
  covering both an indexed equality and a non-key AND'd predicate) and confirmed **byte-identical**
  optimizer output on both sides of the edit: generated the golden against the new code, then
  `git stash`ed the two source edits and re-ran the same golden test against the pre-edit code —
  it still passed. This is a direct before/after check, not just self-consistency against one
  version.
- `yarn workspace @quereus/quereus build` — clean.
- `yarn workspace @quereus/quereus test` — 6522 passing, 9 pending (pre-existing pending markers,
  unrelated to this change), 0 failing.
- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`).

## Gaps for the reviewer

- No test was added specifically isolating `branchesKeyUnique`'s O(1) lookup (the zip-by-key
  rewrite has its own existing test suite that exercises this path indirectly via the full
  rewrite firing — I relied on the full `yarn test` run rather than adding a unit test scoped to
  just this helper). If the reviewer wants tighter coverage on that function specifically, that's
  a gap.
- The dropped memoization item (see above) means the original ticket's stated perf win for that
  specific hot path (repeated `extractConstraints` calls across re-mints) is not realized — only
  the two `getAttributeIndex()` swaps and the regression test landed. The `NOTE:` comment in
  `filter.ts` is the parking spot for anyone picking this back up.
