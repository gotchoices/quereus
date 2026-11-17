description: A subquery used as a single value — `(select val from t where …)` — yields null when it finds no row, but the engine told callers it could never be null whenever the selected column was declared not null. It now announces "possibly null" unless the subquery is guaranteed to produce a row.
architecture: docs/types.md#enforcement-quereus_repr_strict
files:
  - packages/quereus/src/planner/analysis/always-yields-row.ts       # alwaysYieldsARow(relation)
  - packages/quereus/src/planner/nodes/subquery.ts                   # ScalarSubqueryNode.getType uses it
  - packages/quereus/src/planner/rules/subquery/rule-scalar-agg-decorrelation.ts  # review: tripwire NOTE
  - packages/quereus/test/announced-result-types.spec.ts             # pin (review added the HAVING case)
  - packages/quereus/test/logic/07.6.1-subquery-extras.sqllogic
  - packages/quereus/test/logic/08.4-key-set-semi-join.sqllogic
  - packages/quereus/test/lens-advertisement.spec.ts
  - packages/quereus/test/lens-put-fanout.spec.ts
  - docs/sql-select.md
  - docs/lens-default-mapper.md
----

# Scalar subqueries announce nullable unless they always produce a row

## What landed

`ScalarSubqueryNode.getType()` returns the subquery's first-column type with `nullable: true` unless that column is already nullable or `alwaysYieldsARow(subquery)` holds. `alwaysYieldsARow` (`planner/analysis/always-yields-row.ts`) is a conservative structural check: it accepts an aggregate with no grouping keys (logical and both physical forms), `SingleRow`, a non-empty `Values`, and the row-preserving wrappers `Project`, `Alias`, `Sort`, `Distinct`, `Cache`, plus `LimitOffset` with limit absent or a constant ≥ 1 and offset absent or the constant 0. Everything else — HAVING (a `Filter` over the aggregate), grouped aggregates, table access, joins, set operations, `insert … returning` — announces nullable.

Fallout handled in the implement pass: a nullable scalar subquery is rejected as a LIMIT/OFFSET at prepare time, so two sqllogic tests now wrap such a LIMIT in `coalesce(…, 0)`; EAV-backed logical lens columns must be declared `null` (documented in `docs/lens-default-mapper.md`, two lens specs updated); `docs/sql-select.md` §3.6 lists the new rejected shape.

## Review findings

Read the `ticket(implement): scalar-subquery-nullability` diff first, then the handoff.

- **Correctness of the accepted shapes.** Checked each wrapper is a `UnaryRelationalNode` with `source` (all are) and that none can drop rows. Checked aggregates carry no internal HAVING (`groupBy` only; HAVING plans as a `Filter`, which is rejected). `constantNumber` truncation: `limit 0.5` truncates to 0 rows and is correctly rejected by the `>= 1` test; `offset 0.5` is rejected though it keeps the first row — conservative, fine. Probed with a throwaway spec (deleted): `(select 1)` non-null; `(select 1 where 1 = 0)`, HAVING, `limit 0`, `limit 1 offset 1`, `union all` all nullable; `limit 1`, `order by`, a derived table over `count(*)` non-null. All as documented.
- **Implementer's deviations.** `Cache` in the accepted list is required (the optimizer's scalar-subquery cache wraps uncorrelated bodies; without it the announcement flips after optimization) — agreed. `LimitOffset` with no limit — correct. The 08.4 `coalesce((insert … returning n), 0)` LIMIT: the key-set row-bound rule declines any limit expression "holding a subquery", and coalesce still holds one, so the test still exercises the gate; the following `count(*) = 1` assertion is what would catch a double write. Kept.
- **Pre/post-optimization disagreement (tripwire).** A correlated `(select count(*) from c where c.fk = o.k)` announces non-null at build time but nullable after `scalar-agg-decorrelation` rewrites it, because the CASE's ELSE column read is typed nullable though it is only read on a match. Pre-existing (not introduced here) and the sound direction; parked as a `NOTE:` in `rule-scalar-agg-decorrelation.ts` at the `valueColRef` construction. Likewise a scalar subquery over a literal `values` list announces nullable after constant folding turns it into a `TableLiteral` — already named in the implement handoff; sound direction, no action.
- **Rewrites replacing `ScalarSubqueryNode`.** Only the scalar-agg decorrelation rule and the scalar-subquery cache rule touch it; the cache rule is covered by `Cache` acceptance, the decorrelation rule by the tripwire above. Nothing else constructs the node outside `building/expression.ts`.
- **Tests.** Implementer's pin is one `it` with three assertions — appropriate. Added one assertion for HAVING (the `Filter`-over-aggregate rejection the module comment calls out as the notable case; the most plausible regression if someone treats `Filter` as row-preserving). No tests cut: the sqllogic/lens edits are required fallout, not new tests.
- **Docs.** `docs/sql-select.md` §3.6 and `docs/lens-default-mapper.md` reflect the change; `docs/types.md` defers nullable-axis enforcement to the egress-check ticket, which is still open — nothing to change there. Grepped docs and READMEs for other `limit (select …)` examples over a filtered NOT NULL column: none.
- **Type safety / hygiene / performance.** Type-only node imports plus `nodeType` switch; casts are narrowed by the switch arm. The recursion is a short wrapper walk per `getType()` call — no caching needed. File is 58 lines. No resource or error-path concerns (pure function).
- **Major findings / tickets filed:** none — no defect found that is reachable now.

## Validation

- `yarn workspace @quereus/quereus test`: 11191 passing, 23 pending, 0 failing.
- `yarn workspace @quereus/quereus lint`: clean.
- Not run: `yarn test:store` (the edited `.sqllogic` files change only SQL text).
