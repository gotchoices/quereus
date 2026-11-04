description: Nothing in the test suite checks that a query using an index returns the same rows as the same query without one, so index bugs that silently drop rows are only found by luck. Add a randomized test that compares the two.
architecture: docs/memory-table.md
files:
  - packages/quereus/test/property-planner.spec.ts
  - packages/quereus/test/fuzz.spec.ts
  - packages/quereus/src/vtab/memory/layer/scan-layer.ts
  - packages/quereus-store/src/common/store-table-scan.ts
difficulty: medium
tradeoffs: The individual bugs found so far are fixed and pinned by hand-written cases, and this test adds run time to every suite run, so a maintainer could reasonably rank it below feature work until another seek bug appears.
----

An index must never change a query's answer, only how fast it arrives. The rule to test: for any key shape, any rows and any predicate an index can serve, the indexed query and the same query on an unindexed copy of the table return the same rows.

Today nothing checks this. `property-planner.spec.ts` and `fuzz.spec.ts` compare optimizer behaviour and generate `order by` directions, but neither ever creates an index, so they never reach a seek on a compound key. Only hand-written sqllogic cases exercise seeks, and each covers the shapes its author thought of.

## Evidence

`bug-prefix-range-seek-skips-rows-on-desc-trailing-column` returned wrong rows on the memory backend for `k = 'a' and r > 1` over `(k, r desc)`, and no existing test noticed. While fixing it, a throwaway check of this rule ran 35,400 queries over 12 key shapes against an unindexed copy. It found no differences on the fixed code, and 4,330 wrong queries when the direction was deliberately read from column 0 instead of the bound column. That check was not committed. `test/vtab/scan-layer-descending.spec.ts` pins an earlier bug in the same seek-direction logic.

## Expected behaviour

The test generates, with the `fast-check` setup these two spec files already use:

- **Key shapes:** primary keys and secondary indexes of one to three columns, each ascending or descending, with nullable columns and at least one non-binary collation.
- **Rows:** values with duplicates and NULLs in the key columns, and groups that sort on both sides of the queried prefix.
- **Predicates:** equality on the leading columns, optionally followed by one or two range bounds on the next column, with bound values that are absent from the data and equal to stored values. Bounds are supplied as parameters too.

It compares the two result sets without regard to row order, and a failure reports the schema, rows and query. It runs on the memory backend, inside and outside an open transaction, and on the store backend through the existing store test mode.

A generated key shape that the planner does not serve with an index proves nothing, so the test must confirm through `query_plan` that a seek is actually used for the shapes it means to cover.
