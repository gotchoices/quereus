description: When the planner knows nothing about table sizes, it now prices an unmeasured table at the same 1000-row default everything else uses, and remembers that a filter has already narrowed the other side, so a filtered or single-row side joined to an indexed table looks that table up by key instead of reading all of it.
architecture: docs/progressive-optimizer.md#1-design-principles
files: packages/quereus/src/planner/framework/trace.ts, packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts, packages/quereus/src/planner/rules/join/rule-quickpick-enumeration.ts, packages/quereus/src/planner/util/relative-rows.ts, packages/quereus/src/planner/util/row-estimates.ts, packages/quereus/src/planner/rules/join/rule-join-physical-selection.ts, packages/quereus/src/planner/rules/join/rule-monotonic-merge-join.ts, packages/quereus/src/planner/rules/access/rule-key-set-seek.ts, packages/quereus/src/planner/nodes/filter.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/test/optimizer/index-nested-loop.spec.ts, packages/quereus/test/optimizer/cardinality-feedback.spec.ts, packages/quereus/test/optimizer/index-seek-row-estimates.spec.ts, packages/quereus/test/optimizer/key-set-seek.spec.ts, packages/quereus/test/plan/joins/simple-join.plan.json, packages/quereus/test/plan/aggregates/group-by.plan.json, packages/quereus/bench/reference/execution.json, docs/optimizer-joins.md, docs/optimizer-costing.md, docs/progressive-optimizer.md
----

# With no statistics, joins scan tables they could seek — complete

Join selection (`rule-join-physical-selection`) and the monotonic merge-join cost gate no longer price an unmeasured join side at a flat 100 rows. A side nobody measured is priced relatively (`planner/util/relative-rows.ts`): its unknown leaf starts at `tuning.defaultRowEstimate` (1000, the same no-statistics default the rest of the planner uses), narrowed by the filters, joins and aggregates above it through their own shared formulas. A filtered or single-row side joined to an indexed, never-analyzed table now seeks that table by key instead of hashing over a full scan of it. The recorded plan estimate stays `undefined`, so gates that refuse on an unknown size still refuse. Implementation: `ticket(implement): unknown-size-join-scans-instead-of-seeking`.

Shared formula extracted: `filterRowsFrom` in `row-estimates.ts` (used by `FilterNode`'s getter, its `computePhysical`, and the walker); aggregates' `rowsFrom` made public for the walker. Goldens `joins/simple-join` and `aggregates/group-by` now seek `departments` by primary key; `execution/join-1kx1k` bench re-baselined. New specs in `test/optimizer/index-nested-loop.spec.ts` ("index-nested-loop over never-analyzed tables") cover the primary-key inner under a filtered outer (inner + left join), the filter below another join, and the secondary-index inner under a single-row outer.

`cardinality-feedback-rows-per-key` (plan/) depends on this.

## Review findings

Checked: the implement diff in full (source, tests, goldens' shape, docs); `relayedRows` branches against `FilterNode.computePhysical`, `joinPhysicalRows`/`estimateJoinRows` and the aggregate `rowsFrom`s; `rowsRead`'s changed unknown-leaf fallback (leaf default rather than the side's filtered count — correct, a Filter pulls every scanned row); measured-0 flooring through `costedRows`; the docs' quoted costs (hash 100×0.8 + 1000×0.4 = 480 vs index-NL 180) against `hashJoinCost`; every doc the change touches (`optimizer-joins.md`, `optimizer-costing.md`, `progressive-optimizer.md`) reads consistently with the code.

Validation: `yarn lint` (packages/quereus) exit 0; full quereus suite without `--bail` (`mocha 'packages/quereus/test/**/*.spec.ts'`) 10,849 passing, 25 pending, 0 failing. `yarn test:store` and `yarn bench:gate` not re-run — this pass changed only debug log format strings and a comment after the implementer's bench gate passed.

Fixed inline (minor):
- Remaining debug-log `%.2f` tokens (the `debug` package has no precision formatter, so the token prints verbatim and arguments shift) changed to `%d` in `planner/framework/trace.ts` (two perf lines), `rules/aggregate/rule-aggregate-streaming.ts`, and `rules/join/rule-quickpick-enumeration.ts` — the implementer flagged the quickpick one; the sweep found the other three.

Tripwires parked:
- `relayedRows` is recursive while the codebase converted `PlanNode.physical` and friends to iterative walks to survive ~30,000-deep plans. It only descends through nodes with no known count, so real SQL cannot reach that depth; `NOTE:` at `planner/util/relative-rows.ts` names the worklist conversion if deep generated plans ever hit join selection with unknown leaves.
- Key-set seek not being a priced candidate (implementer's `NOTE:` in `rule-key-set-seek.ts`): agreed it is conditional, not a ticket — under the relative estimates the index-NL semi join seeking a 1000-row key source per filtered target row is the cheaper plan; it is only wrong when an unmeasured key source is actually small. Left as is.
- Monotonic merge-join gate not pricing index-NL (implementer's `NOTE:` in `rule-monotonic-merge-join.ts`): agreed conditional; left as is.

Considered, no action:
- Hash cost for semi/left joins assuming the cheaper build side — pre-existing and not changed by this ticket; the larger default makes the optimism matter more only for a large unknown right side. Not filed: no current-release anchor and no observed wrong plan.
- Relative estimate not re-deriving join key coverage — the figure is only compared, never recorded; accepted per the fix ticket.
- Node self-costs still reading `estimatedRows ?? 100` (`join-node.ts`, `bloom-join-node.ts`, `merge-join-node.ts`, `key-set-semi-join-node.ts`, `asof-scan-node.ts`) — already owned by `debt-node-self-cost-reads-the-blank-estimate`.
- Walk cost: each join selection walks its side's unknown subtree a few times (`sideRows` per side plus `rowsRead`), quadratic only in join count with every leaf unknown; `.physical` is cached per node, so each step is cheap. No measurement suggests a problem; not recorded further.

Tests: the three new specs each pin a distinct case named by the fix ticket (primary-key inner under a filter, filter beneath another join, secondary index under a single row) — kept. The four adjusted specs (`cardinality-feedback`, `index-seek-row-estimates`, `key-set-seek`, the orientation comment) were re-read: each change keeps the spec testing its own subject by measuring the side whose size it presumes, rather than loosening an assertion. No tests added or cut.
