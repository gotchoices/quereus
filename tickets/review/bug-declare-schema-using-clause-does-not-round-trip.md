---
description: Turning a parsed `declare schema` back into SQL could produce text that no longer parsed, or quietly lose part of a table's definition, and a table's backing module written after its columns was ignored. The parser and SQL writer are fixed so every declared table keeps its module, arguments and body through the round trip; this needs a review pass.
architecture: docs/sql-ddl.md#declaration-syntax
files:
  - packages/quereus/src/parser/parser.ts            # parseModuleClause (new), declareTableItem, createTableStatement, both materialized view parsers, declareIgnoredItem, initialize
  - packages/quereus/src/emit/ast-stringify.ts       # tableDefinitionParts (new), moduleClauseToString, declareItemToString
  - packages/quereus/src/parser/ast.ts               # DeclareIgnoredItem (kind removed)
  - packages/quereus/test/emit-roundtrip-property.spec.ts
  - packages/quereus/test/declare-schema-item-boundary.spec.ts
  - docs/sql-ddl.md                                  # new "Module clause placement" section
  - docs/sql.md                                      # table item grammar
  - docs/lens.md                                     # examples changed from `using mem()` to `using memory`
repro: verified
---

# Declared table's `using <module>` clause round trip

## What changed

**Parser.** One `parseModuleClause()` replaces the duplicated argument loops. `declareTableItem` calls it before the body and again directly after it. A single check at the end of the item rejects any `using` still unread, which covers `using` on both sides of the body, after `with` clauses, and after a `maintained` body. Ignored items now keep their source text: `initialize` stores the SQL and `declareIgnoredItem` slices it. `sourceSlice` is gone, and `DeclareIgnoredItem.kind` is dropped because nothing read it and any unrecognized leading word lands there, so it could not be accurate.

**Writer.** `tableDefinitionParts()` writes body, `using`, `maintained`, `with context`, `with tags` for both `create table` and declared tables. Module argument values go through `sqlValueToSqlLiteral`. A text-less ignored item emits `/* ignored */`, not a line comment.

## Behavior to expect

| Input item | Now emits |
|---|---|
| `table T using memory { id integer primary key }` | `table T (id integer primary key) using memory` |
| `table T using mem2() (id integer primary key)` | `table T (id integer primary key) using mem2` |
| `table T (id integer primary key) using memory with tags (a = 1)` | same text; module and tags both kept |
| `table T { id integer primary key } maintained as select 1 as id` | `table T (id integer primary key) maintained as select 1 as id` |
| `create table T (…) using memory (x = 'a"b')` | `… using memory (x = 'a"b')` |
| `domain d1 as text` | `domain d1 as text` |

All of these were run through parse, emit, parse, emit, and the text was stable. At apply, a trailing `using mem2` landed the table on `mem2`, and a trailing `using nosuchmodule` failed with `No virtual table module named 'nosuchmodule'`.

`table T using memory (id integer primary key)` stays a parse error by design; `docs/sql-ddl.md` explains why and gives the alternatives.

## Tests added

In `test/emit-roundtrip-property.spec.ts`, `createTableArb` and `declaredTableInnerArb` now generate a module with and without arguments, with string values holding `"` and `'`. `declaredTableInnerArb` also generates a `maintained` clause. Before the fix, the `create table` property failed on the quoting defect and the `declare schema` property failed on the dropped `maintained` clause. fast-check reports only the first counterexample per property, so the leading-`using` re-parse failure was not separately seen in this run; the original ticket's table records that observation.

In `test/declare-schema-item-boundary.spec.ts`:

- `keeps <item> and the table after it` (6 cases): `domain`, `collation` and `import` items, parenthesized and braced payloads, and a line comment inside an item. Each checks the item count, the verbatim text and the following table's name.
- `keeps an ignored item that comes last`, `keeps a block holding only ignored items`: the other two positions from the absorbed backlog ticket.
- `emits a text-less item as a comment that does not swallow the block end`: the hand-built AST fallback.
- `reads a trailing using with arguments and tags as one item`: the module, named and positional arguments, and tags all land on one item.
- `rejects using on both sides of the body`, `rejects using after the with clauses`: the silent-loss orders are errors.

All 14 failing cases were confirmed failing before the fix.

## Validation

`yarn workspace @quereus/quereus lint` exits 0. `yarn test` across all workspaces exits 0, with quereus at 10982 passing and 25 pending. `yarn test:store` was **not** run.

## Choices and gaps to check

- **Wider than the ticket's TODO.** Both materialized view parsers also use `parseModuleClause`, since their loops were copies, and `mvModuleClauseToString` was merged into `moduleClauseToString`, since it had the same `JSON.stringify` bug. The property test has no materialized view generator, so this path was only checked by hand (`using memory (x = 'a"b')` is stable in both the `create` and declared forms).
- **One deviation from "keep each as it is".** A declared `using m ()` now gives `moduleArgs: undefined`, not `{}`, matching what the materialized view parsers already did. Readers checked: `schema/manager.ts` uses `|| {}`, and the differ goes through `canonicalBackingModuleArgs`.
- **`docs/lens.md` needed a fix the ticket did not predict.** Its examples used `table … using mem()`. `mem` is an alias only for materialized view backing modules (`normalizeBackingModuleName` in `schema/view.ts`), not a registered module, so these only worked because the clause was discarded; they failed at apply once it was honored. They now say `using memory`, and the getting-started example was run end to end. Making `mem` an alias for tables too was the alternative, rejected as new surface area. `docs/vu-mutation-context.md` also has `create table … using mem()`; that is pre-existing, unaffected by this change, and left alone.
- **`docs/migration.md`'s `using store()`** now takes effect, so it needs the store module registered. That matches what the example describes, so it is unchanged.
- **Schema hashes change.** The non-lens hash renders through `generateDeclaredDDL` and `createTableToString`, so it should differ from before for tables with string module arguments and for declarations whose trailing `using` was previously dropped. This is read from the code, not measured. The test suite still passes, so no test pins these values.
- **Module arguments changed in two small ways.** A bare `flag` in a declared table now gives `flag = 'flag'` rather than `null`, and a leading `using` with no module name is now an error.
- **Known remaining silent loss, unchanged.** A `using` trailing a `view` or `materialized view` body, or following an explicit `;` after a table (`table t (…); using memory`), still parses as an ignored item, verified by running it. The module is not applied, though the text now survives re-emission. The existing `NOTE` on `declareIgnoredItem` covers this class: diagnosing it needs a real grammar for those kinds. The reviewer may want to judge whether `using` as an item's leading word deserves its own error.
- **A text-less ignored item does not keep its place.** It re-parses as no item at all. This is reachable only from a hand-built AST and is what the ticket specified.
- **Comparator blind spot.** `emit-roundtrip-comparator.ts` skips keys it treats as positional metadata (`start`, `line`, `offset`, `pos`, `span`), so a generated module argument with one of those names is not compared. This reduces coverage slightly and causes no false failures.

The absorbed `tickets/backlog/bug-declare-schema-ignored-item-breaks-roundtrip.md` is deleted; its use cases are covered above.
