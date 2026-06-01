description: Planner consumer for the access-shape facet of a mapping advertisement — during path selection, consult an auxiliary-access advertisement's `AccessShape.served` (equality / range / prefix / contains / intersects / knn, extensible) so an exotic access path (nd-tree spatial, vector-similarity, full-text, time-series prefix) can serve a logical query whose predicate matches a form it advertises. The motivating case is an nd-tree backing a spatial logical table alongside a column-store primary decomposition. Reads `LensSlot.auxiliaryAccess` (stored by `lens-module-mapping-advertisement`); routes the matched predicate forms into `getBestAccessPlan` path selection.
prereq: lens-module-mapping-advertisement
files: packages/quereus/src/vtab/best-access-plan.ts, packages/quereus/src/vtab/mapping-advertisement.ts, packages/quereus/src/schema/lens.ts, packages/quereus/src/planner/rules/access
----

## Use case

`lens-module-mapping-advertisement` defines and stores the **access-shape** facet (`AccessShape.served`: which predicate forms a decomposition serves efficiently over which columns/coordinate tuple) but builds **no planner consumer** — only the storage-shape facet (write fan-out) has an immediate consumer (`lens-multi-source-decomposition`). This ticket builds the read-path consumer.

A logical `Spatial` table can be simultaneously backed by a column-store primary decomposition (storage), an nd-tree (spatial access), and covering MVs (constraint/index access). The lens compiler routes writes to the primary decomposition's fan-out (the storage-shape consumer) and must **select read access paths per query from the union of advertised access shapes** (this ticket): a `where st_contains(region, point)` query should choose the nd-tree's `contains` form; an equi-lookup on the surrogate should choose the column-store's `equality` form.

## What needs to be designed

- How `AccessShape.served` forms map onto the existing access-planning surface (`ConstraintOp` / `getBestAccessPlan` in `best-access-plan.ts`) — `equality`/`range` map cleanly to `=`/`>`/`<`; `prefix`/`contains`/`intersects`/`knn` need either new `ConstraintOp` members or a parallel advertised-form channel the planner consults during path selection.
- How the planner enumerates candidate access paths from `LensSlot.auxiliaryAccess` for a logical-table reference and costs them against the storage decomposition's own access forms.
- The extensible-vocabulary contract: `AccessForm` is open (`string & {}`); the planner must degrade gracefully (ignore a form it has no matcher for) rather than reject, so vector-similarity / full-text modules land without a planner change.
- The `lens.no-answering-structure` advisory interaction: a declared `quereus.lens.access.<col>` expectation with no advertised access shape serving it is exactly the warning `lens-prover-and-attachment` emits — this consumer is what makes an advertised access shape *answer* it.

## Test vehicle (the former backlog blocker, now resolved)

This was parked pending "a concrete exotic-access module (nd-tree) to test against." That gate is gone: the multi-source decomposition foundation has **landed** (`lens-multi-source-{get-synthesis,put-fanout,put-insert-fanout,ind-injection}`, all complete), and a real exotic module is **not** needed to exercise the consumer — a **synthetic test fixture** suffices and is idiomatic here.

- `AccessForm` is an open union (`… | (string & {})`), so a fixture advertises exotic forms with no engine change.
- Follow the existing synthetic-vtab pattern (`test/vtab/test-query-module.ts`, `test-ordinal-seek-module.ts`, `test-monotonic-decline-module.ts`): add e.g. `test/vtab/test-nd-tree-module.ts` whose `getMappingAdvertisements` returns a `MappingAdvertisement` with `access: { served: [{ columns: ['coord'], forms: ['contains','knn','intersects'] }] }` over a trivial in-memory backing, plus an `equality`-serving column-store fixture for the dual-decomposition routing case.
- Plan scope: settle the design questions above (form→`ConstraintOp` mapping vs. parallel advertised-form channel; candidate enumeration from `LensSlot.auxiliaryAccess`; cost integration; graceful degrade on unknown forms), specify the synthetic fixtures as the test bed, then emit implement ticket(s). The read-path optimization sits over an already-correct foundation (a spatial query currently scans), so it is non-regressing by construction.
