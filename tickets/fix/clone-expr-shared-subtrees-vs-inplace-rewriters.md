description: cloneExpr still shares two subtree kinds by reference — WITH-clause CTE bodies (rebuildSelect spreads `withClause`) and IUD-RETURNING subqueries (mapQueryExprUniform returns `{ ...query }` shallow). The in-place rename rewriters DO descend into both, so a schema-differ rename reconcile over a predicate containing a CTE would silently mutate the DECLARED AST (the source of truth backing recreate DDL), not just the clone.
files:
  - packages/quereus/src/planner/mutation/scope-transform.ts  # mapQueryExprUniform (`withClause` preserved by reference; IUD branch `{ ...query }`), rebuildSelect (`...sel` spread carries withClause)
  - packages/quereus/src/schema/rename-rewriter.ts            # visitTableRename / visitColumnRename descend into stmt.withClause?.ctes and IUD statements — the mutation channel
  - packages/quereus/src/schema/schema-differ.ts              # declaredIndexCanonicalBody / reconciledDeclaredBody — the callers that rely on cloneExpr isolation
----

# `cloneExpr` shares CTE bodies and IUD-RETURNING subqueries with the source AST, defeating clone-isolation under in-place rewriters

## The gap

`cloneExpr` (scope-transform.ts) deep-clones expressions and SELECT subqueries, and — since
the `schema-differ-predicate-table-qualifier-reconcile` fix — also deep-clones the nested
`TableSource.table` identifier. Two subtree kinds are still shared by reference with the
source AST:

1. **WITH-clause CTE bodies**: `rebuildSelect` spreads `...sel` and never rebuilds
   `withClause` (documented as "a CTE body cannot correlate to the enclosing query, so it
   needs no rewrite" — true for *substitution* callers, false for *mutation* callers).
2. **IUD-RETURNING subqueries**: `mapQueryExprUniform` returns `{ ...query }` for a
   non-select/non-values query, sharing `stmt.table`, `assignments`, `where`, etc.

The schema differ's rename reconcile clones a declared CHECK / partial-index WHERE
expression and then runs the **in-place** rewriters (`renameTableInAst` /
`renameColumnInCheckExpression`) over the clone. Both rewriters descend into
`stmt.withClause?.ctes` and into IUD statements and mutate nodes there — so for a predicate
containing a CTE (or an embedded IUD-RETURNING subquery), the NEW→OLD inverse rewrite would
leak through the shared subtree back into the **declared** AST in `declaredSchemaManager`.
That AST backs the recreate DDL and survives across diff cycles: the corruption is silent
and persistent (wrong identifier in a later-emitted `CREATE INDEX` / `ADD CONSTRAINT`).

## Why backlog, not fix

- A CTE or IUD subquery inside a CHECK expression or index WHERE predicate is exotic; the
  engine barely plans subqueries in index predicates at all.
- Widening `mapQueryExprUniform` to rebuild `withClause` would change its semantics for the
  view-mutation substitution callers (which rely on the documented "CTE bodies need no
  rewrite" contract) — the fix needs care, not a drive-by.

## Expected behavior

After `cloneExpr`, no node reachable from the clone is shared with the source tree's
mutable channels (`table`/`schema`/`name` fields the rename rewriters write). Options:

- give `cloneExpr` a true-deep mode (rebuild `withClause` CTE queries via `cloneQueryExpr`
  and structurally clone IUD statements) used by the differ;
- or assert/document that the differ's reconcile inputs cannot contain these shapes
  (e.g. reject CTE-bearing predicates at DDL time), making the share provably safe.

A regression test should pin whichever contract is chosen (e.g. reconcile a predicate
containing `exists (with c as (select …) select … from c)` under a table rename and assert
the declared AST is byte-stable).
