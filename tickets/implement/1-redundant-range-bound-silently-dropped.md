---
description: A query with two limits on the same column — like `where age > 10 and age > 30` — silently ignores one of them and returns too many rows; make the planner keep every filter it was given.
prereq:
files:
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # handledByCol (298, 841); eq seek (304-318); prefix-range trailing bounds (591-637); range seek (662-700); OR_RANGE (723-726); legacy eq (841-895) + legacy range (912-948); seq-scan fallbacks (824, 997); combineResidualExpressions (1380)
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts      # residual built per-constraint from handledFilters (411-433, 562-578)
  - packages/quereus/src/vtab/memory/module.ts                             # findRangeMatch (597-619) over-claims; IS NOT NULL post-pass (374-389)
  - packages/quereus-store/src/common/store-module.ts                      # PK equality branch (~1846) + PK range branch (~1877) over-claim; tryIndexAccessPlan claimFirst (2043-2054) is the correct pattern
  - packages/quereus-store/test/pushdown.spec.ts                           # `redundant same-column constraints keep their predicate` — reuse this test shape
  - docs/module-authoring.md                                               # handledFilters contract (lines ~67, ~139, ~179)
  - docs/optimizer.md                                                      # BestAccessPlanResult (line ~586)
difficulty: medium
---

# Keep every pushed filter: planner must not trust an over-claiming access plan

## Confirmed reproduction

Run against current `main` (in-memory engine, no plugin):

| Table kind | Query | Expected | Actual |
|---|---|---|---|
| memory, primary key | `where id > 10 and id > 30` | `40` | `20, 30, 40` |
| memory, primary key | `where id < 40 and id < 20` | `10` | `10, 20, 30` |
| memory, primary key | `where id > 10 and id >= 30` | `30, 40` | `20, 30, 40` |
| memory, index on `v` | `where v > 10 and v > 30` | `4` | `2, 3, 4` |
| memory, index on `v` | `where v < 40 and v < 20` | `1` | `1, 2, 3` |
| store, primary key | `where id > 10 and id > 30` | `40` | `20, 30, 40` |
| store, primary key | `where id < 40 and id < 20` | `10` | `10, 20, 30` |
| **store, composite PK `(a,b)`** | `where a = 1 and a = 2` | *(no rows)* | **every row in the table** |

Equality duplicates on a *single*-column key already behave (`where v = 20 and v = 30`
→ no rows) because both the memory module and the store's non-composite path decline
to claim the second `=`.

The last row is a distinct, worse defect found while reproducing: the store's full-PK
point-lookup branch counts pushed `=` filters without deduplicating by column, so on a
two-column primary key `a = 1 and a = 2` looks like "both PK columns are pinned". It
claims both filters handled, provides no seek columns, falls into the legacy access
path, finds no complete PK equality set, and degrades to a sequential scan — with the
residual predicate already discarded. The query returns the whole table.

## Root cause

`getBestAccessPlan` returns `handledFilters: boolean[]`, one flag per pushed filter.
`rule-grow-retrieve` builds the residual `Filter` from exactly the constraints whose
flag is `false` (`rule-grow-retrieve.ts:414`, `:565`). So a `true` flag is a promise:
*this predicate will be enforced somewhere else*.

