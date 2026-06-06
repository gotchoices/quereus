description: REVIEW — suppress the spurious named-constraint DROP+ADD that a column/parent-table rename triggers in the declarative differ. A named CHECK/UNIQUE/FK whose body is unchanged except for a renamed identifier (handled by the rename pass in the same diff) now emits ONLY the rename, not a redundant drop+recreate. Fix lives entirely in `computeTableAlterDiff`'s body comparison (plus a small thread-through of table renames + schema name).
files:
  - packages/quereus/src/schema/schema-differ.ts            # the fix: reconciledDeclaredBody + body-comparison change + thread-through
  - packages/quereus/src/schema/rename-rewriter.ts          # renameColumnInCheckExpression (reused, inverse-direction)
  - packages/quereus/src/planner/mutation/scope-transform.ts # cloneExpr (reused; type-only imports → no runtime cycle)
  - packages/quereus/src/emit/ast-stringify.ts              # constraintBodyToCanonicalString (canonical render, both sides)
  - packages/quereus/src/schema/catalog.ts                  # CatalogTable.namedConstraints[].definition (actual-side body)
  - packages/quereus/src/runtime/emit/alter-table.ts        # apply-side RENAME COLUMN/TABLE rewriters (unchanged; relied upon)
  - packages/quereus/test/declarative-equivalence.spec.ts   # new `rename without constraint churn` describe block (4 tests)
  - docs/schema.md                                          # updated "Rename reconciliation" section (replaced the old caveat)
----

# Review: suppress redundant constraint drop+recreate on a rename-only identifier change

## What changed (and why)

The declarative differ's named-constraint body-change detector compared two canonical body
strings: the **declared** side (rendered with the NEW identifier names) vs the **actual** catalog
side (rendered with the OLD/current names, because the rename has not landed at diff time). When a
column — or an FK's parent table — was renamed in the same apply, those strings differed *purely*
because of the renamed identifier, so the body-change path fired a spurious `DROP CONSTRAINT` +
`ADD CONSTRAINT` **on top of** the rename the diff already emitted.

This converged (RENAME runs before DROP/ADD within the table block) but was churn: for UNIQUE/FK the
redundant re-add re-validates **every existing row** (full scan) on a metadata-only rename, and the
drop+recreate is **not atomic** on the memory backend (a failed re-add strands the constraint
dropped) — a new failure surface on a previously-safe rename.

### Fix shape (committed design — inverse-on-declared)

Reconcile the **declared** body back to the actual (pre-rename) names before comparing, rather than
rewriting the actual side forward. Chosen because the actual side is only a string in the catalog;
rewriting it forward would require enriching every `CatalogTable.namedConstraints` entry with a
lifted AST (catalog bloat + serialization). Inverse-on-declared keeps the whole change inside
`schema-differ.ts` (plus a small thread-through), reuses the **same** canonical renderer on both
sides (byte-comparable), and reuses the runtime CHECK rewriter.

Mechanics in `computeTableAlterDiff` (`schema-differ.ts`):
- **Thread-through**: `computeTableAlterDiff` now also takes `tableRenames: ReadonlyArray<RenameOp>`
  and `schemaName: string`, passed from the call site (`tableRenames.renames`, `targetSchemaName`).
- **`DeclaredNamedConstraint.bodyAst`**: the lifted `AST.TableConstraint` is kept so the body can be
  re-rendered after an inverse rewrite (never mutated — it backs `ddl`/`definition`; reconciliation
  clones first).
- **`reconciledDeclaredBody(...)`**: surgical clone + inverse rename →
  - CHECK: `cloneExpr(tc.expr)` then `renameColumnInCheckExpression(expr, tableName, newName, oldName, schemaName)` (args swapped for the inverse).
  - UNIQUE: clone `columns`, map each `name` new→old.
  - FK: clone `columns` (child cols, new→old) AND `foreignKey` (parent `table` new→old via the threaded table renames). Referenced parent columns are cloned but NOT rewritten (see limitation).
- **Comparison**: `d.definition !== matchedActual.definition && reconciledDeclaredBody(...) !== matchedActual.definition`. The raw-string check short-circuits the common no-rename case; reconciliation runs only on a mismatch. Equal-after-reconcile ⇒ pure rename ⇒ skip drop+recreate (flows to the existing rename/tag paths). Differ-after-reconcile ⇒ genuine body change ⇒ drop+recreate exactly as before.

