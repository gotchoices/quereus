description: A single-source updateable view's COMPUTED column whose base-term lineage contains a correlated scalar subquery (`(select x from oth where fk = id) as note`) silently mis-writes when that view column is referenced inside a user UPDATE/DELETE subquery operand. The descent substitutes the lineage subquery, but `qualifyUnqualifiedRefs` is shallow — it only qualifies the replacement's TOP-LEVEL refs, and the replacement is a `subquery` node with no top-level column ref, so the lineage's own correlation ref (`id`) is left unqualified. Emitted inside the user subquery whose FROM introduces a same-named column, `id` re-binds to the innermost local source instead of the outer target row → confirmed silent wrong write. Fix: make the substituted-term qualification scope-aware and DEEP — descend into a nested subquery within the replacement and qualify only refs that are base-table columns AND not shadowed by the lineage subquery's own FROM.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Confirmed reproduction (verified in fix stage)

```sql
create table cv_base (id integer primary key, lbl text);
create table cv_oth (fk integer, x text);
create table cv_src (id integer, tag text);
insert into cv_base values (1, 'A'), (2, 'B');
insert into cv_oth values (1, 'AA'), (2, 'BB');
insert into cv_src values (99, 'AA');
create view cv_v as select id as id, lbl as lbl,
    (select x from cv_oth where fk = id) as note from cv_base;
update cv_v set lbl = 'CHANGED' where exists (select 1 from cv_src where tag = note);
select id, lbl from cv_base order by id;
-- correct: [{id:1,lbl:'CHANGED'},{id:2,lbl:'B'}]
-- buggy  : [{id:1,lbl:'A'},{id:2,lbl:'B'}]  (nothing changes)
```

Ran this as a scratch sqllogic file against HEAD on branch `view-updates-lens`:
fails with `row 0 mismatch. Actual {id:1,lbl:'A'} Expected {id:1,lbl:'CHANGED'}`.
The substituted lineage `(select x from cv_oth where fk = id)` is emitted inside
`select 1 from cv_src where tag = …`; the inner `id` is left unqualified and binds
to `cv_src.id` (=99) by innermost-scope rules → `note` evaluates to NULL → the
`exists` is false for every row → silent no-op.

## Root cause (precise)

`single-source.ts`:

- `makeViewSubstitute.resolve(name)` (≈ line 336) fetches the view column's
  base-term replacement from `columnMap` and, when a `baseQualifier` is set (the
  single-source descent path), runs it through `qualifyUnqualifiedRefs(repl, baseQualifier)`.
- `qualifyUnqualifiedRefs(expr, qualifier)` (≈ line 289) is
  `transformExpr(expr, col => col.table ? undefined : {...col, table: qualifier})`
  with **no `descend` argument**, so `transformExpr` passes any `subquery` /
  `exists` / `in`-subquery operand through structurally (see `transformExpr`'s
  `case 'subquery'`: `descend ? descend(...) : expr.query`). The lineage
  `(select x from cv_oth where fk = id)` is a `subquery` node with no top-level
  column ref, so qualification touches nothing — the inner `id` is never reached.

For a `base`-kind lineage the replacement is a bare `column` node, so the
shallow qualifier already does the right thing (cases g/h/i/j in 93.4 — green and
must stay green). The gap is exclusively the computed-lineage-with-nested-subquery
shape.

## Required fix — scope-aware DEEP qualification

Replace the shallow `qualifyUnqualifiedRefs` (on the substituted-term path only)
with a scope-aware descent that mirrors the `collectFromColumnNames` / `shadowed`
logic already in `transformQueryExpr`:

- At the top level of the replacement (no enclosing FROM within the replacement),
  qualify every unqualified ref **that is a base-table column** with the base
  table name. (Restricting to base columns changes nothing for valid inputs — a
  `normalizeBaseRefs`-normalized lineage's top-level refs are all base columns —
  and is the principled gate the design constraints call for.)
- Descend into a nested `subquery` / `exists` / `in`-subquery within the
  replacement. For each nested `select`, resolve its FROM's column names via the
  existing `collectFromColumnNames(ctx, sel.from)` and add them to a `shadowed`
  set. Inside that scope, an unqualified ref is qualified **only if** it is a base
  column AND not in `shadowed`. So in `(select x from cv_oth where fk = id)`:
  `x` / `fk` are shadowed by `cv_oth` → left local; `id` is a base column, not
  shadowed → qualified to `cv_base.id`. Result:
  `(select x from cv_oth where fk = cv_base.id)`, which correlates to the outer
  target row regardless of the user subquery's FROM.
- **Taint:** if a nested FROM is unresolvable (`collectFromColumnNames` returns
  `null` — a `select *` source / TVF / CTE), shadowing cannot be proven. Reject
  with `raiseMutationDiagnostic({ reason: 'unsupported-subquery-correlation', … })`
  rather than risk an over- or under-qualify silent wrong write — consistent with
  the existing taint philosophy on the user-subquery side. (Unreachable for the
  base/g-h-i-j cases, which have no nested FROM in the replacement, so no
  regression.)

### Suggested shape (threading)

Swap the threaded `baseQualifier?: string` for a closure built at the call site
where `analysis` (hence `analysis.baseTable`) is in scope:

