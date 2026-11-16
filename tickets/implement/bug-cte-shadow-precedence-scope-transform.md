---
description: When a query defines a temporary named result set with the same name as a real table, the analysis behind updates through views and temporary names picks the real table while query execution picks the temporary one, so such an update can quietly change the wrong rows. Make the analysis check the temporary names first, as execution already does.
architecture: docs/view-updateability.md
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts    # tableSourceColumnNames (~line 494-541) — the one site to change
  - packages/quereus/src/planner/building/select.ts             # buildFrom ~line 510-518 — the resolution order to match (cteNodes before findSchemaItem, bare names only)
  - packages/quereus/test/logic/13.10-cte-qualified-name.sqllogic # suggested home for the regression case (bare-name shadowing of a real table)
  - docs/view-updateability.md                                  # ~line 127 states the same-environment, same-order requirement
  - docs/vu-operators.md                                        # ~line 297 describes the cteNodes-resolves-columns enabler
difficulty: easy
repro: verified
---

# Static shadow analysis must check `cteNodes` before the catalog

## What is wrong

When a write goes through a view, a common-table-expression (CTE) name target (`with t as (…) update t …`), or an inline subquery target, the lowering runs a static pass (`collectFromColumnNames` → `fromSourceColumnNames` → `tableSourceColumnNames` in `planner/mutation/scope-transform.ts`). For each sub-query in the user's predicate it works out which column names that sub-query's own FROM sources provide. A bare column reference whose name is in that set stays local to the sub-query; one that is not is treated as a correlation to the outer target row and rewritten.

`tableSourceColumnNames` resolves a bare FROM name in this order:

1. the `ctes` map built by the static descent (with-clauses met *inside* the analysed fragment) — correct, checked first;
2. `ctx.schemaManager.findSchemaItem(...)` — the real catalog;
3. `ctx.cteNodes` — the statement's own CTEs (and injected eager-capture relations), which the predicate is planned with.

`buildFrom` (`planner/building/select.ts`) checks `cteNodes` **before** the catalog for an unqualified name. So for a bare name that is both a statement-level CTE and a real table, the analysis uses the table's columns while the plan binds the CTE. That is the non-conservative disagreement `docs/view-updateability.md` (~line 127) forbids.

## Reproduction (verified)

```sql
create table other (id integer primary key, val integer);
insert into other values (2, 20), (3, 30);
create table s (a integer primary key, b integer);
insert into s values (2, 200);

-- the read is correct: inner x binds to CTE s.x, exists is true for every row
with s as (select id as x, val as y from other),
     t as (select x, y from s)
select x, y from t where exists (select 1 from s where x = 3) order by x;
-- → both rows

-- the write is wrong: only id=3 is updated
with s as (select id as x, val as y from other),
     t as (select x, y from s)
update t set y = 5 where exists (select 1 from s where x = 3);
select id, val from other order by id;
-- expected [{"id":2,"val":5},{"id":3,"val":5}]
-- actual   [{"id":2,"val":20},{"id":3,"val":5}]   (observed)
```

The analysis sees `s` as the real table `{a, b}`, so the inner `x` is not shadowed and gets rewritten as a correlation to the target row's `x` — the predicate becomes "this row's x = 3". Without the real table `s` the same update correctly touches both rows.

Hypothesis confirmed by experiment: inserting the `ctx.cteNodes` lookup ahead of `findSchemaItem` (experiment reverted afterwards) made the update touch both rows.

## Fix

In `tableSourceColumnNames`, for an unqualified name, check `ctx.cteNodes` immediately after the descent `ctes` map and before `findSchemaItem`. The resulting order — descent-local with-clauses, then statement `cteNodes`, then catalog — matches `buildFrom`, because `buildWithClause` / `buildCommonTableExpr` layer inner definitions over `ctx.cteNodes` (`building/with.ts` ~line 127). Qualified names keep skipping both CTE maps.

Same site, other shapes this also fixes (worth a quick check, not necessarily a test each):

- a CTE-name target's self-read of its own name when a real table of that name exists (`with t as (…) update t … where id in (select id from t)` plus `create table t …`) — the injected eager-capture relation under `t` should win, as at plan time;
- an inline subquery target whose predicate reads a statement CTE that shadows a real table.

Views are unaffected: `storedBodyContext` clears `cteNodes`, so a view body has none to consult.

Rewrite the long comment above the `ctx.cteNodes` lookup: it currently says "A schema object of the same name was already resolved above, so this only fires for a genuine context-backed name" and then documents the precedence mismatch as a tracked bug. Replace with a short statement that the order mirrors `buildFrom` (local with-clauses, then `cteNodes`, then the catalog; qualified names skip CTEs). Check that `docs/vu-operators.md` ~line 297 ("a FROM source whose name is in `cteNodes` resolves its columns …") still reads correctly; add "before the catalog, as `buildFrom` does" if it helps.

## TODO

- Move the `ctx.cteNodes` lookup in `tableSourceColumnNames` ahead of `findSchemaItem` (unqualified names only); keep the descent `ctes` check first.
- Replace the stale precedence comment; drop the reference to this ticket's slug.
- Add the reproduction above as a regression section — suggested: append to `test/logic/13.10-cte-qualified-name.sqllogic` under a heading like "Bare name shadows a real table on the write path too". One case (the update + verifying select) is enough.
- Touch up `docs/vu-operators.md` ~line 297 if needed.
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`.
