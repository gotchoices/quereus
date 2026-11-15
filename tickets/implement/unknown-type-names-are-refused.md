description: Make a column or cast that names a type nobody registered fail with an error, instead of quietly becoming a binary column, and make a registered type still resolve when declared with parameters such as `measure(3)`. Hosts that forget to register a custom type on one process then get an error there instead of a different table.
architecture: docs/types.md
files:
  - packages/quereus/src/types/registry.ts  # inferType: exact match on the whole string, then affinity substrings, then BLOB; getTypeOrDefault
  - packages/quereus/src/core/database.ts  # option registrations (~line 470, beside foreign_keys / nondeterministic_schema); registerType (~line 2097)
  - packages/quereus/src/schema/manager.ts  # ~1828 columnDefToSchema for CREATE TABLE and catalog rehydrate (importTable), beside the collation gate; ~2038 mutation-context vars
  - packages/quereus/src/planner/building/alter-table.ts  # ADD COLUMN (~378, ~425) and ALTER COLUMN SET DATA TYPE (~171)
  - packages/quereus/src/planner/building/expression.ts  # ~177 user-written cast → CastNode
  - packages/quereus/src/planner/nodes/scalar.ts  # ~767 CastNode.generateType comment about inferType vs getTypeOrDefault
  - packages/quereus/src/planner/analysis/change-scope.ts  # ~120 scalarTypeFromPortable, ~1058 NOTE + getTypeOrDefault in bindParameters
  - packages/quereus/src/index.ts  # exports getTypeOrDefault / inferType
  - packages/quereus/src/types/index.ts
  - packages/quereus/test/type-system.spec.ts  # inferType / getTypeOrDefault unit tests (~75-160)
  - packages/quereus/test/column-declared-type.spec.ts  # pins GEOMETRY → BLOB through db-less columnDefToSchema
  - packages/quereus/test/cast-static-type.spec.ts  # relies on NVARCHAR → TEXT
  - packages/quereus/test/plan/cast-seek-blocking.spec.ts  # relies on NVARCHAR → TEXT
  - docs/types.md  # § Design Decisions, § Plugin System
repro: verified
----

# Refuse unknown type names; resolve registered names declared with parameters

## Reproduction (2026-11-14, current `main`, built `dist`)

A scratch script against `packages/quereus/dist/src/index.js`:

| Statement (nothing registered) | `table_info` / `typeof` result |
|---|---|
| `create table U (id integer primary key, v volume)` | `v` is `BLOB` |
| `create table P (… v point)` | `v` is `INTEGER` (contains `INT`) |
| `create table R (… v realm)` | `v` is `REAL` (contains `REAL`) |
| `select typeof(cast(1 as volume))` | `blob` |
| `alter table U add column w foo` | `w` is `BLOB` |

With `db.registerType('MEASURE', { ...REAL_TYPE, name: 'MEASURE' })`:

| Statement | Result |
|---|---|
| `create table M (… a measure, b measure(3))` | `a` is `MEASURE`, **`b` is `BLOB`** |
| same `create table` on a second `Database` in the same process, no registration | `a` is `MEASURE` (registry is process-wide) |

## Cause

One site: `TypeRegistry.inferType` (`packages/quereus/src/types/registry.ts`).

- It looks up the **whole** declared string, parameters included. The parser (`parseDataTypeName` and `columnDefinition` in `src/parser/parser.ts`) produces one identifier plus an optional `(…)` suffix glued on, e.g. `varchar(100)`, `decimal(10,5)`, `measure(3)`. So every parameterized name misses the registry. Built-ins survive only because the affinity substring step (`includes('CHAR')`, `includes('DECIMAL')`) catches them afterwards; a registered custom type with parameters falls to BLOB.
- On a miss it applies SQLite's substring affinity rules and finally returns BLOB with a debug log. Nothing at the DDL or cast build sites can tell a resolved name from a fallback.

`getTypeOrDefault` has the same silent BLOB fallback. Its only internal callers are in `change-scope.ts`, where the name comes from an already-resolved type (a portable scope deserialized in another process); a miss there means the type is not registered in this process, and the existing `NOTE:` at ~line 1058 already says to reject it if scopes cross such a boundary. The hosts this ticket is about (SiteCAD: browser, sync server, simulation server) are exactly that boundary.

## Decisions (record in docs/types.md)

These are the recommended answers to the questions the fix ticket left open. Each is a small, reversible default.

**A new boolean database option `strict_type_names`, default `true`.** Grounds: docs/types.md § Core Principles item 2 ("Strict Typing"), and AGENTS.md says not to worry about backwards compatibility. Measured impact on the test corpus: parsing every statement in `test/logic/*.sqllogic` (28,266 statements) found **no** type name that misses the registry once the `(…)` suffix is stripped; scanning SQL string literals in all `packages/**/*.spec.ts` found only `GEOMETRY` (one db-less unit test pinning the fallback), `NVARCHAR` (two cast specs) and names those specs register first.

- **On:** a declared or cast type name resolves only if its base name (the text before any `(`, trimmed, case-insensitive) is registered, built-in aliases included. Otherwise the statement fails with `StatusCode.ERROR` and a message naming the type and the column (and table, where known), and saying to register the type or turn the option off. The SQLite substring affinity rules are **not** consulted, so `point` and `realm` are errors rather than INTEGER/REAL.
- **Off:** today's behaviour — the SQLite affinity rules and the BLOB fallback.

