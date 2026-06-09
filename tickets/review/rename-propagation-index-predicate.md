description: Implemented forward rename propagation (ALTER TABLE RENAME / RENAME COLUMN) into stored partial-index predicate ASTs — IndexSchema.predicate (and the derived UNIQUE constraint sharing it) now rewrites alongside CHECKs/FKs/views, fixing post-rename stale catalog/persisted index DDL and the one-cycle-late declarative re-diff churn.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts        # rewriteTableForTableRename / rewriteTableForColumnRename: index-predicate rewrite added
  - packages/quereus/test/index-ddl-roundtrip.spec.ts       # 6 forward-propagation tests + declarative convergence e2e
  - packages/quereus/test/logic/41.3-alter-rename-propagation.sqllogic  # sections 2b/2c (qualified table rename, column rename under partial index)
  - packages/quereus-store/test/index-persistence.spec.ts   # 2 reopen/rehydration tests (persisted DDL follows the rename)
  - docs/sql.md                                              # RENAME TABLE / RENAME COLUMN / declarative-renames propagation lists updated
----

# Review: rename propagation into stored partial-index predicates

## What was implemented

Mirrored the existing CHECK-expression treatment inside the two per-table
rewrite helpers in `runtime/emit/alter-table.ts`:

- **`rewriteTableForTableRename`** — each `table.indexes[].predicate` is run
  through `renameTableInAst(predicate, oldName, newName, renamedSchemaLower)`
  (qualified `ColumnExpr.table` qualifiers + subquery table sources); a changed
  entry is shallow-copied (`{ ...idx }`) into a new frozen `indexes` array,
  marking `changed` so the table is re-added and `table_modified` fires.
- **`rewriteTableForColumnRename`** — same map with the same ternary the CHECK
  path uses: the renamed table goes through the seeded
  `renameColumnInCheckExpression(..., resolveColumnInSource)` (unqualified refs
  resolve against the indexed table, like an implicit CHECK seed); other tables
  get the scope-walking `renameColumnInAst`. The non-renamed-table arm is
  defensive symmetry only — a genuine cross-table predicate ref is impossible
  today (`compilePredicate` rejects subqueries and schema-qualified refs), and
  the "like-named column on another table is NOT rewritten" test pins the
  no-false-positive behavior.

Both rewrites mutate the predicate AST **in place**, so the derived UNIQUE
constraint of a unique partial index — which shares the predicate by reference
via `appendIndexToTableSchema` — is covered by the same rewrite. This was
verified, not assumed: the UNIQUE test asserts `uc.predicate === ix.predicate`
still holds post-rename AND both render the new column name.

### Audit of other `predicate` holders (ticket TODO)

- `UniqueConstraintSchema.predicate` is **only** set via
  `appendIndexToTableSchema` (`derivedFromIndex`); `buildUniqueConstraintSchema`
  and the manager's table-level UNIQUE extraction never populate it. No other
  AST-predicate holder exists.
- The memory module's `renameColumn` spreads index entries (`{ ...idx }`), so
  its internal copies carry the same shared AST; compiled predicates
  (`CompiledPredicate`) are positional, so runtime is unaffected either way.

## Store persistence path (risk flagged in the ticket — now verified)

The propagation's `table_modified` notification drives the store module's
`persistCatalogIfChanged` listener, which regenerates the table bundle
(table DDL + index DDLs) from `event.newObject`. **Nuance discovered:** that
persist rides the store's async `persistQueue` — it is durable only after
`whenCatalogPersisted()` / `closeAll()` drains it. The two new
`index-persistence.spec.ts` tests pin the full loop: rename (table-qualified
WHERE / column rename) → drain → persisted catalog DDL carries the new
qualifier/column → close → reopen → `rehydrateCatalog` reports zero errors,
the index rehydrates `partial`, and write-time maintenance honors the
predicate under the new name. (Pre-fix, the column-rename case would persist
`WHERE b > 0` against a table with no column `b` — exactly the rehydration
failure the ticket flagged as a risk.)

## Use cases for validation

1. **Table rename, qualified predicate**: `create index ix on t (name) where
   t.active = 1; alter table t rename to t2` → `generateIndexDDL` renders
   `... ON "t2" ... WHERE t2.active = 1` (no stale `t.`).
2. **Column rename, unqualified + qualified**: `where active = 1` /
   `where t.active = 1` → both render `is_active` after
   `rename column active to is_active`.
3. **UNIQUE partial index**: derived constraint predicate rewritten through the
   shared AST (identity preserved).
4. **Declarative convergence (the repro-2 case, failed pre-fix)**: declare +
   apply a partial index, re-declare with the predicate column renamed via
   `quereus.previous_name`, apply (runs only RENAME COLUMN — diff #1 is
   reconciled by the already-landed differ work) → catalog DDL shows the new
   name and a re-diff is EMPTY (no deferred index drop/create churn).
5. **Negative guard**: a like-named predicate column on a different table is
   untouched by the rename.
6. Runtime (sqllogic 41.3 §2b/2c, runs under both memory and `test:store`
   legs): partial indexes keep excluding out-of-scope rows after both rename
   forms.

## Verification performed

- Pre-fix failure confirmed empirically: stashing the src change makes the
  first new spec test fail (and pre-fix the store column-rename case persists
  a predicate naming a nonexistent column).
- `yarn test` (full workspace): green — 5535 passing (quereus, 9 pending),
  399 passing (quereus-store, includes the 2 new), all other packages passing.
- `yarn lint` (quereus): clean. `tsc --noEmit`: clean.
- Store leg spot-check: `yarn test:store --grep "41.3"` green (LevelDB-backed
  logic run of the rename-propagation file). Full `yarn test:store` was NOT
  run (AGENTS.md reserves it for store-specific diagnosis/release; the store
  path is covered by the targeted run + the quereus-store package suite).
- `packages/quereus` dist was rebuilt (`yarn build:engine`) — dependent
  packages consume dist, not src; without the rebuild the new store tests
  fail against the stale build (worth remembering when reviewing/re-running).

## Known gaps / notes for the reviewer

- The rename rewriters remain scope-naive about aliases shadowing the renamed
  name inside predicate subqueries — the established limitation of the forward
  path (views/CHECKs share it), intentionally not fixed here to keep the
  forward and differ sides symmetric. Practically unreachable for index
  predicates (subqueries are rejected at predicate-compile time).
- Diff-time churn for a **table-qualified** predicate under a pure TABLE
  rename still exists at diff #1 — that is the differ-side follow-up this
  ticket unblocks (`schema-differ-predicate-table-qualifier-reconcile`, in
  fix/). The doc note in docs/schema.md §index-body-change describing that
  benign churn remains accurate until it lands.
- `oldObject` in the propagation's `table_modified` notification shares the
  mutated AST (only the shallow-copied entries differ) — same accepted shape
  as the pre-existing CHECK/view propagation comments describe.
- Docs updated: docs/sql.md RENAME TABLE / RENAME COLUMN sections and the
  declarative renames overview now list partial-index predicates among the
  propagated dependents.
