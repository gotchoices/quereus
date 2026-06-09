description: Differ-side reconcile of the table qualifier inside a partial-index WHERE predicate / constraint CHECK expression under a concurrent table rename — inverse-rewrite the qualifier NEW→OLD alongside the existing column reconcile, and align the two paths' rewriter seeds (index path seeds NEW, check path seeds OLD, which also misses qualified column renames).
prereq: rename-propagation-index-predicate
files:
  - packages/quereus/src/schema/schema-differ.ts        # declaredIndexCanonicalBody (~833, WHERE reconcile); reconciledDeclaredBody (~1035, case 'check'); computeSchemaDiff index loop (~462) for threading the table rename
  - packages/quereus/src/schema/rename-rewriter.ts       # renameTableInAst (inverse use; no changes expected), renameColumnInCheckExpression
  - packages/quereus/src/planner/mutation/scope-transform.ts  # cloneExpr (already used by both paths)
  - packages/quereus/test/index-ddl-roundtrip.spec.ts    # index-WHERE cases live here (rename-reconciliation block ~747)
  - packages/quereus/test/declarative-equivalence.spec.ts # constraint CHECK + table-rename cases live here
----

# Reconcile predicate/CHECK table qualifiers NEW→OLD under a concurrent table rename

## Problem (reproduced; all three cases churn today)

The differ inverse-rewrites renamed **columns** inside a partial-index WHERE and a
constraint CHECK so a same-named object over a renamed column doesn't churn — but the
**table qualifier** of a qualified self-reference is never reconciled, so a pure table
rename spuriously drops+recreates:

1. `index ix on t (name) where t.active = 1` → rename t→t2, declared
   `where t2.active = 1` ⇒ `indexesToDrop=['ix']` + recreate (spurious).
2. `constraint cc check (t.qty > 0)` → rename t→t2, declared `check (t2.qty > 0)`
   ⇒ constraint drop+add (spurious).
3. Check path seed bug: with table rename t→t2 AND column rename qty→amount, declared
   `check (t2.amount > 0)` — `reconciledDeclaredBody` seeds
   `renameColumnInCheckExpression` with `actualTable.name` (OLD `t`), so the qualified
   ref under NEW name `t2` fails the seed match and the **column** reconcile is missed
   too. (The index path seeds with `indexStmt.table.name` — NEW — so it reconciles
   columns but not the qualifier.)

Unqualified forms reconcile correctly today (regression guard passes), and a genuine
predicate edit layered on the rename still recreates (precedence guard passes).

## Prereq coupling

`rename-propagation-index-predicate` must land first: it makes the executed migration
rewrite the stored index predicate's qualifier, so that after this differ fix emits
*only* the rename op, the post-apply catalog renders `t2.active` and the next diff is
clean. Without it this fix would merely move the churn from diff #1 to diff #2.

## Design

On both reconcile paths, normalize the **qualifier first**, then run the column
rewriter seeded with the **OLD** table name — this aligns the two seeds (fixing
bug 3) and mirrors the forward propagation exactly:

- Use `renameTableInAst(clone, newTableName, oldTableName, schemaName)` for the
  inverse qualifier pass. It is the exact inverse of the forward rewriter the
  migration runs (rewrites `ColumnExpr.table` qualifiers incl. schema-qualified
  forms, and table sources inside subqueries), so the diff-side reconcile and the
  executed migration cannot drift. Prefer this over growing a qualifier option on
  `renameColumnInCheckExpression`.
- **`declaredIndexCanonicalBody`**: thread the index table's in-diff rename in
  (available in `computeSchemaDiff`'s index loop as `tableRenames.renames`; match
  `r.newName` against `declaredIndex.indexStmt.table.name`, same key the
  colRenames lookup uses). Clone the WHERE when either a table rename or column
  renames apply; inverse-rewrite qualifier NEW→OLD; then run the per-column
  rewrites seeded with the **OLD** table name (currently seeded NEW — change it,
  since qualifiers are pre-normalized to OLD).
- **`reconciledDeclaredBody` case 'check'**: find the self rename via the already-
  threaded `tableRenames` (`r.oldName === tableName`, the actual/OLD name). Apply
  the inverse qualifier pass on the clone, then the existing OLD-seeded column
  loop is correct as-is.
- Indexed-column lists carry bare names (no qualifiers) — only the WHERE/CHECK
  expressions need the qualifier pass. The canonical index body case-folds
  qualifiers (`lowerExprIdentifiers` lowers `table`/`schema` too), so no
  case-sensitivity trap.
- Symmetry/precedence: the inverse rewrite is deterministic, so a genuine
  predicate/expression edit layered on the rename still differs after
  reconciliation → recreate precedence preserved (mirror of the existing
  column-rename guards).
- Accepted edge (document, don't fix): the rename rewriters are scope-naive about
  an alias that happens to equal the new table name inside a predicate subquery —
  worst case a spurious (valid) recreate; identical limitation on the forward
  path, kept symmetric.
- Self-references only: a CHECK can't reference another table at top level and an
  index predicate resolves to the indexed table; cross-table threading (as the FK
  body reconcile does) is out of scope.

## TODO

- Thread the index table's in-diff table rename into `declaredIndexCanonicalBody`;
  inverse-rewrite the WHERE qualifier NEW→OLD via `renameTableInAst` over the
  clone, and flip the column-rewrite seed NEW→OLD.
- Add the inverse qualifier pass to `reconciledDeclaredBody` case 'check' (lookup
  self rename in `tableRenames`); keep the existing OLD seed.
- Update the doc comments on both functions (they currently state "a *table*
  rename alone never churns" for the index body — true only for the column list,
  now also true for the predicate).
- Tests (index cases in `index-ddl-roundtrip.spec.ts`, CHECK cases in
  `declarative-equivalence.spec.ts`):
  - index partial WHERE with `t.active` self-ref under pure table rename → no churn.
  - constraint CHECK with `t.qty` self-ref under pure table rename → no churn.
  - combined table rename + column rename with qualified refs (`t2.amount`) → no
    churn on either path (covers the seed bug).
  - genuine predicate/CHECK edit layered on the table rename → still recreates.
  - unqualified forms unchanged (regression guard).
  - end-to-end idempotency: declare+apply the qualified-predicate table rename,
    re-diff → empty (relies on the prereq's forward propagation).
  - require-hint: a reconciled pure table rename produces zero index
    creates/drops, so it must not trip the unhinted-rename guard.
- Run `yarn test` and lint.
