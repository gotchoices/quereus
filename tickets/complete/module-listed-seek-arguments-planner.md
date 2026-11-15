---
description: Lets a storage module name exactly which filters it enforces inside its chosen index and receive their values, in order, when the query runs — so a multi-dimensional index can be handed placeholder box bounds. This is the query-planner half; the transaction-overlay half is a separate ticket.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/vtab/best-access-plan.ts                           # BestAccessPlanResult.moduleSeekFilters; isModuleSeekFilterOp; moduleSeekFiltersProblem; validateAccessPlan call
  - packages/quereus/src/vtab/index-descriptor.ts                           # IndexPlanKind 'moduleSeek'; AccessPath 'unorderedIndex'; accessPathPlan
  - packages/quereus/src/vtab/idx-str.ts                                    # PLAN_CODE_BY_KIND moduleSeek → 8
  - packages/quereus/src/vtab/filter-info.ts                                # retargetAccessPath renames unorderedIndex
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # selectLeaf dispatch; selectPhysicalNodeFromModuleSeek + helpers; buildIndexAccessPath unordered case; rangeSeekKey; isLiteralNullComparison; orderingClaimSurvivesCollation / orderingClaimIndexName
  - packages/quereus/src/planner/nodes/table-access-nodes.ts                # IndexSeekNode singleton FD excludes moduleSeek
  - packages/quereus/src/runtime/emit/scan.ts                               # walksOneWindow NOTE
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts            # comment at the seekColumnIndexes gate
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts          # comment at the seekColumnIndexes gate
  - packages/quereus-isolation/src/isolated-table.ts                        # resolveScanIndex: unorderedIndex throws INTERNAL (dormant)
  - packages/quereus/test/vtab/test-module-seek-module.ts                   # new test double
  - packages/quereus/test/vtab/module-seek-filters.spec.ts                  # new spec
  - packages/quereus/test/vtab/idx-str.spec.ts                              # moduleSeek added to the plan-code bijection list
  - docs/module-authoring.md                                                # new "Module-listed seek arguments" subsection; unorderedIndex paragraph in "Naming the chosen index"
  - docs/optimizer.md                                                       # access-path seam: new kind and the moduleSeek arm
---

# Module-listed seek arguments — planner half (complete)

## What was built

A module may now return `moduleSeekFilters: readonly number[]` on `BestAccessPlanResult`: indexes into `request.filters` of filters it enforces inside `indexName`. The engine consumes exactly those filters, in list order, and delivers them at `query()` time as `FilterInfo.constraints[k]` (column + operator) with `FilterInfo.args[k]` (value). Plan kind `moduleSeek`, idxStr `idx=<indexName>(0);plan=8` (plus `reverse=1` from a reversed descriptor). Every other handled filter is reattached above the seek by the existing `reattachUnconsumedConstraints`. A module that never sets the field sees no change.

- **Shared check** `moduleSeekFiltersProblem(filters, result)` (best-access-plan.ts): requires `indexName`; excludes a non-empty `seekColumnIndexes`; entries are integer, in range, unrepeated, and `handledFilters`-claimed; listed ops are `=`, `<`, `<=`, `>`, `>=`, or a literal single-element `IN` without `runtimeSet`. `validateAccessPlan` throws FORMAT; the planner arm throws INTERNAL with the table name.
- **Arm** `selectPhysicalNodeFromModuleSeek`, dispatched from a new small `selectLeaf` before the index-aware/legacy choice. Order: shared check → consume listed → literal-NULL fold to `EmptyResultNode` → collation cover (`moduleSeekCover`: range rule for every listed filter, BINARY when the index does not describe the column or does not resolve) → `IndexSeekNode` with seek keys from `equalitySeekKey` / new `rangeSeekKey`.
- **Access path**: resolvable index → `{ kind: 'index', plan: 'moduleSeek' }`; unresolvable + order claimed (`providesOrdering` non-empty or `monotonicOn`) → `unresolvedIndex` + warning; unresolvable + no order → new `{ kind: 'unorderedIndex', indexName, plan }`, no warning. Implemented inside `buildIndexAccessPath` keyed on `plan === 'moduleSeek'`, so the other arms are unchanged.
- `rangeSeekKey` replaced the six inline copies of the range seek-key expression in the existing arms (pure move). `isLiteralNullEquality` renamed `isLiteralNullComparison`.
- `IndexSeekNode` no longer stamps the singleton FD for a `moduleSeek` (keys are not one per primary-key column).
- `IsolatedTable.resolveScanIndex` throws INTERNAL on `unorderedIndex` (the exhaustive switch required a case). Dormant: no in-repo module emits it; `module-listed-seek-arguments-isolation-overlay` replaces it.

