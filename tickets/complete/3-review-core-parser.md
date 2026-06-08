---
description: Completed review of parser subsystem (lexer, parser, AST, visitor)
prereq: none

---

# Parser Subsystem Review — Completed

This document summarizes the review and fixes applied to the Quereus parser subsystem.

## 1. Architecture Summary

The parser subsystem is well-structured with clean separation:

- **Lexer** (`lexer.ts`, ~810 lines) — SQL tokenization with comprehensive keyword/operator support
- **Parser** (`parser.ts`, ~3500 lines) — Recursive descent parser, largest file
- **AST** (`ast.ts`, ~609 lines) — Well-typed AST node definitions with location tracking
- **Visitor** (`visitor.ts`, ~154 lines) — AST traversal via visitor pattern
- **Public API** (`index.ts`) — `parse()`, `parseAll()`, `parseSelect()`, `parseInsert()`

### Strengths
- Clean lexer/parser separation
- Comprehensive AST type system with proper location tracking
- Good error location reporting with line/column/offset
- Visitor pattern properly implemented
- Support for complex SQL features (CTEs, window functions, declarative schema, UPSERT)

## 2. Issues Found & Fixed

### 2.1 Debug Logging in Production Code (Fixed)
**File:** `parser.ts`, `columnList()` method

Five raw `log()` calls with `// DEBUG` comments were left in the `columnList()` method. These were removed. The unused `log` variable was also eliminated — `errorLog` now derives directly from `createLogger`.

### 2.2 O(n) Token Lookup Performance Issue (Fixed)
**10 occurrences** of `this.tokens.find(t => t.startOffset === expr.loc!.start.offset)` pattern across expression parsing methods. Each was an O(n) scan of the token array, executed on every expression node creation.

**Fix:** Capture `this.peek()` *before* calling the sub-expression parser instead of retroactively searching for the start token. This changes the lookups from O(n) to O(1).

### 2.3 Binary Operator Parsing Duplication (Fixed)
Six methods (`logicalXorOr`, `logicalAnd`, `equality`, `term`, `factor`, `concatenation`) all followed the same pattern: parse operand, loop matching operators, create binary nodes.

**Fix:** Extracted `parseBinaryChain()` helper:

```typescript
private parseBinaryChain(
    operand: () => AST.Expression,
    tokenTypes: TokenType[],
    resolveOperator: (token: Token) => string,
): AST.Expression
```

This reduced ~120 lines of duplicated code to ~25 lines total. The `comparison()` method was left separate since it handles IN, BETWEEN, LIKE with significantly different logic. The `factor()` method retains its unary prefix handling separately.

### 2.4 isNull() Backtracking Simplified (Fixed)
The `isNull()` method had verbose backtracking logic with mutable `isNot` and comments about future IS TRUE/FALSE/DISTINCT FROM support. Simplified to use `const isNot = this.match(TokenType.NOT)` and cleaner backtrack path.

### 2.5 Existing TODOs Reviewed (No action needed)
Three TODOs in the parser subsystem were reviewed:
- Line 253: `TODO: Add support for VALUES directly` — Future feature, CTE context
- Line 292: `TODO: Replace pragmas with built-in functions` — Design decision
- Line 154 (visitor.ts): `TODO: Traverse frame bounds if needed` — Completeness note

All are legitimate future-work markers, not bugs.

## 3. Test Coverage

### Existing Coverage
The parser is well-exercised through 47 `.sqllogic` integration test files covering expressions, joins, CTEs, window functions, aggregates, error paths, constraints, transactions, set operations, and more.

### New Tests Added
Created `test/parser.spec.ts` with 35 focused unit tests covering:

- **Operator Precedence** (7 tests): multiplication before addition, AND before OR, XOR at OR level, comparison before equality, left-to-right associativity, concatenation chaining, parenthesized grouping
- **Unary Operators** (4 tests): negation, double negation, NOT, bitwise NOT
- **IS NULL / IS NOT NULL** (3 tests): IS NULL, IS NOT NULL, backtracking when IS not followed by NULL
- **Location Tracking** (3 tests): expression locations, binary chain locations, statement locations
- **Statement Parsing** (4 tests): multi-statement, SELECT without FROM, aliased columns, SELECT *
- **Error Handling** (5 tests): incomplete statements, misspelled keywords, unclosed parens, empty input, error location info
- **Equality Operators** (3 tests): =, ==, !=
- **BETWEEN and IN** (3 tests): BETWEEN, IN value list, NOT BETWEEN
- **COLLATE** (1 test): COLLATE expression parsing
- **CASE Expression** (2 tests): simple and searched CASE

All 299 Mocha tests + 49 node:test tests pass.

## 4. Remaining Recommendations (Future Work)

### File Decomposition (Phase 2)
`parser.ts` at ~3500 lines is the largest file in the project. Candidates for extraction:
- Expression parsing → `parser-expressions.ts` (~620 lines, 11 methods)
- DDL parsing → `parser-ddl.ts` (~707 lines, 11 methods)
- DML parsing → `parser-dml.ts` (~760 lines, 6 methods)
- Transaction/control → `parser-control.ts` (~64 lines, 6 methods)
- Helpers → `parser-helpers.ts` (~250 lines, 23 methods)

### Further Code Quality (Phase 3)
- Consolidate identifier parsing methods (`consumeIdentifier`, `consumeIdentifierOrContextualKeyword`, `checkIdentifierLike`)
- Refactor large methods: `selectStatement()` (~165 lines), `primary()` (~222 lines), `createTableStatement()` (~112 lines)
- Extract `canBeImplicitAlias()` for readability (lines 728-735)

### Additional Testing (Phase 4)
- Lexer-specific unit tests (Unicode, edge cases, unterminated constructs)
- Parser error recovery quality tests
- AST location accuracy regression tests
- Parser stress/performance tests

## 5. Code Quality Summary

| Aspect | Rating | Notes |
|--------|--------|-------|
| Architecture | Good | Clean lexer/parser/AST separation |
| Expression Parsing | Good | DRY after `parseBinaryChain` extraction |
| Performance | Good | O(n) token lookups eliminated |
| Error Handling | Good | ParseError with location info |
| Test Coverage | Good | 35 unit tests + 47 integration files |
| File Size | Needs Work | `parser.ts` still ~3500 lines — decomposition recommended |
| Documentation | Acceptable | Methods have JSDoc; no standalone parser docs |

## 6. Files Reviewed

- `packages/quereus/src/parser/parser.ts` (modified)
- `packages/quereus/src/parser/lexer.ts`
- `packages/quereus/src/parser/ast.ts`
- `packages/quereus/src/parser/visitor.ts`
- `packages/quereus/src/parser/utils.ts`
- `packages/quereus/src/parser/index.ts`
- `packages/quereus/test/parser.spec.ts` (new)
- `packages/quereus/test/logic/03-expressions.sqllogic`
- `packages/quereus/test/logic/90-error_paths.sqllogic`
