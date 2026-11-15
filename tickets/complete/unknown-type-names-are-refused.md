description: A column, cast or schema declaration that names a type nobody registered now fails with an error instead of quietly becoming a binary column, and a registered type declared with parameters such as `measure(3)` now resolves to that type. Reviewed; one gap in sync schema replication was fixed.
architecture: docs/types.md
files:
  - packages/quereus/src/types/registry.ts  # declaredTypeBase, resolveDeclaredType, requireRegisteredTypeName, new aliases; getTypeOrDefault removed
  - packages/quereus/src/core/database.ts  # strict_type_names option (~477); registerType JSDoc
  - packages/quereus/src/schema/manager.ts  # buildColumnSchemas gate (~1831), mutation-context gate (~2046)
  - packages/quereus/src/schema/table.ts  # columnTypeSubject message helper
  - packages/quereus/src/planner/building/alter-table.ts  # ADD COLUMN (~103), ALTER COLUMN SET DATA TYPE (~171)
  - packages/quereus/src/planner/building/expression.ts  # user-written cast (~177)
  - packages/quereus/src/runtime/emit/schema-declarative.ts  # requireDeclaredTypeNamesRegistered at declare time
  - packages/quereus/src/planner/analysis/change-scope.ts  # registeredScopeType replaces getTypeOrDefault
  - packages/quereus/src/planner/nodes/scalar.ts  # CastNode.generateType comment
  - packages/quereus/src/index.ts, packages/quereus/src/types/index.ts  # getTypeOrDefault export removed
  - packages/quereus/test/logic/03.6.3-unknown-type-names.sqllogic  # new
  - packages/quereus-sync/src/sync/store-adapter.ts  # review: localColumnType for replicated ADD COLUMN / SET DATA TYPE decisions
  - packages/quereus-sync/test/sync/schema-replication-idempotency.spec.ts  # review: unregistered remote type test
  - docs/sync-schema.md  # review
  - packages/quereus/test/type-system.spec.ts, test/cast-static-type.spec.ts, test/plan/cast-seek-blocking.spec.ts
  - docs/types.md, docs/usage.md, docs/schema-declarative.md, docs/optimizer-rule-families.md
----

# Unknown type names are refused; parameterized registered names resolve

## What changed

**Resolution (`src/types/registry.ts`).** `inferType` (still the one lenient resolver everything uses) now tries, in order: an exact match of the whole declared string, an exact match of its base name (text before the first `(`, trimmed — `declaredTypeBase`), then the SQLite substring affinity rules, then BLOB. The first two steps are `TypeRegistry.resolveDeclaredType`. New aliases: `INT2`, `INT8` (INTEGER), `NCHAR`, `NVARCHAR` (TEXT). Side effect with the option off too: `json(3)`, `timestamp(3)`, `interval(…)` now resolve to JSON / TIMESTAMP / TIMESPAN where they used to fall to BLOB or (for `interval`, which contains `INT`) INTEGER.

**The check.** `requireRegisteredTypeName(options, typeName, subject, loc?)` throws `QuereusError(StatusCode.ERROR)` — `Unknown type 'volume' for column 'v' of table 'main.U': register the type (Database.registerType) before using it, or set pragma strict_type_names = false …` — when the boolean option `strict_type_names` (default `true`) is on and `resolveDeclaredType` misses. An omitted type (`create table t (a)`) is not checked and stays BLOB. Called at:

- `SchemaManager.buildColumnSchemas` — shared by CREATE TABLE, `importTable` (store catalog rehydrate) and `buildLogicalTableSchema` (lens logical tables).
- `SchemaManager.buildTableSchemaFromAST` — mutation-context variables (`with context (who wibble)`).
- `buildAlterTableStmt` — ADD COLUMN and ALTER COLUMN SET DATA TYPE, before any module sees the name.
- `buildExpression` `case 'cast'` — user-written casts only; the planner's own casts (`coercion.ts` `wrapInCast`, `set-operation-node.ts`) construct `CastNode` directly with resolved names.
- `emitDeclareSchema` — **added beyond the ticket's list**: the differ compares types via lenient `inferType`, so `declare schema { table A (…, w volume) }` over an existing BLOB column generated no DDL and passed unchecked (and the applied-state fast path can skip the diff entirely). Now refused at declare time, before anything is stored.