### One addition beyond the ticket text — please scrutinize

`orderingClaimSurvivesCollation` now also returns false when a moduleSeek plan's arm would decline on collation (`moduleSeekKeepsItsSeek`, which reuses `moduleSeekCover`; malformed list → false). Reason: the arm's range rule is stricter than the equality lattice that function uses, so without this a module claiming an order with, say, a NOCASE equality on a NOCASE index column and no `honorsCollatedRangeBounds` (or a non-BINARY filter on a column its descriptor does not hold) would have its `Sort` dropped by grow-retrieve while the arm then built an unordered `SeqScan`. The existing loop still runs too (it guards unlisted handled equalities). Not covered by a test; verified by reading. The existing prefix-range arm has the same shape of inconsistency for non-honouring modules (it applies the range rule to prefix equalities while the ordering check uses the equality lattice) — left alone, worth a look.

## Findings during implementation

- **`x between ? and ?` never reaches any module.** `extractBetweenConstraints` only extracts literal bounds, so the ticket's headline box query (and lamina's) stays a residual over a full scan. The box test is spelled `x >= ? and x <= ? and …`, which extracts fine. Filed as `tickets/plan/between-with-placeholder-bounds-offered-to-modules.md`; docs/module-authoring.md says so in one sentence (remove it when that lands).
- **`col > null` is never offered as a filter** (constraint-extractor.ts declines non-equality `op NULL` on purpose), so the range half of the literal-NULL fold is unreachable from SQL; the test uses `x = null`. The range branch stays as a guard.
- A test double that prices its no-filter baseline the same as its seek trips grow-retrieve's seek-versus-scan veto and lands on the known `bug-declined-push-down-is-rebuilt-as-seek-plus-duplicate-filter` path (a duplicate Filter above the seek; rows still correct). The double now prices an unfiltered request as a full scan.

## Tests added

`packages/quereus/test/vtab/module-seek-filters.spec.ts` (double: `test-module-seek-module.ts` — array-backed, lists every `=`/range filter on configured columns under `_box_` with no descriptor, can handle-but-not-list a column or list nothing, applies constraints with BINARY compare, null ⇒ no match, emits in reverse insertion order, records the last FilterInfo):

- Placeholder box run twice on one prepared statement → correct ids each time; FilterInfo constraints `(x,GE),(x,LE),(y,GE),(y,LE)` and args in that order; idxStr `plan=8` on `_box_`; `accessPath` is `unorderedIndex`; no `Filter` in the plan.
- Handled-but-unlisted `z = 1` → only `x >= 2` delivered, exactly one `Filter`, correct rows; then an empty list → idxStr still names `_box_`, args empty, rows correct.
- Literal NULL in a listed equality → `EmptyResultNode`, `query()` never called.
- NOCASE column listed on the undescribed index → `SeqScan` + `Filter`, no seek, both case variants returned.
- `validateAccessPlan` table: no indexName, non-empty seekColumnIndexes, out-of-range, fractional, repeated, unhandled, multi-value IN, runtime-set IN, OR_RANGE, IS NULL, LIKE — each rejected; single-value IN + `=` and the empty list accepted.
- `idx-str.spec.ts`: `moduleSeek` added to the existing plan-code bijection list.

Verified by throwaway probes, not kept as tests: `x in (?)` with a parameter arrives as one EQ constraint carrying the bound value, re-evaluated per execution; `_primary_` as `indexName` → physical `primary`, `index` access path with role primary, no singleton FD; `monotonicOn` with the unresolvable `_box_` → `unresolvedIndex`.

Inspection only: resolvable index with matching BINARY collations keeps the seek; reversed descriptor → `reverse=1`; `provablyEmpty` checked before dispatch; correlated values governed by the `IndexSeekNode` row-context invariant; index-nested-loop and key-set-seek decline at their `seekColumnIndexes` gates (comments added); `walksOneWindow` leaves `moduleSeek` out (NOTE added).

## Validation

