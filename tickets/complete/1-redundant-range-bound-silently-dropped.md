---
description: A query with two limits on the same column — like `where age > 10 and age > 30` — used to silently ignore one of them and return too many rows; the planner now keeps every filter it was given, and a second, related case where a bound was applied to the wrong column was found and fixed during review.
prereq:
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # RECLAIMABLE_OPS + reattachUnconsumedConstraints; consumed-set threading; per-role pickers; leading-seek-column range guard
  - packages/quereus/src/vtab/memory/module.ts                             # findRangeMatch claims first-lower/first-upper only; NOTE tripwire on the multi-value IN prefix
  - packages/quereus-store/src/common/store-module.ts                      # claimFirstPerRole/rangeRoles/equalityRoles at module scope; PK eq dedupe by column; PK range positional claim
  - packages/quereus/test/vtab/test-overclaim-module.ts                    # deliberately over-claiming stub module
  - packages/quereus/test/vtab/overclaiming-module.spec.ts                 # guard that keeps the safety net alive
  - packages/quereus/test/vtab/redundant-constraints.spec.ts               # memory PK / secondary index / composite PK / IN / OR_RANGE / multi-value-IN prefix / plan-shape floor
  - packages/quereus-store/test/pushdown.spec.ts                           # PK single-column + composite-PK blocks
  - docs/module-authoring.md                                               # handledFilters positional contract; leading-seek-column corollary
  - docs/optimizer.md                                                      # "The handledFilters contract" section
difficulty: medium
---

# Keep every pushed filter: the planner must not trust an over-claiming access plan

## What was wrong

`getBestAccessPlan` returns `handledFilters: boolean[]`, one flag per pushed filter, and
`rule-grow-retrieve` builds the residual `Filter` from exactly the constraints whose flag
is `false`. So `handledFilters[i] = true` is a promise that predicate `i` is enforced
somewhere else — and the only "somewhere else" is `FilterInfo.constraints`, the seek
bounds `rule-select-access-path` builds.

That rule consumes at most **one constraint per column per role**: the first `=`/`IN`, the
first lower bound, the first upper bound. Anything else a module claimed was seeked
nowhere and filtered nowhere. Three in-tree modules over-claimed, producing wrong answers:
memory over its primary key and over secondary indexes, and the store over both its
single-column and composite primary keys (the composite case returned *every row in the
table* for `where a = 1 and a = 2`).

## What was done

**Planner safety net.** `reattachUnconsumedConstraints` wraps the physical leaf in a
`FilterNode` over the AND of every constraint the module claimed but the rule never turned
into a seek bound. A `ConsumedSet` (identity-keyed on constraint objects) is threaded
through `selectPhysicalNodeFromPlan` / `selectPhysicalNodeLegacy`; each terminal branch
records the constraints it consumed. Restricted to `RECLAIMABLE_OPS` (`=`, `IN`, `>`, `>=`,
`<`, `<=`, `OR_RANGE`) — the ops the rule can seek — and skipped for an `EmptyResultNode`
leaf. An over-claiming module now costs a redundant predicate evaluation, never a wrong
answer.

**Modules tightened** so the safety net stays dormant in normal operation. Memory's
`findRangeMatch` claims the first lower and first upper bound only. The store lifted its
positional claim into module-scope `claimFirstPerRole(filters, roles)` shared by all three
claim sites, and its primary-key equality branch now counts *distinct pinned PK columns*
rather than raw `=` filters.

**Docs.** `docs/module-authoring.md` gained the positional `handledFilters` contract (its
worked example was itself over-claiming, and is fixed); `docs/optimizer.md` gained a
matching subsection.

## Review findings

### Checked

Read the implement diff before the handoff summary. Scrutinized `rule-select-access-path.ts`
end to end (not just the diff hunks): consumed-set placement relative to every early
return, interaction with the collation-cover decline paths, `combineResidualExpressions`
identity dedup for `BETWEEN` (which yields two constraints sharing one source node),
alignment of `constraints[i]` with `handledFilters[i]` on both the grow-retrieve and
fresh-extraction paths, and the `EmptyResultNode` skip. Traced the memory module's
`findRangeMatch` / `findEqualityMatches` and the store's `claimFirstPerRole` against the
rule's per-role pickers to confirm both sides agree on "first match by position". Ran
`yarn test` (whole monorepo) and `yarn lint` (which includes `tsc -p tsconfig.test.json
--noEmit`). Empirically exercised each of the six gaps the implementer flagged, using
throwaway spec files against both `HEAD` and the pre-fix commit `a0514453` in a scratch
worktree.

### Found and fixed in this pass

**A range bound could be seeked against the wrong column.** `rule-select-access-path`
picked its standalone range column with `seekCols.find(colIdx => findLower(colIdx) ||
findUpper(colIdx))` — the first seek column carrying *any* bound, not necessarily the
leading one. Seek keys are positional and the runtime applies them to the index's leading
column, so a bound on a later column was silently applied to the leading one. Reachable
today: `select ... from t where a in (1, 2) and b > 15` over an index on `(a, b)`. The
memory module claims the multi-value `IN` as a prefix match, but the rule's prefix-range
encoding needs a *single-valued* prefix key, so it fell through to the standalone-range
branch and picked `b`. `b > 15` was then never applied. On the pre-fix commit this query
returned all five rows of the fixture (both `a in (1,2)` and `b > 15` lost); after the
implement commit it returned four (the `IN` recovered by the new safety net, `b > 15`
still lost); the expected answer is two.

