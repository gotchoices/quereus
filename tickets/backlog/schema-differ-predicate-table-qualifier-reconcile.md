description: A partial-index WHERE predicate (or a CHECK constraint) carrying a table-qualified self-reference spuriously recreates under a concurrent table rename — the table qualifier inside the expression is not reconciled NEW→OLD. Benign churn (valid recreate), rare, shared between the index-WHERE and constraint-CHECK reconcile paths.
files:
  - packages/quereus/src/schema/schema-differ.ts        # declaredIndexCanonicalBody (WHERE reconcile); reconciledDeclaredBody (CHECK case)
  - packages/quereus/src/schema/rename-rewriter.ts       # renameColumnInCheckExpression — rewrites column names only, not table qualifiers
  - packages/quereus/test/index-ddl-roundtrip.spec.ts    # add a case once fixed
----

# Predicate / CHECK table-qualifier reconciliation under a concurrent table rename

## Problem

The schema differ reconciles **column** renames inside a partial-index `WHERE`
predicate and inside a `CHECK` constraint expression (inverse-rewriting each renamed
column NEW→OLD via `renameColumnInCheckExpression`, so a same-named index/constraint
over a renamed column does not churn). But the rewriter rewrites *column names only* —
it does **not** rewrite the **table qualifier** of a qualified reference.

So when a predicate carries a **table-qualified self-reference** and the table is
renamed in the same diff, the qualifier diverges between the two diff sides and the
object spuriously drops+recreates:

```
baseline:  index ix on t  (name) where t.active = 1
declared:  index ix on t2 (name) where t2.active = 1   -- t renamed → t2
           (catalog still renders `t.active = 1`; declared renders `t2.active = 1`)
=> indexesToDrop = ['ix'], indexesToCreate = 1   -- spurious recreate
```

Confirmed empirically against the current `view-updates-lens` branch (reviewing
`index-canonical-body-rename-reconciliation`). The unqualified form
(`where active = 1`) reconciles correctly and does **not** churn — only the qualified
form is affected.

The **constraint CHECK path** (`reconciledDeclaredBody`, `case 'check'`) has the same
limitation, and is in fact slightly worse: it seeds the rewriter with
`actualTable.name` (the OLD name), so a declared qualified ref under the NEW table name
fails to even match the seed and the *column* rename is also missed. The index-WHERE
path seeds with the declared/new table name (`indexStmt.table.name`), so it at least
reconciles the column correctly and only the table qualifier is left stale.

## Why it is benign (hence backlog, not fix/plan)

- The result is a **valid** migration: drop-old + recreate with the correct
  post-rename predicate. No data loss, no incorrect schema — just an unnecessary
  index/constraint rebuild.
- **Table-qualified self-references inside a partial index predicate or a CHECK
  expression are unusual** — the idiomatic form is an unqualified column reference,
  which reconciles correctly today.
- The limitation is **symmetric on both diff sides** (it does not produce a wrong
  result, only redundant churn).

## Expected behavior

A pure table rename whose only "body" coupling is a table-qualified self-reference in
a partial `WHERE` predicate (index) or a `CHECK` expression (constraint) should emit
**only** the table rename op — no spurious index drop+recreate / constraint drop+add.

## Specification / use case

- Reconcile the **table qualifier** of a qualified self-reference NEW→OLD alongside the
  existing column-name reconcile, on both the index-WHERE and constraint-CHECK paths.
  The reconcile must remain symmetric: a *genuine* predicate/expression edit layered on
  the table rename must still recreate (precedence preserved, mirroring the existing
  column-rename precedence guards).
- Do it for **self-references only** — a CHECK cannot legally reference another table at
  top level, and an index predicate's qualified refs resolve to the indexed table.
  (A future cross-table predicate would need the same parent-table threading the FK body
  reconcile already does — out of scope unless predicates gain cross-table refs.)
- Add coverage:
  - index partial `WHERE` with a table-qualified self-ref under a table rename → no churn
  - constraint `CHECK` with a table-qualified self-ref under a table rename → no churn
  - a genuine predicate/expression edit layered on the table rename → still recreates
    (precedence guard)
  - unqualified forms continue to behave as today (regression guard)

## Notes

Consider whether `renameColumnInCheckExpression` should grow an optional
table-qualifier rewrite, or whether a small dedicated qualifier-rewrite pass over the
cloned expression is cleaner. Keep the two reconcile paths consistent (the index-WHERE
and constraint-CHECK seeds currently differ — new vs old table name — which is itself
worth aligning as part of this work).
