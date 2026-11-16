description: Renaming a table column can rewrite a reference that actually reads a like-named column from a table function (such as json_each) or from a WITH-clause query, so a CHECK constraint or a saved view silently starts reading the wrong column; dropping the column can be refused for the same mistaken reason.
architecture: docs/sql-alter.md
files:
  - packages/quereus/src/schema/rename/column-rename.ts      # collectFromBindings: 'functionSource' arm and the non-exposing CTE branch of the 'table' arm push no FrameSource; unqualifiedRefBinding's shadow scan
  - packages/quereus/src/schema/rename/shared.ts             # ResolveColumnInSource — the only catalog question the walk can ask today
  - packages/quereus/src/schema/column-source-resolver.ts    # catalog-backed resolver every walk caller passes
  - packages/quereus/src/func/registration.ts                # table-valued functions declare returnType.columns
  - packages/quereus/src/schema/schema-differ.ts             # declared-world resolver (resolveDeclaredColumn) — any new question needs an answer here too
  - docs/sql-alter.md                                        # "Known limit — a function source or a non-exposing CTE"
  - docs/sql-ddl.md                                          # same limit, assertion bullet
repro: verified
severity: wrong-result
likelihood: unusual
tradeoffs: Both shapes need a bare column name that collides with the altered table's column inside a subquery, and qualifying the reference already avoids it; the function arm needs a new catalog question (a table function's output columns) threaded through every caller, including the schema differ.
----

# Column verbs capture a bare ref that binds through a function source or a non-exposing CTE

## What happens

`ALTER TABLE … RENAME COLUMN` and `ALTER TABLE … DROP COLUMN` share one scope-aware walk over stored bodies (`packages/quereus/src/schema/rename/column-rename.ts`). For each select it records which FROM sources bind which qualifiers and — for sources whose column set it can work out — which columns they publish (`ScopeFrame.sources`). A bare column ref that matches the renamed column is followed outward through the frames; a frame with a non-target source publishing that name stops the walk ("the ref binds here"), otherwise the first frame binding the target captures it.

Real tables and inline subquery sources are askable. Two kinds of FROM source are not, so a bare ref that binds only through one of them walks past it and is captured by an enclosing binding to the altered table:

1. **Table-valued function source** (verified 2026-11-16):
   ```sql
   create table t (id integer primary key, value integer, check ((select min(value) from json_each('[1]')) > 0));
   insert into t values (1, -1);           -- ok: min(json value) = 1
   alter table t rename column value to val;
   insert into t values (2, -1);           -- ERROR: CHECK constraint failed: ... (select min(val) from json_each('[1]')) > 0
   ```
   The CHECK now tests the written row's own column. `alter table t drop column value` is refused for the same reason (same walk).

2. **CTE source that does not re-expose the renamed column** (verified 2026-11-16):
   ```sql
   create table t (id integer primary key, v integer); insert into t values (1, 5);
   create table u (id integer primary key, v integer); insert into u values (1, 9);
   create view vw as with c as (select v from u) select id from t where exists (select 1 from c where v > 8);
   select * from vw;                        -- [{id: 1}]
   alter table t rename column v to w;
   select * from vw;                        -- no rows: body is now `... from c where w > 8`, reading t.w
   ```
   The view keeps planning, so nothing reports the change.

Qualified references are not affected: both kinds of source register their qualifier, so `j.value` / `c.v` resolve correctly.

## Expected

A bare ref binds the innermost FROM source that publishes its name, as the planner resolves it. Neither verb should treat it as a reference to the altered table when an inner function source or CTE source publishes that name.

## Where the fix goes

`collectFromBindings` in `column-rename.ts` — the same site that was fixed for subquery sources (`bug-column-verbs-blind-to-star-over-subquery-source`), which introduced `FrameSource { key, publishes(colLower) }`:

- **CTE arm**: a non-exposing CTE source currently only lands in `ctesShadowingSource`. It can push a `FrameSource` whose `publishes` answers from `cte.columns` or from the CTE body via `queryPublishesColumn`, the same way a subquery source does. The frame needs the CTE's AST (today `ctesInScope` holds only names), and a `with recursive` CTE whose body stars over itself needs a cycle guard.
- **Function arm**: needs a new question the walk cannot answer from the AST — the function's declared output columns (`returnType.columns` on the registered table-valued function, or the explicit `f(a, b)` column list when present). That means a resolver alongside `ResolveColumnInSource`, passed by every caller, with an answer in the schema differ's declared-world resolver too.
