description: Every CHECK, UNIQUE and FOREIGN KEY rule written without a name is now stored under a reserved automatic name at every place a rule is created, so each one can be dropped by name and a declared schema that stops listing one applies instead of failing. Review the naming change, the guards it made unnecessary, and the test and doc churn.
architecture: docs/schema-rename-detection.md#unnamed-constraint-lifecycle-body-matched
files:
  - packages/quereus/src/schema/table.ts               # mintTableCheckConstraintName, isAutoConstraintName (moved here from catalog.ts)
  - packages/quereus/src/schema/constraint-builder.ts  # mintUniqueConstraintName, mintForeignKeyConstraintName, nameAddedTableConstraint; buildUniqueConstraintSchema(takenNames?); extractColumnLevelUniqueConstraints(columnDef, takenNames); mintCheckConstraintName deleted
  - packages/quereus/src/schema/manager.ts             # extractCheckConstraints / extractUniqueConstraints mint; CREATE-time backing-name guard call removed
  - packages/quereus/src/schema/catalog.ts             # hasUserWrittenName; isAnonymousUniqueConstraint / assertUniqueConstraintNotDuplicated / describeUniqueConstraint; pairwise backing-name guards + DeclaredUniqueConstraint deleted
  - packages/quereus/src/runtime/emit/add-constraint.ts # names the constraint once before dispatch; statement text keeps the user-written name
  - packages/quereus/src/runtime/emit/alter-table.ts   # runAddColumn: one taken set for the UNIQUE + CHECK extractors
  - packages/quereus/src/schema/schema-differ.ts       # mintUnnamedConstraintName routed through the shared mints; refusal kept, comment rewritten
  - packages/quereus/src/runtime/row-constraints.ts    # generateDefaultConstraintName doc: hand-built-schema fallback only
  - packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus-store/src/common/store-module-alter.ts  # UNIQUE builder gets the table's taken set
  - docs/sql-constraints.md, docs/sql-alter.md, docs/sql-alter-rename.md, docs/sql-ddl.md, docs/sql-vtab.md, docs/schema.md, docs/schema-rename-detection.md, docs/determinism.md, docs/functions.md, docs/memory-table.md, docs/invariants.md
----

# Name every unnamed constraint where it is created — review handoff

## What changed

Every CHECK / UNIQUE / FOREIGN KEY the user leaves unnamed is stored under a reserved `_`-prefixed name at every creation site: `CREATE TABLE`, catalog rehydrate (`importTable`, which uses the same extractors), logical (lens) tables, `ALTER TABLE … ADD CONSTRAINT`, `ADD COLUMN` inline, and the declarative differ.

| declaration | stored name |
|---|---|
| column-level CHECK on `a` | `_check_a` (unchanged) |
| table-level CHECK | `_check_<n>`, `n` = its position in `checkConstraints`, bumped while taken (`mintTableCheckConstraintName`) |
| UNIQUE | `_uc_<cols as written>`, `_<N>` suffix on collision (`mintUniqueConstraintName`) |
| FOREIGN KEY | `_fk_<table>_<cols>` (unchanged; now via `mintForeignKeyConstraintName`) |

- **Imperative ALTER no longer spells `check_<n>`.** It is `_check_<n>` now, the same label a violation reported before.
- **The `ADD CONSTRAINT` emitter names the AST once** (`nameAddedTableConstraint`), right after `assertConstraintNameFree` runs on the user-typed name. It does this for FKs too, not only CHECK/UNIQUE, so "every engine path arrives named" is literally true. The pre-dispatch FK collation build, the CHECK row scan, both UNIQUE guards, the module and the isolation overlay all read that one name. `describeAddCheck` and the UNIQUE operation text use the user-written name (`declaredName`).
- **"Anonymous" now means "no user-written name".** `hasUserWrittenName` in `catalog.ts` returns false for an absent name or an `isAutoConstraintName` one. `isAnonymousUniqueConstraint`, the early return in `assertUniqueConstraintNotDuplicated` and `describeUniqueConstraint` all use it. The duplicate-UNIQUE refusal therefore still fires after the mint, and `constraint _x unique (a)` beside `unique (a)` is now refused as a duplicate.
- **Deleted as unreachable: the pairwise backing-name guards** (`assertUniqueConstraintBackingNamesDistinct`, `assertNoDuplicateUniqueConstraintBackingNames`, `DeclaredUniqueConstraint`, and the CREATE TABLE / ADD COLUMN calls to them).
  - CREATE TABLE and ADD COLUMN mints are disambiguated against every user-written name and earlier mint in the statement.
  - User-written duplicates are refused by the name guards first.
  - So no two UNIQUEs in one declaration can derive one name. The ALTER-path `assertUniqueConstraintIndexNameFree` is kept unchanged: it still sees the table, which a module could hand-build.
- **The differ's "created without a name" throw is kept.** It is now reachable only through a hand-built module `TableSchema`. Removing it and the other nameless fallbacks is backlog `debt-constraint-schema-name-required`.

## Behaviour changes a reviewer should weigh

