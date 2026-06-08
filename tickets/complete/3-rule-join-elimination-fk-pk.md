---
description: FK→PK join-elimination optimizer rule — completed (review pass closed one major correctness bug).
files:
  - packages/quereus/src/planner/rules/join/rule-join-elimination.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/test/optimizer/rule-join-elimination.spec.ts
  - packages/quereus/test/logic/11-joins.sqllogic
  - docs/optimizer.md
  - docs/architecture.md
---

## What landed

`ruleJoinElimination` — a Structural-pass rule (priority 24, between `groupby-fd-simplification` at 23 and `subquery-decorrelation` at 25) that fires on `ProjectNode`, walks down through a whitelist of pass-through nodes (`Filter`/`Sort`/`LimitOffset`/`Distinct`/`Alias`) collecting the set of attribute IDs demanded above the join, then drops the join when:

1. `joinType ∈ {left, right, inner}` and the ON-clause is AND-of-column-equalities,
2. the demanded set never touches the non-preserved side,
3. `checkFkPkAlignment` proves the preserved side is the FK side and the eliminated side is its PK target, and
4. (INNER only) every FK column is `NOT NULL` **and** the eliminable side is a row-preserving path to its base table.

The eliminated side is replaced with the preserved side; the pass-through chain above the join is rebuilt bottom-up. `ProjectNode.preserveInputColumns` and original attribute IDs are preserved so callers' bindings survive.

## Usage / triggers

Most commonly fires on views that join a parent table for FK-side selects the outer caller never references. Examples:

```sql
-- LEFT JOIN elimination (right side unused)
SELECT order_id, total FROM orders LEFT JOIN customers ON orders.customer_id = customers.id;

-- INNER JOIN elimination (NOT NULL FK + bare PK side)
SELECT order_id FROM orders JOIN customers ON orders.customer_id = customers.id;

-- View-based elimination
CREATE VIEW order_view AS
  SELECT o.order_id, o.total, c.name AS cust_name
  FROM orders o LEFT JOIN customers c ON o.customer_id = c.id;
SELECT order_id, total FROM order_view;  -- join drops out
```

`SELECT * FROM query_plan(?)` should show no rows with `op IN ('JOIN','HASHJOIN','MERGEJOIN','NESTEDLOOPJOIN','BLOOMJOIN','ASOFSCAN')` for these. If a right-side column appears in the projection (or in a `WHERE`/`ORDER BY` above the join), the join survives.

## Testing notes

- `yarn workspace @quereus/quereus run test` — **2839 passing**, 0 failing (12 specs in `rule-join-elimination.spec.ts` covering the happy paths plus the new adversarial cases from review).
- `yarn workspace @quereus/quereus run lint` — clean.
- `test/logic/11-joins.sqllogic` block exercises result equality across LEFT, INNER, and view-based eliminations.

## Review findings

### What was checked

1. **Correctness — row-count preservation under each join type.** Built and exercised adversarial queries that introduce row-reducing wrappers between the join and the PK side: filtered subquery (`JOIN (SELECT … WHERE region='EU') c`), `LIMIT` subquery, and `WHERE` on the PK side. Verified both produced output and the `query_plan(?)` ops.
2. **Pass-through chain whitelist completeness** — confirmed `Filter`/`Sort`/`LimitOffset`/`Distinct`/`Alias` are the only nodes whose `getAttributes()` is a strict superset of demand and that any other node (Project, Aggregate, Window, CTE, Set) bails the walker.
3. **`isAndOfColumnEqualities`** — traced `normalizePredicate` output (binary tree, flattened AND/OR) and verified the stack walk rejects every non-`colRef=colRef` conjunct, including a single equality (no AND wrapper) and nested mixed predicates.
4. **Constructor signatures** in `rebuildChain` / `rebuildProject` against `FilterNode`/`SortNode`/`LimitOffsetNode`/`DistinctNode`/`AliasNode`/`ProjectNode` — all match. `ProjectNode` rebuild preserves attribute IDs via the `predefinedAttributes` slot and carries `preserveInputColumns`.
5. **`extractTableSchema` walks through arbitrary single-child wrappers** — fine for *schema* lookup (the underlying table identity is unchanged), but combined with cardinality-altering wrappers became the bug below.
6. **FK NOT NULL** — `ColumnSchema.notNull` is the canonical field, and `createDefaultColumnSchema` defaults to `true` (Third Manifesto). The rule's check at `fkSchema.columns[colIdx]?.notNull` is correct.
7. **Interaction with `rulePredicatePushdown`** — pushdown explicitly does NOT cross `JoinNode` (`Non-moves: Across Aggregate/Window/Join`), so a `WHERE customers.region='EU'` above the join stays above the join, keeps `usesRight=true`, and the rule correctly bails.
8. **Docs** — `docs/optimizer.md` join-rule entry and `docs/architecture.md` federation cross-link updated to reflect the new constraint.
9. **Lint + tests** — both clean.