The only place "somewhere else" can be is `FilterInfo.constraints` — the array
`rule-select-access-path` builds from the constraints it turns into seek bounds, and
the only channel through which a module receives a pushed predicate at runtime (the
store's `StoreTable.matchesFilters` re-checks exactly these). A constraint that is
marked handled but never lands in `FilterInfo.constraints` is applied nowhere.

That is precisely what happens today:

- `rule-select-access-path` collapses `handledFilters` into a per-**column** set
  (`handledByCol`, line 298 and again at 841), losing per-constraint identity.
- It then consumes at most one constraint per column per role: first `=`/`IN`
  (line 308), first lower and first upper bound (lines 669-670, 625-626, 918-919),
  first `OR_RANGE` (line 723) — each via `.find(...)`, i.e. **by position in the
  constraint array**.
- Anything else the module claimed is neither seeked nor residualized. Gone.

Modules over-claim in three known places:

- `memory/module.ts` `findRangeMatch` (597) sets `handledFilters[i] = true` for
  *every* range filter on the column, not the first per side.
- `store-module.ts` PK range branch (~1877): `rangeFilters.some(rf => rf.columnIndex
  === f.columnIndex && rf.op === f.op)` — same over-claim.
- `store-module.ts` PK equality branch (~1846): `pkFilters.length ===
  pkColumns.length` counts duplicates as distinct columns (the composite-PK case above).

`tryIndexAccessPlan` in the same store file (2028-2054) already does it right — it
claims *positionally*, matching the rule's `find`-first pick, and leaves duplicates
unhandled. Its comment block is the best existing statement of the contract.

## Design

Do both halves. The planner change is the correctness guarantee; the module changes
keep plans tight and are the model for third-party authors.

### 1. Planner safety net (authoritative)

Make `rule-select-access-path` reattach any constraint the access plan marked handled
that the rule did not actually consume.

Thread a `consumed: Set<number>` (indices into the `constraints` array) through
`selectPhysicalNodeFromPlan` and `selectPhysicalNodeLegacy`. Record an index each time
a constraint becomes a seek key or a `FilterInfo.constraints` entry. Build the index
lookup once by object identity — the constraint objects in the array are unique.

Then, in `selectPhysicalNode` (the shared entry point, line 220), after the physical
leaf is chosen:

```
lost = constraints.filter((c, i) =>
    accessPlan.handledFilters[i] === true
    && !consumed.has(i)
    && RECLAIMABLE_OPS.has(c.op))
```

and, when `lost` is non-empty, wrap the leaf in a `FilterNode` whose predicate is
`combineResidualExpressions(lost.map(c => c.sourceExpression))` (the helper at line
1380 already AND-combines and de-duplicates by identity). Wrapping at this point is
consistent with the existing collation-cover residuals, which already return
`new FilterNode(scope, leaf, cover.residual)` from inside these functions — and those
residual constraints *were* consumed, so the two mechanisms compose by AND without
double-counting.

`RECLAIMABLE_OPS` = the ops the rule can turn into seek bounds:
`=`, `IN`, `>`, `>=`, `<`, `<=`, `OR_RANGE`.

Restricting to those ops is deliberate. `memory/module.ts:374-389` marks a tautological
`IS NOT NULL` on a `NOT NULL` column as handled purely to shed the residual filter;
that claim is sound (the predicate cannot exclude a row) and a blanket reattach would
resurrect a pointless `Filter` node. Ops outside the seek family are never pushed into
`FilterInfo` by this rule, so the module's claim stands on its own — which is a real
sharp edge worth a `NOTE:` comment at the definition of `RECLAIMABLE_OPS` (see
Tripwire below).

Skip the wrap when the chosen leaf is an `EmptyResultNode` (the literal-NULL-equality
short circuits at lines 582 and elsewhere) — filtering an empty relation is dead weight.

### 2. Tighten the over-claiming modules

Mirror `tryIndexAccessPlan`'s `claimFirst` pattern. It is worth lifting `claimFirst`
(and the `EQ_OPS` / `LOWER_BOUND_OPS` / `UPPER_BOUND_OPS` constants at
`store-module.ts:119-122`) to a module-scope helper so both the PK branch and
`tryIndexAccessPlan` share one implementation.

- **store PK range branch** — claim the first lower bound and the first upper bound on
  the leading PK column, by position. Duplicates stay unhandled.
- **store PK equality branch** — require each PK column to have at least one `=` filter
  (deduplicate by `columnIndex` before comparing against `pkColumns.length`), then claim
  the first `=` per PK column. `a = 1 and a = 2` must no longer read as a full PK match.
- **memory `findRangeMatch`** — claim the first `>`/`>=` and the first `<`/`<=` only.
  This feeds both the standalone range path (514) and the prefix-range combine (496-500),
  so both get fixed at once.

After these, the queries above should still use an index seek (on the *first*-positioned
bound) with the redundant bound applied as a residual `Filter` — correct rows, and only
one extra predicate evaluation per fetched row.

### 3. Document the contract

State it where a module author will hit it. Both `docs/module-authoring.md` (around the
`handledFilters` description, ~line 139 and the worked example at ~179) and
`docs/optimizer.md` (~line 586):

> A module may set `handledFilters[i] = true` only for a filter it will actually apply.
> For the seek-family operators (`=`, `IN`, `<`, `<=`, `>`, `>=`, `OR_RANGE`) the planner
> consumes at most one filter per column per role — the first `=`, the first lower bound,
> the first upper bound, **in `request.filters` order**. Claim positionally: mark the
> first match, leave redundant same-column same-role filters unhandled so they survive as
> a residual `Filter`. The planner defends itself against an over-claim by reattaching
> any seek-family filter it did not consume, so an over-claiming module costs a
> redundant filter, not a wrong answer.

Note the store's `computeBestAccessPlan` also carries a comment (~1863) explaining that
ranges on non-leading PK columns must not be claimed — the same family of rule. Keep it.

## Tripwire

Add at the `RECLAIMABLE_OPS` definition:

```ts
// NOTE: ops outside this set (IS NULL / IS NOT NULL / LIKE / GLOB / MATCH) are never
// pushed into FilterInfo by this rule, so a module claiming one is taken at its word.
// Sound today: the only such claim is memory's tautological IS NOT NULL on a NOT NULL
// column. If a module ever claims a non-tautological non-seek op, its predicate is lost
// — widen this set, or make grow-retrieve refuse the claim.
```

## Acceptance

- Every row of the reproduction table above returns the expected rows.
- `where v = 20 and v = 30` and `where v = 30 and v > 35` return no rows.
- `where v > 10 and v < 40` still plans an `IndexSeek` (a genuine two-sided range must
  not regress into a scan).
- `yarn test` green; `yarn workspace @quereus/store test` green; `yarn lint` clean.

## TODO

Phase 1 — planner safety net
- [ ] Thread a consumed-constraint index set through `selectPhysicalNodeFromPlan` and `selectPhysicalNodeLegacy`, recording every constraint that becomes a seek key / `FilterInfo.constraints` entry (eq seek, IN multi-seek, prefix-range, range seek, OR_RANGE, legacy eq, legacy range).
- [ ] In `selectPhysicalNode`, wrap the leaf with a `FilterNode` over the AND of unconsumed-but-handled seek-family constraints (`combineResidualExpressions`); skip for `EmptyResultNode`.
- [ ] Define `RECLAIMABLE_OPS` with the `NOTE:` tripwire comment above.

Phase 2 — modules
- [ ] Lift `claimFirst` + op-group constants in `store-module.ts` to module scope; reuse in `tryIndexAccessPlan`.
- [ ] Fix the store PK range branch to claim first-lower/first-upper positionally.
- [ ] Fix the store PK equality branch to dedupe by `columnIndex` before the full-PK-match test, then claim the first `=` per PK column.
- [ ] Fix `memory/module.ts` `findRangeMatch` to claim first-lower/first-upper only.

Phase 3 — tests + docs
- [ ] Engine test (new spec under `packages/quereus/test/`, or extend `memory-vtable.spec.ts`): the memory PK and memory secondary-index rows of the table, plus `v = 20 and v = 30`, plus the `IndexSeek` non-regression check for a two-sided range.
- [ ] Extend `packages/quereus-store/test/pushdown.spec.ts` with a PK-range block mirroring the existing `redundant same-column constraints keep their predicate` describe, and a composite-PK `a = 1 and a = 2` case.
- [ ] Add a planner-level test that a *deliberately over-claiming* stub module (marks every filter handled) still yields correct rows — this is the guard that keeps the safety net alive.
- [ ] Update `docs/module-authoring.md` and `docs/optimizer.md` with the contract text above.
