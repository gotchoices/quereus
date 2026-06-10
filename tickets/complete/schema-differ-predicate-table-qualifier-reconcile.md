description: COMPLETE — differ-side NEW→OLD reconcile of the table qualifier in partial-index WHERE predicates and constraint CHECK expressions under a concurrent table rename, with both paths' column-rewriter seeds aligned to OLD. Reviewed; minor findings fixed inline, two exotic-edge findings filed to backlog.
files:
  - packages/quereus/src/schema/schema-differ.ts          # index loop threads indexTableRename; declaredIndexCanonicalBody qualifier pass + OLD seed; reconciledDeclaredBody case 'check' qualifier pass
  - packages/quereus/src/planner/mutation/scope-transform.ts  # rebuildFrom 'table' case clones the nested table identifier
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # 5 qualified-predicate cases
  - packages/quereus/test/declarative-equivalence.spec.ts # 4 qualified-CHECK cases, upgraded in review to assert runtime enforcement
  - docs/schema.md                                        # constraint + index body-change sections
----

# Completed: predicate/CHECK table-qualifier reconcile NEW→OLD under a table rename

## What landed (implement stage)

1. `declaredIndexCanonicalBody` takes the index table's own in-diff rename
   (`tableRename: RenameOp | undefined`, threaded from the `computeSchemaDiff` index loop
   by `r.newName === indexStmt.table.name`). Over a `cloneExpr` copy of the partial WHERE
   predicate it first inverse-rewrites the table qualifier NEW→OLD via `renameTableInAst`
   (the exact inverse of the forward rewriter the executed rename migration runs), then
   runs the per-column rewrites seeded with the OLD table name.
2. `reconciledDeclaredBody` case `'check'` looks up the table's own rename by
   `r.oldName === tableName` (tableName is the actual/OLD name there) and applies the same
   inverse qualifier pass before the existing OLD-seeded column loop — fixing the seed bug
   where a qualified ref under the NEW table name never matched the OLD-seeded reconcile.
3. Clone-depth fix in `scope-transform.ts`: `rebuildFrom` case `'table'` now clones the
   nested `table` identifier (`{ ...fc, table: { ...fc.table } }`) so `renameTableInAst`'s
   in-place `ts.table.name` mutation over a cloned predicate cannot leak into the declared
   AST through a shared identifier.
4. Tests: 5 index-roundtrip cases (pure rename / rename+column-rename seed alignment /
   genuine edit precedence / require-hint guard / end-to-end convergence) and 4
   declarative-equivalence CHECK cases (pure rename / seed alignment / genuine-edit
   regression / unqualified regression guard). `docs/schema.md` constraint and index
   body-change sections updated.

## Review findings

**Reviewed:** the full implement diff (commit 46d9f4fd) with fresh eyes, then: both rename
rewriters (`renameTableInAst`, `renameColumnInCheckExpression`) for inverse-symmetry and
scope semantics; both differ call sites for lookup-key correctness (newName-keyed in the
index loop where the declared name is the NEW name; oldName-keyed in the check path where
`tableName` is the actual name — both verified against their callers); the seed-alignment
argument (the seed only gates resolution of unqualified refs and pre-normalized qualified
refs, and is never rendered — correct unconditionally); the clone-depth fix and an audit of
every node kind `cloneExpr` rebuilds against every mutation channel the rewriters write;
canonical-render case-folding (`lowerExprIdentifiers` folds `col.table`/`col.schema` too,
so qualifier-case divergence cannot churn); the require-hint exclusion; the updated docs
against the code; lint, build, both targeted specs, and the full workspace suite.

**Checked and clean (explicitly):**
- Forward/inverse symmetry holds by construction: the same `renameTableInAst` runs forward
  in `rewriteTableForTableRename` (alter-table.ts) and inverse in the differ, and the
  end-to-end convergence test pins the round trip.
- No error-handling, resource-cleanup, or type-safety issues in the diff; the new parameter
  is typed `RenameOp | undefined`, no `any`, no exception swallowing.
- Performance: the clone + two rewrites run only when a rename is actually in play
  (`colRenames.length > 0 || tableRename`); the no-rename fast path is unchanged.
- Docs accurate after the update; `docs/sql.md` qualified-self-reference semantics (added
  by the triage pass) consistent with both.

**Minor — fixed in this pass:**
- The three qualified-CHECK tests asserted only the stored catalog `definition` because
  runtime enforcement of a table-qualified CHECK self-ref was a pre-existing engine gap
  (flagged in `.pre-existing-error.md`). The triage pass fixed that gap (commit 4f8d899d:
  `stripSelfQualifierInCheckExpression` wired into the constraint builder, plus sqllogic
  coverage). Upgraded all three tests to assert real-insert enforcement post-apply —
  including the previously-untested interaction of forward-propagated qualifiers with the
  new strip rewriter (pure rename, rename+column-rename, and the edited `>= 0` boundary) —
  and removed the now-false "pre-existing engine gap" comments.

**Major — filed to backlog (not fixed here):**
- `schema-differ-cross-table-rename-subquery-reconcile`: the diff-side reconcile applies
  only the owning table's rename, but the forward path rewrites a rename into *every*
  table's CHECK/index-predicate bodies — so a subquery referencing another table renamed in
  the same diff still churns a benign converging drop+recreate. Same class as this ticket's
  bug, cross-table; exotic and convergent, hence backlog.
- `clone-expr-shared-subtrees-vs-inplace-rewriters`: `cloneExpr` still shares WITH-clause
  CTE bodies and IUD-RETURNING subqueries by reference, and the in-place rewriters descend
  into both — a CTE inside a reconciled predicate would silently mutate the declared AST.
  The implementer flagged this honestly; review concurs it needs a deliberate fix (widening
  `mapQueryExprUniform` affects its substitution callers), hence backlog rather than inline.

**Validation:** `yarn build` clean; `yarn lint` clean (quereus package); targeted runs of
both spec files green (104 + 77); full `yarn test` workspace green — 5545 passing in
`packages/quereus` (9 pending, pre-existing), no failures in any package.
