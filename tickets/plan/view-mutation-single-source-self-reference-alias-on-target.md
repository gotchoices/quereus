description: Close the documented same-base-table self-reference corner in single-source view-mutation subquery rewriting by synthesising an alias on the lowered statement's target, so a correlation-qualified base term no longer binds the innermost local source when the user subquery FROM names the same base table.
files: packages/quereus/src/planner/mutation/single-source.ts, docs/view-updateability.md, packages/quereus/test/logic/93.4-view-mutation.sqllogic

## Background

The single-source view-mutation rewriter (`single-source.ts`) correlation-qualifies
a substituted base *term* emitted inside a subquery operand with the **base table
name** (e.g. `p1_t.lbl`), so it correlates to the outer UPDATE/DELETE target row
rather than re-binding to a same-named source the subquery's own FROM introduces.
This was hardened twice:

- `view-mutation-single-source-subquery-base-term-local-rebind` — introduced the
  base-table-name qualifier (shallow, top-level only).
- `view-mutation-computed-lineage-correlated-subquery-deep-rebind` — made the
  qualifier scope-aware and DEEP (descends into a computed lineage's own nested
  scalar subquery, qualifying only base columns not shadowed by the lineage FROM).

Both qualify with the **base table name itself** — there is no synthesised alias on
the lowered single-source target.

## The corner (unfixed)

When the **user subquery FROM names the same base table** as the lowered target:

```sql
create view p1_v as select id as id, lbl as note from p1_t;
update p1_v set note = 'X' where exists (select 1 from p1_t where p1_t.k = note);
--                                                    ^^^^ same base table
```

The substituted term `note` → `p1_t.lbl`. But the subquery's own FROM is **also**
`p1_t`, so by ordinary innermost-scope SQL rules the qualifier `p1_t.lbl` binds the
**inner** `p1_t` (the subquery's FROM), not the outer UPDATE target row. The
predicate silently becomes uncorrelated → a **silent wrong write** (the EXISTS no
longer correlates to the outer row).

This is an inherent SQL self-reference scoping ambiguity that the base-table-name
qualifier cannot disambiguate, because the lowered single-source statement puts **no
alias** on its target. It is:

- **rare** (the user subquery must FROM the exact same base table the view lowers to),
- **no worse than pre-fix behaviour** (the shallow qualifier had the same blind spot),
- **documented** in `docs/view-updateability.md` § Selection as a "Known corner
  (unfixed)".

The deep scope-aware qualification from the deep-rebind ticket is **orthogonal** to
this corner — it fixes *whether* nested refs get qualified, not *which name* they are
qualified with. Closing this corner is purely about giving the lowered target a
distinct, collision-proof correlation name.

## Desired behaviour

A write through a single-source view must correlate to the outer target row even when
the user subquery FROM names the same base table. Either:

- synthesise a unique alias on the lowered single-source target (the statement that
  today names the bare base table) and qualify substituted subquery-descent terms
  with **that alias** instead of the bare base table name — the alias cannot collide
  with any user-introduced FROM source; or
- detect the same-base-table collision during the subquery descent and reject loudly
  with `unsupported-subquery-correlation` rather than silently mis-bind (a strictly
  smaller, fail-loud alternative if the alias synthesis proves invasive).

The alias approach is preferred (it fixes rather than rejects), but it touches the
base-statement lowering (target naming) and every place that assumes the target is
named by the bare base table — hence deferred from the deep-rebind ticket, which
deliberately kept its change confined to the AST-rewrite qualifier and out of the
lowering.

## Acceptance

- A repro of the shape above (user subquery FROM = the view's own base table) writes
  the correct row(s) — or, if the reject alternative is chosen, raises
  `unsupported-subquery-correlation` rather than silently mis-writing.
- The `93.4-view-mutation.sqllogic` blocks (g)–(o) and the deep-rebind guards stay
  green (the alias must not regress the existing base-table-name correlation cases).
- `docs/view-updateability.md` § Selection "Known corner (unfixed)" note is updated to
  reflect the fix (removed if closed, or narrowed to the reject case).