```ts
// callers (rewriteViewUpdate / rewriteViewDelete / rewriteViewReturning) build:
const baseQualify = makeBaseQualifier(ctx, analysis.baseTable);   // or undefined for multi-source
makeViewColumnDescend(ctx, analysis.columnMap, view.name, view, baseQualify);

function makeBaseQualifier(ctx: PlanningContext, baseTable: TableSchema):
    (repl: AST.Expression) => AST.Expression {
  const baseCols = new Set(baseTable.columns.map(c => c.name.toLowerCase()));
  return (repl) => qualifyCorrelatedBaseRefs(ctx, repl, baseTable.name, baseCols, new Set());
}

// resolve() in makeViewSubstitute becomes:
const repl = columnMap.get(name);
return repl && baseQualify ? baseQualify(repl) : repl;
```

`qualifyCorrelatedBaseRefs(ctx, expr, qualifier, baseCols, shadowed)` =
`transformExpr(expr, substitute, descend)` where `substitute` qualifies an
unqualified base-col ref not in `shadowed`, and `descend` recurses through a
parallel `qualifyCorrelatedBaseRefsQuery` that, for a `select`, computes
`local = collectFromColumnNames(ctx, sel.from)` (reject on `null`), forms
`innerShadow = shadowed ∪ local`, and rebuilds via the existing `rebuildSelect`
(onExpr uses `innerShadow`; onNested inherits `innerShadow`; onLeg keeps the
incoming `shadowed` — a compound/union leg is a sibling, not nested). `values`
bodies keep the incoming `shadowed`. This reuses `collectFromColumnNames` /
`rebuildSelect` verbatim — only the substitute predicate differs from
`transformQueryExpr` (qualify-base-col vs. substitute-view-col).

The multi-source spine passes `baseQualify = undefined` (its terms are already
alias-qualified — `p.label`), so it is untouched. The top-level (non-subquery)
WHERE / SET / RETURNING path is unchanged because `baseQualify` is invoked only
through `resolve` on the descent path, exactly where the old `baseQualifier` was.

### Optional: also close the self-reference corner (alias-on-target)

The bare-table-name qualifier still mis-binds in the documented self-reference
corner (`update p1_v … where exists (select 1 from p1_t …)`, doc § Selection
"Known corner"). The deep fix above does NOT need the alias to fix THIS ticket's
reproduction (the user subquery FROM is never the base table here), so keep it
optional. If the implementer chooses to fold it in: synthesise an explicit alias
on the lowered single-source UPDATE/DELETE target and pass that alias (instead of
`baseTable.name`) as the qualifier — an aliased target name cannot collide with a
subquery-local source. If done, update the "Known corner (unfixed)" note in
`docs/view-updateability.md` to "closed". This is a judgement call; the deep
scope-aware qualification is the required fix either way (the alias only changes
WHICH name to qualify with, not WHETHER nested refs get qualified).

## Tests to add (93.4-view-mutation.sqllogic, after block (j))

- **(k) the repro** — computed lineage with a correlated subquery, referenced
  inside a user EXISTS subquery whose FROM (`cv_src`) shadows the lineage's
  correlation column (`id`). Assert `[{id:1,lbl:'CHANGED'},{id:2,lbl:'B'}]`.
  MUST fail before the fix (verified: it does).
- **(l) negative control — no over-qualify** — same computed-lineage view, but a
  user subquery whose FROM does NOT shadow the lineage's correlation column (a
  lookup table with no `id`), e.g. `where exists (select 1 from cv_ok where tag = note)`
  with `cv_ok(tag)` holding only `'AA'`. Asserts only the matching row writes,
  guarding against the fix wrongly deep-qualifying the genuinely-local `fk` / `x`
  to `cv_base.fk` / `cv_base.x` (which would error — `cv_base` has no such
  columns — or mis-evaluate). Passes pre- AND post-fix; its job is regression
  guarding.
- **(m) DELETE variant** — the repro shape on the delete path
  (`delete from cv_v where exists (select 1 from cv_src where tag = note)`),
  confirming the descent qualifier is threaded through `rewriteViewDelete` too.
  Assert only row 1 is deleted.

## Out of scope

- Bare-base-term shallow case (g/h/i/j) — already fixed and guarded; must stay green.
- The same-base-table self-reference corner — documented separately; close it
  only if the optional alias-on-target approach is taken (and update the doc).

## TODO

- [ ] Add `qualifyCorrelatedBaseRefs` + `qualifyCorrelatedBaseRefsQuery` to
      `single-source.ts` (scope-aware deep qualify, reuse `collectFromColumnNames`
      / `rebuildSelect`); reject-on-taint via `raiseMutationDiagnostic`.
- [ ] Replace the threaded `baseQualifier?: string` with a `baseQualify?` closure
      (`makeBaseQualifier`) through `makeViewColumnDescend` → `transformQueryExpr`
      → `makeViewSubstitute.resolve`; multi-source passes `undefined`.
- [ ] Remove (or repurpose) the now-shallow `qualifyUnqualifiedRefs`.
- [ ] Add tests (k)/(l)/(m) to `93.4-view-mutation.sqllogic`.
- [ ] Update `docs/view-updateability.md` § Selection: describe the scope-aware
      DEEP descent (it currently says "shallow … does NOT descend into a nested
      subquery"); decide and note the self-reference-corner status.
- [ ] Decide on the optional alias-on-target approach; if taken, update the
      "Known corner" note to closed.
- [ ] `yarn workspace @quereus/quereus test` green; run lint.
