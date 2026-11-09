description: When a query names a WITH query twice under the same name, the planner reuses one internal reference for both mentions, so the engine thinks it is used once and runs it separately per mention (a random value then differs between the two), and a nested WITH that reuses an outer WITH's name reads the wrong one's rows.
architecture: docs/runtime-caching.md#shared-cte-materialization-multi-reference-ctes
files:
  - packages/quereus/src/planner/building/select.ts  # buildFrom ~line 535: the cteReferenceCache lookup to delete
  - packages/quereus/src/planner/planning-context.ts  # cteReferenceCache field (~line 196) to delete
  - packages/quereus/src/planner/building/expression.ts  # subquery / IN / EXISTS contexts copy cteReferenceCache (~lines 190, 252, 282)
  - packages/quereus/src/planner/building/schema-authored-context.ts  # clears cteReferenceCache (~lines 22, 72-74)
  - packages/quereus/src/planner/stored-body-context.ts  # clears cteReferenceCache (~lines 21, 62)
  - packages/quereus/src/core/database.ts  # context factory ~line 2734
  - packages/quereus/src/core/derived-row-validator.ts  # context factory ~line 154
  - packages/quereus/src/schema/manager.ts  # context factory ~line 2256
  - packages/quereus/src/planner/cache/materialization-advisory.ts  # shouldMaterializeCTE doc comment ~line 150 claims the undercount
  - packages/quereus/src/planner/building/with.ts  # comment ~lines 196-206 cites the undercount
  - docs/optimizer.md  # line ~131 cites the undercount
  - docs/runtime-caching.md  # § Shared CTE materialization
  - packages/quereus/test/logic/07.8.2-subquery-selecting-outer-column.sqllogic  # lines 88-90: recursive, reads outer row, two mentions under one name
  - packages/quereus/test/logic/13.4-cte-extras.sqllogic  # home for the shadowing regression cases
  - packages/quereus/test/logic/13.6-cte-dml-runs-once.sqllogic  # header comment cites the undercount
  - packages/quereus/test/plan/cte-dml-plan-shape.spec.ts  # header comment ~line 212 cites the undercount
  - packages/quereus/test/view-cte-isolation.spec.ts  # header + ~line 72 describe the cache as a leak channel
repro: verified
----

## Root cause

`buildFrom` (`packages/quereus/src/planner/building/select.ts`, the non-recursive CTE branch) keeps a statement-wide `cteReferenceCache` keyed by the string `"<cteName>:<alias>"`. Every FROM mention with the same name and alias reuses one `CTEReferenceNode`. The cache is created once per statement context and copied by reference into every subquery context (`expression.ts` spreads `...ctx`), so it spans the whole statement, including nested WITH clauses.

That one site produces two defects.

### Arm 1: two mentions under one name count as one reference

`MaterializationAdvisory.analyzeAndTransform` sums parent counts per CTE `tableDescriptor`. Two mentions that share one `CTEReferenceNode` give the `CTENode` a single parent, so a read-only body is not marked `materialize` and each mention emits and runs the body separately.

```sql
create table u (id integer primary key);
insert into u values (1);

-- Two aliases: two reference nodes, stored once, same = true
with c as (select random() as x from u) select c1.x = c2.x as same from c c1 join c c2 on 1=1;

-- One name mentioned twice: one reference node, runs twice, same = false (verified)
with c as (select random() as x from u) select (select max(x) from c) = (select min(x) from c) as same;
```

### Arm 2: a nested WITH that reuses an outer name reads the wrong rows

The cache key carries no notion of which WITH clause defined the name, so a nested `with c` and an outer `c` collide on `"c:c"`. Whichever is built first wins, and the other mention reads its rows. Verified:

```sql
-- expected a=1, b=2; actual a=1, b=1
with c as (select 1 as x) select (select x from c) as a, (with c as (select 2 as x) select x from c) as b;

-- expected b=2, a=1; actual b=2, a=2
with c as (select 1 as x) select (with c as (select 2 as x) select x from c) as b, (select x from c) as a;

-- FROM-clause subquery, same collision: expected {"x":2,"x:1":1}; actual {"x":2,"x:1":2}
with c as (select 1 as x) select * from (with c as (select 2 as x) select x from c) s join c on 1=1;
```

`storedBodyContext` and `schemaAuthoredContext` already clear the cache for view and schema bodies for this same reason (`test/view-cte-isolation.spec.ts` calls it "the third leak channel"), but ordinary nested WITH clauses inside one statement were never isolated.

## Fix

Delete the cache. Every FROM mention of a non-recursive CTE builds its own `new CTEReferenceNode(parentContext.scope, cteNode, fromClause.alias)`. All of them still point at the one `CTENode` from `cteNodes`, so the parent count on that node, summed per descriptor, becomes the number of mentions, and `emitCTE`'s descriptor-keyed buffer is shared as before.

The cache's comment says it exists "to ensure consistent attribute IDs across multiple references to the same CTE with the same alias". Measured: with the lookup bypassed (`if (false && ...)`), `yarn test` in `packages/quereus` gave 3693 passing and 1 failing, and the one failure is the intended behaviour change below. No other test depends on two mentions sharing attribute IDs, and each mention is resolved through its own `registerColumnScope`, so column references bind to their own mention's attributes. The scratch file holding all the statements above passed with the cache bypassed and failed with it in place.

