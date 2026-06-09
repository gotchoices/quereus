description: Forward rename propagation (ALTER TABLE RENAME / RENAME COLUMN) never rewrites stored partial-index predicate ASTs — post-rename the IndexSchema.predicate (and its rendered/persisted DDL) references the old table qualifier or old column name. Causes a confirmed re-diff churn after a reconciled column rename, and stale persisted index DDL that references a no-longer-existing name.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts     # rewriteTableForTableRename (~1343), rewriteTableForColumnRename (~1441), propagateTableRenameInSchema, propagateColumnRenameInSchema
  - packages/quereus/src/schema/rename-rewriter.ts        # renameTableInAst, renameColumnInCheckExpression (used as-is, no changes expected)
  - packages/quereus/src/schema/table.ts                  # IndexSchema.predicate (:365), appendIndexToTableSchema (derived UNIQUE constraint shares the predicate AST ref)
  - packages/quereus/test/alter-table-conformance.spec.ts # likely home for forward-propagation cases
  - packages/quereus/test/index-ddl-roundtrip.spec.ts     # post-apply convergence case
----

# Propagate table/column renames into stored partial-index predicate ASTs

## Problem (confirmed empirically)

The forward rename propagation in `alter-table.ts` rewrites dependent **CHECK
expressions**, **FK references**, and **view bodies** — but never touches
`IndexSchema.predicate` (the partial-index WHERE AST stored on
`TableSchema.indexes`). Two consequences, both reproduced on `view-updates-lens`:

1. **Table rename leaves a stale qualifier in the index predicate/DDL:**

   ```
   create table t (id INTEGER PRIMARY KEY, name TEXT, active INTEGER);
   create index ix on t (name) where t.active = 1;
   alter table t rename to t2;
   -- catalog index ddl:        CREATE INDEX "ix" ON "t2" (...) WHERE t.active = 1
   -- catalog index definition: index (name) where t.active = 1
   ```

   The CHECK path correctly rewrites (`check (t.qty > 0)` → `check (t2.qty > 0)`
   after the same rename); the index predicate does not. A store module that
   persists this DDL (`generateIndexDDL` renders the predicate AST) would emit
   `... ON t2 ... WHERE t.active = 1` — a qualified reference to a table that no
   longer exists — and risk a rehydration error on reopen (unverified, flagged as
   a risk; add a store-path test if cheap, else note it).

2. **Column rename breaks declarative convergence (exists TODAY):** the
   already-landed differ reconcile (`index-canonical-body-rename-reconciliation`)
   suppresses the index recreate at diff #1 of a pure column rename, so the
   migration only runs RENAME COLUMN — and the stored predicate still names the
   old column. The **next** diff then churns:

   ```
   declare … index ix on t (name) where active = 1; apply;
   declare … is_active with previous_name 'active' … where is_active = 1; apply;
   -- post-apply catalog definition: index (name) where active = 1   ← stale
   -- re-diff: indexesToDrop=['ix'], recreate with `where is_active = 1`
   ```

   So the diff-time reconcile currently just defers the churn by one apply cycle,
   and between the two applies the persisted index DDL references a renamed-away
   column.

This ticket is the prerequisite for the differ-side qualifier reconcile
(`schema-differ-predicate-table-qualifier-reconcile`): fixing the differ alone
would likewise leave the stored predicate stale after a pure table rename and
merely move that churn from diff #1 to diff #2.

## Design

Mirror the existing CHECK-expression treatment inside the two per-table rewrite
helpers in `alter-table.ts` (AST mutated in place, shallow-copy the containing
object to signal change — same pattern as `{ ...cc }` for checks):

- **`rewriteTableForTableRename`** (alter-table.ts:1343): for each
  `table.indexes ?? []`, run `renameTableInAst(idx.predicate, oldName, newName,
  renamedSchemaLower)`; if it reports a change, mark `changed` and shallow-copy
  the index entry into a new frozen `indexes` array. `renameTableInAst` already
  rewrites both qualified `ColumnExpr.table` qualifiers and table sources in
  subqueries — exactly the forward semantics the differ's inverse reconcile will
  mirror.
- **`rewriteTableForColumnRename`** (alter-table.ts:1441): when `isRenamedTable`,
  rewrite each index predicate with `renameColumnInCheckExpression(idx.predicate,
  tableName, oldCol, newCol, renamedSchemaLower, resolveColumnInSource)` — index
  predicates resolve unqualified refs against the indexed table, the same implicit
  seed CHECK expressions use. Non-renamed tables need nothing (an index predicate
  cannot reference another table).

Notes / verifications for the implementer:

- `appendIndexToTableSchema` (schema/table.ts:396) copies `predicate:
  indexSchema.predicate` **by reference** into the derived `derivedFromIndex`
  UNIQUE constraint, so the in-place AST rewrite covers both automatically —
  verify with a UNIQUE partial index case rather than assuming.
- Audit other holders of a `predicate` AST (`UniqueConstraintSchema.predicate`
  not derived from an index, if any source exists) for the same gap.
- Runtime behavior is unaffected by the rewrite itself (compiled predicates work
  positionally), but the `table_modified` notification must fire so store modules
  re-persist the corrected DDL — both helpers already notify when `changed`.
- The rename rewriters are scope-naive about aliases that shadow the renamed
  name inside predicate subqueries; that is the established limitation of the
  forward path (views/CHECKs share it) — do not fix here, keep the two sides
  symmetric.

## TODO

- Rewrite index predicates in `rewriteTableForTableRename` via `renameTableInAst`
  (qualifier + subquery table sources), shallow-copying changed index entries.
- Rewrite index predicates in `rewriteTableForColumnRename` (renamed table only)
  via `renameColumnInCheckExpression` with the owning-table seed and
  `resolveColumnInSource` threaded through.
- Verify the derived UNIQUE constraint's shared `predicate` ref is covered
  (UNIQUE partial-index case); audit other `predicate` holders.
- Tests:
  - `alter table … rename to …` with a qualified partial WHERE → catalog index
    DDL/definition render the new qualifier.
  - `alter table … rename column …` with both unqualified and table-qualified
    partial WHERE → predicate renders the new column name.
  - UNIQUE partial index variant (derived constraint predicate also rewritten).
  - Declarative convergence: declare+apply a pure column rename under a partial
    index, then re-diff → no index drop/create (this is the repro-2 case that
    fails today).
- Run `yarn test` (full workspace) and lint; consider whether a `test:store`
  spot-check of index DDL persistence after rename is warranted.