Because the parser yields a single identifier, a "whole-word affinity match" is the same thing as an exact match of the base name, so there is no separate whole-word mode. To keep SQLite's documented single-word spellings working under strict mode, register the missing ones as aliases in the `TypeRegistry` constructor: `NVARCHAR`, `NCHAR` (TEXT), `INT2`, `INT8` (INTEGER). (SQLite's multi-word spellings such as `double precision` don't parse as one type name today, so they are out of scope.)

**Registration stays process-wide, documented as such.** Making it per database would mean threading a registry through every type resolution, including db-less ones (`columnDefToSchema`, `createBasicSchema`, `CastNode.generateType`, `inferType` calls in `quereus-sync/src/sync/store-adapter.ts` and `quereus-store`), and logical types are compared by object identity. With strict mode on, the hazard the ticket raised — a process that forgot to register — now errors, so per-database registration is not needed to close it. Document in § Plugin System: `Database.registerType` writes to a registry shared by every `Database` in the same JavaScript realm; registering a name again replaces the earlier definition for all of them (with a warn log).

**Where the check runs.** Validate at the entry points where a user-written name enters and the database's options are reachable; keep `inferType` as the single resolver everywhere else. After validation, `inferType` returns the registered type directly, so the two cannot disagree.

- CREATE TABLE and catalog rehydrate: `schema/manager.ts` ~1828, beside the collation gate (that site is shared by fresh CREATE and `importTable`, so a persisted table whose type is no longer registered fails on reopen with the table and column named — the same treatment the collation gate gives an unregistered collation; reading such a column as BLOB would be a wrong result).
- Mutation-context variables: `schema/manager.ts` ~2038.
- ALTER TABLE ADD COLUMN and ALTER COLUMN SET DATA TYPE: `planner/building/alter-table.ts`, before the module or emitter sees the name (so `quereus-store`, `quereus-isolation` and the memory layer's own `columnDefToSchema` calls never receive an unknown name).
- User-written `cast(x as name)`: `planner/building/expression.ts` ~177. The synthetic casts built in `coercion.ts`, `set-operation-node.ts` and `scalar.ts` use names of already-resolved types and need no check.
- Confirm by `find_references` on `dataType` / `targetType` that no other user-facing build site (e.g. declarative `declare schema`, function return declarations) bypasses these; `declare schema` applies through CREATE / ALTER, so it should be covered.

**`getTypeOrDefault` is removed.** Replace its two `change-scope.ts` uses with a lookup that throws a `QuereusError` naming the type when it is not registered (unconditional, not gated on the option: these names were never user spellings). Remove the `NOTE:` at ~1058 since the condition it describes is now handled. Drop the export from `src/index.ts` / `src/types/index.ts` and its unit tests in `type-system.spec.ts`.

## Tests

Keep it to the reproductions:

- One sqllogic file (or a section in an existing type-system one) with strict on: `create table … v volume` errors naming `volume` and `v`; `alter table … add column w foo` errors; `cast(1 as volume)` errors; `point` errors (not INTEGER); `varchar(100)` and `decimal(10,5)` still resolve. Then turn the option off (`pragma strict_type_names = false`, or however boolean options are set in sqllogic — check an existing `nondeterministic_schema` test) and show `volume` → BLOB, `point` → INTEGER.
- One spec case: a registered custom type declared with parameters (`measure(3)`) resolves to that type. Use a name unique to the test since the registry is process-wide.
- Update existing: `inferType` unit tests in `type-system.spec.ts` stay (it remains the lenient resolver) — add the parameter-stripping exact match case there if that is the lowest layer; `column-declared-type.spec.ts` GEOMETRY case goes through db-less `columnDefToSchema` and stays valid; the NVARCHAR specs keep passing through the new alias — update their comments, which say NVARCHAR "misses the registry".

## TODO

- registry.ts: add a `declaredTypeBase(name)` helper (strip a trailing `(…)` and trim); make `inferType` try the exact whole string, then the base name, before the affinity rules; add `NVARCHAR`, `NCHAR`, `INT2`, `INT8` aliases; add a `isKnownTypeName(name)` (or `requireKnownTypeName(name, what)` that throws) used by the entry-point checks.
- database.ts: register `strict_type_names` (boolean, default true, description stating both behaviours).
- Add the checks at the entry points listed above, with messages naming type, column and table.
- change-scope.ts: replace `getTypeOrDefault` with a throwing lookup; remove the `NOTE:`; remove `getTypeOrDefault` from registry.ts and both export lists; update `type-system.spec.ts`.
- scalar.ts ~767: update the comment that contrasts `inferType` with `getTypeOrDefault`.
- docs/types.md: § Design Decisions gets a bullet on unknown type names and `strict_type_names`; § Plugin System states registration is process-wide and that declared names may carry parameters (`measure(3)`) that resolve to the registered base name. Add `strict_type_names` wherever the other database options are listed (grep docs for `default_column_nullability`).
- Tests as above; run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`; also run the `quereus-store`, `quereus-isolation` and `quereus-sync` tests, since they declare tables through the same paths.
