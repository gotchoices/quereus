description: A table-level CHECK or any UNIQUE rule written without a name is stored with no name at all, so no statement can drop it and a declared schema that stops listing it fails to apply. Store every such rule under a reserved automatic name (the way column-level CHECKs and foreign keys already are), so every rule can be dropped by name.
architecture: docs/schema-rename-detection.md#unnamed-constraint-lifecycle-body-matched
files:
  - packages/quereus/src/schema/table.ts               # disambiguateAutoConstraintName (~320) — add the shared `_check_<n>` mint beside it
  - packages/quereus/src/schema/manager.ts             # extractCheckConstraints (~1940), extractUniqueConstraints (~2042), buildTableSchemaFromAST (~2105) / buildLogicalTableSchema (~2190) taken-set wiring
  - packages/quereus/src/schema/constraint-builder.ts  # buildUniqueConstraintSchema (~40), buildCheckConstraintSchema + mintCheckConstraintName (~133-175), extractColumnLevelUniqueConstraints (~272)
  - packages/quereus/src/schema/catalog.ts             # isAnonymousUniqueConstraint (~874), assertUniqueConstraintNotDuplicated (~908), isAutoConstraintName (~238)
  - packages/quereus/src/runtime/emit/add-constraint.ts # emitAddConstraint / runAddCheckEngineSide / runAddConstraintViaModule — mint before dispatch
  - packages/quereus/src/runtime/emit/alter-table.ts   # runAddColumn inline-constraint extraction (~790)
  - packages/quereus/src/schema/schema-differ.ts       # mintUnnamedConstraintName (~2330), diffUnnamedConstraints refusal (~2245) and its doc comment
  - packages/quereus/src/runtime/row-constraints.ts    # generateDefaultConstraintName — now a legacy fallback only
  - packages/quereus/test/logic/50-declarative-schema.sqllogic, test/logic/10.1.5-alter-add-constraint-minted-name-disambiguation.sqllogic, test/logic/47.5-upsert-do-update-constraints.sqllogic, test/alter-add-constraint.spec.ts, test/schema/alter-mint-collision-disambiguation.spec.ts  # expectations that spell `check_<n>` or a nameless constraint
  - docs/schema-rename-detection.md, docs/sql-constraints.md, docs/sql-alter.md, docs/sql-alter-rename.md, docs/determinism.md, docs/functions.md, docs/memory-table.md, docs/schema.md
----

# Name every unnamed constraint where it is created

## Today

| declaration | `CREATE TABLE` stores | `ALTER TABLE … ADD` (unnamed) stores | declarative upgrade `ADD` stores |
|---|---|---|---|
| column-level CHECK on `a` | `_check_a` | ADD COLUMN inline: `_check_<col>` | `_check_a` |
| table-level CHECK | *no name* | `check_<n>` (user-class, no `_` prefix) | `_check_<n>` |
| UNIQUE (column or table) | *no name* | *no name* | `_uc_<cols>` |
| FOREIGN KEY on `b` | `_fk_t_b` | `_fk_t_b` | `_fk_t_b` |

A constraint stored with no name cannot be removed by `DROP CONSTRAINT` (resolution is by stored name only). So the declarative differ refuses a declaration that stops listing one (`diffUnnamedConstraints`, "created without a name, so no statement can drop it"), and the imperative mint `check_<n>` is user-class, so a declaration listing that CHECK unnamed later drops `check_<n>` and re-adds it as `_check_<n>` once.

## Design

**One rule: every CHECK / UNIQUE / FOREIGN KEY the user leaves unnamed is stored under a reserved `_`-prefixed name, at every site that creates one.** A name beginning with `_` is already the "no user identity" class everywhere (`isAutoConstraintName` in `catalog.ts`): the catalog lists it under `unnamedConstraints` and the differ matches it by body. Giving these constraints such a name changes nothing about how they are diffed — it only makes them droppable.

| declaration | stored name (all three sites) |
|---|---|
| column-level CHECK on `a` | `_check_a` (unchanged) |
| table-level CHECK | `_check_<n>` |
| UNIQUE | `_uc_<cols>` |
| FOREIGN KEY | `_fk_<table>_<cols>` (unchanged) |

### The two mints

