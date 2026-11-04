---
description: Turning a parsed `declare schema` back into SQL could produce text that no longer parsed, or quietly lose part of a table's definition, and a table's backing module written after its columns was ignored. The parser and SQL writer now keep every declared table's module, arguments and body through the round trip, and a misplaced module clause is an error.
architecture: docs/sql-ddl.md#declaration-syntax
files:
  - packages/quereus/src/parser/parser.ts            # parseModuleClause, declareTableItem, declareIgnoredItem, both materialized view parsers, initialize
  - packages/quereus/src/emit/ast-stringify.ts       # tableDefinitionParts, moduleClauseToString, declareItemToString
  - packages/quereus/src/parser/ast.ts               # DeclareIgnoredItem (kind removed)
  - packages/quereus/test/emit-roundtrip-property.spec.ts
  - packages/quereus/test/declare-schema-item-boundary.spec.ts
  - docs/sql-ddl.md
  - docs/sql.md
  - docs/lens.md
  - docs/vu-mutation-context.md
repro: verified
---

# Declared table's `using <module>` clause round trip

## What was built

**Parser.** One `parseModuleClause()` replaces four copies of the module argument loop (`create table`, `create materialized view`, and the declared table and materialized view items). A declared table reads it before or after its body. Ignored items (`domain`, `collation`, `import`) now keep their source text, so they survive re-emission. `DeclareIgnoredItem.kind` is gone because it could not be accurate.

**Writer.** `tableDefinitionParts()` writes body, `using`, `maintained`, `with context`, `with tags` for both `create table` and declared tables, so the two cannot drift apart. Module argument values go through `sqlValueToSqlLiteral`, which fixes the `"`-quoted string values that re-parsed as identifiers or failed outright. A text-less ignored item emits `/* ignored */`.

**Misplaced `using`.** A `using` where an item would begin is a parse error. `table t using memory (id integer primary key)` remains a parse error by design, because `using m (a, b)` could be arguments or untyped columns; `docs/sql-ddl.md` gives the alternatives.

**Behavior changes for callers.** A trailing `using` on a declared table now takes effect at apply, so a module name that was previously ignored can now fail with `No virtual table module named …`. A declared `using m ()` gives `moduleArgs: undefined`. A bare `flag` argument in a declared table gives `flag = 'flag'`, not `null`. Schema hashes change for tables with string module arguments and for declarations whose trailing `using` was dropped before (read from the code, not measured).

## Review findings

**Checked by running the code**, through a temporary spec that has since been deleted (parse, emit, parse, emit, compare text):

- Module arguments: `true`, `false`, negative floats, `null`, bareword values, bare flags, positional strings and numbers, quoted module and argument names, keyword-named arguments. All stable. A blob value is a parse error, so the writer's blob branch cannot be reached from parsed text.
- Clause order: empty argument lists, `with context` and `with tags` after `using`, `using` before `maintained`, adjacent items with no separator, and a `join … using (id)` inside a `maintained` body. All stable.
- Ignored items: block comments around the item, quoted strings, a quoted `"using"` name.
- `apply schema` followed by `diff schema` on a table with `using memory (x = 'y')` gives an empty diff.

**Fixed in this pass:**

- **A `using` could still be lost silently.** The handoff listed `table t (…); using memory`, and a `using` after a `view` or `materialized view` body, as a known remaining loss. Running it also found `index i on t (id) using memory`. All parsed as an ignored item, so the module was dropped. The check is moved from the end of `declareTableItem` into `declareIgnoredItem`, because no item can begin with `using`. That one site covers these cases and the two table orders the old check caught. Added one table-driven test with three cases in `declare-schema-item-boundary.spec.ts`; `docs/sql-ddl.md` is updated.
- **`docs/vu-mutation-context.md`** had four `create table … using mem()` examples. Running `create table … using mem` gives `No virtual table module named 'mem'`, the same mistake the handoff fixed in `docs/lens.md`. They now say `using memory`.
- **`docs/sql-ddl.md`** now states that a plain table's module is read only at creation (see the ticket below).

**Filed:** `bug-declared-table-module-change-not-detected` in `backlog/`, `repro: verified`. Re-declaring an existing plain table with a different `using` gives an empty diff and leaves the table on its old module. This is not caused by this change, since the leading form already behaved this way, but honoring the trailing form makes it easier to hit. It needs a decision on destructive moves, so it is not a fix for this pass.

**Tripwires:** none added. The existing `NOTE` on `declareIgnoredItem` still applies to any other unrecognized leading word: a misspelled item keyword is accepted as ignored text.

**Tests.** Kept the implementer's tests: each reproduces a defect or pins a position from the absorbed backlog ticket. None cut. The property test has no materialized view generator, so that path is covered by the shared `moduleClauseToString` and the hand checks above. This is accepted, because the writer code is now shared with the generated table cases.

**Also read, no finding:**

- Reuse and structure: the duplicated loops and `mvModuleClauseToString` are gone. `schema/ddl-generator.ts` has its own module clause writer (`formatUsingClause`), which renders a live table's schema rather than an AST. It already quotes string values correctly, so it is unaffected.
- Types: `lint` type-checks the test files too. Nothing outside the parser and writer reads `DeclareIgnoredItem.kind`.
- Resource cleanup: not applicable, except that the parser now holds the source string, which is replaced on the next `initialize`.
- Performance: no new work beyond a string slice per ignored item.
- Comparator blind spot: `emit-roundtrip-comparator.ts` skips argument names such as `line` and `pos`. This reduces coverage slightly and causes no false failures, so it is left as is.
- A text-less ignored item re-parses as no item. It is reachable only from a hand-built AST and is what the ticket specified.

**Validation.** `yarn workspace @quereus/quereus lint` exits 0. `yarn test` across all workspaces reported no failures, with quereus at 10985 passing and 25 pending. `yarn test:store` was not run, by both implement and review. The four store package specs checked that use `declare schema` (`rehydrate-catalog`, `seed-reopen-idempotent`, `tag-persistence`, `apply-undo-restores-unique`) pick the store through the schema-level `default_vtab_module`, so a table item's own trailing `using store` was not seen under test against the store.