**`getTypeOrDefault` removed** (class method, function, both export lists, its two unit tests). `change-scope.ts` uses a local `registeredScopeType` that throws, unconditionally, naming the type; the `NOTE:` about BLOB fallback in `bindParameters` is gone. `scalarTypeFromPortable` now throws on an unregistered type.

**Registry stays process-wide**, documented on the `TypeRegistry` class, `Database.registerType`, and docs/types.md § Plugin System.

## Validation done

- `yarn workspace @quereus/quereus test` — 11148 passing, 26 pending.
- `yarn workspace @quereus/quereus lint` — clean (eslint + test-file tsc).
- `tsc -b tsconfig.build.json` — clean across all library packages.
- `@quereus/store` (2019), `@quereus/isolation` (453), `@quereus/sync` (878) and every other workspace's `test` — all passing.
- `yarn test:store` (logic tests against the LevelDB store) — **not run**.
- Reopen, verified by a scratch spec (deleted afterwards, not committed): create a store table with a BLOB column, rewrite its persisted DDL to `VOLUME`, rehydrate on a fresh `Database` → `rehydrateCatalog` returns one error `Unknown type 'VOLUME' for column 'v' of table 'main.utr'…` and the table is absent. That is the store's existing per-entry policy (log, skip, report in `result.errors`) — the same thing an unregistered collation gets.

## Tests added / changed

- `test/logic/03.6.3-unknown-type-names.sqllogic` (new) — the ticket's reproductions under strict mode: unknown column type, `point` (an affinity substring) refused, context-variable type, `cast(1 as volume)`, ADD COLUMN, SET DATA TYPE, `declare schema` over an existing table; `varchar(100)`, `decimal(10,5)`, `nvarchar(20)`, `int8`, `timestamp(3)` still resolve (via `table_info`); with `pragma strict_type_names = false`, `volume` → BLOB, `point` → INTEGER, `realm` → REAL, `typeof(cast(1 as volume))` = blob.
- `test/type-system.spec.ts` — new case: a registered `PARAM_MEASURE` resolves from `param_measure(3)` through `inferType` (lowest layer; no affinity keyword, so only the base-name lookup finds it). Removed the two `getTypeOrDefault` cases.
- `test/cast-static-type.spec.ts`, `test/plan/cast-seek-blocking.spec.ts` — the "affinity-only name" cases used `nvarchar`, which is now a registered alias. Switched them to `mychar` under `pragma strict_type_names = false` so they still exercise the affinity-only path they were written for.
- `test/column-declared-type.spec.ts` — unchanged; its GEOMETRY → BLOB case goes through db-less `columnDefToSchema`, which stays lenient.

## Known gaps / things for the reviewer to look at