`yarn build` green; `yarn test` green across all workspaces (quereus 11179 passing); `yarn workspace @quereus/quereus run lint` green.

## Known gaps (carried forward)

- The isolation overlay cannot merge a `moduleSeek` read yet: `unorderedIndex` throws INTERNAL, and a resolved-index `moduleSeek` goes through the existing merge, whose window matcher reads several EQs on one column as an IN set rather than a conjunction. Both are the scope of `module-listed-seek-arguments-isolation-overlay`.
- `moduleSeekFiltersProblem` is not exported from the package index; out-of-tree modules get it through `validateAccessPlan`.
- `x between ? and ?` is not offered to modules: `between-with-placeholder-bounds-offered-to-modules` (plan/).

## Review findings

Read the `ticket(implement): module-listed-seek-arguments-planner` diff first, then the handoff; ran lint and the quereus suite.

- **Correctness of the arm** — checked by reading: the shared validity check runs before anything consumes; every return path consumes exactly the listed filters (seek keys, the collation residual, or the empty fold), so `reattachUnconsumedConstraints` re-checks only handled-but-unlisted filters; `provesEmpty` runs before dispatch; a single-value `IN` delivers through `equalitySeekKey` as `EQ`; the singleton-FD exclusion is right for repeated-column keys; `rule-monotonic-range-access` only annotates and tolerates two bounds on one column (both hold, either is valid). No defect found.
- **Ordering-claim interaction (the implementer's extra change)** — confirmed it is needed and correct: every Sort-dropping site in `rule-grow-retrieve` goes through `planDeliversOrdering` → `orderingClaimSurvivesCollation`. It was untested, so added one test (`keeps the Sort when the arm will decline a described index the module claims an order from`): a NOCASE equality on a NOCASE descriptor column, no `honorsCollatedRangeBounds`, order claimed. Verified it fails (`[2, 1]` instead of `[1, 2]`) with the guard disabled and passes with it. The test double gained an optional `descriptor` that also makes the plan claim (but not honour) ascending order on the descriptor's last key column. This also covers the previously untested described-index path through the arm's collation cover.
- **Pre-existing prefix-range inconsistency** the implementer flagged (prefix-range arm applies the range rule to prefix equalities; the ordering check uses the equality lattice) — tried to reproduce with `CollationBlindMemoryModule` (BINARY prefix equality over a NOCASE `(a, b)` index plus a range on `b`); the memory module planned an equality seek and the order was correct. Not reproduced, so recorded as a `NOTE:` tripwire on `orderingClaimSurvivesCollation` rather than a ticket.
- **Rewrites that re-plan a seek leaf** — `index-nested-loop` and `rule-key-set-seek` both admit an `IndexSeekNode` by its `pushedConstraints`; a moduleSeek leaf with listed filters is admitted and re-probed, and the re-probe declines at the `seekColumnIndexes` gate if the module answers with `moduleSeekFilters` again. An empty-list moduleSeek records no pushed constraints and both rules decline it. Safe. Fixed the `pushedConstraints` doc comment in `table-access-nodes.ts`, which claimed an empty array was impossible.
- **Docs** — `docs/module-authoring.md` and `docs/optimizer.md` match the code (validation rules, idxStr shape, collation rule, `unorderedIndex`, BETWEEN caveat). No change needed.
- **Tests** — the implementer's tests each pin a contract (value delivery and order, unlisted re-check, NULL fold, collation decline, validation table); none restate a mock. Kept all; added the one above.
- **Size / hygiene** — `rule-select-access-path.ts` is now 1925 lines (`wc -l`). Added an update to `debt-access-path-seek-selection-is-one-giant-function` (backlog) naming the self-contained module-seek arm as the first piece to move out. Comments in the new code explain reasons, not statements.
- **Error handling / type safety** — malformed lists throw (FORMAT in validation, INTERNAL in the planner, with table name); the dormant `unorderedIndex` case in `IsolatedTable.resolveScanIndex` throws INTERNAL, as the exhaustive switch requires. No `any`. Nothing to change.
- **Performance / resource cleanup** — the arm allocates one map per listed filter at plan time and nothing at run time; `walksOneWindow` NOTE left as is. Nothing found.

Validation: `yarn workspace @quereus/quereus run lint` green; `yarn workspace @quereus/quereus run test` 11180 passing, 26 pending.
