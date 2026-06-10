description: REVIEW — declarative differ now detects view/MV definition drift (body, `insert defaults` clause, explicit column list) via a shared canonical-definition renderer, with in-diff rename reconciliation; MV bodyHash redefined over the canonical definition.
files:
  - packages/quereus/src/emit/ast-stringify.ts          # NEW viewDefinitionToCanonicalString (~1072) — the shared canonical renderer
  - packages/quereus/src/schema/catalog.ts              # CatalogView.definition + viewSchemaToCatalog population
  - packages/quereus/src/schema/schema-differ.ts        # views block (~408), MV block (~470), require-hint (~580); reconciledDeclaredViewDefinition + collectFromTableNames (~990-1100)
  - packages/quereus/src/schema/view.ts                 # computeBodyHash / MaterializedViewSchema.bodyHash doc-comments
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # bodyHash stamping (materializeView ~315, applyMaterializedViewRewrite ~720)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic      # new view-drift section (end of file)
  - packages/quereus/test/logic/50.2-declare-schema-renames.sqllogic # new §11-14 (reconciliation + require-hint)
  - packages/quereus/test/schema-differ.spec.ts         # new "view definition drift" describe + catalogView/catalogTableWithColumns helpers
  - packages/quereus/test/declarative-equivalence.spec.ts # MV clause-only / column-list-only rebuild tests
  - docs/schema.md                                      # new §View / materialized-view definition-change detection; corrected tag-drift paragraph; §46 bodyHash wording
----

# Review: view/MV definition drift detection in the declarative differ

## What was broken (all three axes verified live before the fix)

1. A name-matched plain view's body or `insert defaults` clause change diffed
   EMPTY — after `apply`, an insert through the view silently kept writing the
   OLD default.
2. An MV's clause-only or explicit-columns-only change diffed EMPTY —
   `bodyHash` covered `astToString(stmt.select)` only.
3. Soft regression: the deprecated `quereus.update.default_for.<col>` tag this
   clause replaced WAS tag-drift-detected; migrating tag → clause lost detection.

## What was built

**Canonical definition (one renderer, both diff sides).**
`viewDefinitionToCanonicalString(columns, select, insertDefaults)` exported from
`ast-stringify.ts` — explicit column list + `astToString(select)` + the
insert-defaults clause; name/schema/tags excluded. Deliberately NO identifier
case-folding (asymmetry vs constraint/index canonical bodies — documented in
docs/schema.md with rationale: a plain-view recreate is free, an MV case-only
rebuild matches the old select-only-hash behavior).

**Plain views.** `CatalogView.definition` (new required field) populated in
`viewSchemaToCatalog` from live `ViewSchema` fields. The differ's views block
compares declared vs actual definition for every matched view (name- AND
rename-matched); drift → `viewsToDrop` (actual name) + `viewsToCreate`
(declared DDL), `viewBodyRecreates++`, SET TAGS suppressed.
`enforceRequireHint('view', creates − recreates, drops − recreates)`.

**Rename reconciliation** (`reconciledDeclaredViewDefinition`, mirrors
`reconciledDeclaredBody`/`declaredIndexCanonicalBody`): called only on raw
mismatch with in-diff renames present. Clones the select (`cloneQueryExpr`),
inverse-applies ALL table renames NEW→OLD (`renameTableInAst`), then per-table
column renames (`renameColumnInAst`, seeded with OLD table name). The
insert-defaults clause reconciles separately: `d.column` via the FROM tables'
column renames (FROM-scoped lookup — `collectFromTableNames` walks top-level
FROM incl. joins and compound tails, NOT subqueries — so an unrelated table's
rename cannot false-rewrite), `d.expr` via `cloneExpr` + table rewriters +
`renameColumnInCheckExpression` seeded with the FROM table's OLD name. Explicit
column list passes through (view-own output names). This is
correctness-critical for column renames: `generateMigrationDDL` emits view
creates BEFORE the table-alter block, and CREATE VIEW plans its body at create
time — an unreconciled recreate naming the NEW column fails at apply.

