---
description: A query with two limits on the same column — like `where age > 10 and age > 30` — used to silently ignore one of them and return too many rows; the planner now keeps every filter it was given.
prereq:
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # RECLAIMABLE_OPS + reattachUnconsumedConstraints; consumed-set threading; per-role pickers
  - packages/quereus/src/vtab/memory/module.ts                             # findRangeMatch now claims first-lower/first-upper only
  - packages/quereus-store/src/common/store-module.ts                      # claimFirstPerRole/rangeRoles/equalityRoles lifted to module scope; PK eq dedupe by column; PK range positional claim
  - packages/quereus/test/vtab/test-overclaim-module.ts                    # NEW — deliberately over-claiming stub module
  - packages/quereus/test/vtab/overclaiming-module.spec.ts                 # NEW — guard that keeps the safety net alive
  - packages/quereus/test/vtab/redundant-constraints.spec.ts               # NEW — memory PK / secondary index / composite PK
  - packages/quereus-store/test/pushdown.spec.ts                           # extended: PK single-column + composite-PK blocks
  - docs/module-authoring.md                                               # handledFilters positional contract + fixed the over-claiming example
  - docs/optimizer.md                                                      # "The handledFilters contract" section
difficulty: medium
---

# Keep every pushed filter: planner must not trust an over-claiming access plan

## What was wrong

`getBestAccessPlan` returns `handledFilters: boolean[]`, one flag per pushed filter.
`rule-grow-retrieve` builds the residual `Filter` from exactly the constraints whose flag
is `false`. So `handledFilters[i] = true` is a promise that predicate `i` gets enforced
somewhere else — and the only "somewhere else" is `FilterInfo.constraints`, the seek
bounds `rule-select-access-path` builds.

That rule consumes at most **one constraint per column per role**: the first `=`/`IN`, the
first lower bound, the first upper bound — each picked by position via `.find(...)`. It
also collapses `handledFilters` into a per-*column* set, losing per-constraint identity.
Anything else a module claimed was seeked nowhere and filtered nowhere. Gone.

Three modules over-claimed, producing wrong answers on `main`:

| Table kind | Query | Expected | Was |
|---|---|---|---|
| memory, primary key | `where id > 10 and id > 30` | `40` | `20, 30, 40` |
| memory, index on `v` | `where v < 40 and v < 20` | `1` | `1, 2, 3` |
| store, primary key | `where id > 10 and id > 30` | `40` | `20, 30, 40` |
| store, composite PK `(a,b)` | `where a = 1 and a = 2` | *(no rows)* | **every row in the table** |

The composite-PK row is the worst: the store's full-PK point-lookup branch counted pushed
`=` filters without deduplicating by column, so `a = 1 and a = 2` read as "both PK columns
pinned". It claimed both filters, provided no seek columns, fell into the legacy access
path, found no complete PK equality set, and degraded to a sequential scan — with the
residual already discarded.

## What was done

### 1. Planner safety net (the correctness guarantee)

`rule-select-access-path.ts`:

- `RECLAIMABLE_OPS` — the ops the rule can turn into seek bounds (`=`, `IN`, `>`, `>=`,
  `<`, `<=`, `OR_RANGE`), with the `NOTE:` tripwire the ticket asked for.
- A `ConsumedSet` (a `Set` of constraint objects, identity-keyed) threaded through
  `selectPhysicalNodeFromPlan` and `selectPhysicalNodeLegacy`. Each terminal branch adds
  the constraints it turns into a seek key, a `FilterInfo.constraints` entry, or a
  collation-cover residual — recorded at the *top of each all-arms-return block* so a
  branch that falls through never leaves a stale entry.
- `reattachUnconsumedConstraints` in `selectPhysicalNode` wraps the physical leaf in a
  `FilterNode` over the AND of every constraint that was `handledFilters[i] === true`,
  not in the consumed set, and in `RECLAIMABLE_OPS`. Skipped for an `EmptyResultNode` leaf.

Two incidental cleanups inside the rule, both behaviour-relevant:

- The prefix-range block re-ran the same three `.find(...)` predicates three times. They
  are now three named per-role pickers (`findPrefixEq` / `findLower` / `findUpper`) used
  everywhere in that function, so the "first match by position" contract has one source.
- `selectPhysicalNodeLegacy`'s `eqByCol` kept the **last** `=` per column
  (`map.set` in a loop). It now keeps the **first**, matching the documented positional
  contract and what `claimFirstPerRole` in the store assumes. Reviewer: this is a real
  behaviour change on the legacy PK-seek path — with the safety net either choice is
  *correct*, but only "first" agrees with the contract the docs now state.

### 2. Modules tightened

- `memory/module.ts` `findRangeMatch` — claims the first `>`/`>=` and the first `<`/`<=`
  only. Feeds both the standalone range path and the prefix-range combine.
- `store-module.ts` — `claimFirst` and the op-group constants lifted out of
  `tryIndexAccessPlan` into module-scope `claimFirstPerRole(filters, roles)` plus
  `rangeRoles(colIdx)` / `equalityRoles(colIdxs)`. All three claim sites now share it:
  `tryIndexAccessPlan`, the PK range branch, and the PK equality branch.
- The store PK equality branch now counts **distinct pinned PK columns**
  (`pinnedPkColumns: Set<number>`), not raw `=` filters.

