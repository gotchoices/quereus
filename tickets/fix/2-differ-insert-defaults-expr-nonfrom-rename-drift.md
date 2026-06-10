description: Declarative differ does not inverse-reconcile a column rename of a NON-FROM table referenced inside a view's `insert defaults` expr subquery — spurious drift → drop+recreate (MV: rebuild churn). Forward rename propagation handles this case; the inverse path should mirror it.
prereq: schema-differ-cross-table-column-rename-subquery-reconcile
files:
  - packages/quereus/src/schema/schema-differ.ts                # reconciledDeclaredViewDefinition — clause expr inverse pass iterates fromTables only
  - packages/quereus/src/schema/rename-rewriter.ts              # renameColumnInInsertDefaults — the forward mirror (seeded walk for FROM tables, plain renameColumnInAst otherwise)
  - packages/quereus/test/schema-differ.spec.ts
----

# Differ: non-FROM-table column rename inside `insert defaults` expr not reconciled

## Behavior

Forward rename propagation (`renameColumnInInsertDefaults`, used by ALTER TABLE
RENAME COLUMN propagation) rewrites a `d.expr` subquery reference to a renamed
column of a table that is NOT one of the view's FROM tables, via the plain
scope-aware `renameColumnInAst` branch (pinned by 41.3 §20).

The differ's inverse reconciliation (`reconciledDeclaredViewDefinition`) does
not mirror that branch: its clause-expr pass iterates only the FROM tables'
column renames (seeded `renameColumnInCheckExpression`). A declarative diff
that contains a column rename on a non-FROM table referenced inside a declared
view's `d.expr` subquery therefore reconciles the body but not the clause expr
→ the canonical strings differ → the view is treated as a genuine definition
edit and drop+recreated instead of converging via the rename op alone.

## Use case

```sql
-- catalog: audit(c), view v as select id from t insert defaults (ts = (select max(c) from audit))
-- declared: audit(c2) with rename hint c→c2, view v unchanged (referencing c2)
-- expected: pure rename — RENAME COLUMN op only, view untouched
-- actual:   spurious view drift → drop+recreate (plain view: free; MV: full rebuild)
```

The end state is correct either way (the clause resolves lazily at
write-through plan time, and view creates that only reference the renamed
column inside the clause expr do not fail at apply) — this is an
efficiency/parity gap, not a correctness bug. The body pass already applies
ALL in-diff column renames (`columnRenamesByTable`); the clause-expr pass
should do the same, using the seeded CHECK walk for FROM tables and the plain
scope-aware walk for the rest — exactly mirroring `renameColumnInInsertDefaults`.

## Expectations

- The scenario above converges as a pure rename (no view recreate, no MV rebuild).
- FROM-table scoping for the clause `column` target is unchanged (schema-aware
  via `collectFromTableNames`).
- Existing differ suite stays green; add a spec pinning the non-FROM expr case
  for both a plain view and an MV.