**Materialized views.** All three `bodyHash` sites now hash the canonical
definition: creation stamping (`materializeView` — `def.bodySql` stays
select-only for execution), `applyMaterializedViewRewrite` (rename
propagation), and the differ's declared side. The differ's MV block also runs
the same reconcile on raw hash mismatch, so an in-diff source rename no longer
churns a spurious MV rebuild (was pre-existing churn). NOTE: `bodyHash` is
never persisted/deserialized — `importMaterializedView` → `materializeView`
recomputes it at rehydrate — so the formula change has NO store-migration
consequence at all (better than the ticket anticipated; verified by reading
manager.ts ~2519 and running store-mode tests).

## Test coverage (use this as the floor)

- **50-declarative-schema.sqllogic (end):** clause changed / removed / added /
  body changed on a name-matched view — each asserts the DROP VIEW + CREATE
  VIEW diff DDL, post-apply behavior (new default written; NOT NULL failure
  after clause removal; body filter), and converged re-diff `[]`.
- **50.2-declare-schema-renames.sqllogic §11-14:** in-diff COLUMN rename +
  dependent view (body + untouched clause) → only `RENAME COLUMN`, apply
  succeeds, converged; in-diff TABLE rename + dependent view → only `ALTER
  TABLE RENAME`; in-diff TABLE rename + dependent MV → only the rename, no
  re-materialization, row-time maintenance intact, converged re-diff `[]`
  (proves the live propagation re-stamp and the differ formula agree);
  require-hint + view body recreate → apply succeeds.
- **schema-differ.spec.ts (new describe):** clause-only drift → recreate w/o
  SET TAGS; tag-only drift → SET TAGS w/o recreate; require-hint not tripped;
  column-rename reconcile of body + clause-expr; rename of the clause TARGET
  column (projected-away base column — the case the body rewrite can't catch);
  FROM-scoped negative case (unrelated table's rename must not rewrite the
  clause); genuine edit layered on rename still recreates.
- **declarative-equivalence.spec.ts:** MV clause-only change → drop+recreate,
  write-through uses NEW default, bodyHash changes, converged; MV
  column-list-only change → drop+recreate. Pre-existing MV tag-only SET TAGS
  cases unchanged and green.

## Validation performed

- `yarn test` (full monorepo): all green, 5586 passing in quereus core, 0 failing.
- `yarn workspace @quereus/quereus run lint` and `typecheck`: clean.
- Store mode spot-runs (`QUEREUS_TEST_STORE=true`, logic.spec grep): all
  50*-declarative/renames and 51/53*-materialized-view files green.
  (Full `yarn test:store` not run — per AGENTS.md it is reserved for
  store-specific diagnosis/release.)

## Known gaps / honest flags for the reviewer

1. **Residual hazard (documented, deliberately unsolved per ticket):** a
   GENUINE view/MV definition edit that also references a column renamed in
   the same diff still emits CREATE before RENAME COLUMN → fails at apply.
   The optional "emit view/MV creates after the table-alter block" fix was NOT
   taken (migration-order change has wide blast radius). Documented in
   docs/schema.md §View/MV definition-change detection.
2. **Clause-target rename end-to-end:** when the renamed column IS the clause
   target, the differ correctly emits only the rename (unit-tested), but the
   live forward propagation does not rewrite a view's `insertDefaults` on
   RENAME (sibling fix ticket `view-insert-defaults-not-rewritten-on-source-rename`,
   not a prereq) — so post-apply the live clause briefly names the old column
   and the NEXT diff self-heals via a recreate. Deliberately not asserted in
   sqllogic to avoid coupling re-diff expectations to the sibling's landing.
3. **`collectFromTableNames` does not descend into subqueries** — a clause on
   a view whose base table appears only inside a derived-table FROM would not
   clause-reconcile (worst case: a spurious recreate that, for a column
   rename, hits hazard 1). Insert-defaults views are single-source/direct in
   practice; judged acceptable, not documented in docs (reviewer may disagree).
4. **MV + in-diff COLUMN rename reconcile** is exercised only via the shared
   helper's plain-view unit tests and the MV TABLE-rename sqllogic case; no
   dedicated MV-column-rename diff test (live propagation side is covered by
   53.2 / mv-rename-propagation.spec.ts).
5. A definition-changed RENAME-matched view now resolves to drop(old)+
   create(new) — strictly better than before, but a PURE hint-matched view
   rename remains a silent no-op at apply (pre-existing; backlog
   `view-rename-hint-silent-noop`).
