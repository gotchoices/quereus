description: Make the cross-source SET-value qualifier strip (`stripSideQualifier`) alias-scope-aware so a user-authored alias-qualified ref shadowed by an inner value-subquery FROM alias binds locally instead of mis-routing through the `__vmupd_keys` capture (partner-alias collision) or stripping bare (owning-alias/table-name collision). Implemented; needs adversarial review.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts    # NEW collectFromAliases + transformAliasScopedExpr/Query (lines ~544-650)
  - packages/quereus/src/planner/mutation/multi-source.ts        # stripSideQualifier substitute+descent (~2560-2580); docstrings (~2401-2520)
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic      # uq-17..uq-21 (after uq-16)
  - docs/view-updateability.md                                  # § Inner Join, cross-source `set` (~line 149)
----

# Alias-aware shadow tracking in the cross-source SET-value strip — review handoff

## What landed

A multi-source (join-view) UPDATE lowers each SET value to base terms in two passes. Pass 2,
`stripSideQualifier`, routes by a column's `.table` qualifier: an **owning**-side alias/table
strips to bare; a **partner**-side alias/table routes the read through the up-front
`__vmupd_keys` capture (`routePartnerRead` → `registerCrossSource` + `gateCrossSourceCardinality`);
a **bare** qualifier is left untouched. Previously pass 2 applied its substitute *uniformly at
every depth* via the scope-unaware `mapQueryExprUniform` descent, justified as "purely syntactic —
a qualified leaf cannot re-bind to a value subquery's own FROM."

That justification is true only for **injected lineage leaves** (side aliases a user subquery
would not reuse). It was **false for user-authored qualified refs** whose qualifier collides with a
side alias or a side's table name: SQL innermost-scope rules bind such a ref to the inner
subquery's FROM, but the qualifier-only strip mis-routed it.

The fix threads a **FROM-alias shadow set** through the strip's descent:

- **`scope-transform.ts`** — two new exports:
  - `collectFromAliases(from)` — lowercased FROM aliases a clause binds. **Never null, no
    `PlanningContext`**: an alias is always statically known (`table → alias ?? table.name`,
    `subquerySource → alias`, `functionSource → alias ?? name.name`, `join → union`), so an
    unresolvable source (`select *` / TVF / CTE) still shadows its own alias — no taint signal.
  - `transformAliasScopedExpr(expr, substitute)` + module-private `transformAliasScopedQuery` —
    an alias-only structural descent **parallel to** `transformScopedQuery`. It threads ONLY an
    alias set (no column-name shadow set, no taint, no reject), and **clones DML…RETURNING
    subqueries through** via the existing `cloneDmlStmt` (no substitution, no reject) — byte-
    matching the strip's prior `mapQueryExprUniform` behavior. Scope rules mirror
    `transformScopedQuery`: a select's own FROM aliases join the set for its clauses + nested
    subqueries; a compound/union leg keeps the *incoming* set (`onLeg`); VALUES (no FROM) keeps it.
- **`multi-source.ts`** — `stripSideQualifier`'s substitute now takes `(col, aliasShadow)` and
  **short-circuits `if (aliasShadow.has(col.table)) return undefined`** *before* the
  owning/other qualifier sets, then descends via `transformAliasScopedExpr` instead of
  `transformExpr(… mapQueryExprUniform …)`. No new ctx param. At depth 0 `aliasShadow` is empty,
  so behavior is **byte-identical for every non-colliding statement**.
- Docstrings (`stripSideQualifier`, `substituteViewColumns`) and `docs/view-updateability.md`
  § Inner Join corrected: the strip is qualifier-driven **but alias-scope-aware**; only injected
  lineage leaves are guaranteed collision-free.

## Why a parallel descent (design decision to scrutinize)

Chosen over extending `transformScopedQuery` because the strip's decision is alias-only and must
**preserve DML-subquery clone-through** (the scoped descent instead `rejectDmlSubquery()`s).
Routing the strip through the shared `ScopeContext` would have changed the shared
`makeSubstitute` signature for all three callers and coupled the strip to column-name/taint
semantics it never reads. **Tradeoff to weigh in review:** the alias-accumulation / compound-leg
/ values scope rules in `transformAliasScopedQuery` are **duplicated** from `transformScopedQuery`.
They are simple and co-located in the same module (kept visibly parallel), but a future scope-rule
change must touch both. Confirm the two stay in correspondence.

## Validation

