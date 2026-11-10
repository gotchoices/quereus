description: On the persistent storage backend, a query that fixes only the first part of a multi-column primary key (for example every line of one order, keyed by order and line number) reads the whole table instead of jumping to the matching rows.
architecture: docs/module-authoring.md
files: packages/quereus-store/src/common/store-module-access-plan.ts (`computeFilterAccessPlan`, `resolvePrimaryKeyPins`, `leadingPkRangePlan`, `NO_PINNED_COLUMNS`), packages/quereus-store/src/common/store-table-scan.ts (`analyzePKAccess`, `buildPKRangeBounds`, `encodePkPrefixBounds`), packages/quereus/src/planner/rules/access/rule-select-access-path.ts (index-aware `_primary_` path)
tradeoffs: Correct answers are already returned and a secondary index on the leading column works around it, so a maintainer may wait until a composite-key store table is measured scanning on a prefix lookup.
----

Found statically while planning `store-access-plan-reads-predicate-collation`; not run.

For `create table t (a integer, b integer, v text, primary key (a, b)) using store`, the predicate `where a = 1` gets a full sequential scan with a residual Filter. Reading `computeFilterAccessPlan`:

- `resolvePrimaryKeyPins` returns null unless every primary-key member is pinned by an equality, so neither the point-lookup arm nor the `_primary_` multi-seek arm applies.
- `leadingPkRangePlan` requires a range operator (`>`, `>=`, `<`, `<=`) on the leading member, so an equality does not qualify.
- With no secondary index, the result is `scanPlan`, which claims no filters.

The data store is ordered by the encoded primary key, so the rows with `a = 1` are one contiguous byte window. The scan layer already builds per-value windows of exactly that shape (`encodePkPrefixBounds`, used by `buildPKRangeBounds`). Expected: a leading-prefix equality on the primary key (`a = ?`, and `a = ? and b > ?` on a three-member key) is served as a `_primary_` prefix window, claimed positionally like the secondary index's `eq` / `prefixRange` arms. It should also claim the primary-key ordering on the remaining members, so `where a = ? order by b` needs no Sort.

The same gates apply as for every other arm: the predicate's `PredicateConstraint.collation` must refine the member's collation, the key-byte order-safety gates for any trailing bound, the semantic-ordering type handling, and NULL ordering for nullable DESC members. Confirm by checking `query_plan` output for the query above on a store table.
