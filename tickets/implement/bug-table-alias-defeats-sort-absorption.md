description: Giving a table an alias in a query stops the engine from answering "order by ... limit" from an index that fits, so it reads and sorts the whole table instead. Results are correct, but the cost grows with table size for no visible reason.
architecture: docs/optimizer-rules.md
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts # trySortAbsorbViaIndexOrdering walk, plus comments that list the walk's node types
  - packages/quereus/src/planner/rules/aggregate/rule-minmax-index-boundary.ts # second caller of that walk; gains the same fix
  - packages/quereus/test/optimizer/minmax-index-boundary.spec.ts # "a derived table between the aggregate and the table" pins the old limitation and must flip
  - packages/quereus/test/optimizer/desc-index-ordering.spec.ts # candidate home for the reproduction test
  - docs/optimizer-rules.md # ruleMinMaxIndexBoundary entry
repro: verified
----

Reported in GitHub issue #32. The reporter runs eleven "latest revision" lookups, six of them inside CHECK constraints, so each insert sorted a whole journal twice. They kept the aliases for readability and are waiting on this fix.

## Reproduction

Run on the current tree against the memory backend:

```sql
create table t (k text, r integer, x integer, primary key (k, r));
create index t_r on t (r desc);
select x from t order by r desc limit 1;
select x from t TV order by TV.r desc limit 1;
```

```
-- no alias                                -- alias
LIMIT 1 OFFSET null                        LIMIT 1 OFFSET null
  SELECT x                                   SELECT x
    INDEX SCAN t USING t_r ORDER BY 1 DESC     ORDER BY TV.r DESC
                                                 ALIAS tv
                                                   INDEX SCAN t USING _primary_ ORDER BY 0, 1
```

## Root cause

`trySortAbsorbViaIndexOrdering` (`rule-grow-retrieve.ts`) walks down from a Sort to the table's Retrieve node, and admits only `ProjectNode` and `FilterNode` on the way. A table alias builds an `AliasNode` directly above the Retrieve, so the walk hits an unsupported node and returns null. The Sort stays, and with no ordering requested the access-path rule picks the primary key.

The issue's suspicion is correct. An Alias only changes the `relationName` on its attributes and keeps their ids (`nodes/alias-node.ts`). `computePhysical` passes `ordering` and `monotonicOn` through. So it is as safe to walk through as a bare-column Project, and sort keys still resolve through `tableRef.getAttributeIndex()`.

## Fix

Add `AliasNode` to the walk's admitted types, and to the `chain` array's type. The rebuild loop needs no change: it replaces child 0 through `withChildren`, which AliasNode supports.

A trial of exactly that change was run and then removed (the tree is back at HEAD):

- The ticket's query plans as `ALIAS tv` over `INDEX SCAN t USING t_r ORDER BY 1 DESC`, matching the unaliased plan apart from the Alias.
- The same walk also serves `rule-minmax-index-boundary`, so these changed too. `select max(TV.r) from t TV` and `select min(z.c) from n z` became boundary reads, and the `min` kept its `is not null` filter.
- These shapes now also absorb: aliased views (`select v.b from vu v order by v.a limit 1`), derived tables, a residual filter (`where TV.x > 1`), and a key-set semi join below the alias.
- Rows matched between the aliased and unaliased forms for every pair run: ordered, filtered, min/max, derived, view, and `exists`. Column labels differ for aggregates only because the SQL text differs.
- `yarn workspace @quereus/quereus test` gave 5490 passing and 1 failing. The one failure is the expected test described below.

## The expected test change

`minmax-index-boundary.spec.ts`, "a derived table between the aggregate and the table", asserts that `select max(c) from (select c from t) x` does not rewrite. Its comment gives the reason as "an Alias interrupts the chain", which is this bug. With the fix the query becomes a boundary read and its answer stays 120. Move it out of the "declines" group, or change it to assert the boundary read, and keep the answer check. Do not keep the old assertion.

## Other rules checked for the same stop

No other rule that reaches a table access stops at an Alias, so this one site is the fix for index-style modules:

- Rules with their own Alias handling: `rule-predicate-pushdown`, `rule-monotonic-limit-pushdown`, `rules/shared/access-leaf.ts` (used by key-set seek and index nested loop), `rule-lateral-top1-asof`, `rule-fanout-lookup-join`, `rule-join-elimination`, `rule-empty-relation-folding`, `rule-lens-auxiliary-access`, the subquery decorrelation rules, and `query-rewrite-matcher`.
- Plan comparison, aliased against unaliased, showed the same shape apart from the Alias for: `group by`, `distinct`, equality filter, bare `limit`, `limit` with `offset`, and join with `order by`.
- `with c as (...) select ... from c q order by q.a` keeps its Sort, but so does the unaliased form, so that is not alias-related.

The one other stop is the direct-child lookup in `ruleGrowRetrieve`, which affects only modules implementing `supports()`. It is a different site with an open design question about what such a module should be shown, so it is filed separately as backlog `bug-table-alias-stops-query-module-growth`.

## One difference to be aware of

An unaliased `select * from t order by id` has its Sort directly above the Retrieve, so it goes through the Sort arm of `fallbackIndexSupports`, which deliberately does not set `orderingLoadBearing` (see the accepted-tradeoff `NOTE:` there). The aliased form will go through `trySortAbsorbViaIndexOrdering`, which does set it. From reading the code (not run), `join (select * from big b order by b.v) z` therefore still will not qualify for an index-nested-loop seek. That is no regression, since the Sort blocks that seek today, and the marker only makes the rule more conservative. Leave it as it is.

## Reproduction test

Add one test at the optimizer plan layer: the ticket's two queries produce the same access leaf and neither contains a Sort. Assert on plan shape with Alias nodes ignored, not on the index name alone, so the test states the actual requirement that an alias changes nothing about the access path. Do not add a case per shape listed above, since the min/max spec flip already covers the second caller.

## TODO

- Admit `AliasNode` in the `trySortAbsorbViaIndexOrdering` walk and widen the `chain` type.
- Update the comments that list the walk's types: the special-case comment in `ruleGrowRetrieve`, the `trySortAbsorbViaIndexOrdering` doc comment, and the `truncationIsSafe` paragraph saying the chain "admits Project and Filter alone". An Alias discards no rows, so that function's logic is unchanged.
- Reread the `NOTE:` in `rule-minmax-index-boundary.ts` about a non-table relation becoming reachable through the probe's walk. An Alias over a table is still a table, so the note should hold, but confirm it. Mention Alias in the rule's docs entry if the walk is described there.
- Add the reproduction test.
- Flip the min/max derived-table test as described above.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`. Also run `yarn test:store`, because the store module now receives ordering requests for aliased tables that it never saw before.
- Reply on GitHub issue #32 once this lands, or note in the handoff that a human needs to.
