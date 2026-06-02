description: Close the same-base-table self-reference corner in single-source view-mutation by synthesising a collision-proof alias on the lowered UPDATE/DELETE target and qualifying substituted subquery-descent base terms with that alias (instead of the bare base table name), so a correlation-qualified base term binds the outer target row even when the user subquery FROM names the same base table.
files: packages/quereus/src/parser/ast.ts, packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/building/update.ts, packages/quereus/src/planner/building/delete.ts, packages/quereus/src/planner/scopes/aliased.ts, packages/quereus/src/emit/ast-stringify.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic

## Problem

The single-source view-mutation rewriter (`single-source.ts`) correlation-qualifies a
substituted base *term* emitted inside a subquery operand with the **base table name**
(`p1_t.lbl`), because the lowered single-source statement names its target by the bare
base table and puts **no alias** on it. When the user subquery FROM names the *same*
base table the view lowers to:

```sql
create view p1_v as select id as id, lbl as note from p1_t;
update p1_v set note = 'X' where exists (select 1 from p1_t where p1_t.k = note);
--                                                    ^^^^ same base table the view lowers to
```

`note` substitutes to `p1_t.lbl`, but the subquery's own FROM is **also** `p1_t`, so by
ordinary innermost-scope SQL rules the qualifier `p1_t.lbl` binds the **inner** `p1_t`
(the subquery's FROM), not the outer UPDATE/DELETE target row. The EXISTS silently
de-correlates → a **silent wrong write**. The base-table-name qualifier cannot
disambiguate this because the target carries no distinct correlation name.

## Approach: synthesise a collision-proof alias on the lowered target

Give the lowered single-source UPDATE/DELETE target a reserved, `__`-prefixed alias
(collision-proof by the same internal-name convention as `__vmupd_keys` / `__shared_key`)
and qualify substituted subquery-descent terms with **that alias** instead of the bare
base table name. The alias cannot collide with any user-introduced FROM source, so a
`__vm_self.lbl` reference always binds the outer target row, regardless of what the
subquery FROM defines.

A single module-level constant alias suffices: lowered-target nesting cannot occur
(view-over-view, MV-over-MV, and view-over-MV are all rejected by `analyzeView`), and a
user subquery is a plain SELECT that never re-lowers, so two `__vm_self`-aliased targets
can never be in scope simultaneously.

This is **orthogonal** to the deep scope-aware qualification (`view-mutation-computed-
lineage-correlated-subquery-deep-rebind`): that fixed *whether* nested refs get
qualified; this fixes *which name* they are qualified with. Both ride the same
`makeBaseQualifyScope` / `transformScopedExpr` machinery — only the `qualifier` string
the scope emits changes (base table name → synthesised alias for UPDATE/DELETE).

### Why UPDATE/DELETE only (not INSERT)

The corner exists only where the lowered base statement has a **target-row scan** a
subquery can correlate to — i.e. UPDATE and DELETE. An INSERT base statement has no such
scan (RETURNING evaluates against NEW; a `from <base>` subquery in INSERT RETURNING is a
genuine fresh scan, not an outer-row correlation), so INSERT keeps the base-table-name
qualifier unchanged. Only `UpdateStmt` / `DeleteStmt` gain the alias field.

### Scope-resolution mechanics

`building/update.ts` and `building/delete.ts` today register the target under the bare
table name:

```ts
const tableName = tableReference.tableSchema.name.toLowerCase();
const tableScope = new AliasedScope(tableColumnScope, tableName, tableName);
```

The `AliasedScope(parent, parentName, alias)` maps `alias.col` → `parent.resolve(col)`
and delegates everything else (including unqualified `col`) to the parent. When the
lowered statement carries `stmt.alias`, register the correlation name as the alias:

```ts
const tableName = tableReference.tableSchema.name.toLowerCase();
const correlationName = stmt.alias?.toLowerCase() ?? tableName;
const tableScope = new AliasedScope(tableColumnScope, tableName, correlationName);
```

Effect (alias-only correlation name, the standard `UPDATE t AS x` semantics):
- `__vm_self.col` → resolves to the outer target row (via `AliasedScope`).
- the bare table name `p1_t.col` → no longer matches the alias, falls through the
  parent (the lowered statement's own `RegisteredScope` registered only unqualified
  names), so it binds whatever the inner subquery FROM defines — exactly the inner
  same-named source. This is what disambiguates the corner.
- unqualified `col` → still resolves to the target (the parent `RegisteredScope`
  delegate is unchanged), so the view body's normalized filter predicate and the
  substituted top-level user-WHERE / SET terms (all unqualified base terms) resolve
  correctly.

Ordinary (non-view) UPDATE/DELETE never set `stmt.alias`, so `correlationName ===
tableName` and behavior is byte-identical — the change is inert outside view-mutation
lowering.

### Threading the qualifier name

`makeBaseQualifier` / `makeBaseQualifyScope` take the qualifier name as a parameter
(default `baseTable.name`). The `rewriteViewReturning` helper takes the correlation name
too (its RETURNING-subquery descent must use the same alias the lowered statement
carries, since a RETURNING subquery can correlate to the target row the same way a WHERE
subquery can). Thread the synthesised alias from `rewriteViewUpdate` / `rewriteViewDelete`
into BOTH their where/set/assignment descend AND their `rewriteViewReturning` call.
`rewriteViewInsert` passes the base table name (unchanged).

The RETURNING / where-descend subqueries resolve `__vm_self.col` through their planning
scope chain, whose root is the `AliasedScope` registered under the alias — no extra
symbol registration is needed in the RETURNING scope (it chains to `deleteCtx.scope` /
`updateCtx.scope`).

## Acceptance

- The same-base-table self-reference repro (user subquery FROM = the view's own base
  table) writes the correct row(s) on both the UPDATE and DELETE paths (new test blocks
  (p)/(q)).
- Existing blocks (a)–(o) and the deep-rebind guards in `93.4-view-mutation.sqllogic`
  stay green: those user subqueries FROM a *different* table, and with the alias the
  substituted term becomes `__vm_self.col` (vs the old `p1_t.col`) — both resolve to the
  target the same way, so correlation is preserved with no regression.
- Ordinary (non-view) UPDATE/DELETE with a correlated subquery referencing the target by
  table name still resolve (no `stmt.alias` ⇒ correlation name is the table name).
- `docs/view-updateability.md` § Selection "Known corner (unfixed)" note is rewritten to
  describe the fix (synthesised target alias) rather than the limitation.

## Key tests (append after block (o), before the Phase 2b section at ~line 948)

```sql
-- --- (p) same-base-table self-reference: the user subquery FROM names the view's OWN
--          base table — the corner the synthesised target alias closes ---
-- The view renames base `lbl` to view column `note`; the EXISTS subquery FROM is the
-- SAME base table (sr_t). `note` substitutes to base `lbl` and is correlation-qualified.
-- A bare-base-table-name qualifier (sr_t.lbl) would bind the INNER sr_t (innermost
-- scope) -> the predicate degrades to the uncorrelated sr_t.k = sr_t.lbl, true for the
-- ('A','A') row, so EVERY outer row would pass (a silent wrong write). The synthesised
-- alias on the lowered target (__vm_self.lbl) binds the OUTER row -> the predicate is
-- the correlated sr_t.k = <outer>.lbl -> only outer row 1 (lbl 'A', matched by k='A').
create table sr_t (id integer primary key, k text, lbl text);
insert into sr_t values (1, 'A', 'A'), (2, 'Z', 'B');
create view sr_v as select id as id, lbl as note from sr_t;

update sr_v set note = 'CHANGED' where exists (select 1 from sr_t where sr_t.k = note);
select id, lbl from sr_t order by id;
→ [{"id":1,"lbl":"CHANGED"},{"id":2,"lbl":"B"}]

-- --- (q) DELETE variant — the delete path threads the same synthesised alias ---
create table dr_t (id integer primary key, k text, lbl text);
insert into dr_t values (1, 'A', 'A'), (2, 'Z', 'B');
create view dr_v as select id as id, lbl as note from dr_t;

delete from dr_v where exists (select 1 from dr_t where dr_t.k = note);
select id, lbl from dr_t order by id;
→ [{"id":2,"lbl":"B"}]
```

Expected behaviour before the fix: block (p) would write BOTH rows (uncorrelated EXISTS
true for every outer row) and (q) would delete BOTH rows — confirming the corner is a
silent wrong write the alias closes.

## TODO

### Phase 1 — AST + builders (the alias plumbing)

- Add an optional `alias?: string` field to `UpdateStmt` and `DeleteStmt` in
  `packages/quereus/src/parser/ast.ts`. Document it as **internal**: synthesised by the
  view-mutation single-source lowering to give the target a collision-proof correlation
  name; the parser does not produce it (no `UPDATE t AS x` user syntax in scope).
- In `building/update.ts`, replace the `AliasedScope(tableColumnScope, tableName,
  tableName)` construction with the `correlationName = stmt.alias?.toLowerCase() ??
  tableName` form (see § Scope-resolution mechanics). Do the same in `building/delete.ts`.
- Confirm the RETURNING scope in each builder chains to the `AliasedScope` (it does —
  `returningScope`'s parent is `*Ctx.scope`), so an alias-qualified RETURNING subquery
  term resolves with no extra registration.

### Phase 2 — single-source qualifier (use the alias)

- Add a module-level reserved alias constant in `single-source.ts`, e.g.
  `const SELF_ALIAS = '__vm_self';` (note the `__` internal-name convention = collision
  proof, same family as `__vmupd_keys`).
- Parameterize `makeBaseQualifier(ctx, baseTable, qualifierName)` and
  `makeBaseQualifyScope(baseTable, qualifierName)` on the qualifier name (default
  `baseTable.name` to keep INSERT / multi-source callers unchanged).
- Parameterize `rewriteViewReturning(..., correlationName?)` (default
  `analysis.baseTable.name`), threading it into the `makeBaseQualifier` it builds
  internally.
- In `rewriteViewUpdate`: set `alias: SELF_ALIAS` on the returned `UpdateStmt`; build the
  where/set/assignment descend with `makeBaseQualifier(ctx, baseTable, SELF_ALIAS)`; pass
  `SELF_ALIAS` to its `rewriteViewReturning` call.
- In `rewriteViewDelete`: set `alias: SELF_ALIAS` on the returned `DeleteStmt`; build the
  where descend with `makeBaseQualifier(ctx, baseTable, SELF_ALIAS)`; pass `SELF_ALIAS`
  to its `rewriteViewReturning` call.
- Leave `rewriteViewInsert` qualifying with the base table name (no target-row scan; see
  § Why UPDATE/DELETE only).
- Update the doc-comments on `makeBaseQualifier` / `makeBaseQualifyScope` / the § view-
  column descent block to say the qualifier is the lowered target's synthesised alias for
  UPDATE/DELETE (was: the bare base table name).

### Phase 3 — stringify + docs + tests

- Update `emit/ast-stringify.ts` `updateToString` / `deleteToString` to render
  `update <table> as <alias>` / `delete from <table> as <alias>` when `stmt.alias` is set
  (plan/debug fidelity; the lowered op is built directly, so this is not on the execution
  path but keeps round-trip / plan-explain output honest).
- Rewrite the `docs/view-updateability.md` § Selection "Known corner (unfixed)" note
  (~lines 293–300) to describe the fix: the lowered single-source UPDATE/DELETE target
  carries a synthesised collision-proof alias (`__vm_self`), and substituted subquery-
  descent terms are qualified with that alias, so a same-base-table self-reference
  correlates to the outer target row. Note the alias is UPDATE/DELETE-only and that the
  deep scope-aware qualification remains orthogonal (whether vs which-name).
- Add test blocks (p) and (q) to `test/logic/93.4-view-mutation.sqllogic` (see § Key
  tests) after block (o) (~line 946), before the Phase 2b section header (~line 948).
- Run `yarn workspace @quereus/quereus test 2>&1 | tee /tmp/vm-test.log; tail -n 80
  /tmp/vm-test.log` and confirm `93.4-view-mutation.sqllogic` (a)–(q) pass. Run
  `yarn workspace @quereus/quereus run lint` (single-quote globs on Windows). Run
  `yarn build` to type-check the AST + builder changes.