- **Lens messages quote auto-names.** Examples: `lens:unique:_uc_email` (was `lens:unique`), advisory site `unique '_uc_grp'` (was `unique`), `basis unique '_uc_a'` (was `basis unique (a)`). I accepted these by analogy with the ticket's accepted `lens:_check_<n>`. If the column-list form reads better, the sites are `setLevelConstraintName` / `setLevelCommitOnly` (`lens-enforcement.ts`), `basisKeyLabel` and `constraintLabel` (`lens-prover.ts`); a `hasUserWrittenName`-style test there would restore the old text.
- **Module-side BUSY statement text shows the mint.** The memory and store UNIQUE arms build `add constraint <uc.name> unique (…)`, and both FK arms call `describeAddForeignKey(constraint.name)`. Both now print e.g. `add constraint _uc_c unique (c)` / `add constraint _fk_t_b foreign key`, because the engine names the AST before dispatch. Tests match only `/commit the pending writes first/`, so this is cosmetic.
- **Mint vs index names.** The mint avoids constraint names only, not index names.
  - A plain user index `_uc_x` still makes `add unique (x)` fail with "would collide with existing index", as the ticket said to leave it.
  - A `create unique index _uc_x …` synthesizes a constraint with that name, so the mint *does* skip it: `add unique (x)` now succeeds as `_uc_x_2` (10.5.7 `cn_ok4` / `cn_ok5` flipped to assert this).
  - Whether the mint should also skip plain index names is open.
- **Declarative DROP COLUMN plan.** When a dropped column carries an unnamed UNIQUE, the plan is now `DROP CONSTRAINT _uc_a` then `DROP COLUMN a`, the same as for a user-named UNIQUE (checked with a probe). Before, the DROP COLUMN alone pruned it.
- **RENAME COLUMN no longer moves `_uc_a` to `_uc_z`** (memory and store). An index already named `_uc_z` no longer blocks the rename. The memory/store rename code paths are untouched (they key on `uc.name ?? …`).
- **Legacy store catalog (documented in `docs/schema.md`, not handled).** Take a catalog holding two UNIQUEs that shared one backing structure: two duplicate nameless UNIQUEs, or `constraint _uc_c unique (b)` beside nameless `unique (c)`. On load the second gets a distinct mint, and its backing store was never built, so it goes unenforced. The store test `a legacy catalog whose two UNIQUEs derive one backing structure name still reopens` asserted the old behaviour and was deleted.
- **DROP COLUMN / DROP TABLE refusals** for a column or table an unnamed CHECK references now quote `CHECK constraint '_check_0'` instead of the expression.
- **ADD COLUMN operation text uses `isAutoConstraintName(uc.name)`** to choose between `UNIQUE` and `constraint 'x'`, so a user-typed `_x` reads as `UNIQUE`. This is the same corner `isAutoConstraintName` already documents. ADD CONSTRAINT uses the real user-written name instead.

## Tests

Added or flipped to pin the new contract:
- `test/logic/10.1.4-create-table-duplicate-constraint-names.sqllogic` §6 (new):
  - CREATE stores a table-level CHECK as `_check_0` and a UNIQUE as `_uc_b`.
  - `alter table … add check` then stores `_check_1`.
  - Both auto-names drop by name, and violating inserts are then accepted.
- `test/logic/50-declarative-schema.sqllogic` (`uc_f`): the refusal case flipped. A declaration dropping the unnamed table-level CHECK and UNIQUE emits `DROP CONSTRAINT _check_1` and `_uc_a`, after which neither rule binds.
- `test/declarative-upgrade-equivalence.spec.ts`: the `freshRemovable` flag is removed. Every case's fresh-v2 downgrade now converges and matches a fresh v1's constraint set; seven cases used to assert the refusal.
- `test/index-ddl-roundtrip.spec.ts`: the two CREATE refusal tests became one test. `unique (a_b), unique (a, b)` is stored as `_uc_a_b` / `_uc_a_b_2` and both enforce.
- `quereus-store/test/index-persistence.spec.ts`: the old "rename refused" and "rename relocates store" tests became one test. A rename keeps the `_uc_a` store beside a user index `_uc_z`, still enforcing, across a reopen.

Expectation churn only: `10.1.5` (`check_<n>` → `_check_<n>`), `10.5.7` (§9f rename and §11 collisions rewritten around "the mint disambiguates"; redundant `iul_rn` and §12 `as_bn` removed), `06.3.3`, `41.3`, `41.10.2`, `41.10.4`, `55.5`, `alter-add-constraint.spec.ts`, `alter-mint-collision-disambiguation.spec.ts`, `alter-drop-rename-constraint.spec.ts` (refused-rename test deleted as unreachable), `lens-enforcement.spec.ts`, `write-scope-analyzer.spec.ts`, store `tag-persistence.spec.ts` / `unique-constraints.spec.ts`.

## Validation run

- `yarn build`: clean.
- `yarn lint` (quereus): clean. quereus-store `yarn typecheck`: clean.
- quereus mocha (full, spec reporter): 11185 passing, 0 failing.
- Every other workspace's `test`: green (store 2017 passing).
- Store-backed logic suite (`QUEREUS_TEST_STORE=true` mocha on `logic.spec.ts`, the same thing `yarn test:store` runs, without `--bail`): 384 passing.
- Note: mocha's `dot` reporter writing to a file here exits 0 without printing a summary, even with failures present. Use `--reporter spec` to trust a non-bail run.

## Unreachable code deliberately kept (all for a hand-built nameless schema)

- the differ's refusal throw
- `generateDefaultConstraintName`
- `findUniqueConstraintSharingBackingName`
- the RENAME COLUMN collision refusal for a nameless UNIQUE
- memory `ensureUniqueConstraintIndexes` name adoption
- nameless-expression wording in the DROP COLUMN / DROP TABLE CHECK refusals

All of it is covered by `debt-constraint-schema-name-required`.
