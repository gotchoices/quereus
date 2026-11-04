---
description: Turning a parsed `declare schema` back into SQL can produce text that no longer parses, or quietly lose part of a table's definition, and a table's backing module written after its columns (the form the docs show) is ignored. Fix the parser and the SQL writer so every declared table survives the round trip with its module, arguments and body intact.
architecture: docs/sql-ddl.md#declaration-syntax
files:
  - packages/quereus/src/parser/parser.ts            # declareTableItem (~3784), createTableStatement (~2638, duplicate module-argument loop), declareIgnoredItem (~3691), sourceSlice (~4162), initialize (~83)
  - packages/quereus/src/emit/ast-stringify.ts       # declaredTableToString (~1448), createTableToString (~1883), moduleClauseToString (~1860), declareItemToString (~1436), sqlValueToSqlLiteral (~1532)
  - packages/quereus/src/parser/ast.ts               # DeclareIgnoredItem (~981)
  - packages/quereus/test/emit-roundtrip-property.spec.ts  # declaredTableInnerArb (~690), createTableArb (~359), assertAstEquivalent
  - packages/quereus/test/declare-schema-item-boundary.spec.ts  # existing stringify round-trip and unrecognized-item cases
  - docs/sql-ddl.md                                  # Declaration Syntax section
repro: verified
---

# Declared table's `using <module>` clause does not round-trip

Filed from the SiteCAD board: anything that re-parses a declaration emitted by `astToString` can hit this. All results below were observed by running `parseAll` and `astToString` from the built package (`@quereus/quereus` 4.25.0).

## Observed behavior

| Input item | Parsed as | Emitted | Result |
|---|---|---|---|
| `table T using memory { id integer primary key }` | module `memory` | `table T using memory (id integer primary key)` | Re-parse fails: `Expected ')' after module arguments.` |
| `table T using mem2() (id integer primary key)` | module `mem2`, no arguments | `table T using mem2 (id integer primary key)` | Same failure. Used by `test/declarative-equivalence.spec.ts:1872`. |
| `table T (id integer primary key) using memory` | **no module**, plus an extra ignored item | `table T (id integer primary key); -- ignored;` | Module lost, and the `--` comment swallows the closing `}`, so re-parse fails. |
| `table T (id integer primary key) using memory with tags (a = 1)` | no module, **no tags** | as above | Tags lost too: the whole tail is skipped as one ignored item. |
| `table T { id integer primary key } maintained as select 1 as id` | maintained clause present | `table T (id integer primary key)` | Re-parses cleanly, but **the maintained clause is gone** from the output. |
| `create table T (…) using memory (x = 'a"b')` | argument value `a"b` | `using memory (x = "a\"b")` | Re-parse fails: `Unterminated identifier`. Affects `create table` as well. |
| `domain d1 as text` inside a block | ignored item with empty text | `-- ignored` | The comment swallows the closing `}`. |

**Correction to the original report.** It said `table sessions (body) using memory` round-trips fine. It does not. That form is what `docs/sql-ddl.md` Declaration Syntax documents, and it is also used in `docs/lens.md:26` and `docs/migration.md:47`. Today the parser ends the table item at the body, then treats `using memory` as an unrecognized item and discards it, so the AST has no module name. By the fallback in `schema/manager.ts:1717-1722`, such a table lands on the default module; that end-to-end effect was read from the code, not run. This is the most serious defect here because it changes behavior even when nothing is ever re-emitted.

## Root causes

1. **`declareTableItem` has no trailing `using`.** `createTableStatement` accepts `(body) using module [(args)]`. The declared form accepts `using` only before the body.
2. **`declaredTableToString` has its own clause order.** It writes `using` before the body and omits `maintained`, while `createTableToString` writes body, `using`, `maintained`, `with context`, `with tags`. Writing `using` first is what creates the ambiguity, because the parser must read a `(` straight after a module name as an argument list.
3. **`moduleClauseToString` uses `JSON.stringify` for values.** A string comes out as a double-quoted identifier with JSON escapes, which is not SQL.
4. **`sourceSlice` is a stub returning `''`**, so ignored items lose their text and the writer falls back to a line comment on single-line output.

## Design

**Parser.** Extract one `parseModuleClause()` from the two duplicated argument loops, and call it from `createTableStatement` and from both positions in `declareTableItem`: before the body (kept, since tests and existing declarations use it) and directly after the body, before `maintained`, matching `create table`.

