description: Removed the redundant single-column `ProjectNode` wrap on subquery branches in `ruleFanOutLookupJoin`. The branch child is now `subqueryRoot` verbatim — aggregate nodes already advertise exactly their logical groupBy+aggregate schema (since the `scalar-agg-subquery-star-column-naming` fix), so a no-GROUP-BY scalar-aggregate subquery root is already single-column and the prior Project was an identity projection adding nothing.
files: packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts, docs/optimizer.md
----

## Summary

The fan-out subquery-branch assembly loop in
`packages/quereus/src/planner/rules/join/rule-fanout-lookup-join.ts`
previously built a `ProjectNode(subqueryRoot, [colRef(valueAttr)])` for each
recognized subquery branch as a "defensive identity pin." After
`scalar-agg-subquery-star-column-naming` made physical aggregates advertise
exactly the logical groupBy+aggregate schema in both their logical and
physical forms, the wrap became a true identity projection: the
recognition gate already rejects any subquery whose root has
`getAttributes().length !== 1`, and the Project's
`attributeId: valueAttr.id` argument made the Project's output attribute
the same `Attribute` object as the aggregate's already-single output
attribute — so there was no second `Attribute` object to "pin to" in the
first place.

The branch child is now `b.subqueryRoot` directly, with
`outputAttrs: b.subqueryRoot.getAttributes()`. The `docs/optimizer.md`
paragraph and the `RecognizedSubqueryBranch` JSDoc were updated to drop
the defensive-pin language and state the new reality.

## Review findings

### What was checked

- **Implement-stage diff** (`git show cc131d0d`) — fresh read before
  consulting the handoff summary.
- **Imports / dead code** — `ProjectNode`, `ColumnReferenceNode`, and
  `columnExprFor` are all still used downstream (in `rebuildProject`,
  in the subquery-replacement column-ref builder, and as instance
  guards / chain-walk wrappers). Nothing went stale.
- **Attribute identity & ID stability** — `b.valueAttr` is
  `scalarSubquery.subquery.getAttributes()[0]`, and
  `b.subqueryRoot.getAttributes()[0]` is the same `Attribute` object.
  `ruleAggregatePhysical` always passes `node.getAttributes().slice()`
  as `preserveAttributeIds` to `StreamAggregateNode` /
  `HashAggregateNode`, both of which return that slice verbatim from
  `buildAttributes()` when `preserveAttributeIds` is set
  (`packages/quereus/src/planner/nodes/stream-aggregate.ts:40-44`,
  `packages/quereus/src/planner/nodes/hash-aggregate.ts:42-44`). So
  after the Physical pass replaces the logical aggregate beneath the
  fan-out branch, the new physical node carries the same Attribute
  object — `FanOutLookupJoinNode.validateConstruction`'s
  `outputAttrs.length === child.getAttributes().length` check
  (`fanout-lookup-join-node.ts:185-192`) stays green.
- **Runtime emit shape** — `emitStreamAggregate`'s no-GROUP-BY path
  (`runtime/emit/aggregate.ts:309`) yields `aggregateRow` (length =
  `plan.aggregates.length` = 1 for a scalar aggregate), not `fullRow`.
  Removing the wrapping Project doesn't change the wide-row
  contribution. The branch genuinely emits one column whether or not
  the Project is there.
- **Pass-through wrappers around the aggregate** — when the subquery's
  body has a `Project` / `Alias` / `Sort` / `LimitOffset` around the
  no-`GROUP BY` aggregate, `subqueryRoot` is that wrapper, not the
  aggregate. The `subAttrs.length !== 1` gate (line 463) still rejects
  any wrapper that does not advertise exactly one column, so the
  branch-child contract holds in the wrapped case too.
- **Cost-gate & wide-row math** — the cost gate reads off
  `b.subqueryRoot.physical.expectedLatencyMs` (line 247), unchanged.
  `wideIndex` accumulation increments by one per subquery branch
  (line 338), unchanged.
- **`ruleProjectionPruning` interaction** — only fires on
  `Project(Project(...))`; the prior identity Project on a 1-col
  aggregate was never a candidate for pruning (the source was an
  aggregate, not a project), so removing it does not regress any
  pruning opportunity.
- **Doc consistency** — the rule-file's top-level comment already
  stated the subquery's relational root is "used verbatim as the
  branch child" (line 25-29). That description was technically
  inaccurate while the Project wrap existed; it is now accurate.
  `docs/optimizer.md` was rewritten to drop the defensive-pin paragraph
  and the back-pointer to this ticket.
- **Test coverage** — the existing `parallel-fanout.spec.ts` subquery
  block exercises bare, wrapped (coalesce / `+` / cast), mixed-with-spine,
  count→0 empty children, and the explicit
  `attribute-ID stability: identical output columns enabled vs disabled`
  test. None assert on a Project node count above the branch's
  aggregate — they verify branch modes, joinCount, and result
  equivalence — so the simplification is invisible to them.
- **Cross-package latency declarations** — `expectedLatencyMs` is
  declared only in `quereus` core (interface in `vtab/module.ts`,
  consumers in planner rules, synthetic `HighLatencyMemoryModule` in
  tests). No plugin (LevelDB / IndexedDB / etc.) declares per-call
  latency, so the rule remains inert in all out-of-tree memory and
  store paths.

### What was found

**Minor — nothing required.** Every aspect angle the ticket-rules
checklist mentions (SPP, DRY, modular, scalable, maintainable,
performant, resource cleanup, error handling, type safety) was either
unchanged by the edit or strictly improved (one fewer node per
recognized subquery branch in the logical tree; no per-branch
allocation of a redundant `ColumnReferenceNode` / `ProjectNode` pair).
The change is a pure simplification of an already-covered code path.

**Major — none.** No new ticket needed.

### What was done

Nothing beyond verification. The implement-stage commit already:

- removed the `ColumnReferenceNode` + `ProjectNode` construction in the
  subquery-branch assembly loop and replaced it with a direct
  `b.subqueryRoot` reference;
- updated `RecognizedSubqueryBranch`'s JSDoc to drop the
  defensive-identity-pin framing;
- updated `docs/optimizer.md`'s "Aggregate nodes advertise…" paragraph
  to remove both the Project-wrap description and the back-pointer to
  this ticket.

### Validation

- `yarn workspace @quereus/quereus run lint` — clean (exit 0).
- `yarn workspace @quereus/quereus run typecheck` — clean (exit 0).
- `yarn workspace @quereus/quereus run test` — **3642 passing, 9 pending**,
  unchanged from baseline.
- `yarn test:store` was not run (rule is cost-gated on
  `expectedLatencyMs > 0`, which no store declares, so behavioral
  impact under the LevelDB store is zero by construction).

### Known gaps

None. The change is a strict reduction of work; the existing tests
already cover the recognition, branch-formation, result-correctness,
and attribute-ID-stability paths.
