description: COMPLETE — declarative differ detects view/MV definition drift (body, `insert defaults` clause, explicit column list) via a shared canonical-definition renderer with in-diff rename reconciliation; MV bodyHash redefined over the canonical definition. Reviewed; minor doc/test gaps fixed in the review pass.
files:
  - packages/quereus/src/emit/ast-stringify.ts          # viewDefinitionToCanonicalString — the shared canonical renderer
  - packages/quereus/src/schema/catalog.ts              # CatalogView.definition; CatalogMaterializedView.bodyHash doc fixed in review
  - packages/quereus/src/schema/schema-differ.ts        # views block, MV block, require-hint; reconciledDeclaredViewDefinition + collectFromTableNames
  - packages/quereus/src/schema/view.ts                 # computeBodyHash / MaterializedViewSchema.bodyHash over canonical definition
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # bodyHash stamping (materializeView, applyMaterializedViewRewrite)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic      # view-drift section
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic # §11-15 (§15 MV column-rename added in review)
  - packages/quereus/test/schema-differ.spec.ts         # "view definition drift" describe
  - packages/quereus/test/declarative-equivalence.spec.ts # MV clause-only / column-list-only rebuild tests
  - docs/schema.md                                      # §View/MV definition-change detection (+ subquery caveat from review)
  - docs/sql.md, docs/materialized-views.md, docs/architecture.md   # stale bodyHash wording fixed in review
----

# Detect view / MV definition drift in the declarative differ — COMPLETE

## What was broken

1. A name-matched plain view's body or `insert defaults` clause change diffed
   EMPTY — after `apply`, an insert through the view silently kept writing the
   OLD default.
2. An MV's clause-only or explicit-columns-only change diffed EMPTY —
   `bodyHash` covered `astToString(stmt.select)` only.
3. Soft regression: the deprecated `quereus.update.default_for.<col>` tag this
   clause replaced WAS tag-drift-detected; migrating tag → clause lost detection.

## What was built (implement stage)

- **`viewDefinitionToCanonicalString(columns, select, insertDefaults)`**
  exported from `ast-stringify.ts` — explicit column list + canonical body SQL
  + the insert-defaults clause; name/schema/tags excluded; deliberately no
  identifier case-folding (asymmetry vs constraint/index canonical bodies,
  documented in docs/schema.md). Both diff sides funnel through it.
- **Plain views:** new required `CatalogView.definition` populated in
  `viewSchemaToCatalog`; the differ compares declared vs actual definition for
  every matched view (name- AND rename-matched); drift → drop+recreate,
  `SET TAGS` suppressed, recreates excluded from the require-hint counts.
- **In-diff rename reconciliation** (`reconciledDeclaredViewDefinition`): on raw
  mismatch with renames present, inverse-applies all table renames NEW→OLD over
  a `cloneQueryExpr` clone, then per-table column renames; the insert-defaults
  clause reconciles separately — `d.column` via a FROM-scoped column-rename
  lookup (`collectFromTableNames`: top-level FROM incl. joins/compound legs,
  not subqueries), `d.expr` via `cloneExpr` + the same inverse rewriters
  through the CHECK-expression entry point. Correctness-critical for column
  renames: view creates emit before the table-alter block, so an unreconciled
  recreate naming the NEW column would fail at apply.
- **MVs:** `bodyHash` redefined over the canonical definition at all three
  sites (create stamping, `applyMaterializedViewRewrite` re-stamp, differ
  declared side); the differ's MV block runs the same reconcile, eliminating
  pre-existing spurious-rebuild churn on in-diff source renames. `bodyHash` is
  never persisted — `importMaterializedView` → `materializeView` recomputes at
  rehydrate — so the formula change has no store-migration consequence.

## Review findings

**Read first-hand:** the full implement diff (commit 99b91c04), the differ's
views/MV blocks and `reconciledDeclaredViewDefinition` in current source, the
rename-rewriter and `cloneQueryExpr`/`cloneExpr` contracts, the
`applyMaterializedViewRewrite` in-place-mutation contract, `importCatalog`/
`importMaterializedView` rehydrate path, and every test file touched.

**Correctness checks that came back clean (no findings):**
- `ViewSchema.columns` / `MaterializedViewSchema.columns` are the explicit
  DDL column list only (never derived) on both diff sides — no constant false
  drift for views without an explicit list.
- `applyMaterializedViewRewrite` hashes `mv.selectAst` which the callers have
  already rewritten in place — the re-stamped hash reflects the post-rename
  body (verified against both propagation call sites).
- `columnRenamesByTable` is keyed by declared (new) table name lowercased,
  exactly the key the new helper assumes; `cloneQueryExpr` deep-clones every
  walker-reachable subtree (its own comments cite this differ use).
- Rename-matched drifted view: drop(old)+create(new) with no double-drop (the
  drop loop skips `consumedActuals`); require-hint subtraction is symmetric
  (each recreate contributes exactly one create and one drop).
- `importMaterializedView` recomputes `bodyHash` via `materializeView` at
  rehydrate, confirming the handoff's no-store-migration claim.
- Type safety / error handling / resource cleanup: pure functions, no `any`,
  no swallowed exceptions, no new resources.

**Minor findings — fixed in this pass:**
- Stale doc-comment: `CatalogMaterializedView.bodyHash` (catalog.ts) still
  described the old "canonical body hash / body changed" formula → rewritten
  to canonical-definition wording.
- Stale docs: `docs/sql.md` §materialized-views declarative paragraph,
  `docs/materialized-views.md` "Body-change rebuild" bullet (stated the old
  `fnv1aHash(<canonical body SQL>)` formula explicitly), and
  `docs/architecture.md` MV overview phrase — all updated to the
  canonical-definition formula and the rename-reconcile behavior.
- Handoff gap 3 (undocumented): the `collectFromTableNames` subquery
  limitation is now documented in docs/schema.md §View/MV definition-change
  detection (clause on a view whose base table appears only inside a
  derived-table FROM does not clause-reconcile; worst case a spurious
  recreate).
- Handoff gap 4 (missing test): added 50.2 §15 — in-diff COLUMN rename with a
  dependent MV asserts diff = rename-only, post-apply row-time maintenance and
  renamed output column, and converged re-diff `[]` (proves the live
  column-rename re-stamp and the differ formula agree end-to-end).

**Major findings:** none. The residual hazards the implementer flagged were
re-verified as real but correctly scoped out:
- Genuine view/MV definition edit + same-diff column rename still emits CREATE
  before RENAME COLUMN and fails at apply (pre-existing create-before-alter
  ordering; documented in docs/schema.md with the two-applies workaround).
- Live forward propagation does not rewrite a view's/MV's `insertDefaults` on
  source rename — covered by the open sibling fix ticket
  `view-insert-defaults-not-rewritten-on-source-rename` (next diff self-heals
  via a recreate/rebuild).
- Pure hint-matched view rename remains a silent no-op at apply (pre-existing;
  backlog `view-rename-hint-silent-noop`).

**Validation (review pass):** `yarn workspace @quereus/quereus run lint` and
`typecheck` clean; full quereus suite 5586 passing / 0 failing (twice — before
and after review edits); full logic.spec under `QUEREUS_TEST_STORE=true` green
(227 passing, 4 pending).

**Housekeeping:** the implement-stage agent errored after writing the review
handoff but before deleting its source ticket, leaving a duplicate in
`tickets/implement/`; that stale file was removed in this pass (its work was
fully committed in 99b91c04).
