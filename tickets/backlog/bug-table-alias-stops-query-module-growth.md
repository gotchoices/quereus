description: For storage modules that run whole query pipelines themselves, such as a remote database, giving a table an alias stops the engine from handing them the column selection and later steps, so that work runs locally instead. Results are correct, but the remote side may send back more data than it needed to.
files:
  - packages/quereus/src/planner/rules/retrieve/rule-grow-retrieve.ts # findRetrieveChild only looks at direct children
  - packages/quereus/src/planner/optimizer.ts # GROW_RETRIEVE_NODE_TYPES does not include Alias
  - packages/quereus/src/planner/rules/access/rule-select-access-path.ts # passes Retrieve.source to supports()
  - packages/quereus/test/vtab/test-query-module.ts # the only supports() implementer in the repo
  - docs/module-authoring.md # supports() contract
repro: verified
severity: edge-case
likelihood: unusual
tradeoffs: No module shipped in this repository implements supports(), only a test fixture does, so the cost falls entirely on third-party modules that may not exist yet; a fix also has to decide whether such modules must learn to accept Alias nodes.
----

Found while working `bug-table-alias-defeats-sort-absorption`, which fixes the same symptom for modules that use `getBestAccessPlan`. This ticket covers modules that implement `supports()`, which is a different code path.

## Observed

Using `TestQueryModule`, whose `supports()` accepts Project and Filter:

```sql
create table qt (id integer primary key, name text) using query_test;

select id from qt;
-- REMOTE QUERY pipeline over qt
--   SELECT id
--     main.qt

select q.id from qt q;
-- SELECT q.id
--   ALIAS q
--     REMOTE QUERY qt
--       main.qt
```

`select id from qt limit 1` shows the same difference: the Project reaches the module without an alias and stays local with one. A Filter still reaches the module in both forms, because `rule-predicate-pushdown` carries it across the Alias first.

## Cause

`ruleGrowRetrieve` looks for a Retrieve only among a node's direct children (`findRetrieveChild`). With an alias, a Project's child is the Alias, so it finds nothing. `Alias` is also absent from `GROW_RETRIEVE_NODE_TYPES`, so the Alias itself is never offered to the module.

## Expected behaviour

An alias does not change how much of a query is offered to a query-based module.

## What has to be decided

Adding `Alias` to `GROW_RETRIEVE_NODE_TYPES` alone is not enough. `supports()` would receive pipelines containing an `AliasNode`, and a module that declines node types it does not recognize, as the test fixture does, would decline the Alias and everything above it. The options are to require modules to accept Alias and document that in the `supports()` contract, or to have the engine keep Alias out of the pipeline a module sees, which needs checking against anything that reads `relationName` from those attributes.
