---
description: Let a storage module name exactly which filters it will enforce inside its chosen index and receive their values, in order, when the query runs — so a multi-dimensional index can be handed placeholder bounds such as "x between ? and ? and y between ? and ?". This ticket is the query-planner half; the transaction-overlay half follows.
architecture: docs/module-authoring.md
files:
  - packages/quereus/src/vtab/best-access-plan.ts                           # BestAccessPlanResult.moduleSeekFilters; shared check helper; validateAccessPlan
  - packages/quereus/src/vtab/index-descriptor.ts                           # IndexPlanKind 'moduleSeek'; AccessPath 'unorderedIndex'; accessPathPlan
  - packages/quereus/src/vtab/idx-str.ts                                    # PLAN_CODE_BY_KIND: moduleSeek → 8
  - packages/quereus/src/vtab/filter-info.ts                                # retargetAccessPath: rename an unorderedIndex
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # selectPhysicalNode dispatch; new arm function; buildIndexAccessPath; usesIndexAwarePath / orderingClaimIndexName
  - packages/quereus/src/planner/nodes/table-access-nodes.ts                # IndexSeekNode singleton-FD claim must exclude moduleSeek (around line 640)
  - packages/quereus/src/runtime/emit/scan.ts                               # walksOneWindow — leave moduleSeek out, with a NOTE
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts            # comment only, at the seekColumnIndexes gate (~line 430)
  - packages/quereus/src/planner/rules/access/rule-key-set-seek.ts          # comment only, at the seekColumnIndexes gate (~line 361)
  - packages/quereus-isolation/src/isolated-table.ts                        # resolveScanIndex: compile-only case for the new AccessPath kind (real merge is the next ticket)
  - packages/quereus/test/vtab/test-module-seek-module.ts                   # new test double
  - packages/quereus/test/vtab/module-seek-filters.spec.ts                  # new spec
  - docs/module-authoring.md                                                # new subsection after "Claiming handledFilters — the positional contract"; note in "Naming the chosen index"
  - docs/optimizer.md                                                       # "The access-path seam: FilterInfo.accessPath" — list the new kind and plan
---

# Module-listed seek arguments — planner half

Filed from the lamina board: lamina's multi-dimensional (nD-tree) index answers a box query (`x between ? and ? and y between ? and ?`) in one pass, but today a module can only receive run-time values when its lookup fits one of the engine's fixed seek shapes (all equalities; equalities plus one trailing range; a range on the leading seek column; one `OR_RANGE`). Two range columns fit none of them, and a module that advertises no seek columns lands in the primary-key-only legacy arm, where its own `indexName` never reaches `query()`.

This ticket adds an opt-in, additive contract: the module lists the filters it enforces inside `indexName`, and the engine delivers exactly those values in exactly that order. A module that never sets the field sees no change.

## Contract

```typescript
interface BestAccessPlanResult {
	// …existing fields…
	/**
	 * Module-enforced seek. Indexes into `request.filters` of the filters the module enforces
	 * itself, inside the index named by `indexName`, and whose comparison values it needs at
	 * run time. At query() time `FilterInfo.constraints[k]` names the column and operator of
	 * `request.filters[moduleSeekFilters[k]]` and `FilterInfo.args[k]` carries its value
	 * (argvIndex k + 1). An empty list asks for the module's own scan of `indexName` with no
	 * arguments.
	 */
	moduleSeekFilters?: readonly number[];
}
```

Rules (one shared check, see below):

- Requires `indexName`. Mutually exclusive with a non-empty `seekColumnIndexes`.
- Each entry is an integer in `0..filters.length-1`, no entry repeats, and `handledFilters[entry] === true`.
- The listed filter's op is `=`, `<`, `<=`, `>` or `>=`, or an `IN` whose literal `value` array has exactly one element and which carries no `runtimeSet` (treated as `=`). Multi-value `IN`, `OR_RANGE`, `runtimeSet`, `IS NULL`, `LIKE`, etc. are rejected in this cut.
- The existing `providesOrdering` ⇒ `orderingIndexName === indexName` rule already applies unchanged.

The engine consumes **exactly** the listed filters — no per-column, per-role picking, so the module never has to mirror the engine's first-`=` / first-lower / first-upper picker, and a filter the module did not handle can never become a seek argument (the class of `bug-seek-argument-taken-from-constraint-module-did-not-handle`, avoided by construction for modules using this field). Every other handled filter is reattached above the leaf by `reattachUnconsumedConstraints`, exactly as today.

