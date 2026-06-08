---
description: Optimizer rule that drops GROUP BY columns functionally determined by other GROUP BY columns under aggregate-output FDs / ECs. Picker MIN() aggregates re-emit dropped columns so output attribute IDs survive.
files:
  - packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts
  - packages/quereus/src/planner/optimizer.ts
  - packages/quereus/src/planner/nodes/retrieve-node.ts
  - packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts
  - packages/quereus/test/logic/07-aggregates.sqllogic
  - packages/quereus/test/logic/109-aggregate-physical-selection.sqllogic
  - packages/quereus/test/plan/aggregate-physical-selection.spec.ts
  - docs/optimizer.md
---

## What was built

`ruleGroupByFdSimplification` (Structural pass, priority 23). For an
`AggregateNode` with two or more bare-column GROUP BYs, the rule reads the
aggregate-output FDs (already projected by `propagateAggregateFds`) plus its
equivalence classes (expanded into bi-directional FDs), runs `minimalCover`
over the candidate output indices, and drops every column not in the cover.
Each dropped column is re-emitted as a `MIN(<original-column>)` picker
aggregate; the rewrite preserves the original output attribute IDs via
`AggregateNode.preserveAttributeIds`, so HAVING / ORDER BY / outer Project
continue to bind unchanged.

The rule is decomposed into a small private helper (`expandEcsToFds`) and
reuses the existing `minimalCover` / FD utilities — no duplicate logic. Guards
make the rule a strict no-op when fewer than two GROUP BY columns are bare
`ColumnReferenceNode`s, when the cover doesn't shrink, or when `min/1` is
unexpectedly not registered as an aggregate.

### Foundation fix that landed alongside

`RetrieveNode` had no `computePhysical` override, so it silently dropped every
physical property (FDs, ECs, uniqueKeys, ordering, ...) at the module/Quereus
boundary. This blocked the rule on the common `Aggregate(Retrieve(...))` shape
— the aggregate saw `fds = undefined` even though the source's
`TableReferenceNode` advertised the PK-derived FD. Added a minimal pass-through
`computePhysical` (mirroring `AliasNode`): Retrieve's output is bit-for-bit
its source pipeline's output, so all physical properties propagate verbatim.
This is a real foundation gap and benefits more than just this rule (any
future consumer of `physical.fds` above a Retrieve would have hit the same
wall). Documented in the FD propagation table in `docs/optimizer.md`.

### Other test churn

`109-aggregate-physical-selection.sqllogic` and
`aggregate-physical-selection.spec.ts` both asserted that
`GROUP BY a, b, c` over a composite PK `(a, b)` lands on `HashAggregate`.
With the new rule, `c` is dropped (it's PK-determined), leaving
`GROUP BY a, b` which matches the source ordering — so the plan now lands on
`StreamAggregate`. Updated both assertions and added explanatory comments.

## Key files

- `packages/quereus/src/planner/rules/aggregate/rule-groupby-fd-simplification.ts` — the rule (new).
- `packages/quereus/src/planner/optimizer.ts` — registration at priority 23, Structural pass.
- `packages/quereus/src/planner/nodes/retrieve-node.ts` — pass-through `computePhysical`.
- `packages/quereus/test/optimizer/rule-groupby-fd-simplification.spec.ts` — 9 specs (new).
- `packages/quereus/test/logic/07-aggregates.sqllogic` — appended PK-driven and EC-driven result-row cases.
- `docs/optimizer.md` — RetrieveNode FD propagation row + rule description.

## Testing notes

Validation that ran clean:

- `yarn workspace @quereus/quereus run lint` — 0 issues.
- `yarn workspace @quereus/quereus run test` — 2827 passing, 2 pending, no failures.
- Targeted: `node test-runner.mjs --grep "ruleGroupByFdSimplification"` — 9/9 passing.

Spec coverage:

- PK-driven drop: `GROUP BY id, name, email` over `id PRIMARY KEY` collapses to `GROUP BY id` with two `MIN()` picker aggregates.
- EC-driven drop: `SELECT a, b FROM e WHERE a = b GROUP BY a, b` collapses to `GROUP BY a` with one `MIN(b)` picker.
- Negative — independent columns: rule does not fire.
- Negative — expression GROUP BYs (`a + 1, b`): rule does not fire.
- Negative — single GROUP BY column: rule does not fire.
- Attribute-ID preservation: result rows verify downstream binding survives.
- Physical aggregate operator still selected (`STREAMAGGREGATE` or `HASHAGGREGATE`).
- HAVING on a dropped column still binds after simplification.
- Result rows match un-simplified semantics under EC-driven drop (duplicates + ordering).

## Usage

Manual smoke (after `yarn workspace @quereus/quereus run build`):

```sql
CREATE TABLE customers (id INT PRIMARY KEY, name TEXT, email TEXT);
INSERT INTO customers VALUES (1,'a','a@x'),(2,'b','b@x'),(3,'b','b@y');
-- Before: GROUP BY id, name, email
-- After:  GROUP BY id    + MIN(name), MIN(email)
SELECT id, name, email FROM customers GROUP BY id, name, email;
```

Or via `query_plan(...)`:

```sql
SELECT properties FROM query_plan(
  'SELECT id, name, email FROM customers GROUP BY id, name, email'
) WHERE op IN ('STREAMAGGREGATE','HASHAGGREGATE','AGGREGATE');
```

The `groupBy` array in the JSON has length 1 (`id`), and `aggregates`
contains two entries with expressions like `min(name)`, `min(email)`.

## Out of scope (deferred)

- Expression-grouping simplification (`GROUP BY x+1, x+2`) — needs injective-pair reasoning beyond single-attribute injectivity.
- `DistinctNode` analogue (`DISTINCT a, b WHERE a = b` → `DISTINCT a`).
- Cost-aware cover selection (prefer narrower-typed columns to keep). `minimalCover` is deterministic but not cost-aware.
- FK-derived FDs would enable the full FK-join-then-aggregate shape; that lives in a separate ticket (not yet landed).