- **Table-level CHECK → `_check_<n>`**, `n` = the position the CHECK takes in the table's `checkConstraints` list (column-level CHECKs come first at CREATE; an ALTER/declarative ADD appends, so `n` = current CHECK count), then bumped upward while `_check_<n>` is taken. This is exactly the label a nameless CHECK's violation already shows (`generateDefaultConstraintName` in `runtime/row-constraints.ts` uses the list index), so a CHECK-violation message is unchanged in every non-colliding case. Add one function beside `disambiguateAutoConstraintName` in `schema/table.ts` — e.g. `mintTableCheckConstraintName(position: number, taken: Set<string>): string` — that bumps, registers the chosen name (lower-cased) into `taken`, and returns it. It replaces three copies: `mintCheckConstraintName` in `constraint-builder.ts` (which spells `check_<n>` today), the table-level-CHECK branch of `mintUnnamedConstraintName` in `schema-differ.ts`, and the new CREATE site. Bump the index, don't suffix it — `_check_1_2` is the shape `mintCheckConstraintName`'s doc already rejects.
- **UNIQUE → `_uc_<cols>`** = `implicitIndexNameForColumns(undefined, <column names as written in the declaration>)`, passed through `disambiguateAutoConstraintName(…, taken)`. This is already the covering structure's name, so a non-colliding constraint's backing index keeps the name it has today (same on-disk store key). Use the column names **as written in the constraint** (`con.columns[].name`, or `colDef.name` for an inline `a int unique`), the same source the differ's mint and `_check_<col>` / `_fk_<table>_<cols>` use, so a fresh create and a declarative add spell the name identically.

`check_<n>` gets no special treatment: a database that already holds one keeps it as an ordinary user-class name (backwards compatibility is not a concern yet — AGENTS.md).

### Where each mint runs

- **CREATE TABLE / rehydrate / logical (lens) tables** — `SchemaManager.extractCheckConstraints` mints table-level CHECKs (pass the position = `result.length` at push time); `extractUniqueConstraints` takes the same statement-wide `takenConstraintNames` set and threads it into `buildUniqueConstraintSchema`. Both `buildTableSchemaFromAST` and `buildLogicalTableSchema` already build that set and share these extractors, so `importTable` (store reopen, `importDDL`) gets the names for free: a catalog persisted before this change, whose DDL carries a nameless constraint, is named on load by the same deterministic rule, and the next DDL rewrite persists the name. No upgrade step is needed.
- **`ALTER TABLE … ADD CONSTRAINT`** — name the AST constraint in `emitAddConstraint` **before** either dispatch arm, immediately after the user-name check (`if (constraint.name) assertConstraintNameFree(…)` must still see only the name the user typed). Everything downstream — the engine-side CHECK arm, the pre-dispatch CHECK row scan, the UNIQUE guards, `module.alterTable`, and the isolation layer's `installOverlayUniqueConstraint` (which names its overlay index from `constraint.name`) — then sees one already-named constraint, so no module re-derives the name. Keep user-facing operation text (`add UNIQUE constraint to table …`, `describeAddCheck(…)`) keyed on the user-written name, not the mint.
- **`ALTER TABLE … ADD COLUMN` inline** — `extractColumnLevelUniqueConstraints(columnDef, takenNames)` mints `_uc_<col>` like `extractColumnLevelCheckConstraints` already mints `_check_<col>`; in `runAddColumn` (~line 790) pass both extractors the same taken set.
- **Builders as a fallback** — `buildCheckConstraintSchema` keeps `con.name || mint` (now `_check_<n>`); `buildUniqueConstraintSchema` gains an optional `takenNames?: Set<string>` and mints `_uc_<cols>` when the name is absent (disambiguated when a set is given — same optional shape as `buildForeignKeyConstraintSchema`). Engine paths always arrive named; this covers third-party modules calling the exported builders directly. Change `buildCheckConstraintSchema`'s `takenNames` to `Set<string>` if the shared mint registers into it (callers pass fresh sets from `collectTableConstraintNames`).

### "Anonymous" now means "no user-written name"

`isAnonymousUniqueConstraint` (`catalog.ts`) and the early return in `assertUniqueConstraintNotDuplicated` test `name === undefined` today. Once unnamed UNIQUEs carry `_uc_*`, that test would silently switch the duplicate-UNIQUE refusal off (`unique (a), unique (a)` would mint `_uc_a` / `_uc_a_2` and both be accepted). Change both to "name absent **or** `isAutoConstraintName(name)`". That keeps the refusal at all three sites regardless of whether the guard runs before or after the mint, and is consistent with the catalog, which already treats a `_`-name as unnamed-class. Consequence: a user-written `constraint _x unique (a)` beside `unique (a)` is now refused as a duplicate; update the docs' "named UNIQUE beside an unnamed one is legal" carve-out to say *user-named (no leading `_`)*.

