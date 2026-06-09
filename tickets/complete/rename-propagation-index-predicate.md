description: Forward rename propagation (ALTER TABLE RENAME / RENAME COLUMN) into stored partial-index predicate ASTs — IndexSchema.predicate (and the derived UNIQUE constraint sharing it) rewrites alongside CHECKs/FKs/views, fixing post-rename stale catalog/persisted index DDL and the one-cycle-late declarative re-diff churn. Reviewed: no major findings; one coverage gap and one doc staleness fixed inline.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # rewriteTableForTableRename / rewriteTableForColumnRename: index-predicate rewrite
  - packages/quereus/src/schema/rename-rewriter.ts          # (unchanged) shared AST rewriters — reviewed for undefined-predicate and ordering safety
  - packages/quereus/test/index-ddl-roundtrip.spec.ts       # 7 forward-propagation tests (+1 added in review) + declarative convergence e2e
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic  # sections 2b/2c
  - packages/quereus-store/test/index-persistence.spec.ts   # 2 reopen/rehydration tests
  - docs/sql.md                                              # propagation lists updated (implement)
  - docs/schema.md                                           # stage-neutral ticket reference (review)
----

# Completed: rename propagation into stored partial-index predicates

## What landed

`rewriteTableForTableRename` and `rewriteTableForColumnRename` in
`runtime/emit/alter-table.ts` now run each `table.indexes[].predicate` through
the same AST rewriters the CHECK path uses (`renameTableInAst` /
`renameColumnInCheckExpression` with the seeded implicit-table frame /
`renameColumnInAst` for other tables). A changed entry is shallow-copied into a
new frozen `indexes` array, marking the table changed so it is re-added and
`table_modified` fires — which drives the store module's catalog re-persist.
The AST mutates in place, so the derived UNIQUE constraint of a unique partial
index (sharing the predicate by reference via `appendIndexToTableSchema`) is
rewritten by the same pass.

Pre-fix, a `RENAME COLUMN` under a partial index persisted catalog DDL naming a
nonexistent column (rehydration failure on reopen), and a declarative re-declare
with `quereus.previous_name` converged one apply cycle late (deferred index
drop+create churn). Both are pinned by tests now.

## Review findings

### Checked

- **Implement diff read fresh** (commit 026b64b7) before the handoff summary;
  both rewrite arms compared line-by-line against the established CHECK
  pattern. They mirror it exactly (same ternary, same shallow-copy/frozen-array
  convention, same `changed` flagging).
- **Undefined-predicate safety**: all three rewriters (`renameTableInAst`,
  `renameColumnInAst`, `renameColumnInCheckExpression`) accept
  `undefined` and return false — non-partial indexes pass through untouched.
- **Ordering safety**: propagation runs *after* the catalog already holds the
  renamed column. Verified the seeded-frame rewriter resolves top-level
  unqualified refs purely from the seed (no catalog lookup of the old name);
  `resolveColumnInSource` is consulted only for inner FROM frames over *other*
  tables, and the renamed table is explicitly skipped there
  (`rename-rewriter.ts isTableInUnaliasedScope`). Moot for index predicates
  anyway (subqueries rejected at predicate-compile), but the arm is sound.
- **Independent sweep for other predicate-AST holders** (`predicate?:` across
  `src/`): `IndexSchema.predicate` (rewritten), derived
  `UniqueConstraintSchema.predicate` (shared reference — confirmed in
  `appendIndexToTableSchema`, the only setter), the memory layer's internal
  index entries (`{ ...idx }` spread keeps the shared reference — confirmed in
  `memory/layer/manager.ts renameColumn`), and catalog's
  `SyntheticExposedIndex` (reads `uc.predicate` on demand). All covered by the
  in-place mutation. All `CompiledPredicate` consumers (memory layer, MV
  maintenance) are positional, so runtime is rename-immune regardless. The
  implementer's audit claim is correct.
- **No parallel text field**: `IndexSchema` has no cached SQL string (unlike
  `ViewSchema.sql`); DDL renders from the AST via `generateIndexDDL` →
  `expressionToString`, so nothing else can go stale.
- **Notification ordering**: `runRenameColumn` fires a first `table_modified`
  whose `newObject` still carries the old predicate, then propagation fires a
  second with the rewrite. The store persist queue processes in order, so the
  final persisted DDL is correct — pinned by the two store tests
  (drain → assert DDL → reopen → zero rehydration errors → write-time
  maintenance honors the predicate).
- **Docs**: read the touched docs/sql.md sections (accurate) and the
  docs/schema.md §index-body-change note about the differ-side qualifier churn
  (still accurate — the `schema-differ-predicate-table-qualifier-reconcile`
  implement ticket has not landed).
- **Lint/types/tests**: `yarn lint` clean, `tsc --noEmit` clean, full
  `yarn test` green across the workspace (5535 passing / 9 pending in quereus,
  399 in quereus-store including the 2 new store tests, all other packages
  green).

### Found and fixed inline (minor)

- **Coverage gap**: the UNIQUE shared-AST identity (`uc.predicate ===
  ix.predicate` post-rename) was pinned only for the **column**-rename arm.
  Added the **table**-rename counterpart test (qualified predicate, identity +
  rendered-text assertions) to `index-ddl-roundtrip.spec.ts` — 7/7 passing.
- **Doc staleness**: docs/schema.md called the follow-up a "backlog ticket";
  it now sits in `tickets/implement/`. Made the reference stage-neutral.

### Noted, not actioned

- sqllogic 41.3 §2b/2c do not pin the fix itself (compiled predicates are
  positional, so the queries pass even with a stale stored AST) — they pin
  post-rename runtime index maintenance. The spec and store tests are the real
  pins; the implementer verified the pre-fix failure empirically by stashing.
- Pre-existing nit, out of scope: `memory/layer/manager.ts renameColumn` sets a
  `name` property on index-column entries that `IndexColumnSchema` does not
  declare — a harmless stray property (DDL generation reads the column name
  positionally via `tableSchema.columns[col.index].name`). Not introduced or
  worsened by this ticket; not worth a ticket.
- Known limitation carried forward intentionally: the rename rewriters stay
  scope-naive about aliases shadowing the renamed name inside predicate
  subqueries — shared with views/CHECKs and unreachable for index predicates
  (subqueries rejected at compile).
- Diff-time churn for a table-qualified predicate under a pure TABLE rename at
  diff #1 remains the differ-side follow-up
  (`schema-differ-predicate-table-qualifier-reconcile`, in implement/).

### Major findings

None. No new tickets filed — the two adjacent gaps (differ-side qualifier
reconcile, MV body not rewritten on source rename) already have tickets in
implement/ and backlog/ respectively.
