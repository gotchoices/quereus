description: Single-source view-DML descent substitutes a nested view-column reference to an *unqualified* base term (`note` → bare `lbl`). Inside a lowered subquery whose FROM has a source that also defines that base name, the unqualified term re-binds to the local source (innermost SQL scoping) instead of correlating to the outer base row — a confirmed silent wrong write. Fix: qualify the single-source substituted base term with the base table name in the subquery-descent path only, so it correlates to the outer (UPDATE/DELETE target) row. Multi-source already alias-qualifies its terms and stays unaffected.
prereq:
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Confirmed reproduction (fix-stage)

Both shapes below were reproduced against HEAD on branch `view-updates-lens` via the
sqllogic harness (`node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/logic.spec.ts" --grep "<file>"`).

**Shape 1 — substituted base term re-binds to a same-base-name subquery-local source (silent wrong write):**

```sql
create table p1_t (id integer primary key, lbl text);
create table p1_aux (k text, lbl text);
insert into p1_t values (1, 'A'), (2, 'B');
insert into p1_aux values ('A', 'X'), ('Q', 'Q');
create view p1_v as select id as id, lbl as note from p1_t;

update p1_v set note = 'CHANGED' where exists (select 1 from p1_aux where k = note);
select id, lbl from p1_t order by id;
-- expected [{id:1,lbl:'CHANGED'},{id:2,lbl:'B'}]
-- ACTUAL   [{id:1,lbl:'CHANGED'},{id:2,lbl:'CHANGED'}]   <-- BOTH rows wrongly written
```

`note` → bare `lbl`; inside EXISTS the bare `lbl` binds to `p1_aux.lbl` (innermost), so the
predicate becomes the uncorrelated `p1_aux.k = p1_aux.lbl`, true for the `('Q','Q')` row →
every outer row passes.

**Shape 2 — `where lbl = note`, both collapse to a base-name local (silent wrong write):**

```sql
create table p2_t (id integer primary key, lbl text);
create table p2_aux (k text, lbl text);
insert into p2_t values (1, 'A'), (2, 'B');
insert into p2_aux values ('A', 'A'), ('Q', 'Q');
create view p2_v as select id as id, lbl as note from p2_t;

update p2_v set note = 'CHANGED' where exists (select 1 from p2_aux where lbl = note);
select id, lbl from p2_t order by id;
-- expected [{id:1,lbl:'CHANGED'},{id:2,lbl:'B'}]
-- ACTUAL   [{id:1,lbl:'CHANGED'},{id:2,lbl:'CHANGED'}]   <-- both wrongly written
```

`note` → bare `lbl`; the literal `lbl` already binds `p2_aux.lbl`, so the predicate is the
always-true `p2_aux.lbl = p2_aux.lbl`.

> Note on the `No row context found for column lbl` surface mentioned in the source ticket:
> the fix-stage probe did not pin an exact query that raises it (the variants tried either
> correlated correctly — when the subquery source has no `lbl` — or silently mis-wrote as
> above). It is the same root cause (an unqualified substituted base term resolving by local
> scope) and the qualification fix below addresses it. If the implementer pins a precise
> raising shape, add it as a positive case; otherwise the two confirmed shapes are sufficient.

## Fix validation (fix-stage)

The qualified-term hypothesis was validated against the *plain* (non-view) equivalent, which
already qualifies the correlation — it correlates to the UPDATE target even when the subquery
FROM has its own `lbl`:

```sql
-- (p1_t / p1_aux as above, no view)
update p1_t set lbl = 'CHANGED' where exists (select 1 from p1_aux where k = p1_t.lbl);
-- -> only row 1 changes.  PASSES today.
```

So qualifying the single-source substituted base term with the base table name
(`analysis.baseTable.name`, which is exactly the table named by the lowered UPDATE/DELETE —
`tableIdentifier(analysis.baseTable)`, no synthesised alias) makes the nested reference
correlate to the outer row regardless of what the subquery FROM defines.

## Root cause

