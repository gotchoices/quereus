description: A schema change that adds (or renames) a column and an index on it in the same "apply schema" used to fail because the migration plan created the index first; index creates now run after the table-alter block. Reviewed.
architecture: docs/schema.md#migration-order
files: packages/quereus/src/schema/schema-differ.ts (`generateMigrationPlan` end of function; `computeSchemaDiff` index loop ~850-895), packages/quereus/test/apply-schema-index-order.spec.ts, packages/quereus/test/schema-differ.spec.ts, packages/quereus/test/schema/differ-undo-plan.spec.ts, packages/quereus/test/index-ddl-roundtrip.spec.ts, packages/quereus/test/logic/50.2.1-declare-schema-index-renames.sqllogic, docs/schema.md, docs/schema-rename-detection.md
difficulty: easy
----

# Complete: apply schema now creates indexes after the table-alter block

## What changed (landed in the fix stage, verified in implement)

Before: `generateMigrationPlan` pushed `diff.indexesToCreate` in the create block, ahead of the per-table alter block (`RENAME COLUMN` → `ADD COLUMN` → …). Declaring `t(id, b text null)` plus `index t_b on t (b)` over an existing `t(id)` failed with "Column 'b' not found in table 't'"; a hinted column rename plus an index on the new name failed the same way.

Now:
- Index creates are pushed after the alter block and the maintained re-attaches, right before assertion creates (`pushCreates(diff.indexesToCreate, 'index')` near the end of `generateMigrationPlan`). `DROP INDEX` stays early, so a version that drops an index together with its column still applies. Table and view creates are unchanged (views keep their column-rename reconciliation).
- `columnReconciledIndexStmt` was deleted. It existed because a hinted index rename's recreate ran before `RENAME COLUMN` and so had to name the OLD columns; the recreate now runs after the rename and uses the declared statement verbatim (declared, post-rename column names).
- Docs: `docs/schema.md` Migration Order has a new step 5 (index and assertion creates last); `docs/schema-rename-detection.md` no longer mentions the removed helper. No other doc (`schema-undo-plan.md`, `materialized-views.md`) states an index-before-alter order.

## Verification done in this stage

- `yarn test` in `packages/quereus`: 10770 passing, 25 pending, 0 failing. The earlier `alter-table-conformance` timeout (`dropConstraint → UNSUPPORTED`) did not recur.
- `yarn test:store` (LevelDB store path): 10762 passing, 33 pending, 0 failing. The `[TransactionCoordinator] ... out of range` lines in that run are log noise from existing savepoint tests, not failures.
- `yarn lint` in `packages/quereus`: exit 0 (eslint + test-file type-check). No stale `columnReconciledIndexStmt` references anywhere under `packages/` or `docs/`.
- Added in this stage: a case at the end of `50.2.1-declare-schema-index-renames.sqllogic` (add nullable column + index in one apply; asserts the `diff schema` order `ADD COLUMN` then `create index`, the index exists, an indexed lookup works, re-diff is empty). The new mocha spec runs on the memory module only; this sqllogic case is what exercises the same path under `yarn test:store`. Both modes pass.

## Test coverage (floor, not ceiling)

- `apply-schema-index-order.spec.ts`: add column + index; hinted column rename + index on the new name; drop index with its column; forced failure after the moved index create (a later unique index over duplicate data) restores the pre-apply catalog.
- Updated plan-order expectations in `schema-differ.spec.ts`, `differ-undo-plan.spec.ts`, `index-ddl-roundtrip.spec.ts` (index recreate now names the NEW column), and the existing rename case in `50.2.1`.

## Known gaps worth a reviewer's look

- Partial indexes (`where` predicate over a column being added or renamed) and indexes with collate-folded columns (`col collate x`) rely on the same ordering but have no dedicated case; the removed helper was the only code that special-cased those forms, so confirm nothing else still assumed pre-rename column names in index DDL.
- Index on a maintained table / materialized view target created in the same round as the table (the maintained re-attach now precedes index creates) — covered only incidentally by the existing suite (`covering-structure.spec.ts`, `declarative-equivalence.spec.ts` pass).
- Undo plan: the create-index step still undoes to `DROP INDEX IF EXISTS`; its position in the plan moved later, and the executed-undo roundtrip tests in `differ-undo-plan.spec.ts` pass, but there is no case that mixes a column add with an index create and executes the undo.
- No tripwires parked.

## Review findings

- **Diff read (`schema-differ.ts`)**: the move of `pushCreates(diff.indexesToCreate, 'index')` to after the maintained re-attaches is correct; nothing in the alter block (constraint adds, PK change, FK adds) depends on a new index existing, and `DROP INDEX` stays early. Removing `columnReconciledIndexStmt` left no dead imports (`indexedColumnBareName`, `cloneExpr`, `renameColumnInCheckExpression`, `singleSchemaObjectRefResolver` are all still used by `declaredIndexCanonicalBody` and the view/constraint reconcilers). The undo order got better too: undo now drops the new index before dropping the added column.
- **Gap: partial + collate indexes over a renamed column**: tested now. Added a case to `apply-schema-index-order.spec.ts` (hinted index rename, `newc collate nocase`, `where newc is not null`, plus a partial index over an added column): the recreate names `newc` (no `oldc`), the plan orders the column ops before the index creates, the apply works, and re-diff is empty. No other code assumed pre-rename names in index DDL.
- **Gap: executed undo mixing a column add/rename with index creates**: tested now. Added a round-trip case in `differ-undo-plan.spec.ts` (column rename + add, renamed partial/collate index, new partial index). It passes.
- **Gap: index on a maintained table in the reshape round**: tested now. The index create runs after `set maintained as` and works. This turned up a **real defect that already existed (reproduced)**: the catalog leaves out every index on a maintained table, so a declared index there never converges and a second `apply schema` fails. Filed `backlog/bug-declared-index-on-maintained-table-never-converges.md`. The new test reads the live table's indexes for that reason.
- **Docs**: `docs/schema.md` § Migration Order step 5 and `docs/schema-rename-detection.md` match the code; no other doc mentions the old order.
- **Hygiene / types / resource cleanup**: no issues. The change is a relocated call plus a deleted helper, and the comments explain the reason, not the code.
- **Tripwires**: none parked; no conditional concerns found.
- **Validation**: `yarn lint` (packages/quereus) exit 0; `yarn test` 10773 passing, 25 pending, 0 failing. `yarn test:store` not re-run in review; the review only added memory-backed mocha cases and changed no source.
