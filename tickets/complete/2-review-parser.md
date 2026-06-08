description: Review of SQL parser (lexer, parser, AST, visitor)
files:
  packages/quereus/src/parser/ast.ts
  packages/quereus/src/parser/index.ts
  packages/quereus/src/parser/lexer.ts
  packages/quereus/src/parser/parser.ts
  packages/quereus/src/parser/utils.ts
  packages/quereus/src/parser/visitor.ts
----
## Findings

### defect: Stacked unary operators without parens fail to parse
file: packages/quereus/src/parser/parser.ts:1442
`factor()` delegates the unary operand to `this.concatenation()` instead of recursing. This means `- -1`, `NOT NOT x`, `~-x` etc. fail with "Expected expression". SQLite supports `SELECT - -1`. Existing test uses `(-(-1))` with explicit parens.
Ticket: tickets/fix/parser-stacked-unary-operators.md

### defect: AST visitor has inverted traversal logic
file: packages/quereus/src/parser/visitor.ts:49
`enterNode` returning `void` (the natural default) causes traversal to STOP. Only returning `false` explicitly continues. This is backwards from the documented behavior ("return false to stop traversal"). Additionally, `case`, `in`, `exists`, `between`, and `mutatingSubquerySource` node types are not traversed. Currently **zero external callers**, so this is latent.
Ticket: tickets/fix/visitor-inverted-traversal-and-missing-nodes.md

### defect: `parseSelect` was broken (fixed in review)
file: packages/quereus/src/parser/index.ts:42
`parseSelect` called `parser.initialize(sql).selectStatement()` without consuming the SELECT token, causing it to always fail. Has zero callers but is part of the public API.
Ticket: fixed in review — now uses `parse()` + type check, consistent with `parseInsert`.

### smell: Repeated contextualKeywords array allocation
file: packages/quereus/src/parser/parser.ts (multiple locations)
The array `['key', 'action', 'set', 'default', 'check', 'unique', ...]` is re-allocated as a local `const` in ~15 methods. Should be a module-level constant.
Ticket: tickets/plan/parser-contextual-keywords-constant.md

### note: `SelectStmt` has both `union` and `compound` fields
file: packages/quereus/src/parser/ast.ts:183-185
`union` appears to be legacy (used by ast-stringify.ts); `compound` is the newer generalized approach. Both exist on SelectStmt. Not creating a ticket — flagged for awareness.

### note: `WindowFrame` doesn't extend `AstNode`
file: packages/quereus/src/parser/ast.ts:94
Unlike other AST types, `WindowFrame` doesn't extend `AstNode`, so it can't carry `loc` information. Its `type` field is overloaded to represent frame units ('rows' | 'range') rather than a node type identifier.

### note: `CREATE TEMP TABLE` syntax not supported
file: packages/quereus/src/parser/parser.ts:2108
`createStatement()` dispatches on the token after CREATE (TABLE, INDEX, etc.) so `CREATE TEMP TABLE` fails. Only `CREATE TABLE [TEMP] ...` works. Non-standard but may be intentional.

## Trivial Fixes Applied
- `lexer.ts:358-359` — Fixed inconsistent indentation on `{`/`}` case branches (extra tab removed)
- `index.ts:42-52` — Fixed broken `parseSelect` to use `parse()` + type check, matching `parseInsert` pattern

## No Issues Found
- `utils.ts` — clean (single function, correct behavior)
- `ast.ts` — clean (well-typed interfaces with proper location tracking)
- `parser.ts` — structurally sound; expression precedence, DDL/DML parsing, error handling all correct apart from findings above

## Build & Tests
- Build: passes
- Tests: 472 passing, 1 pre-existing failure (keys-propagation, existing ticket `fix-keys-propagation-test.md`)
- Lint: no new issues in changed files
