description: Writing through a view mishandles a WITH query that reads the row being written: when the view's own filter contains one the write fails with "column not found", and when the UPDATE's own WHERE contains one that names a renamed view column, the write can silently change the wrong rows.
architecture: docs/view-updateability.md
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts  # rebuildSelect (~line 241), cloneWithClause (~line 319), mapQueryExprUniform (~line 175), transformScopedQuery (~line 731), transformAliasScopedQuery (~line 830); false comments at ~170, ~244, ~313
  - packages/quereus/src/planner/mutation/single-source.ts    # normalizeBaseRefs (~line 259) and makeViewScope (~line 405) — the two callers whose rewrite never reached WITH bodies
  - packages/quereus/test/logic/93.4-view-mutation.sqllogic   # add the regression blocks here
  - docs/view-updateability.md                                # § Schema resolution during write-through (~lines 115, 127-133)
repro: verified
----

## What happens

Two arms, same cause.

**Arm 1: the view's filter has a WITH query that reads the view's row.** The write is rejected.

```sql
create table u (id integer primary key);
insert into u values (1);
create table b (id integer primary key, x integer);
insert into b values (1, 5), (2, -5);
create view v2 as select id, x from b where (with c as (select b.x as y from u) select max(y) from c) > 0;
select id, x from v2;        -- [{"id":1,"x":5}]
update v2 set x = 100;       -- error: Column not found (b.x), from buildCommonTableExpr under buildUpdateStmt
```

The same filter written as a plain subquery (`where (select b.x from u) > 0`) can already be written through.

**Arm 2: the UPDATE's own WHERE has a WITH query that names a view column.** If the view renames the column and the base table has another column with the view column's name, the write silently changes the wrong row. Verified:

```sql
create table u (id integer primary key);
insert into u values (1);
create table b (id integer primary key, x integer, y integer);
insert into b values (1, 5, -1), (2, -5, 1);
create view v6 as select id, y as x from b;
select id from v6 where exists (with c as (select x as q from u) select 1 from c where q > 0);
-- [{"id":2}]
update v6 set x = 100 where exists (with c as (select x as q from u) select 1 from c where q > 0);
select * from b order by id;
-- actual:   [{"id":1,"x":5,"y":100},{"id":2,"x":-5,"y":1}]   (row 1 written: x bound to b.x, not b.y)
-- expected: [{"id":1,"x":5,"y":-1},{"id":2,"x":-5,"y":100}]
```

When the view column name does not also exist on the base table, the same shape fails with "Column not found" instead (e.g. `create view v5 as select id as vid, x as vx from b; update v5 set vx = vx + 1 where exists (with c as (select vid as q from w where w.k = vid) select 1 from c);`).

## Cause

A write through a view is lowered to a write on the base table. Column references in the copied pieces are rewritten on the way: the view's filter re-points `b.x` inside a subquery at the lowered target's alias `__vm_self` (`normalizeBaseRefs` → `transformAliasScopedQuery`), and a view column named in the user's WHERE / SET is replaced by its base-column expression (`makeViewScope` → `transformScopedQuery`).

Both descents rebuild each select through `rebuildSelect`, which clones the select's `with` clause through `cloneWithClause` → `cloneQueryExpr` — a pure clone with no substitution. The stated reason (comments on `mapQueryExprUniform`, `rebuildSelect` and `cloneWithClause`) is "a CTE body cannot correlate to the enclosing query". That is false: a WITH body nested inside a subquery can read the enclosing row, and the read path supports it (`07.8.2-subquery-selecting-outer-column.sqllogic`). So the CTE body keeps `b.x` (arm 1, nothing named `b` in the lowered UPDATE) or the bare view column `x` (arm 2, which then binds to the base table's own `x`).

## Fix (prototyped and verified, then reverted)

Let `rebuildSelect` take a transformer for CTE bodies, defaulting to `cloneQueryExpr`, and pass it to `cloneWithClause` in place of the hard-wired `cloneQueryExpr`. Then:

- `transformScopedQuery` and `transformAliasScopedQuery` pass their **`onLeg`** transformer. A CTE body has the same scope as a sibling compound leg: it sees the enclosing scope (incoming shadow set, taint and alias-shadow set) but not this select's own FROM, and it is planned on this select's naming environment (`buildSelectStmt` builds the `with` clause on `contextWithSchemaPath`, i.e. what the analysis calls `fromCtx`).
- `mapQueryExprUniform` passes its **`descend`**. Its substitution decides on the column's own qualifier only, so applying it inside CTE bodies is correct — e.g. `substituteNewRefs` should replace a `new.x` inside a WITH body in an authored inverse just as it does in any other subquery.
- `mapNestedSelects` keeps the default (`cloneQueryExpr`): its WITH bodies stay **unstamped** on purpose (see its NOTE and `docs/view-updateability.md` ~line 115) — `buildSelectStmt` builds a stamped select's `with` clause on the already-entered stored-body context, so the nested CTE bodies resolve in the view's home environment without a stamp.

The prototype was about 7 changed lines. With it applied, both arms above and the v5 shape produced the expected rows, and the whole logic suite (391 files) plus `view-cte-isolation.spec.ts`, `schema/clone-expr-isolation.spec.ts`, `view-home-schema.spec.ts` and `schema/table-rename-scope.spec.ts` passed.

### Consequence to be aware of (not a regression to chase)

Inside a CTE body, a FROM that names a sibling CTE (or the CTE itself, for a recursive one) is not resolvable by the static analysis, so that scope becomes tainted, and an unqualified reference whose name matches a view column is then rejected with `unsupported-subquery-correlation` instead of being left alone. The select that reads a CTE (`... from c`) already has this behaviour today; the fix extends it to CTE bodies, which before were never analysed (and so could be mis-bound, as arm 2 shows). Teaching `collectFromColumnNames` to resolve CTE names from the enclosing `with` clause (declared column list, else `projectionOutputNames`) would remove that rejection; it is a separate improvement. Put a `NOTE:` at the CTE-body hand-off in `transformScopedQuery` saying so.

## Related, not this ticket

- `bug-cte-shadow-precedence-scope-transform` (fix/) touches `tableSourceColumnNames` in the same file — different site, no ordering dependency.
- `packages/quereus/src/schema/expr-scope/walk.ts` (~lines 77, 214) and `docs/sql-ddl.md` (~line 418) make the same "a CTE body cannot correlate" claim for CHECK constraints, where it is documented behaviour ("there the name is not resolved and every write fails"). That is a separate subsystem with a deliberate, documented rule; do not change it here.

## TODO

- Add the `onCte` parameter to `rebuildSelect` and `cloneWithClause`; wire `onLeg` from `transformScopedQuery` / `transformAliasScopedQuery`, `descend` from `mapQueryExprUniform`; leave `mapNestedSelects` on the default.
- Correct the three comments making the false claim (on `mapQueryExprUniform`, `rebuildSelect`, `cloneWithClause`) and say why a CTE body takes the sibling-leg scope.
- Add the `NOTE:` about sibling-CTE names tainting a CTE body's scope (see above).
- Add two regression blocks to `test/logic/93.4-view-mutation.sqllogic`: arm 1 (view filter WITH body, `update` changes only row 1) and arm 2 (renamed view column in the UPDATE's own WITH body, the expected row is written). Use fresh table names so they do not collide with the file's existing tables.
- Update `docs/view-updateability.md`: in the static-analysis paragraphs (~127-133) state that the shadow analysis descends into a nested select's WITH bodies with the enclosing scope (like a compound leg); keep the ~line 115 statement that the stamping pass leaves them unstamped.
- Run `yarn test` and `yarn lint` (from root).