### The differ refusal

With every engine path naming its constraints, the "created without a name" throw in `diffUnnamedConstraints` is unreachable for any table the engine built (including reopened ones). Keep the throw — the schema types still permit a nameless constraint, and a module that builds a `TableSchema` by hand could still produce one — but rewrite its doc comment and the docs section to say that is now the only way to reach it. Removing the throw and the other nameless fallbacks is the backlog ticket `debt-constraint-schema-name-required`.

### Accepted residual (document it; don't engineer around it)

Fresh and upgraded databases store identical names when the declaration evolves by appending constraints — the common case. They can still differ when constraints are removed or reordered, because `_check_<n>` is positional (fresh: `[check(x), check(y)]` → `_check_0`, `_check_1`; drop `x`, append `z` → fresh `y`=`_check_0`, `z`=`_check_1`, upgraded keeps `y`=`_check_1` and mints `z`=`_check_2`), and because a stored name does not follow a later RENAME COLUMN. This is harmless: these names are matched by body, never by name, so neither database ever re-diffs. A body-hash name would make them always identical at the cost of an unreadable violation label; rejected. Replace the "Accepted residual" paragraph in `docs/schema-rename-detection.md` with this statement.

## Behaviour that changes (expected test churn)

- `ALTER … ADD CHECK (…)` unnamed stores `_check_<n>`, not `check_<n>` — update the test files listed in `files:` that spell `check_<n>`.
- Introspection (`check_constraint_info` / `unique_constraint_info`, `docs/functions.md` "NULL for unnamed") reports the auto-name instead of NULL for a table-level CHECK or UNIQUE.
- Generated / persisted table DDL now spells `constraint _check_<n> check (…)` and `constraint _uc_<cols> unique (…)` (the DDL generator already emits `_`-names and they re-parse stably — `emitTableConstraints` in `ddl-generator.ts`).
- DROP COLUMN's refusal for a column named by a table-level CHECK now has a name to quote (`docs/sql-alter.md` line ~75 says only an unnamed table-level CHECK can't be addressed — no longer true).
- A declaration that stops listing a CREATE-time table-level CHECK or UNIQUE now applies (DROP CONSTRAINT by the stored name) instead of throwing — the existing refusal case in `50-declarative-schema.sqllogic` flips.
- RENAME COLUMN no longer moves an unnamed UNIQUE's covering structure from `_uc_a` to `_uc_z`: the structure takes the stored name, like any named UNIQUE. The memory/store rename code paths keyed on `uc.name ?? implicitIndexNameFor(uc)` handle this without change; update `docs/sql-alter-rename.md` (~line 44) and `docs/memory-table.md` (~line 596), which describe the moving name, to say it applies only to a constraint stored without a name.
- Lens (logical-table) CHECK violations name the constraint `lens:_check_<n>` instead of `lens:check` (`view-mutation-builder.ts` ~1187, `lens-enforcement.ts` ~525 use the name when present). Accepted: physical tables already show `_check_<n>`.
- Two unnamed UNIQUEs whose `_uc_` spellings collide on ordinary column names (`unique (a_b)` beside `unique (a, b)`) are now disambiguated at CREATE (`_uc_a_b`, `_uc_a_b_2`) instead of refused by `assertNoDuplicateUniqueConstraintBackingNames`; an existing test asserting that refusal at CREATE should flip to asserting both are enforced. The ALTER path still refuses a mint that collides with a user **index** name (`assertUniqueConstraintIndexNameFree` runs on the minted name) — leave that as is.

## Edge cases & interactions

