----
description: The multi-level CTE-body flattener's consumer-rewrite substitutes a sibling-CTE-qualified column reference blindly through nested subquery operands, so a nested subquery that re-binds the inner CTE's source name as a LOCAL alias has its qualified refs wrongly rewritten to the outer inner-CTE's defining expression — a silent-wrong result (exotic name-collision trigger). Make the consumer-body substitution scope-aware (alias shadowing) so a re-bound source name shadows out.
difficulty: hard
files:
  - packages/quereus/src/planner/mutation/cte-flatten.ts          # composeBody / makeSubstitutions / mapQueryExprUniform descend (nestedSubst)
  - packages/quereus/src/planner/mutation/scope-transform.ts      # transformScopedQuery / transformAliasScopedExpr / collectFromAliases — the existing alias-shadow machinery to reuse
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic       # add the collision regression here
----

# Multi-level CTE flatten: nested-subquery alias shadowing of the inner source name

## The bug

`flattenCteBody` (`planner/mutation/cte-flatten.ts`) collapses a single-source
projection-and-filter chain by substituting each consumer reference to the inner
sibling-CTE source with the inner's defining expression. For the explicit-map
substitution path it descends into the consumer's subquery operands with
`mapQueryExprUniform(q, nestedSubst)`, where `nestedSubst` fires on **any**
column qualified by the inner source name:

```ts
const nestedSubst = (col) =>
    col.table && col.table.toLowerCase() === lcSource ? lookup(col.name) : undefined;
```

This is **not scope-aware**. If a subquery nested inside the consumer body
re-binds the inner source's name as a *local* FROM alias, a column qualified by
that name is local to the subquery (innermost-scope SQL rules) — but
`nestedSubst` still rewrites it to the outer inner-CTE's defining expression.
When the rewritten expression is a renamed/computed base column, the reference
silently binds to the wrong column. No error — just a wrong result.

## Reproduction (confirmed)

```sql
create table nbase (id integer primary key, color text);
insert into nbase values (1,'red');
create table nother (oid integer primary key, note text, color text);
insert into nother values (1,'red','blue');

-- inner `x` renames base.color -> `note`. The consumer's EXISTS aliases `nother`
-- as `x` and references `x.note` — which, in the `from nother x` scope, is
-- `nother.note` ('red' => EXISTS true => update should fire).
with x as (select id, color as note from nbase),
     t as (select id, note from x where exists (select 1 from nother x where x.note = 'red'))
     update t set note='z';
select * from nbase order by id;
-- EXPECTED: [{"id":1,"color":"z"}]   (EXISTS true via nother.note='red')
-- ACTUAL:   [{"id":1,"color":"red"}]  (flattener rewrote x.note -> base.color expr `color`,
--                                      binding nother.color='blue' => EXISTS false => no update)
```

The identity-strip fast path (`select *` inner, no rename) is **not** affected:
its strip only drops the `sourceName.` qualifier and leaves a bare name that
resolves locally to the same column, so a collision is harmless there. The bug
is confined to the explicit-projection / renamed-column map path.

## Why it matters / scope

- Silent-wrong (no diagnostic), which is the most serious class — but the
  trigger is narrow: the inner CTE source name must be re-used as a nested
  subquery FROM alias **and** the referenced column name must collide with an
  inner output column name **and** that output must be a renamed/computed base
  expression (a bare same-named passthrough is benign).
- The top-level consumer substitution is correct; only the **nested** descent
  mis-binds.

## Direction

Replace the blind `mapQueryExprUniform`/`nestedSubst` descent with a scope-aware
substitution that tracks FROM-alias shadowing, so once a nested scope re-binds
`sourceName` the substitution stops firing for that scope and below. The
`scope-transform.ts` module already owns this machinery
(`transformScopedQuery` with its `shadowed`/`aliasShadowed` accumulation, and
`transformAliasScopedExpr`/`collectFromAliases`). The subtlety: the consumer
body's OWN single FROM source *is* `sourceName` (that is precisely what we
substitute away), so its own alias must NOT count as a shadow at the top level —
only an alias bound by a *nested* scope shadows. Thread the alias set starting
empty at the consumer's top scope and accumulate only nested-FROM aliases.

Add the reproduction above as a regression once fixed.
