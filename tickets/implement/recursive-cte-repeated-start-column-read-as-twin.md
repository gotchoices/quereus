description: A recursive CTE whose start row selects the same source expression into two output columns has the recursive step read the first output column as the second instead of keeping them independent.
files: packages/quereus/src/runtime/emit (recursive CTE step — binds `pd.col` names onto working-table slots), packages/quereus/test/plan or test/logic (regression case)
repro: verified
severity: wrong-result
likelihood: normal-use
tradeoffs: none identified — this is a correctness bug with no known tradeoff; a fix changes only how the recursive step binds slots for a start row whose two output columns share a source expression.
----

# A recursive query that starts by selecting one column twice reads the copy as the original

## Problem

When the starting row of a recursive CTE selects the same column twice, the recursive step reads the first output column as if it were the second. Verified against `@quereus/quereus` 4.20.2 through 5.1.0 (bare `Database`, no extensions), with `E(id, parent, type)` holding 100 → 102 → 101 (each row's `parent`):

```sql
with recursive pd(proto_id, id) as (
  select id, id from E where id in (100)
  union all
  select PD.proto_id, E.id from E join pd PD on E.parent = PD.id
)
select PD.proto_id, E.id from E join pd PD on E.id = PD.id
```

returns `proto_id` 102 for row 101 instead of 100: at depth two, `PD.proto_id` evaluates to `PD.id`. Depth one looks right only because there the two columns hold the same value. `select id as proto_id, id …` fails the same way. Writing the start row so the two columns are different expressions gives the right answer: `select id + 0, id …`, `select 100, id …`, or a self-join `select P.id, E.id from E join E P on P.id = E.id …` all return 100 for every row. SQLite returns 100 for the equivalent query.

## Why it matters

This is silent and looks correct at shallow depth — the start row's two columns hold the same value there, so the defect only shows at depth two or more, which is also the point a reviewer stops hand-checking a recursive query. A recursive CTE is a normal way to walk a self-referential hierarchy (parts-of-parts, org charts, retained ownership chains); starting it by carrying the same key into two named output columns (one as the thing being tracked, one as the row identity) is an ordinary way to write that walk, not a contrived shape.

## The fix

The two columns of the start row are distinct output columns even when they come from the same source expression; the recursive step must bind each by its position in the working-table's column list, not by re-resolving the source expression. A regression test with the query above (three levels, asserting `proto_id = 100` for the id-101 row) should pin it in the engine's own suite.

## Found via

SiteCAD (github.com/Digithought/SiteCAD), a consumer of this package. SiteCAD's own affected call sites all route around it by writing `col + 0` instead of repeating the bare column, so nothing there is currently broken by this — the workaround is one-token and reversible, with a comment naming this ticket to drop it once fixed here.