Remove the `cteReferenceCache` field from `PlanningContext` entirely, not just its use, so nothing can reintroduce a statement-wide cache. TypeScript's excess-property check will then flag every context factory that still sets it — the files under `files:` plus the test specs that construct a `PlanningContext` by hand (`grep -rn cteReferenceCache packages/quereus/test` lists about 15 sites: lens-enforcement, lens-put-fanout, optimizer/*, plan/correlated-predicate-scope, planner/relation-key, quereus/view-info, quereus/view-mutation-substrate). Delete the field from each. `yarn lint` in `packages/quereus` type-checks the test files and will catch any you miss.

## Behaviour change: recursive body that reads the outer row, mentioned twice under one name

`07.8.2-subquery-selecting-outer-column.sqllogic` lines 88-90 pin this as passing:

```sql
-- Two mentions under one alias share one reference, so this is not refused.
select a, (with recursive c(x) as (select t.b union all select x+1 from c where x < t.b+2) select (select max(x) from c) + (select min(x) from c)) as v from t order by a;
→ [{"a":1,"v":12},{"a":2,"v":-8},{"a":3,"v":20}]
```

With mentions counted, the advisory's recursive branch sees two references and refuses with `Recursive CTE 'c' reads a column of an outer query and is referenced more than once, which is not supported` — the same refusal the two-alias form at line 115 already gets.

Decision: accept the refusal and change that test to expect the error. Reasons:

- The test's own comment says it passes only because of the shared reference node, i.e. because of this bug.
- It gave correct results only because its two scalar subqueries happen to run one after the other. Each mention drives the recursion with the same working-table descriptor, and two drives that interleave (a self-join, as at line 115) corrupt each other's working table. The planner has no way to tell those two shapes apart, so the refusal must not depend on how the two mentions happen to be scheduled.
- Rejected alternative: give each mention its own copy of the recursive body with its own working-table descriptor. That changes how recursive CTEs are built and duplicated, which is far more change than this rare shape justifies.
- What would lift the refusal properly is a CTE buffer that lives for one run of the enclosing correlated subquery instead of the whole statement; that would also lift the refusal for non-deterministic bodies that read the outer row. Out of scope here.

Rewrite the comment at line 88 to say the two mentions now count as two references and the case is refused for the same reason as line 115. Likewise, a non-deterministic non-recursive body that reads the outer row and is mentioned twice under one name is now refused, which is what `docs/runtime-caching.md` already says should happen; consider adding that case next to line 95 in the same file.

## Comments and docs that describe the undercount

These claim that "two mentions sharing an alias share one `CTEReferenceNode`". After the fix that is false; reword each to drop the claim while keeping the reason that still holds (a data-modifying body is marked at build time because `NOT MATERIALIZED` would license a second write, and because its once-per-execution guarantee should not depend on reference counting):

- `materialization-advisory.ts` `shouldMaterializeCTE` doc comment (~line 150).
- `with.ts` comment ~lines 196-206, including the NOTE that says making DML buffering conditional would mean "first fixing that undercount" — the undercount is fixed, so the NOTE should say only the remaining condition.
- `docs/optimizer.md` ~line 131.
- `13.6-cte-dml-runs-once.sqllogic` header (lines 7-11) — keep it as history ("this held only accidentally before"), but say the undercount has since been fixed.
- `test/plan/cte-dml-plan-shape.spec.ts` header ~line 212.
- `test/view-cte-isolation.spec.ts` header and the comment near line 72 — the cache no longer exists, so the third channel is closed by removal; `storedBodyContext` now clears only `cteNodes`.
- `stored-body-context.ts` and `schema-authored-context.ts` comments that list `cteReferenceCache` as cleared.
- `docs/runtime-caching.md` § Shared CTE materialization: the first bullet says references "usually share one `CTENode`"; that stays true. Add a sentence that each FROM mention gets its own `CTEReferenceNode`, so the advisory's count is the number of mentions.

## Tests

- Arm 1: add the ticket's second statement (`select (select max(x) from c) = (select min(x) from c)`) expecting `[{"same":true}]`. A natural home is `13.3-cte-edge-cases.sqllogic` or next to the multi-reference cases in `13.4-cte-extras.sqllogic`.
- Arm 2: add the three shadowing statements above to `13.4-cte-extras.sqllogic`, which already covers CTE name shadowing. One FROM case and one scalar-subquery case is enough if three feel redundant.
- Update `07.8.2` lines 88-90 as described above.

## TODO

- Delete the `cteReferenceCache` lookup in `buildFrom`; build a fresh `CTEReferenceNode` per mention.
- Remove the `cteReferenceCache` field from `PlanningContext` and every place that sets, copies, or clears it (src and test specs).
- Update `07.8.2-subquery-selecting-outer-column.sqllogic` lines 88-90 to expect the refusal; optionally add the non-deterministic one-name case.
- Add the arm 1 and arm 2 regression statements to the CTE logic files.
- Reword the undercount comments and docs listed above.
- Run `yarn test` and `yarn lint` in `packages/quereus`; confirm the only behaviour changes are the ones above.
