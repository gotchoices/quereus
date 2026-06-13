description: Let a CTE-name DML target's user predicate self-read the target name (`with t as (…) update t set … where id in (select id from t)`) resolve to the CTE body and capture eagerly (Halloween-safe), instead of rejecting. Requires a split planning context: exclude the target name when planning the CTE body (so a same-named base FROM reaches the real table — the load-bearing shadow case), but include it when planning the user WHERE/SET so the self-read resolves through the substrate's eager-capture discipline.
prereq:
files:
  - packages/quereus/src/planner/building/dml-target.ts          # contextForCteTarget — currently deletes the target from cteNodes wholesale
  - packages/quereus/src/planner/building/update.ts
  - packages/quereus/src/planner/building/delete.ts
  - packages/quereus/src/planner/building/insert.ts
  - packages/quereus/src/planner/mutation/single-source.ts       # SELF_ALIAS self-reference machinery the rewrite already uses
  - docs/view-updateability.md                                   # § Common Table Expressions and the CTE-name DML target → v1 boundary (Halloween)
difficulty: hard
----

# CTE-name DML target: self-reference in the user predicate (Halloween)

## Background

The cte-name-dml-write-target work (landed, reviewed) makes a leading `with t as (…)` a real
DML write target routed through the view-mutation substrate via an ephemeral `MutableViewLike`.

To make the **load-bearing shadow case** correct —

```sql
with base as (select id, color from base) update base set color = 'x'
```

— the target CTE's own name must be **excluded** from its body's scope so the body's
`from base` reaches the REAL `base` table (a non-recursive CTE cannot see itself).
`contextForCteTarget` therefore deletes the target name from `cteNodes` wholesale.

## The deferred behavior

A consequence of that single decision: a user-predicate self-read of the target name —

```sql
with t as (select id, color from hw) update t set color = 'x' where id in (select id from t)
```

— does NOT resolve `t` to the CTE. It is currently **rejected cleanly** (the base table is
left unchanged, never a Halloween-unsafe plan): the view-rewrite remaps `from t` to the base
table as a self-reference and the correlation cannot be proven, surfacing
`unsupported-subquery-correlation` ("cannot be proven correlated"). This is pinned as v1
behavior in `93.4-view-mutation.sqllogic` (the "Halloween / self-reference" block) and
documented as a v1 boundary.

## Why it's non-trivial

The shadow case and the Halloween case want **opposite** `cteNodes` treatment of the target
name in the SAME statement:

| Position                     | Wants target name… |
|------------------------------|--------------------|
| CTE body FROM (`from base`)  | **excluded** (→ real base table) |
| User WHERE/SET self-read     | **included** (→ the CTE, captured eagerly) |

So a single shared context cannot satisfy both. A fix needs a **split-context** design:
plan the CTE body against the target-excluded context, but plan the user predicate / SET
subqueries against a target-included context whose `t` resolves to an eager up-front capture
of the affected rows (the substrate already has this discipline for the multi-source
`__vmupd_keys` capture and the set-op membership capture — reuse that machinery rather than
inventing a new one).

## Acceptance

- `with t as (<single-source body>) update t set … where <col> in (select … from t)` resolves
  the self-read against an eager capture and produces a Halloween-safe plan (the predicate
  sees the pre-mutation row set), matching the equivalent view's self-reference behavior.
- The load-bearing shadow case (`with base as (select … from base) update base …`) STILL
  writes the real `base` table — do not regress it.
- Sibling-CTE reads in body / predicate / source still resolve.
- Replace the v1-boundary "rejected cleanly" assertions in `93.4-view-mutation.sqllogic` and
  the doc § Common Table Expressions and the CTE-name DML target with the new behavior.
