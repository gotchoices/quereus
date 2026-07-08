description: Landed the two low-risk plan-time speedups (reuse a cached attribute-id lookup instead of rebuilding it), added a regression test proving optimizer output is unchanged, and swapped one more hand-rolled lookup found during review.
files: packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/rules/parallel/rule-async-gather-zip-by-key.ts, packages/quereus/test/plan/basic/multi-filter-keyed.sql, packages/quereus/test/plan/basic/multi-filter-keyed.plan.json
----

## What shipped

Two mechanical swaps replacing hand-rolled `attrId -> index` lookups with the existing
per-instance-cached `PlanNode.getAttributeIndex()` (`plan-node.ts:758`):

1. `filter.ts:68` (`FilterNode.computePhysical`) — was building a fresh `Map<number,number>`
   from `sourceAttrs` on every call; now reuses `this.source.getAttributeIndex()`.
2. `rule-async-gather-zip-by-key.ts:578` (`branchesKeyUnique`) — was doing an O(n)
   `attrs.findIndex(a => a.id === id)` scan per key attr per branch; now O(1) map `.get`.

A third swap landed **during review** (see findings): `rule-async-gather-zip-by-key.ts:609`
(`keyCollationsAgree`) had the identical `findIndex` scan the implementer flagged as a possible
follow-up.

The memoization item from the original plan (caching `FilterNode`'s covered-key check across
source-only re-mints) was deliberately **not** done — investigating the proposed cache key
surfaced a soundness problem. Parked as a `NOTE:` at the call site (`filter.ts`, above
`createTableInfoFromNode(this.source)`): `relationKey` embeds the source's per-instance node id
(so it never agrees across the exact re-mint the cache would target), and the covered-key result
also depends on physical-strategy-dependent `fds`/`equivClasses`, so a sound signature would have
to fingerprint those too. Revisit only if it shows up hot in profiling.

## Review findings

**Scope reviewed:** the implement-stage diff (`cacf9af8`), `getAttributeIndex()` semantics vs the
two hand-rolled maps it replaced, dead-variable check on the edited functions, the new golden
fixture's schema/meaningfulness, and the full test + lint run.

- **Correctness of the two swaps — CONFIRMED equivalent.** `getAttributeIndex()` builds exactly
  `attrs[i].id -> i` over `getAttributes()`, the same source and mapping the removed code used.
  Cached per instance; `withChildren` mints a fresh instance so the cache rebuilds — no staleness.
- **`sourceAttrs` not left dead** (filter.ts) — still consumed at lines 85/89/96/145/170 after the
  edit; only its `.forEach` map-build was removed.
- **Golden fixture is meaningful, not vacuous.** `multi-filter-keyed.sql` filters on the PK
  (`u.id = 3`), so the covered-key path fires: the golden captures the singleton FD
  (`determinants:[]` → `dependents:[0,1,2,3]`, `kind:unique`) at plan.json:485. Confirms the
  `extractConstraints` path the FilterNode edit sits next to actually ran. Implementer's
  before/after `git stash` check (byte-identical golden on both sides) is sound methodology.
- **Minor — fixed inline.** `keyCollationsAgree` (rule-async-gather-zip-by-key.ts:609) had the
  same `attrs.findIndex(a => a.id === attrId)` scan as the fixed `branchesKeyUnique`; the
  implementer flagged it as out-of-scope-but-noticed. Swapped it to `getAttributeIndex().get()`
  too — same mechanical change, realizes the ticket's intent for the last site. Verified safe:
  the returned index feeds `getType().columns`, which is index-aligned with `getAttributes()`
  (the same list `getAttributeIndex()` is built from). The `Attribute` type import stays — still
  used at line 319.
- **Tripwire (no action) — first-vs-last on duplicate attr ids.** `getAttributeIndex().get(id)`
  returns the *last* index for a given id where the old `findIndex` returned the *first*. These
  differ only if a relation carries two attributes with the same id — which the planner's
  attribute-id-uniqueness invariant forbids, and which `getAttributeIndex()` is the codebase's
  canonical replacement for anyway. Not a latent defect, no code path can trip it today; noting
  it here as the index entry rather than adding a comment, since the invariant is well-established.
- **Major findings:** none.
- **New tickets filed:** none — the one actionable item (keyCollationsAgree) was minor and fixed
  in-pass.

## Validation

- `yarn workspace @quereus/quereus test` — 6522 passing, 9 pending (pre-existing pending markers,
  unrelated), 0 failing. Re-run after the review edit: same result.
- `yarn workspace @quereus/quereus lint` — clean (eslint + `tsc -p tsconfig.test.json --noEmit`),
  exit 0, both before and after the review edit.
- `keyCollationsAgree` swap is exercised by the existing `test/optimizer/parallel-async-gather-*`
  specs via the full suite (direct mocha invocation blocked by a Windows `c:`-scheme loader quirk;
  ran through the workspace `test` script instead).