Precedence preserved: a genuine body edit layered on a rename still differs after reconciliation, so
`renamesSuppressedByBodyChange` / `bodyChangedNames` and the `require-hint` `pureCreate/pureDrop`
counts are unaffected (a suppressed pseudo-body-change is a matched constraint — never counted as a
pure add or drop).

## How to validate (use cases)

Spec: `packages/quereus/test/declarative-equivalence.spec.ts` →
`describe('declarative-equivalence: rename without constraint churn')` (4 new tests). Each uses the
`diffOf(db)` pattern (declare → apply → re-declare-with-rename → diff):

- **CHECK over a renamed column** — `columnsToRename` carries the rename; `constraintsToDrop`/`constraintsToAdd` empty; migration DDL has RENAME COLUMN and NO DROP/ADD constraint; CHECK still enforces under the new name; re-diff is a no-op.
- **UNIQUE over a renamed column** — same shape (the no-scan property follows from not re-adding); UNIQUE still enforces; idempotent.
- **FK whose PARENT TABLE is renamed** (`parent → p2` via table `quereus.previous_name`) — top-level `diff.renames` carries the table rename; child alter has no FK drop/add; FK still enforces against the renamed parent under `pragma foreign_keys = true`; idempotent.
- **REGRESSION: genuine body edit layered on a column rename** — rename `qty → quantity` AND `> 0 → >= 0`; `constraintsToDrop`/`constraintsToAdd` ARE populated; the new predicate enforces. Guards precedence.

Existing regression guards that must stay green (in the same file): the
`named-constraint body change (drop+recreate)` block (a real body edit still drops+recreates), and
`a hinted constraint rename whose body ALSO changed suppresses the RENAME and does drop+add`.

### Commands run (all green)
- `yarn workspace @quereus/quereus run typecheck` → exit 0
- `yarn workspace @quereus/quereus run lint` → exit 0
- `yarn workspace @quereus/quereus run test:single packages/quereus/test/declarative-equivalence.spec.ts` → 59 passing
- `yarn workspace @quereus/quereus test` (full suite) → **4847 passing, 9 pending**, exit 0

## Known gaps / things for the reviewer to probe

- **FK referenced-column-on-parent (documented, out of scope, NOT a regression):** an FK *referenced
  column* renamed on the *parent* table is not reconcilable inside the child's
  `computeTableAlterDiff` — the parent's column renames are computed in the parent's own per-table
  diff and aren't visible cross-table in the single-pass architecture. That narrow case still churns
  a drop+recreate (same as before). A two-pass fix is a follow-up; commented in code
  (`reconciledDeclaredBody` JSDoc) and `docs/schema.md`. **Consider filing a backlog ticket** if the
  reviewer wants it tracked beyond the inline note.
- **`tableName` arg to `reconciledDeclaredBody`** is `actualTable.name`. For the CHECK rewriter this
  only seeds unqualified-ref resolution (always matches) and matches qualified refs by table name.
  When BOTH the table and a column are renamed AND a CHECK uses a *table-qualified self-reference*,
  neither the actual nor declared name fully reconciles (the table qualifier inside a CHECK is not
  rewritten by the column rewriter) — a corner-of-a-corner that still churns harmlessly. Worth a
  sanity check that this can't *false-suppress* a real change (analysis says no: inverse rewrite only
  maps renamed identifiers exactly, so reconciled==actual iff the only difference was the rename).
- **Store backend not exercised here.** The fix is backend-agnostic *diff* logic; the apply-side
  RENAME rewriters in `runtime/emit/alter-table.ts` (which rewrite CHECK exprs + FK refs on the
  in-memory `TableSchema`, shared across modules) are unchanged and relied upon. `test:store` was not
  run (slower, out of ticket scope). Reviewer may run `yarn test:store` to confirm the store's
  RENAME COLUMN/TABLE persists the rewritten constraints now that the redundant drop+recreate no
  longer masks any gap there.
- **Multi-rename ordering edge:** inverse column renames are applied sequentially. A pathological
  column-name *cycle/swap* in one diff (e.g. `a→b` and `c→a`) could mis-reconcile — but the forward
  rename rewriter has the same property and such cycles are not a supported scenario. Not handled.
