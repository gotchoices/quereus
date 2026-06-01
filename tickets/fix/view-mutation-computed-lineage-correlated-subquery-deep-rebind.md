description: A single-source updateable view exposes a COMPUTED column whose base-term lineage is (or contains) a correlated scalar subquery referencing the base row (e.g. `(select x from oth where fk = id) as note`). When that view column is referenced INSIDE a user UPDATE/DELETE subquery operand, the descent substitutes it with the lineage subquery — but `qualifyUnqualifiedRefs` is shallow (qualifies only top-level refs of the replacement), so the lineage's own correlation ref (`id`) is left unqualified. Emitted inside the user subquery whose FROM introduces a same-named column, that `id` re-binds to the innermost local source instead of the outer UPDATE/DELETE target row — a confirmed silent wrong write, the same bug class as `view-mutation-single-source-subquery-base-term-local-rebind` but one nesting level deeper.
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/test/logic/93.4-view-mutation.sqllogic, docs/view-updateability.md

## Confirmed reproduction (verified during review)

```sql
create table cv_base (id integer primary key, lbl text);
create table cv_oth (fk integer, x text);
create table cv_src (id integer, tag text);
insert into cv_base values (1, 'A'), (2, 'B');
insert into cv_oth values (1, 'AA'), (2, 'BB');
insert into cv_src values (99, 'AA');
-- computed column whose lineage correlates on cv_base.id
create view cv_v as select id as id, lbl as lbl,
    (select x from cv_oth where fk = id) as note from cv_base;

update cv_v set lbl = 'CHANGED' where exists (select 1 from cv_src where tag = note);
select id, lbl from cv_base order by id;
```

**Correct result:** `[{id:1,lbl:'CHANGED'},{id:2,lbl:'B'}]` — row 1's `note` =
`(select x from cv_oth where fk = 1)` = `'AA'`, which matches `cv_src.tag='AA'`,
so row 1 is updated; row 2's `note`='BB' has no match, untouched.

**Actual (buggy) result:** `[{id:1,lbl:'A'},{id:2,lbl:'B'}]` — NOTHING changes.
The substituted lineage `(select x from cv_oth where fk = id)` is emitted inside
the user subquery `select 1 from cv_src where tag = …`. The lineage's `id` is
left **unqualified** (shallow `qualifyUnqualifiedRefs` only qualified the
replacement's *top-level* refs — and the replacement is a `subquery` node with no
top-level column ref). By innermost-scope SQL rules `id` binds to `cv_src.id`
(=99), not the outer `cv_base.id`. So `note` evaluates to
`(select x from cv_oth where fk = 99)` = NULL, `tag = NULL` is never true, the
`exists` is false for every row → silent wrong write.

## Why the prior fix does not cover it

`view-mutation-single-source-subquery-base-term-local-rebind` introduced
`qualifyUnqualifiedRefs(expr, qualifier)`, threaded as `baseQualifier` through
`makeViewColumnDescend → transformQueryExpr → makeViewSubstitute`. It qualifies a
substituted base term's **top-level** unqualified refs with the base table name.
It is explicitly **shallow** ("does NOT descend into a nested subquery within the
replacement, because a lineage term's own scalar subquery has its own scope") and
its tests only exercise `base`-kind lineage (a bare column). The implement-stage
handoff flagged this exact computed-lineage-with-correlated-subquery combination
as an "untested combination worth a reviewer's eye (likely fine, but
unverified)." Review verified it is **not** fine — it is a reachable silent wrong
write (the view classifies as updateable and the statement executes, just with
the wrong predicate).

## Required fix (design constraints)

The qualification must descend into a nested subquery WITHIN a substituted
replacement, but it must be **scope-aware** — a naive deep qualify is wrong:

- In the lineage `(select x from cv_oth where fk = id)`, the refs `x` and `fk`
  are LOCAL to `cv_oth` and must stay unqualified (qualifying them to
  `cv_base.x`/`cv_base.fk` would be a different wrong rewrite). Only `id` —
  correlated to the base row in the original view body, NOT introduced by the
  lineage subquery's own FROM — must be qualified to the base table name.
- This mirrors the existing scope-aware descent in `transformQueryExpr`
  (`collectFromColumnNames` → `shadowed` set): a ref shadowed by the
  replacement's own (possibly nested) FROM stays; a ref that is a base-table
  column and is not shadowed gets the `baseQualifier`. The base table's column
  set is known (`analysis.baseTable.columns`), so "is this a base column"
  is decidable.
- Equivalent care for the top-level (non-subquery) path: that path already works
  (a lineage subquery emitted at the lowered WHERE top level correlates
  correctly because there is no intervening user-subquery scope to shadow it),
  so the change is confined to the descent path — do not regress the top-level
  RETURNING/WHERE/SET handling.

A simpler-but-acceptable alternative if scope-aware deep qualification proves too
invasive: synthesise an explicit alias on the lowered single-source target (the
"future hardening" already noted in `docs/view-updateability.md` for the
self-reference corner) and qualify substituted terms against that alias instead
of the bare table name. An aliased target name cannot collide with a
subquery-local source the way the bare base-table name can, and it would also
close the documented self-reference corner (`update p1_v … where exists (select 1
from p1_t …)`). Evaluate both; the alias approach may be the cleaner single fix
for both corners.

## Tests to add (93.4-view-mutation.sqllogic)

- The reproduction above (computed lineage with a correlated subquery, referenced
  inside a user subquery whose FROM shadows the lineage's correlation column) —
  assert the correct result; it must fail before the fix.
- A negative control: the same computed-lineage shape where the user subquery
  FROM does NOT shadow the lineage's correlation column (current behaviour is
  already correct there — guard against the fix over-qualifying a genuinely local
  ref inside the lineage, e.g. `fk`/`x`).
- A DELETE variant (the descent qualifier is threaded into `rewriteViewDelete`
  too — confirm parity).

## Out of scope

- The bare-base-term shallow case (g/h/i/j in 93.4) — already fixed and guarded.
- The same-base-table self-reference corner — documented separately; may be
  closed incidentally if the alias-on-target approach is chosen (note it in the
  doc if so).
