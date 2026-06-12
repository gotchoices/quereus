description: `stripSideQualifier` decides on a column's table qualifier alone at every nesting depth, so an inner subquery FROM alias that collides with a join-side alias mis-routes — `(select x.v from xtab x)` inside a SET value, where `x` is also a view side alias, rewrites `x.v` into the cross-source capture (or strips it bare) instead of leaving the subquery-local reference alone. Needs alias-aware shadow tracking in the descent (the ScopeContext machinery tracks column names only, not FROM aliases).
files:
  - packages/quereus/src/planner/mutation/multi-source.ts    # stripSideQualifier — qualified rule applied uniformly at depth
  - packages/quereus/src/planner/mutation/scope-transform.ts # collectFromColumnNames / ScopeContext — column-name shadow set; no alias tracking today
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic
----

# Inner FROM aliases can shadow join-side aliases in the cross-source strip

## Problem

The strip's qualified rule treats a column's `.table` qualifier as a purely syntactic
side discriminator and applies it uniformly at every nesting depth: a qualifier
matching the owning side's alias/table strips to bare; one matching a partner side
routes through the `__vmupd_keys` capture. But SQL scoping lets a nested value
subquery introduce a FROM alias that **collides** with a side alias:

```sql
create view v as select c.cid as cid, cval, p.pv as pv
    from child c join parent p on p.pid = c.pref;
update v set cval = (select max(p.score) from points p where p.cid = cid);
--                              ^^^^^^^ subquery-local `p` (points), not side `p` (parent)
```

The inner `p.score` / `p.cid` reference the subquery's own `points p`, yet the strip
sees qualifier `p` ∈ partner aliases and rewrites them into correlated capture reads
(or rejects/errors on a column the partner doesn't have). Same hazard for a collision
with the **owning** alias (the ref strips to bare and escapes its local source).

## Expected behavior

A qualifier bound by an inner FROM alias (per innermost-scope rules) must be left
untouched at that depth and below; only a qualifier that genuinely denotes a join side
(not shadowed by any enclosing-subquery FROM alias) participates in the strip/route.
This requires the descent to thread an **alias** shadow set alongside the existing
column-name shadow set — an extension of `ScopeContext`/`transformScopedQuery` (or a
parallel mechanism), since `collectFromColumnNames` resolves column names only.
Unresolvable sources still shadow their alias (the alias itself is always statically
known from the FROM clause, so no taint is needed for alias shadowing). Behavior for
non-colliding aliases must be unchanged.