`single-source.ts` builds `analysis.columnMap` with **unqualified** base terms
(`columnExpr(baseColumnName)` / `normalizeBaseRefs(...)` strips the body's alias). `makeViewSubstitute`
correctly *decides* (scope-aware) to substitute a correlated nested view-column reference, but the
replacement it emits is that unqualified base term. Inside the lowered subquery, an unqualified ref
resolves by ordinary SQL scoping and re-binds to a same-named local source.

Multi-source (`multi-source.ts`) is unaffected because its `viewColToBaseRef` terms are **alias-qualified**
(`p.label`), which already correlate to the join body that becomes the identifying subquery's FROM.

## Fix direction — qualify in the subquery-descent path ONLY (surgical)

`makeViewColumnDescend` / `transformQueryExpr` / `makeViewSubstitute` are **shared** between the
single-source rewriters and the multi-source spine (one call site: `multi-source.ts`
`substituteViewColumns`, line ~824). So **do NOT** globally re-qualify `analysis.columnMap`, and do
NOT change the top-level `remapper` path:

- The top-level `remapper` substitution (used directly on the user's top-level WHERE / SET and the
  RETURNING projection columns) resolves fine today because the lowered statement has exactly one
  source — leave it emitting unqualified terms (no top-level / RETURNING-projection regression).
- Force-qualifying every replacement would break multi-source (two sources, alias-qualified terms,
  no single base-table correlation name).

Instead thread an optional **base qualifier** through the descent and qualify only the replacement
emitted *inside a subquery operand*:

1. Add `qualifyUnqualifiedRefs(expr, qualifier)` (shallow — mirrors `normalizeBaseRefs`: it does NOT
   descend into nested subqueries within the replacement, since a lineage term's own scalar subquery
   has its own scope):

   ```ts
   function qualifyUnqualifiedRefs(expr: AST.Expression, qualifier: string): AST.Expression {
     return transformExpr(expr, (col) => col.table ? undefined : { ...col, table: qualifier });
   }
   ```

2. Add an optional `baseQualifier?: string` parameter to `makeViewColumnDescend`,
   `transformQueryExpr`, and `makeViewSubstitute` (thread it through unchanged at every recursion —
   `onNested` / `onLeg` / the `values` branch).

3. In `makeViewSubstitute`, when a replacement is returned (both the `view.col`-qualified branch and
   the unqualified-correlated branch) and `baseQualifier` is set, return
   `qualifyUnqualifiedRefs(repl, baseQualifier)` instead of the raw `columnMap.get(name)`. Return a
   *fresh* expression (do not mutate the shared `columnMap` entry — `qualifyUnqualifiedRefs` already
   returns a new tree; `transformExpr` clones it again, which is harmless).

4. Single-source call sites (`rewriteViewUpdate`, `rewriteViewDelete`, `rewriteViewReturning`) pass
   `analysis.baseTable.name` as `baseQualifier`.

5. Multi-source call site (`substituteViewColumns`) passes `undefined` — its terms are already
   alias-qualified, so qualification must not apply (and `qualifyUnqualifiedRefs` would be a no-op on
   them anyway, but pass `undefined` to keep the multi-source path byte-identical).

### Why this resolves the repro
- Shape 1: `note` → `p1_t.lbl`; EXISTS predicate becomes `p1_aux.k = p1_t.lbl`, correlated to the
  outer base row → only row 1.
- Shape 2: `note` → `p2_t.lbl`; the literal `lbl` still binds `p2_aux.lbl`; predicate becomes
  `p2_aux.lbl = p2_t.lbl`, correlated → only the matching row.

### Negative control already holds
The descent only ever substitutes references whose *name is a view column* (a `columnMap` key, e.g.
`note`). A bare base-name reference (`lbl`) inside the subquery is never substituted, so a
subquery-local source that genuinely defines `lbl` keeps binding locally — unchanged by the fix.

## Known residual corner (out of scope — document, do not fix here)
If the subquery FROM references the **same base table by name** (e.g.
`update p1_v ... where exists (select 1 from p1_t where ...)`), the base-table-name qualifier
(`p1_t.lbl`) binds to the innermost local `p1_t`, not the outer UPDATE target — an inherent SQL
self-reference scoping ambiguity that the single-source lowering (no alias on the target) cannot
disambiguate. This is no worse than the pre-fix behaviour and is rare; note it in the § Selection
doc as a known corner rather than expanding scope. (A future hardening could synthesise an alias on
the lowered target.)

## Acceptance
- The two confirmed repro shapes update the correct single row.
- New `93.4-view-mutation.sqllogic` cases cover: shape 1 (EXISTS, base-name local source), shape 2
  (`where lbl = note` with base-name local source), and a **negative control** where a subquery-local
  source genuinely defines the base name and a bare reference to it must stay local (analogous to
  existing case (c) but on the base name).
- Existing 93.4 cases (a)–(f) and the whole single-/multi-source suite still pass.
- Full `yarn test` + `yarn lint` green.
- `docs/view-updateability.md` § Selection note (lines ~196–213) updated: single-source substituted
  base terms are now correlation-qualified to the base table inside subquery operands (so the residual
  silent-rebind on the *base term* is closed); add the self-reference corner above as a known limit.

## TODO
- Add `qualifyUnqualifiedRefs(expr, qualifier)` to `single-source.ts`.
- Thread optional `baseQualifier?: string` through `makeViewColumnDescend` → `transformQueryExpr`
  → `makeViewSubstitute`; qualify both return branches in `makeViewSubstitute` when set.
- Pass `analysis.baseTable.name` from `rewriteViewUpdate` / `rewriteViewDelete` / `rewriteViewReturning`;
  pass `undefined` from `multi-source.ts` `substituteViewColumns`.
- Add the three sqllogic cases (shape 1, shape 2, base-name negative control) to
  `93.4-view-mutation.sqllogic`, in the § "View-column references nested inside subquery …" block.
- Update `docs/view-updateability.md` § Selection note + record the self-reference corner.
- Run `yarn test` and `yarn lint` (quereus package); confirm green.