- **Mint vs user name in one statement** — `create table t (a int, constraint _check_1 check (a > 0), check (a < 9))`: the taken set is seeded with user-written names first (`collectDeclaredConstraintNames`), so the table-level CHECK at position 1 bumps to `_check_2`. Same for `constraint _uc_a unique (b), unique (a)` → `_uc_a_2`, except that pair is now a refused duplicate only if the column sets match (they don't here). Verify by inspection; the existing `alter-mint-collision-disambiguation.spec.ts` covers the ALTER shape.
- **Column-level `_check_<col>` vs positional `_check_<n>`** — a column literally named `1` mints `_check_1`; the table-level mint must bump past it. Column-level mints run first and register into the shared set, so it does. Inspection.
- **Duplicate unnamed UNIQUE** at CREATE, `ADD CONSTRAINT`, and `ADD COLUMN … unique` must still be refused with the existing "an equivalent UNIQUE constraint on (…) already exists" message — the predicate change above is what keeps this. Existing tests cover all three; they must stay green unchanged.
- **`ADD CONSTRAINT` pre-dispatch CHECK scan and module build must agree on the name** — today both call `buildCheckConstraintSchema` with the same inputs; after the change the emitter names the AST once and both read it. Assert by inspection that `runAddCheckEngineSide`, the pre-dispatch scan, and the module receive the same named object.
- **Undo of a declarative `DROP CONSTRAINT`** (`UndoRenderer.forwardRenamedConstraint`, docs/schema-undo-plan.md) restores by the stored name, which now always exists. No change expected; covered by existing undo tests.
- **Store reopen** — a table created after the change persists the names and reopens to the same names; a table persisted before the change (nameless in its DDL) is minted on load by the same rule. A catalog that held two duplicate unnamed UNIQUEs from before the duplicate guard existed now mints `_uc_a` and `_uc_a_2`, and the store will look for a `_uc_a_2` index store that was never built; contrived legacy shape, backwards compatibility not a concern — note it in `docs/schema.md` beside the existing import-path paragraph rather than handling it. Verify by running `yarn test:store` once (persisted DDL is store-specific).
- **Memory unique-index reuse** — when an unnamed UNIQUE reuses an existing user unique index (`MemoryTableManager` ~3150, `uc.name ?? matchingUniqueIndex.name`), the covering-structure map is now keyed by the minted `_uc_<cols>` name, the same key readers derive. This removes the lookup-miss half of backlog ticket `debt-memory-unique-index-reuse-after-create-index` (noted there); no extra work here.
- **Sync / isolation** — the isolation overlay's UNIQUE index name comes from `constraint.name`, which is now always set by the engine before dispatch, so it matches the underlying module's name in the disambiguated case too. Inspection.

## Tests

Default is to update existing expectations, not add files. Add one sqllogic case (in `50-declarative-schema.sqllogic` beside the refusal case it replaces, or a short new numbered file) that pins the new contract on the branching logic:

- `create table t (a integer primary key, b integer, check (b > 0), unique (b))` → `check_constraint_info('t')` / `unique_constraint_info('t')` report `_check_0` and `_uc_b`; `alter table t drop constraint _check_0` and `alter table t drop constraint _uc_b` both succeed, after which a violating insert is accepted.
- A declarative apply whose new declaration stops listing an unnamed table-level CHECK and an unnamed UNIQUE succeeds and leaves neither enforced (was: refused).
- `alter table t add check (b < 100)` on a table with one CHECK stores `_check_1`.

## TODO

- Add `mintTableCheckConstraintName` to `schema/table.ts`; route `buildCheckConstraintSchema` and the differ's table-level-CHECK branch through it; delete `mintCheckConstraintName`.
- `extractCheckConstraints`: mint table-level CHECKs by position; update its doc comment.
- `buildUniqueConstraintSchema(con, columnIndexMap, takenNames?)`: mint `_uc_<cols>` from the declared column names; `extractUniqueConstraints` passes `takenConstraintNames` (column-level inline UNIQUE mints from `colDef.name`).
- `extractColumnLevelUniqueConstraints(columnDef, takenNames)`: mint; update `runAddColumn` to share one taken set with the CHECK extractor.
- `emitAddConstraint`: name the AST constraint right after `assertConstraintNameFree`, use the named constraint for both arms; keep messages on the user-written name.
- `isAnonymousUniqueConstraint` / `assertUniqueConstraintNotDuplicated`: treat `_`-prefixed names as anonymous.
- `diffUnnamedConstraints`: keep the throw, rewrite its comment (reachable only for a hand-built module schema).
- Update the docs listed in `files:` (auto-naming tables in `sql-constraints.md` §intro and `sql-alter.md` lines ~60/75/116-122, `determinism.md` ~270-292, the lifecycle bullets + residual in `schema-rename-detection.md`, `functions.md` name columns, rename-column paragraphs in `sql-alter-rename.md` / `memory-table.md`, the import-path note in `schema.md`).
- Update test expectations; add the one sqllogic case above.
- Run `yarn build`, `yarn test`, `yarn lint` (quereus), and `yarn test:store` once.
