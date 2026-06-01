description: Enforce view-column scope for top-level `where` / `set` / `returning` references in single-source view-mediated DML. A reference that is not a column of the *view* must raise a structured diagnostic instead of silently resolving against the underlying base table (the current encapsulation leak). Decided: **enforce, full** — all three clauses move together; base-only column names are rejected uniformly.
prereq:
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, packages/quereus/test/logic/93.2-view-mutation-pending.sqllogic, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md
effort: medium
----

## Decision (settled)

Single-source view-mediated DML currently resolves an unknown top-level column
reference against the underlying base table, so a column the view projects *away*
leaks through `where`, `set`, and (since seq 3.7) `returning`. The agreed
resolution is to **enforce view scope, fully**: a top-level column reference in
`where` / `set` / `returning` must name a column of the **view**; anything else is
a structured diagnostic. All three clauses are treated identically (no
RETURNING-only grandfathering).

This also makes the single-source path **consistent with the multi-source join
path**, which already rejects unknown columns naturally (its identifying subquery
queries the view). Confirm that parity in a test rather than assuming it.

## The leak being closed

```sql
create table t3 (id integer primary key, shown text not null, secret text);
create view sv as select id, shown from t3;          -- view exposes only (id, shown)

-- all three currently succeed against base `t3.secret`; all three must now error:
insert into sv (id, shown) values (3, 'g') returning id, secret;   -- RETURNING leak
update sv set shown = 'X'  where secret = 'classified-2';          -- WHERE leak
update sv set secret = 'leaked' where id = 1;                      -- SET leak
```

## Mechanism

`single-source.ts` rewrites *view* column references to their base-term lineage
via `remapper` + `makeViewColumnDescend` / `transformExpr`; a name that is **not**
a view column passes through unmapped and re-binds in the base scope. The fix is a
**scope guard** applied to the top-level clause expressions *before* (or as part
of) that pass-through: validate each top-level column reference against the view's
output column set; on a miss, raise the diagnostic.

Key correctness points:

- **Key off the view's output column set** (the names the view actually exposes),
  not base column names. For `select p.label as note …` the valid name is `note`;
  `label` must be rejected. A renamed/computed column's *view spelling* is the only
  legal reference.
- **View-qualified references** (`sv.secret`) must reject too, not just bare
  `secret`.
- **Scope is top-level only.** References nested inside a subquery / `exists` /
  `in`-subquery operand are out of scope here — they are handled by the separate
  in-flight fix `view-mutation-single-source-subquery-base-term-local-rebind` (the
  nested-rebind correctness ticket). Do not double-handle; keep this guard to the
  top-level clause expressions and note the boundary.
- **Do not shadow existing diagnostics.** A write to a *computed* view column must
  still surface the existing `no-inverse` diagnostic (the column *is* a view
  column, just not writable); the scope guard fires only for names that are not
  view columns at all.

## Diagnostic

Raise a structured `QuereusError` carrying a `MutationDiagnostic` with a new
`reason: 'unknown-view-column'` (extend the union in `docs/view-updateability.md` §
Diagnostics and the corresponding type), `column` set to the offending name and
`table` to the view name, with a suggestion listing the view's exposed columns.

## TODO

- Add the view-column-set scope guard in `single-source.ts`, applied uniformly to
  the top-level `where`, `set` target columns, and `returning` expressions.
- Add the `'unknown-view-column'` reason to the `MutationDiagnostic` union and emit
  it from the guard (column = offending name, table = view name, suggestion = view
  column list).
- Verify multi-source (`multi-source.ts`) already rejects an unknown top-level
  column; if the diagnostic differs, align it to the same reason/shape so the two
  paths read consistently.
- Tests (`93.4-view-mutation.sqllogic`, and migrate the confirmed RETURNING leak
  case out of `93.2-view-mutation-pending.sqllogic`):
  - the three leak cases above now error with `unknown-view-column`;
  - positive: `where` / `set` / `returning` on real view columns still succeed;
  - renamed view column — `note` accepted, base name `label` rejected;
  - computed view column — `returning <computed>` succeeds (read), `set <computed>`
    still yields `no-inverse` (not `unknown-view-column`);
  - view-qualified `sv.secret` rejected;
  - parity: a multi-source join view rejects an unknown top-level column the same way.
- Update `docs/view-updateability.md`: replace the § (currently describing the leak
  as a Phase-1 limitation / open question) with the enforced contract — top-level
  `where` / `set` / `returning` references resolve against the view's column set for
  single-source views; add `'unknown-view-column'` to the Diagnostics list; note the
  nested-subquery case is the separate ticket's domain.