- `using` in both positions is a parse error.
- A `using` remaining after the `with` clauses is a parse error rather than falling through to the ignored-item path. Without this, `table T (…) with tags (a = 1) using memory` still loses its module silently. `create table` already rejects this order.
- The two loops differ today and the shared helper should settle on the `create table` behavior: a bare `flag` argument becomes `flag = 'flag'` (the declared form currently gives `null`), and the module name is required via `consumeIdentifier` (the declared form skips the name when the next token is not an identifier).
- `create table` always yields `moduleArgs: {}` while the declared form yields `undefined` when there is no argument list. Keep each as it is unless the tests show that matters.

**Writer.** Make the declared form and `create table` share one helper for body, `using`, `maintained`, `with context`, `with tags`. This fixes the first, second and `maintained` rows at one site, with no special case for when braces are needed.

This replaces the brace-based fix the original report proposed. That fix would need a conditional on "module present and no arguments", and it would leave `maintained` still dropped. The non-lens schema hash should be unaffected by the reorder because it renders through `generateDeclaredDDL`, not `astToString` (`schema/schema-hasher.ts`); the lens hash does use `astToString`, but on `declare lens` blocks, which contain view overrides and no table items.

**Module arguments.** Replace `JSON.stringify` with the existing `sqlValueToSqlLiteral`. Strings then re-parse as string literals with the same value.

**Ignored items.** Store the SQL in `initialize` and make `sourceSlice` slice it, so the item re-emits verbatim. Offsets come from the tokens already in hand. Set `kind` from the leading keyword or drop the field: nothing in `src/` was found reading it, and it is hardcoded to `'domain'` today. For an item with empty text (only reachable from a hand-built AST once the slice works), emit a block comment, not a line comment; the block loop already skips stray `;`.

This absorbs `tickets/backlog/bug-declare-schema-ignored-item-breaks-roundtrip.md`, which covers the same site. Its use cases are listed in the TODO below.

**Deliberately not done.** `table T using memory (id integer primary key)` written by hand stays a parse error. `using m (a, b)` is truly ambiguous between arguments and untyped columns unless the parser scans past the closing paren, and nothing needs it once the writer stops producing it. Document it instead.

## Behavior changes to expect

- A trailing `using <module>` now takes effect, so a declaration naming an unregistered module fails at apply where it used to pass silently. That is the correct result. A text scan of the repo's literal declaration blocks found the trailing form only in `docs/lens.md:26` and `docs/migration.md:47`; blocks built from template strings were not visible to that scan, so rely on the test run.
- A trailing `using` on a logical-schema table now reaches the existing rejection in `schema/lens-compiler.ts:591`.
- `create table` text changes from `(x = "v")` to `(x = 'v')`. Any test asserting the old text needs updating.

## TODO

- Extract `parseModuleClause()` and use it from `createTableStatement` and both positions in `declareTableItem`; reject a duplicate `using` and a `using` after the `with` clauses
- Share the table-tail writer between `declaredTableToString` and `createTableToString`, so `maintained` is emitted for declared tables
- Switch `moduleClauseToString` to `sqlValueToSqlLiteral`
- Retain the SQL text in the parser, implement `sourceSlice`, settle `DeclareIgnoredItem.kind`, and replace the `-- ignored` fallback with a block comment
- Widen `declaredTableInnerArb` and `createTableArb` in `test/emit-roundtrip-property.spec.ts` to generate a module with no arguments and with arguments, including a string value containing `"` and `'`; confirm it fails before the fix. Check how `assertAstEquivalent` treats `moduleArgs` `undefined` versus `{}`, and generate `undefined` for "no arguments" if needed, since `using m()` is written without parens
- Add `maintained` to the declared-table generator if a maintained generator is practical; otherwise add one case to `test/declare-schema-item-boundary.spec.ts`
- In `test/declare-schema-item-boundary.spec.ts`, add: a trailing `using` with arguments and tags keeps all three and yields one item; a `using` in both positions throws; a `using` after `with tags` throws
- In the same spec, cover the ignored-item round trip from the backlog ticket: `domain`, `collation` and `import` items; a parenthesized or braced payload (`domain d1 as decimal(10, 2)`); the ignored item first, last, and alone in the block; assert the item count and the following table's name survive
- Update `docs/sql-ddl.md` Declaration Syntax: state that `using` may come before or after the body, that a `(` directly after a leading module name is always the argument list (so write `using m () (…)` or `using m { … }`), and that the writer emits the trailing form
- Update the comment above `parseMaintainedClause()` in `declareTableItem` if it no longer matches
- Delete `tickets/backlog/bug-declare-schema-ignored-item-breaks-roundtrip.md` once its use cases pass
- Run `yarn workspace @quereus/quereus test` and `yarn workspace @quereus/quereus lint`; run `yarn test` for the store and lens packages, since a now-honored trailing `using` can change which module a test table lands on