After these, `lost` is empty for every in-tree module, so the safety net adds no `Filter`
in normal operation — confirmed by inspecting plan shapes (below).

### 3. Docs

`docs/module-authoring.md` gained a *Claiming `handledFilters` — the positional contract*
block, and its worked example was **itself over-claiming** (`pkConstraints.includes(f)`
marks every `=` on column 0) — fixed to `findIndex`. `docs/optimizer.md` gained a
*The `handledFilters` contract* subsection under Virtual Table Integration.

## Verification performed

`yarn test` — 6570 passing / 9 pending in `packages/quereus`, all other workspaces green,
0 failing across the monorepo. `yarn workspace @quereus/store test` — 749 → 758 passing.
`yarn lint` — clean (that includes `tsc -p tsconfig.test.json --noEmit`, so the new spec
call sites typecheck).

**Mutation-checked the guard**: reverting only `reattachUnconsumedConstraints` to a no-op
(`if (leaf) return leaf;`) makes 5 of the 6 `overclaiming-module.spec.ts` tests fail. The
safety net is load-bearing and the test proves it.

**Plan shapes** (`query_plan()` over the memory vtab) — exactly one `FILTER` appears where
a redundant bound must be re-applied, and none otherwise:

| Query | Ops |
|---|---|
| `where v > 10` | `INDEXSEEK` |
| `where v > 10 and v > 30` | `FILTER, INDEXSEEK` |
| `where v > 10 and v < 40` | `INDEXSEEK` (no regression to a scan) |
| `where v = 20` | `INDEXSEEK` |

## Use cases for the reviewer to exercise

Correctness (all now pass; each failed before):

- memory PK: `id > 10 and id > 30` → `40`; `id < 40 and id < 20` → `10`;
  `id > 10 and id >= 30` → `30, 40`
- memory secondary index on `v`: the same three shapes, plus `v = 20 and v = 30` → none,
  `v = 30 and v > 35` → none
- memory composite PK `(a, b)`: `a = 1 and a = 2` → none; `a = 1 and b = 2` → one row
- store, all of the above, plus `a = 1 and b = 2 and a = 2` → none (redundant equality
  alongside a genuine full-key match) and `a = 1` alone → both `a = 1` rows
- over-claiming stub module (`test/vtab/test-overclaim-module.ts`): claims every pushed
  filter, applies only what reaches it in `FilterInfo`. Its spec is the only place a wrong
  answer surfaces if the reattach is deleted.

Non-regression:

- `where v > 10 and v < 40` must still plan an `IndexSeek` (asserted in both the engine and
  store specs).
- Collation-cover behaviour: the declined-seek paths (`NOCASE` index over a `BINARY`
  predicate, etc.) still produce `SeqScan + residual`. Their constraints are marked
  consumed, so they are not double-applied by the reattach.

## Known gaps — please probe these

1. **`OR_RANGE` reattach is untested.** `OR_RANGE` is in `RECLAIMABLE_OPS` and the rule
   marks the chosen `OR_RANGE` constraint consumed, but no test exercises *two* `OR_RANGE`
   constraints on one column, or an `OR_RANGE` claimed on a non-seek column. Reasoning says
   the reattach handles both; nothing verifies it.

2. **`IN` reattach is untested.** Same shape: `v in (1,2) and v in (2,3)`. Constraint
   extraction may collapse or decline these before they reach the rule — worth checking
   whether a redundant `IN` pair can even reach `getBestAccessPlan` as two constraints.

3. **`selectPhysicalNodeLegacy`'s `eqByCol` first-vs-last change.** No existing test
   distinguished the two. If some module out there relies on the legacy path seeking the
   *last* `=` (it shouldn't — that was never contracted), this would change which value is
   seeked. Correctness is preserved either way by the residual, but the seek *window*
   changes.

4. **The legacy `hasRangeConstraints` block can build an `IndexSeekNode` with zero seek
   keys** when the only handled range is on a non-leading PK column (`lower` and `upper`
   both `undefined`). That is pre-existing and now *safe* (the constraint gets reattached),
   but it is a full index walk dressed up as a seek. Not addressed; not in scope.

5. **Duplicate-filter risk in the non-grow path.** When `rule-grow-retrieve` does *not*
   install an index-style context but `retrieveNode.source` still carries a `Filter`,
   `rebuildPipelineWithNewLeaf` preserves that `Filter` and a reattach would add a second,
   redundant one below it. I could not construct such a plan (grow-retrieve is what pushes
   the `Filter` into `source` in the first place), and no test regressed — but I did not
   prove the path is unreachable.

6. **The tests assert rows, not claim-tightness.** With the safety net in place, reverting
   *only* the memory/store module fixes would still yield correct rows (just an extra
   `Filter` node). Nothing pins the module-side positional claim except the plan-shape
   assertions in the two-sided-range tests. A reviewer wanting a tighter floor could assert
   the absence of `FILTER` for single-bound queries.

## Tripwire parked

`NOTE:` comment at the `RECLAIMABLE_OPS` definition in `rule-select-access-path.ts`,
recording that ops outside the seek family (`IS NULL` / `IS NOT NULL` / `LIKE` / `GLOB` /
`MATCH` / `NOT IN`) are taken at the module's word, that this is sound today only because
the sole such claim is memory's tautological `IS NOT NULL` on a `NOT NULL` column, and what
to do if that ever stops being true.
