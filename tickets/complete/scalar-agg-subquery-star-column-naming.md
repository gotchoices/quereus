description: Physical aggregates advertised appended source columns they never emit, leaking the inner table's first column name (`id`) in place of a second scalar-aggregate subquery's alias under `SELECT *`. Fixed by making physical aggregates advertise exactly the logical AggregateNode output schema (groupBy + aggregates). Reviewed: invariant confirmed correct and scoped; stale docs/comments corrected; one redundant defensive wrap spun out to backlog.
files: packages/quereus/src/planner/rules/aggregate/rule-aggregate-streaming.ts, packages/quereus/src/planner/nodes/stream-aggregate.ts, packages/quereus/src/planner/nodes/hash-aggregate.ts, packages/quereus/src/planner/nodes/aggregate-node.ts, packages/quereus/src/planner/building/select-aggregates.ts, packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, packages/quereus/test/optimizer/keys-propagation.spec.ts, docs/optimizer.md
----

## Summary

`SELECT * FROM (SELECT count(*) AS a FROM t) x CROSS JOIN (SELECT count(*) AS b FROM t) y`
returned `{a:3, id:3}` instead of `{a:3, b:3}`. `ruleAggregatePhysical` built the physical
StreamAggregate/HashAggregate output attribute list via `combineAttributes(node.getAttributes(),
source.getAttributes())`, appending every source column to the aggregate's real output. The
emitters only ever yield `[...groupByValues, ...aggregateValues]` (source values go into the
runtime `combinedRowDescriptor` context, never as output), so the physical node advertised more
attributes than it emitted. A scalar-aggregate subquery used as a join source has no Project to
trim it, so the inflated list became the subquery's visible schema and `id` surfaced in place of
`b`.

**Fix (implement stage):** a physical aggregate advertises exactly the logical `AggregateNode`'s
output schema (groupBy + aggregate columns). `rule-aggregate-streaming.ts` now passes
`node.getAttributes().slice()` (deleting the `combineAttributes` helper); the dead source-column
loop in `select-aggregates.ts createAggregateOutputScope` was removed; and the
no-`preserveAttributeIds` fallback branches in `stream-aggregate.ts`/`hash-aggregate.ts` were
corrected to mirror the logical node. HAVING / correlated reads still resolve through the runtime
row-descriptor context and `buildHavingFilter`'s independent source-column fallback.

## Review findings

### Verification performed (all confirmed correct)

- **Emitter ↔ advertised-schema invariant.** Read both yield sites in `runtime/emit/aggregate.ts`:
  the no-GROUP-BY path yields `aggregateRow` (aggregate values only) and the grouped path yields
  `[...currentGroupValues, ...aggregateValues]`. The `fullRow = [...aggregateRow, ...sourceRow]` is
  set only into `combinedRowDescriptor`/`scanRowDescriptor` *context*, never yielded. Confirms the
  physical node must advertise exactly groupBy+aggregate columns — the fix is correct.
- **Logical node schema.** `AggregateNode.buildAttributes`/`buildOutputType` emit exactly
  groupBy+aggregate columns; the rule passes `node.getAttributes()` (the logical node), so
  `preserveAttributeIds` carries the right schema into the physical node.
- **Removed scope loop was a true no-op.** `createAggregateOutputScope` receives the *logical*
  `aggregateNode.getAttributes()` (length === groupBy+aggregates), so the removed
  `for (i = groupBy+agg; i < attributes.length; …)` loop never iterated. Confirmed against the
  caller at `select-aggregates.ts:124`.
- **HAVING / correlated path intact.** `buildHavingFilter` independently registers a source-column
  fallback in its hybrid scope (untouched) and rejects non-grouped/non-aggregate refs. Source
  values read through the runtime context, not aggregate output attributes.
- **FD propagation.** `propagateAggregateFds` is passed `getAttributes().length` (now smaller and
  correct); the singleton/key FDs now span exactly the real output columns. All FD/keys tests pass.
- **Broader "advertise == emit" invariant scan.** `combineAttributes` is fully removed (no other
  callers). Remaining `source.getAttributes()`/`sourceAttributes` appenders are `sort.ts` and
  `table-access-nodes.ts` (genuine pass-through nodes) and `window-node.ts`. Verified the window
  emitter yields `[...sourceRow, ...windowValues]`, matching its advertised `[...sourceAttrs,
  ...windowAttrs]` — correct. Aggregate was the unique offender.

### Minor — fixed inline this pass

- **Stale docs/comments (the change should have touched these).** Corrected four spots that still
  described the old "physical aggregate exposes source columns" behavior:
  - `aggregate-node.ts` `propagateAggregateFds` doc — said `outputColumnCount` "may exceed
    groupCount + aggregateCount"; now states it is always exactly that.
  - `stream-aggregate.ts` — "The optimizer rule now passes both aggregate AND source attributes".
  - `rule-fanout-lookup-join.ts` ×2 (the `RecognizedSubqueryBranch` doc and the branch-wrapping
    comment) — described the now-removed 1→N attribute inflation.
  - `docs/optimizer.md` (fan-out lookup-join section) — same inflation narrative.

### Major — filed new ticket

- **Redundant defensive Project wrap in the fan-out rule.** `ruleFanOutLookupJoin` wraps each
  scalar-aggregate subquery branch root in a single-column `ProjectNode`. Its sole original purpose
  was to defend against the physical aggregate inflating to N columns — now impossible. It is an
  identity projection. Removing it is a plan-shape change with `substituteSubqueries` / golden-plan
  / nullable-widening implications, so it is out of scope here. Filed
  `tickets/backlog/fanout-subquery-redundant-project-wrap`.

### Reviewed — no action taken (with reason)

- **Dead no-`preserveAttributeIds` branches** in `stream-aggregate.ts`/`hash-aggregate.ts`: verified
  unreachable — all 6 construction sites (the 4 in `rule-aggregate-streaming.ts`, both `withChildren`,
  and both in `rule-aggregate-predicate-pushdown.ts`) pass attributes. The branches were corrected by
  the implementer and are consistent with the logical node. Making `preserveAttributeIds` required to
  delete them would reorder the constructor (it sits after the optional `estimatedCostOverride`) and
  ripple to all 6 positional call sites — disproportionate churn/risk for dead-but-correct code. Left
  as-is.
- **HAVING source-column context path coverage:** the implement handoff flagged this as an untested
  gap, but it is already covered by `test/logic/25.2-having-edge-cases.sqllogic`'s positive case
  `select val * 2 as v2 from hu group by val * 2 having val * 2 > 30` — the bare `val` reference
  resolves through the source-column fallback / runtime context (it is not an output column), proving
  the context path still feeds source columns after the dead-loop removal. No new test needed.

### Test coverage

The 2 new regression tests + the tightened DISTINCT-elimination test in `keys-propagation.spec.ts`
are an adequate floor (`SELECT *` star-expansion, explicit `x.a, y.b` over different tables, and the
exact `{a:3, b:3}` shape). Combined with the existing comprehensive HAVING suite (`25.2`), the
behavior is well-pinned. The only uncovered code is the unreachable defensive fallback branch noted
above.

## Validation

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus run lint` — clean.
- `yarn workspace @quereus/quereus run test` — **3631 passing, 9 pending**. (Review pass changed
  only comments/docs after the implement-stage code; no behavioral change, no new failures.)
- No `test:store` run — planner/schema change, not store-relevant.
