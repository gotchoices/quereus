description: A query over a union returned wrong rows, with no error, when the union's first branch selected the same column twice. Fixed where a projection hands out its column identifiers, so one projection never gives two output columns the same identifier.
architecture: docs/optimizer.md#attribute-provenance
files: packages/quereus/src/planner/util/output-names.ts (uniqueOutputId), packages/quereus/src/planner/nodes/project-node.ts (attributesCache, candidateOutputId), packages/quereus/src/planner/nodes/returning-node.ts (buildAttributes, candidateOutputId), packages/quereus/src/planner/analysis/attribute-provenance.ts (computeAttributeProvenance), packages/quereus/src/planner/nodes/recursive-cte-node.ts (buildAttributes comment), packages/quereus/src/planner/building/with.ts (workingTableAttributes comment), packages/quereus/test/logic/28-set-ops-sort-edge-cases.sqllogic, packages/quereus/test/planner/attribute-provenance.spec.ts, docs/optimizer.md, docs/invariants.md
repro: verified
----
# A projection no longer publishes one column identifier at two output positions

## What was wrong

The planner names each output column by a numeric attribute id, and the runtime finds a column's value by mapping that id to a row slot (`buildRowDescriptor`: last position wins). `ProjectNode` forwarded the source id for every bare column reference, so `select id as x, id as y from A` published one id at two positions. `SetOperationNode` publishes its left branch's ids, so a union whose left branch was that projection had `x` and `y` share an id, and a reader above the union read `y` for `x` on the right branch's rows: `select u.x from (select id as x, id as y from A union all select id as x, a_id as y from B) u` returned `1, 1` instead of `1, 2`.

## What changed (`ticket(implement): bug-join-over-union-reads-first-legs-repeated-column`)

- `uniqueOutputId(published, id)` in `planner/util/output-names.ts`: returns `id` the first time a node publishes it and a fresh id for any repeat.
- `ProjectNode` and `ReturningNode` choose each output id through a `candidateOutputId` helper and pass it through `uniqueOutputId`. `returning new.v, old.v` was a second source of repeats (both references carry one id).
- `computeAttributeProvenance` (used only by the debug plan validator) now throws when one node lists an id twice even if the id is forwarded.
- The recursive-CTE tripwire comment and the `workingTableAttributes` doc in `with.ts` were updated; `docs/optimizer.md` § Attribute provenance and `docs/invariants.md` OPT-014 describe the new rule.
- Tests: two queries in `28-set-ops-sort-edge-cases.sqllogic` (fail before, pass after) and one provenance unit test for the stricter check.
- Filed `debt-plan-validator-fails-across-suite` (backlog): 388 validator rejections that predate this ticket.

## Review findings

- **Diff read first, then handoff.** The restructure of both nodes keeps the old id choice for every non-repeated position (optimizer-supplied id, then `preserveInputColumns: false` minting, then forwarded column reference, then fresh id). No behaviour change outside repeats.
- **Id stability across optimizer rebuilds (main risk checked).** A repeat now gets a fresh id, so a rebuild that recomputed ids would strand references above it. Checked every `new ProjectNode(` in `src/planner/rules` (scalar-cse, fanout-lookup-join, join-elimination, async-gather-zip-by-key, projection-pruning, scalar-agg-decorrelation, subquery-decorrelation, predicate-pushdown, groupby-fd-simplification, materialized-view-rewrite) plus `withChildren`/`withProjections`: all pass the existing node's attributes or attribute ids. No defect.
- **Import cycle.** `output-names.ts` now imports `PlanNode`; `plan-node.ts` imports nothing that reaches `output-names.ts`. No cycle.
- **Ad-hoc queries (script not kept), all correct:** repeated column under `group by`, repeated aggregate (`max(v) x, max(v) y`), recursive CTE with `select id, id` base case (plain and joined on the repeated column), `distinct`, `union` / `intersect` / `except`, a view over the union with filter / group-by / order-by on the repeated column, `returning new.v, old.v` consumed by a CTE, and a correlated subquery over the union.
- **Optimization loss (tripwire).** A predicate on the repeated column's fresh id is no longer pushed below the projection by `canPushAcrossProject`; results are correct. Parked as a `NOTE:` in `rule-predicate-pushdown.ts`.
- **Aggregate builder paths** named in the original ticket: their final projections go through `ProjectNode`, so they are covered; the grouped queries above confirm it.
- **Shared-subtree join throwing in the provenance walk:** only the debug validator calls `computeAttributeProvenance`, so no production path can throw. No action.
- **Tests:** the sqllogic pair reproduces the bug at the lowest layer that shows it; the provenance unit test pins a branch of OPT-014. Kept both, added none.
- **Docs:** read `docs/optimizer.md` (Attribute ID Preservation and Attribute provenance), `docs/invariants.md` OPT-012/014, and `docs/optimizer-fd.md` (projection FDs). They match the code. No other doc describes per-position id forwarding.
- **Validation:** `yarn workspace @quereus/quereus lint` exit 0; `yarn workspace @quereus/quereus test` 11157 passing, 26 pending, 0 failing. `test:store` not run (planner-only change).
- **Major findings / new tickets:** none. The incomplete validator sweep the implementer reported is already tracked by `debt-plan-validator-fails-across-suite`.
