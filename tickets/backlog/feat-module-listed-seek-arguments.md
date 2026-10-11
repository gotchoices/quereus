---
description: A storage module can only receive query values at run time when its lookup fits one of a few fixed shapes (all equalities, or equalities plus one range), so a multi-dimensional index cannot be handed placeholder bounds like "x between ? and ? and y between ? and ?" — and a module that plans its own index scan without fitting a shape is not run through that index at all. Let a module name exactly which filters it will enforce inside its chosen index and receive their values in order.
files:
  - packages/quereus/src/vtab/best-access-plan.ts                           # BestAccessPlanResult — new field; validateAccessPlan rules for it
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts   # selectPhysicalNode — new arm ahead of selectPhysicalNodeFromPlan / selectPhysicalNodeLegacy; reattachUnconsumedConstraints; stampSeekProvenance
  - packages/quereus/src/vtab/filter-info.ts                                # idxStr plan code / AccessPath for the new arm
  - packages/quereus-isolation/src/isolated-table.ts                        # resolveScanIndex; window matcher for staged rows; merge of a stream with no describable order
  - packages/quereus/src/planner/rules/join/index-nested-loop.ts            # and rule-key-set-seek: decline (or support) a plan carrying the new field
  - docs/module-authoring.md                                                # "Claiming handledFilters — the positional contract"; "Naming the chosen index"
tradeoffs: The only module that needs it today is lamina's multi-dimensional (nD-tree) index, whose SQL read path is itself not switched on yet, and the change adds a fifth seek arm plus isolation-overlay work to the most correctness-sensitive rule in the planner — a maintainer may reasonably wait until that index is reachable from SQL.
---

# Module-listed seek arguments

Filed from the lamina board (`feat-late-bound-nd-scan-seek-keys`, plan stage); lamina is the module that needs it. Lamina-side consumer: `debt-nd-scan-engine-dispatch` on the lamina board.

## What a module can express today

A module's `getBestAccessPlan` answers with `indexName`, `seekColumnIndexes` and `handledFilters`. `selectPhysicalNodeFromPlan` (`rule-select-access-path.ts`) then infers the seek from the constraints present on the advertised columns, and only these shapes deliver argument values to `query()`:

- every advertised column has an equality (`=`, or an `IN`);
- an equality prefix plus **one** trailing range column (first lower and first upper bound);
- a range on the **leading** advertised column only;
- one `OR_RANGE` column.

A module with no `seekColumnIndexes` goes to `selectPhysicalNodeLegacy`, which reasons only about the primary key: a primary-key equality or leading-column range seek on `_primary_`, an ordering-only walk named by `orderingIndexName ?? 'primary'`, or a sequential scan with the `fullscan` idxStr. In none of those arms does the module's own `indexName` reach `query()` unless it is the ordering index.

## Why that is not enough for a multi-dimensional index

Lamina's nD-tree index answers a box query — `x between ? and ? and y between ? and ?` — in one pass by pruning on every dimension at once. That is two range columns; no arm above carries ranges on two columns, so the module cannot receive the four values. Lamina therefore keeps every placeholder comparison out of its nD plan and the engine filters above a much wider scan.

A related problem shows up with no placeholders at all. An nD plan advertises no seek columns (there is no shape to pick), so it lands in the legacy arm:

- **filter-only plan** → sequential scan with the `fullscan` idxStr; the module never learns it chose its nD index and scans the whole table (correct, since every handled filter is reattached, but the index is never used);
- **plan claiming handled bounds on the leading primary-key column** → a primary-key range seek that *consumes* those bounds; a module that does not implement `_primary_` range seeks of its own answers with the wrong rows;
- **ordered plan** → an ordering-only walk named `primary` unless the module also sets `orderingIndexName`.

## Proposed contract (a default for the plan stage to accept or edit)

```typescript
interface BestAccessPlanResult {
  // …existing fields…
  /** Module-enforced seek. Indexes into `request.filters` of the filters the module
   *  enforces itself, inside the index named by `indexName`, and whose comparison
   *  values it needs at run time. `FilterInfo.args[k]` carries the value of
   *  `request.filters[moduleSeekFilters[k]]`; `FilterInfo.constraints[k]` its column
   *  and op. An empty list asks for the module's own scan of `indexName` with no
   *  arguments. */
  moduleSeekFilters?: readonly number[];
}
```

Rules:

- Requires `indexName`. Mutually exclusive with `seekColumnIndexes` (`validateAccessPlan` rejects both together).
- Every listed index must also be `handledFilters[i] === true`, and its op must be `=`, `<`, `<=`, `>` or `>=` (a single-value `IN` may be allowed as `=`). Multi-value `IN`, `OR_RANGE` and `runtimeSet` filters are rejected in the first cut.
- The engine consumes **exactly** the listed filters — no positional per-column, per-role picking. Any other handled filter is reattached as a residual, as today. This removes the need for a module to mirror the engine's first-`=` / first-lower / first-upper picker.
- A listed filter whose value is a literal SQL NULL folds to `EmptyResult`, as the other arms do. A dynamic null reaches the module, which must treat the comparison as false.
- Seek keys are the listed filters' value expressions (`valueExpr` when dynamic, a literal otherwise), evaluated per execution like the existing arms.
- `providesOrdering` is honoured with the leaf named by `indexName`.
- The idxStr carries `indexName` and a plan code distinct from the existing ones, so the module can tell this arm apart.
- Collation cover: run the range rule (decline to scan + residual on any mismatch) over the listed filters, resolving index collations through the module's `indexDescriptor` (see `bug-index-collation-lookup-ignores-module-descriptor`) and BINARY where it is silent.
- Index-nested-loop and key-set-seek synthesize their own constraints; they decline a plan carrying `moduleSeekFilters` unless the plan stage decides to support it.

## Isolation overlay

`IsolatedTable` must merge staged rows into such a scan:

- Staged rows are matched against every listed constraint (a conjunction of single-column comparisons), the same way the existing window matchers work.
- When the scan has a describable order (`providesOrdering` plus an `indexDescriptor`), merge in that order as today.
- When it has none — a filter-only nD scan emits in an order that no `IndexDescriptor` can state — the overlay still has to merge: for example, drop underlying rows whose primary key the overlay shadows and append the matching overlay rows. Today such a plan reaches `resolveScanIndex` as `unresolvedIndex` and throws.

## What happens if we do nothing

Lamina's nD index stays limited to literal bounds, and a lamina-only workaround has to advertise one dimension as a seek column and mirror the engine's per-column picker, so that one dimension at most can take placeholders. The workaround is described in the lamina ticket; it is strictly narrower and adds engine-mirroring code there.

## Reversibility

Additive and opt-in: a module that never sets the field sees no change.
