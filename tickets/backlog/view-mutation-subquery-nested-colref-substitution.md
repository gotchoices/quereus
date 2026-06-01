description: View-mediated DML predicate/SET rewriting does not descend into nested subqueries when substituting view-column references with their base-term expressions. A user `where` / `set` value that references a view column **inside a correlated subquery or `exists`** is left un-substituted, then re-resolved in the base statement's scope — where it can silently bind to a same-named base column instead of the view column's actual lineage, producing a wrong (not errored) write. Affects both the single-source spine (`single-source.ts transformExpr`) and the multi-source join walk (`multi-source.ts substituteViewColumns`, which reuses the same `transformExpr`). Currently documented as a Phase-1 limitation ("Subqueries are passed through un-rewritten").
files: packages/quereus/src/planner/mutation/single-source.ts, packages/quereus/src/planner/mutation/multi-source.ts, docs/view-updateability.md

## Problem

`transformExpr` (in `single-source.ts`, exported and reused by `multi-source.ts`) rewrites
column references to base terms but **does not recurse into `subquery` / `exists` / `in`-subquery
operands**. The `default` arm passes them through structurally:

```ts
// transformExpr default arm:
// literal / identifier / parameter / subquery / exists / windowFunction /
// functionSource — passed through structurally (subqueries un-rewritten).
```

So for a view mutation whose user predicate (or, multi-source, a SET value) embeds a view-column
reference inside a subquery:

```sql
create view jv as select c.cid as cid, p.label as note   -- note := p.label (renamed!)
                  from c join p on p.pid = c.pref;
-- base table `c` also happens to have a column literally named `note`.
update jv set ... where exists (select 1 from other o where o.k = note);
```

`note` inside the `exists` is **not** rewritten to `p.label`. When the lowered base statement is
re-planned, `note` resolves in the subquery's scope against the join's base tables and binds to
`c.note` (the same-named base column), **not** the view column's true lineage `p.label`. The
write proceeds against the wrong predicate — a **silent** correctness error, not a diagnostic.

The top-level case is correct (a bare or view-qualified `note` in the WHERE *is* substituted); the
gap is strictly references nested inside a subquery operand.

## Expected behavior

Either:
- **Descend** into subquery / exists / in-subquery operands during view-column substitution
  (rewriting view-column references to base terms throughout, with correlation preserved), or
- **Reject** with a structured diagnostic when a view mutation's predicate / SET value embeds a
  subquery that references a view column the rewrite cannot safely thread — never silently widen
  or mis-bind.

The reject path is the safe minimum; full descent is the complete fix. Whichever is chosen must
cover **both** the single-source spine and the multi-source join walk (they share `transformExpr`).

## Notes

- Pre-existing: this limitation predates the multi-source inner-join work
  (`view-mutation-multisource-innerjoin`); that ticket inherited it by reusing `transformExpr`.
  Filed from that ticket's review.
- Low frequency (requires a view-column reference nested in a subquery within the DML predicate,
  plus, for the silent-mis-bind variant, a same-named base column), but the failure mode is silent
  data corruption, which is why it is tracked rather than left purely as a doc note.
