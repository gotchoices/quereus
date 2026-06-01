description: A view-column reference nested inside a `subquery` / `exists` / `in`-subquery operand of a single-source view-DML predicate (or SET value) is substituted to an *unqualified* base term (e.g. view col `note` → bare `lbl`). When the subquery's FROM contains a different source that *also* has a column of that base name, the substituted ref binds to that local source (innermost SQL scoping) instead of correlating to the outer view row — a confirmed **silent wrong write**. The scope-aware descent decides *whether* to substitute correctly; the residual hole is that the *replacement* it emits is unqualified. Multi-source is unaffected (its base terms are alias-qualified).
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Background

The just-landed `view-mutation-subquery-nested-colref-substitution` work made
`transformExpr` descend into subquery operands and rewrite a nested view-column
reference to its base-term lineage, scope-aware (see
`transformQueryExpr` / `makeViewSubstitute` in `single-source.ts`). That fixed
the common silent-mis-bind. This ticket fixes the **narrower variant the
implementer flagged as residual gap #1 and which a review probe confirmed still
silently corrupts.**

## The bug (confirmed reproduction)

Single-source `columnMap` maps a view column to an **unqualified** base ref:
`note` → `{ type: 'column', name: 'lbl' }` (no table qualifier). The scope-aware
descent correctly decides to substitute (the reference is correlated to the outer
view row), but the replacement it splices in is the bare `lbl`. Inside the
lowered subquery, that unqualified `lbl` then resolves by ordinary SQL scoping —
and if the subquery's own FROM has a source with an `lbl` column, it binds
**there** (innermost) instead of correlating to the outer base row.

Minimal repro (fails today — row 2 is wrongly updated):

```sql
create table p1_t (id integer primary key, lbl text);
create table p1_aux (k text, lbl text);
insert into p1_t values (1, 'A'), (2, 'B');
insert into p1_aux values ('A', 'X'), ('Q', 'Q');
create view p1_v as select id as id, lbl as note from p1_t;

-- intended: exists (select 1 from aux where aux.k = OUTER t.lbl)  -> only row 1
-- actual:   `note` -> bare `lbl`, binds to aux.lbl -> predicate aux.k = aux.lbl,
--           true for the ('Q','Q') row, UNCORRELATED -> BOTH rows update.
update p1_v set note = 'CHANGED' where exists (select 1 from p1_aux where k = note);
select id, lbl from p1_t order by id;
-- expected [{id:1,lbl:'CHANGED'},{id:2,lbl:'B'}]
-- actual   [{id:1,lbl:'CHANGED'},{id:2,lbl:'CHANGED'}]   <-- silent wrong write
```

A closely-related shape (`where lbl = note` so both sides collapse to `lbl`)
instead raises a runtime `No row context found for column lbl` — same root cause
(unqualified base term re-binding), different surface. Both are wrong.

## Why this is the same class the parent ticket targeted

The parent ticket's entire reason for existing was to stop a nested view-column
reference from silently re-binding to a same-named base column. This residual is
that exact failure mode, just one indirection deeper: it is now the *substituted
base term* (not the original view-column name) that re-binds. It must not ship as
a known silent-corruption path.

## Fix direction (for the implementer to design)

The replacement emitted for a single-source substitution needs to **correlate
unambiguously to the outer base row**, not resolve by local scoping inside the
subquery. Options to weigh:

- **Qualify the single-source base term with the base table name** (the option the
  implementer named). `columnMap` would map `note` → `t.lbl` (or the base
  table's resolved name/alias) so the reference correlates to the outer base row
  regardless of what the subquery's FROM defines. This is the structurally
  correct analogue of the multi-source spine, whose alias-qualified base terms
  (`p.label`) already avoid this. Note the qualifier must name a relation that is
  actually in scope as the *outer* row of the lowered statement — confirm what the
  single base source is called in the rewritten statement (the base table name vs.
  a synthesised alias) so the qualifier resolves to the outer row, not a fresh
  shadow. The implementer flagged this "touches the top-level remapper path
  broadly" — verify the qualified term does not regress the **top-level**
  (non-subquery) substitution, where today the unqualified term resolves fine
  because the rewritten statement has exactly one source.

- **Or** reject conservatively (extend the taint/`unsupported-subquery-correlation`
  path) when a subquery-local source shares the *base* name of a substituted term —
  i.e. taint on the base-term name, not only the view-column name. Safer but
  narrower (turns a silent wrong write into a loud reject; loses legitimate
  queries the qualified-term fix would keep working).

Prefer the qualified-term fix if it can be made to resolve correctly to the outer
row without regressing the top-level path; fall back to the conservative reject
only if qualification proves infeasible.

## Acceptance

- The repro above updates row 1 only.
- The sibling `where lbl = note` shape resolves correctly (no `No row context`
  error) and correlates to the outer row.
- New `93.4-view-mutation.sqllogic` cases cover both shapes, plus a negative
  control where the subquery source genuinely defines the base-name column as a
  subquery-local (must stay local — analogous to existing case (c) but on the base
  name).
- Existing 93.4 cases (a)–(f) still pass; full suite + lint green.
- `docs/view-updateability.md` § Selection note updated to drop residual #1 from
  the known-gaps wording once fixed.