- `yarn workspace @quereus/quereus test` → **6042 passing, 9 pending, 0 failing**. `yarn typecheck`
  clean. `yarn lint 'src/**/*.ts' 'test/**/*.ts'` clean.
- **TDD pre-fix red confirmed empirically:** with the alias-shadow short-circuit disabled, uq-17
  fails with `QuereusError: p.score isn't a column` (the mis-routed read of `score` from the
  partner `parent` base) — exactly the predicted bug. Restored; suite green again.

### New tests (test/logic/93.4-view-mutation.sqllogic, after uq-16)

| test  | collision kind        | pre-fix behavior (the bug)                                  | role |
|-------|-----------------------|-------------------------------------------------------------|------|
| uq-17 | **partner-alias** `p` | routes `p.score` → `parent` capture → `p.score isn't a column` | regression (red pre-fix, **observed**) |
| uq-18 | **owning-alias** `c`  | strips `c.v`→bare `v` → ambiguous across inner cross-join    | regression (red pre-fix, reasoned) |
| uq-19 | **table-name** `uq19_parent` | routes `uq19_parent.av` → parent capture (no `av`)   | regression (red pre-fix, reasoned) |
| uq-20 | compound-leg scoping  | (passes both) leg A's `p` must NOT shadow leg B's genuine `p.pv` | guards `onLeg` keeps incoming set, not `inner` |
| uq-21 | non-colliding `q`     | (passes both) genuine partner `p.pv` still routes           | guards the fix **narrows**, not removes, routing |

uq-17 is the headline (correlated `where p.k = cid`, the ticket's example). uq-20/uq-21 are
*implementation* guards (green on both old and new code) — they prove the new descent doesn't
over-shadow into sibling legs and doesn't suppress legitimate non-colliding routing.

## Honest gaps / what a reviewer should probe

- **Only uq-17's pre-fix failure was directly observed** (the file runs with `--bail`, so it
  stops at the first red). uq-18 and uq-19's pre-fix failures are reasoned (ambiguous-bare-column
  plan error; partner-capture missing-column error), not separately observed. A reviewer wanting
  full empirical coverage can disable the short-circuit and run uq-18/uq-19 in isolation.
- **Edge cases handled by the descent but NOT given a dedicated sqllogic case** (the mechanism
  covers them structurally; consider whether any warrant an explicit test):
  - **Derived-table double nesting** `from (select … from points p) q` — `q` shadows at this
    level, `p` one level deeper (via `rebuildFrom`→`onNested` into the subquerySource body).
  - **functionSource/TVF alias** shadowing (`collectFromAliases` uses `alias ?? name.name`).
  - **values-source subquery** (`in (values …)`) — no FROM, keeps enclosing alias set.
  - **DML…RETURNING value subquery** clone-through unchanged (not regressed to `rejectDmlSubquery`).
  - **Depth accumulation**: a collision two levels down shadows that depth and below only, while a
    shallower sibling reference to the *genuine* partner alias still routes (uq-20 exercises the
    sibling-still-routes half via union legs, but not the multi-level-deep half).
- **uq-18 robustness:** the divergence relies on the inner cross-join making bare `v` ambiguous
  (a plan-time error). Data is set so even a leftmost-wins resolver would read `uq18_first.v=99 ≠
  42`, so the assertion (42) catches the bug either way — but it's worth confirming the engine
  errors rather than silently resolving.
- **Cross-source semantics unchanged:** uq-1/uq-10/uq-13 (capture + dedup + cardinality gate)
  must stay green — they do — but a reviewer should confirm `routePartnerRead` still fires for
  genuine non-shadowed partner reads at depth (uq-21 asserts this).

## Use cases to exercise during review

```sql
-- partner-alias collision: `p` is BOTH a join side and an inner FROM alias
create view v as select c.cid as cid, cval, pv from child c join parent p on p.pid = c.pref;
update v set cval = (select max(p.score) from points p where p.k = cid) where cid = 2;
--                              ^ points.score (local), NOT routed to parent.score

-- owning-alias collision: inner `from things c` (owning side alias is `c`)
update v set cval = (select c.v from first f cross join things c) where cid = 1;
--                          ^ things.v (local), NOT stripped to bare

-- table-name collision: side `parent p`; inner aliases another table AS the table name
update v set cval = (select av from aux parent where parent.aid = cid) where cid = 2;
--                                                   ^ aux.* (local), NOT routed
```