### What was found

- **Major (fixed in this pass): INNER-JOIN elimination produced wrong row counts when the PK side had a row-reducing wrapper.** The original `tryEliminate` consulted `extractTableSchema`, which duck-walks through `Filter`/`Project`/etc. to find the schema. For LEFT JOIN that's harmless (preserved side keeps all its rows regardless). For INNER JOIN it silently dropped any `Filter`/`Limit`/`Distinct` on the PK side, surviving FK rows whose PK match would have been filtered out. Failing adversarial cases:
  - `SELECT order_id FROM orders JOIN (SELECT id FROM customers WHERE region='EU') c ON orders.customer_id = c.id` returned 3 rows instead of 2.
  - `SELECT order_id FROM orders JOIN (SELECT id FROM customers ORDER BY id LIMIT 1) c ON orders.customer_id = c.id` returned 3 rows instead of 2.

  Fix: added `isRowPreservingPathToTable` guard that requires the eliminable side to walk only through `TableReferenceNode` / `RetrieveNode` (whose pipeline is a bare table reference) / `AliasNode` / `SortNode`. `ProjectNode` is deliberately excluded — it may reorder/drop columns, which would invalidate the table-column-index → attribute-index assumption `checkFkPkAlignment` makes.

  Coverage added to `rule-join-elimination.spec.ts`:
  - "does NOT eliminate INNER JOIN when PK side has a row-reducing wrapper (Filter)"
  - "does NOT eliminate INNER JOIN when PK side has a LimitOffset wrapper"
  - "LEFT JOIN with row-reducing wrapper on non-preserved side is still safely eliminated" (positive control)

- **Minor (not fixed): DRY** — `findMatchingForeignKey` duplicates the iteration logic of `checkFkPkAlignment`. Acceptable for v1: `checkFkPkAlignment` returns `boolean`, and refactoring it to optionally return the matched FK row would touch `ruleJoinKeyInference` and `analyzeJoinKeyCoverage` for a thin DRY win. Leaving as-is.

- **Not bugs:** the right-join branch is symmetric (verified on paper, not exercised because `11-joins.sqllogic` marks RIGHT JOIN as not-supported-yet); `ForeignKeyConstraintSchema` has no `enforced` flag today (ticket-level note carried forward); DISTINCT in the pass-through chain is safe because the at-most-one-match guarantee means the join couldn't have produced duplicates the DISTINCT would collapse.

### Empty categories

- **Resource cleanup / async handling:** N/A — rule is pure-functional plan rewriting, no resources held.
- **Performance:** N/A — the rule is single-pass and short-circuits aggressively; cost is dominated by the existing `checkFkPkAlignment` call which is unchanged.
- **Security:** N/A — no user-input handling, no I/O.

## Out-of-scope deferrals (carried forward from implement)

- Eliminating joins under an `AggregateNode` (needs aggregate-aware demanded-set walking).
- Cascading elimination across multiple stacked joins (relies on the structural pass re-iterating; single-pass / single-elimination is the v1 contract).
- Eliminating below other boundaries (`Window`, `Aggregate`, CTE references) — only `ProjectNode`-rooted chains are in scope.
- Allowing `Project` on the eliminable side (would require checking that the projection is a 1-1 attribute identity, or attribute-id-based FK alignment instead of column-index-based).