- **No committed test for the reopen path.** It was checked only with the scratch spec above. Adding a committed one means rewriting persisted catalog bytes in a test (the registry is process-wide with no unregister, so a "process that forgot to register" can't be produced any other way). Decide whether that test is worth having.
- **Option read at declare time vs apply time.** The declare-time check reads `strict_type_names` when `declare schema` runs; turning it off afterwards doesn't re-admit the declaration (you have to declare again). The CREATE / ALTER an apply generates read the option at apply time.
- **Stored expressions.** A view body, CHECK, DEFAULT or generated column containing `cast(x as volume)` that was stored while the option was off now fails when it is next planned (on query or write), not at reopen. That is consistent with "error instead of wrong result", but the failure happens later than a column-type failure does.
- **`schema-differ.ts` still uses `inferType`** for declared-vs-actual type comparison and collation defaults. With the declare-time check in place it only ever sees accepted names under strict mode; with the option off it stays lenient on purpose.
- **db-less resolution stays lenient by design**: `columnDefToSchema`, `createBasicSchema`, `planRetypeConversion`, `quereus-sync`'s `store-adapter.ts` `inferType` calls, and the memory / store / isolation layers' own `columnDefToSchema` calls. They are only reached after the entry-point checks above. If a new user-facing path that takes a type name is added, it needs its own `requireRegisteredTypeName` call — there is no type-level guard against forgetting.
- **Multi-word SQLite spellings** (`double precision`, `unsigned big int`) still don't parse as one type name, so they are out of scope as the ticket said.
- **Base-name split** is `indexOf('(')` on the parser's glued string. That is safe because the parser only ever produces `ident` or `ident(…)`; a name registered with a `(` in it would still match through the whole-string step first.

## Review findings

Read the `ticket(implement): unknown-type-names-are-refused` diff first, then the handoff.

**Coverage of entry points (checked).** The parser produces a type name in exactly three AST fields — `ColumnDef.dataType`, `MutationContextVar.dataType`, `AlterColumn.setDataType` — plus `CastExpr.targetType`. Every route those reach in the engine (CREATE TABLE, `importTable` rehydrate, lens logical tables, context variables, ADD COLUMN, SET DATA TYPE, `declare schema`, user and parser-synthesized `cast` — `->>` builds `cast(… as text)`, which passes) goes through `requireRegisteredTypeName` before the lenient `inferType`. The remaining `inferType` callers in core (`runtime/emit/alter-table.ts`, `types/validation.ts`, `schema/table.ts`, `schema-differ.ts`) are behind those checks.

**Found and fixed — sync replication skipped the check (major class, fixed inline).** `quereus-sync`'s `store-adapter.ts` decides whether a replicated `add column` or `alter column … set data type` is "already applied" by comparing `inferType(remoteName)` to the local column's type. On a peer that never registered the origin's type, `inferType('volume')` is BLOB, so over a local BLOB column both arms converged silently and the DDL never ran — the peers' column types stayed different with no error, exactly the outcome this ticket removes. Added `localColumnType(db, name)`: under `strict_type_names`, a name this peer cannot resolve returns undefined and the adapter executes the DDL, so the engine refuses it with its own `Unknown type` message (lenient mode keeps the old comparison). New test in `schema-replication-idempotency.spec.ts` covers both arms; documented in `docs/sync-schema.md` § decision table. The `create_table` arm compares rendered DDL text, so it already reports a type-name difference as a conflict.

**Minor, fixed.** `declaredTypeBase` was exported but used only inside `registry.ts`; made module-private.

**Checked, no change:**
- Docs: `types.md`, `usage.md`, `schema-declarative.md`, `optimizer-rule-families.md` match the code; the alias list in `types.md` matches the registry constructor. No stale `getTypeOrDefault` references remain outside tickets.
- Prepared statements: the check runs at build, so a statement prepared with the option off keeps its lenient resolution after the option is turned on. Same "baked at prepare" behaviour `runtime_fuse_scalars` documents; the option's description says "checked when a statement is built". Only the engine's internal statement cache keys on SQL text, and it never uses user type names. No tripwire needed.
- Reopen test gap (raised in handoff): declined to add a committed test. The rehydrate path and CREATE share the single gate in `buildColumnSchemas`, which the sqllogic file covers; a reopen test would have to rewrite persisted catalog bytes, which costs more than it pins.
- Declare-time vs apply-time option read, and stored view/CHECK/DEFAULT expressions with a `cast` to a since-unregistered type failing at next plan rather than at reopen — both consistent with "error instead of wrong result"; left as the handoff describes them.
- Tests: the implementer's new sqllogic and `type-system.spec.ts` case pin the contract (refusal per entry point, base-name resolution); the `nvarchar` → `mychar` switches keep the affinity-only cases meaningful. Nothing to cut.
- Pre-existing duplication: the parser has three copies of the type-name-with-parameters loop (`parseDataTypeName`, `columnDefinition`, `parseMutationContextDefinitions`). Not introduced here and outside this ticket's diff; left alone.
- Type safety / error handling: `TypeNameOptions` keeps `types/` independent of `core/`; errors carry `StatusCode.ERROR` and source location where the AST has one.

**Validation.** `yarn workspace @quereus/quereus lint` clean; `tsc -b tsconfig.build.json` clean; `@quereus/quereus` test 11148 passing / 26 pending; `yarn test:store` 11141 passing / 33 pending (the implementer had not run this); `@quereus/sync` test 879 passing.