### Shared check

Add one function in `best-access-plan.ts`, e.g. `moduleSeekFiltersProblem(filters: readonly PredicateConstraint[], result: BestAccessPlanResult): string | undefined`, returning a human-readable reason or `undefined`. `validateAccessPlan` throws `StatusCode.FORMAT` with it. The planner arm calls it too and throws `StatusCode.INTERNAL` with the table name prepended — not every module calls `validateAccessPlan` (the store module does not), and a malformed list is a module bug, which the rule already treats as loud (`createPlanSeqScan`'s reverse-walk check is the precedent). Do not silently degrade to a scan.

## Plan kind, idxStr and access path

- `IndexPlanKind` gains `'moduleSeek'`, plan code **8** (`idx-str.ts` `PLAN_CODE_BY_KIND`; codes 1 and 4 are unused but keep them free). The idxStr is `idx=<indexName>(0);plan=8`, plus `reverse=1` through `withWalkDirection` when a resolved descriptor says so. No other params: the constraints carry column and op.
- `AccessPath` gains `{ kind: 'unorderedIndex'; indexName: string; plan: IndexPlanKind }`: the plan walks a module-named index the engine cannot describe, and **nothing above relies on its emission order**. `accessPathPlan` answers it (like `unresolvedIndex`), and `retargetAccessPath` renames it.
- The moduleSeek arm resolves the access path as follows:
  - `resolveIndexDescriptor` finds the index (module `indexDescriptor`, `_primary_`, or a schema index) → `{ kind: 'index', index, plan: 'moduleSeek' }`.
  - unresolved and the plan claims an order (`providesOrdering` non-empty, or `monotonicOn` set) → `unresolvedIndex` with the existing warning; an order-sensitive consumer must still be able to refuse it.
  - unresolved and no order claimed → `unorderedIndex`, no warning. This is lamina's nD case: an nD-tree's emission order is not expressible as an `IndexDescriptor`.
  Implement by giving `buildIndexAccessPath` a flag (or a sibling function) rather than duplicating it; the other arms keep today's behaviour.

## The arm

A new function — `selectPhysicalNodeFromModuleSeek(tableRef, accessPlan, constraints, filterInfo, providesOrdering, consumed)` — dispatched from `selectPhysicalNode` **before** the `usesIndexAwarePath` choice whenever `accessPlan.moduleSeekFilters !== undefined`. Do not grow `selectPhysicalNodeFromPlan` (see `debt-access-path-seek-selection-is-one-giant-function`); small helpers are welcome.

1. Run the shared check; throw INTERNAL on a problem.
2. `listed = moduleSeekFilters.map(i => constraints[i])`; add every listed constraint to `consumed` (before any return, matching the other arms — every return below consumes them as seek keys, as a collation residual, or by folding to empty).
3. Literal SQL NULL in any listed filter (no dynamic `valueExpr`, plan-time value `null`; for single-value `IN`, its one element) → `createEmptyResultNode`. `isLiteralNullEquality` already reads `value` for non-`IN` ops; rename it (e.g. `isLiteralNullComparison`) if it now serves ranges too. A dynamic value that turns out null at run time reaches the module, which must treat the comparison as false (document it).
4. Collation cover: `classifyCollationCover(listed.map(c => ({ colIdx: c.columnIndex, constraint: c })), /*isEquality*/ false, lookup, honorsCollatedRangeBounds)`. The **range rule** for every listed filter, equalities included: any mismatch declines to `createSeqScan(tableRef)` + the cover residual (the other handled filters are then reattached by `reattachUnconsumedConstraints` as usual). The lookup resolves the index through `resolveIndexKeyCollations(tableSchema, accessPlan, indexName)` and answers that key column's collation, and **`'BINARY'`** for a column the descriptor does not hold or when the index does not resolve at all. Tradeoff, accepted: a NOCASE equality on a NOCASE index column needs `honorsCollatedRangeBounds` here (the equality lattice would not), and a non-BINARY predicate on an undescribed index always declines — a module that wants either describes its index or uses `seekColumnIndexes`.
5. Seek keys, in list order: `=` / single-value `IN` → `equalitySeekKey(scope, c, columnScalarType(...))`; ranges → `c.valueExpr` when it is a single (non-array) expression, else `literalFromValue(scope, c.value, columnType)` — the expression the existing range arms inline four times; factor it into one helper (`rangeSeekKey`) and use it from the existing arms too only if that is a pure move.
6. `FilterInfo.constraints[k] = { constraint: { iColumn: c.columnIndex, op: EQ | opToIndexOp(op), usable: true }, argvIndex: k + 1 }`, built through `makeIndexFilterInfo(filterInfo, tableSchema, accessPlan, accessPlan.indexName, 'moduleSeek', constraints)` with the access-path rule above.
7. Leaf: always an `IndexSeekNode` (also for an empty list — zero seek keys, which the emitter already handles by leaving `args` empty), physical name `'primary'` when `indexName === '_primary_'`, else `indexName`; `isRange` = some listed op is a range op; `providesOrdering`, `accessPlan.cost`, `extractAdvertisement(accessPlan)` as the other arms pass them. `stampSeekProvenance` then records the listed constraints and `orderingLoadBearing`; `reattachUnconsumedConstraints` handles the rest — no change to either.

Also:

- `usesIndexAwarePath` / `orderingClaimIndexName`: a moduleSeek plan's ordering arm is its `indexName` (so `orderingClaimSurvivesCollation` reads the right index). Simplest: `orderingClaimIndexName` returns `accessPlan.indexName` when `moduleSeekFilters` is set (after the existing `orderingIndexName` check).
- `IndexSeekNode` singleton FD (`table-access-nodes.ts` ~line 640): today `!isRange && indexName === 'primary' && seekKeys.length === pk.length && !multiSeek` stamps "at most one row". A moduleSeek listing `a = 1, a = 1` over a two-column primary key would pass that test falsely. Exclude plan `moduleSeek` alongside `multiSeek`.
- `walksOneWindow` (`runtime/emit/scan.ts`): leave `moduleSeek` out; add a `NOTE:` that a moduleSeek is a conjunction and visits a row at most once in both shipped index shapes, so it may be added if the cardinality floor it feeds ever matters for such a module.
- Index-nested-loop (`index-nested-loop.ts` ~430) and key-set-seek (`rule-key-set-seek.ts` ~361) already decline a plan without `seekColumnIndexes`, which a moduleSeek plan always is. Add a one-line comment at each gate saying so (they synthesize their own seek constraints and need the per-column shape). Their `admitSeekLeaf` paths over a moduleSeek **leaf** stay sound: the leaf's `pushedConstraints` record every listed filter.
- `packages/quereus-isolation/src/isolated-table.ts` `resolveScanIndex` has an exhaustive `never` switch, so the new kind is a compile error there. Add a `case 'unorderedIndex':` that throws INTERNAL ("merged read over an index with no describable order is not supported yet"). The prereq-chained `module-listed-seek-arguments-isolation-overlay` replaces it with the real merge; no in-repo module emits this kind, so the gap is dormant.

## Edge cases & interactions

- Both `moduleSeekFilters` and non-empty `seekColumnIndexes`; missing `indexName`; an out-of-range, fractional or repeated entry; an entry whose filter is unhandled; a disallowed op (multi-value `IN`, `OR_RANGE`, `runtimeSet`, `IS NULL`, `LIKE`) — each rejected by the shared check, FORMAT from `validateAccessPlan`, INTERNAL from the rule. Verified by one table-driven test over `validateAccessPlan` (the rule's throw is the same function; inspection).
- Empty list → `IndexSeekNode` with no keys, idxStr `plan=8` naming the index, every handled filter reattached. Test (folded into the listed-vs-unlisted test).
- Listed vs unlisted handled filters: only unlisted ones appear in a `Filter` above the seek. Test.
- Two listed filters on one column (`x >= ? and x <= ?`) → two constraints with the same `iColumn`, two args. Covered by the box test.
- Literal NULL in a listed equality **or** range → `EmptyResultNode`. Test. Dynamic NULL → reaches the module as a null arg. Inspection plus the doc sentence.
- Single-value `in (?)` with a parameter (array `valueExpr` of length 1) → seek key is the parameter expression, op EQ. Inspection (shared `equalitySeekKey`).
- Placeholder values are evaluated per execution: re-running a prepared statement with new parameters returns the new box. Covered by the box test.
- Collation: a NOCASE column predicate on an undescribed index → declines to a full scan with the listed filters as residual, correct rows. Test. A described index with matching BINARY collations → seek kept. Inspection.
- `provablyEmpty` still wins (checked before dispatch). Inspection.
- `providesOrdering` / `monotonicOn` with an unresolvable index → `unresolvedIndex` + warning; without either → `unorderedIndex`, no warning; resolvable → `index`. A reversed descriptor → `reverse=1` in idxStr. Verified by assertions in the box test on `accessPath.kind`; the others by inspection.
- `_primary_` as `indexName` → descriptor role primary, physical name `primary`, no singleton FD claim. Inspection.
- Correlated value expressions (a listed filter whose value references an outer row) → the `IndexSeekNode` constructor's existing row-context invariant applies. Inspection.
- grow-retrieve's limit-truncation licence: listed filters are handled filters, so nothing changes. Inspection.
- In-tree modules (memory, store) never set the field and never see plan code 8; `yarn test` must stay green unchanged.

## Tests

New test double `packages/quereus/test/vtab/test-module-seek-module.ts`, modelled on `test-aliased-index-module.ts`: array-backed rows; `getBestAccessPlan` handles every `=`/range filter on a configurable set of columns, lists them (in `request.filters` order) as `moduleSeekFilters` on a minted `indexName` (e.g. `_box_`) with no descriptor, and can be told to also handle-but-not-list a filter or to list nothing; calls `validateAccessPlan`; `query()` asserts it got `plan=8` on `_box_`, applies `constraints[k]` with `args[k]` (null ⇒ no match), emits in an order that is not primary-key order (e.g. reverse insertion), and records the last `FilterInfo` for assertions.

New spec `packages/quereus/test/vtab/module-seek-filters.spec.ts`, one test per behaviour:

- Box with placeholders: `select id from t where x between ? and ? and y between ? and ? order by id`, run twice with different parameters → correct ids each time; the recorded FilterInfo has four constraints `(x,GE),(x,LE),(y,GE),(y,LE)` and args in that order; the plan has no `Filter` above the seek; `accessPath.kind === 'unorderedIndex'`.
- Listed vs unlisted: the module handles `z = 1` without listing it → plan shows a `Filter` for `z` only; and with an empty list → idxStr still names `_box_`, args empty, rows correct.
- Literal null: `where x > null and y < 5` → `EmptyResult` in the plan, the module's `query()` never called.
- Collation decline: a NOCASE text column listed with `name = 'bob'` → full scan + residual, rows correct (both case variants matched under NOCASE as the predicate says).
- `validateAccessPlan` rejections: table-driven over the rule list above.

## TODO

- Add `moduleSeekFilters` to `BestAccessPlanResult` with its doc comment; add the shared check and call it from `validateAccessPlan`.
- Add `'moduleSeek'` (code 8) to `IndexPlanKind` / `PLAN_CODE_BY_KIND`; add the `unorderedIndex` `AccessPath` kind; update `accessPathPlan` and `retargetAccessPath`.
- Implement `selectPhysicalNodeFromModuleSeek` and dispatch it from `selectPhysicalNode`; extend `buildIndexAccessPath` for the unordered case; update `orderingClaimIndexName`.
- Exclude `moduleSeek` from the `IndexSeekNode` singleton FD; add the `walksOneWindow` NOTE; add the gate comments in index-nested-loop and key-set-seek.
- Add the compile-only `unorderedIndex` case in `IsolatedTable.resolveScanIndex`.
- Write the test double and spec above.
- Docs: in `docs/module-authoring.md` add a subsection "Module-listed seek arguments — `moduleSeekFilters`" right after "Claiming `handledFilters` — the positional contract" (contract, rules, what `query()` receives, plan code 8, null semantics, collation rule incl. BINARY-when-undescribed, mutually exclusive with `seekColumnIndexes`, declined by index-nested-loop and key-set-seek, ordered plans need a resolvable index or a descriptor), and a sentence in "Naming the chosen index" on `unorderedIndex`. In `docs/optimizer.md` "The access-path seam" list the new kind and plan.
- `yarn build`, `yarn test`, `yarn lint` (quereus) green.