The fix restricts the standalone range branch to `seekCols[0]`. When the leading seek
column carries no bound the rule declines the seek, and `reattachUnconsumedConstraints`
re-applies the claimed range as a residual over a sequential scan. This is a strict
improvement: every case where the old code picked a non-leading column was a case where
the emitted seek was wrong. Covered by a new `multi-value IN prefix with a trailing range
on a composite index` block in `redundant-constraints.spec.ts`, including the
single-value-`IN`, plain-equality, and trailing-equality shapes that must keep seeking.

**Zero-key `IndexSeekNode` on the legacy path** (implementer's gap 4). The legacy PK range
branch entered on `hasRangeConstraints` — true for a handled range on *any* column — then
looked for bounds only on the leading PK column, so it could emit an `IndexSeekNode` with
an empty `seekKeys` array: a full index walk labelled as a seek. Now guarded on
`lower || upper`; the claimed range is recovered as a residual instead.

**`eqHandled` was a misnomer** in `selectPhysicalNodeLegacy` — it is every `=` constraint,
handled or not. Renamed to `eqConstraints` with a comment explaining why including
unhandled ones is sound (an unhandled `=` still makes a valid seek key, because
grow-retrieve keeps it in the residual).

### Found, verified correct, no change needed

- **`OR_RANGE` reattach** (gap 1) and **`IN` reattach** (gap 2) both work. `where (v < 15
  or v > 45) and (v < 25 or v > 35)` and `where v in (10,20) and v in (20,30)` each return
  the intersection; an `OR_RANGE` claimed on a non-seek column is also reattached.
  Regression tests added for all three.
- **`eqByCol` first-vs-last change** (gap 3). The legacy PK-seek path now keeps the *first*
  `=` per column. Confirmed no in-tree module depends on "last", and the residual preserves
  correctness under either choice.
- **Consumed-set placement.** Every branch that adds to the set is a block in which all
  arms return, so no branch can fall through leaving a stale entry. The collation-decline
  arms re-apply exactly the constraints they marked consumed, so the reattach never
  double-applies them.
- **`handledByCol` is column-level, not per-constraint**, so an *unhandled* constraint can
  become the seek bound while the module's claimed one is reattached. Sound: the unhandled
  one is also kept in grow-retrieve's residual, and the claimed one comes back via the
  reattach. Both predicates end up applied.
- **Claim-tightness floor** (gap 6). The row-level assertions could not distinguish a
  tight module claim from a loose one plus the safety net. Added plan-shape assertions:
  single-bound and two-sided-range queries must plan with **no** `Filter`, and a redundant
  bound must produce **exactly one**. These now pin the module-side positional claim.

### Recorded as tripwires (not tickets)

- **Multi-value `IN` prefix costs are now optimistic.** `packages/quereus/src/vtab/memory/module.ts`,
  `NOTE:` at the prefix-equality + trailing-range branch. `a in (1, 2) and b > 15` advertises
  a range-scan cost but, after the fix above, plans as a sequential scan with residuals. The
  answer is right; only the estimate is off. If such plans ever show up as slow, either
  teach the rule a cross-product prefix-range seek or stop claiming the trailing range.
- **Possible duplicate residual on the non-grow path** (implementer's gap 5).
  `packages/quereus/src/planner/rules/access/rule-select-access-path.ts`, `NOTE:` in
  `createIndexBasedAccess`. When there is no index-style `moduleCtx` but `retrieveNode.source`
  still carries a `Filter`, that `Filter` is preserved verbatim and a reattached constraint
  would be applied twice. Only reachable for a module exposing both `supports()` (declining
  at select time) and `getBestAccessPlan()`; redundant, never wrong. Neither the existing
  suite nor a hand-constructed attempt reaches it.
- The non-seek-family `handledFilters` tripwire the implementer parked at `RECLAIMABLE_OPS`
  is still accurate and was left as-is.

### Noted, deliberately not changed

- `treatAsHandledPk` in `selectPhysicalNodeLegacy` is implied by `coversPk`, so the branch
  condition `(hasEqualityConstraints && coversPk) || treatAsHandledPk` reduces to `coversPk`.
  Dead but harmless, and pre-existing; simplifying it would touch a hot correctness path for
  no behavioural gain.
- `createIndexBasedAccess`'s `isIndexStyleContext` arm is unreachable, because
  `ruleSelectAccessPath` returns from its own index-style branch first. Pre-existing, and the
  duplicated logic documents intent; left alone rather than churn an untouched function.

### No findings

Resource cleanup and error handling: the rule allocates only plan nodes and a `Set`, holds
no handles, and throws no new exceptions — nothing to review. Type safety: no `any`, no new
casts beyond the existing `SqlValue` narrowing idiom; `tsc --noEmit` over `src` and `test`
is clean. Cross-platform: no platform-specific code paths added.

## Verification

`yarn test` — 6580 passing / 9 pending in `packages/quereus` (up from 6570, the 10 new
regression tests), 758 in `@quereus/store`, all other workspaces green, **0 failing**
across the monorepo. `yarn lint` — clean, including the `tsc -p tsconfig.test.json
--noEmit` pass over the spec files. No pre-existing failures were encountered, so
`tickets/.pre-existing-error.md` was not written.
