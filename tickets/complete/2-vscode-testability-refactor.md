---
description: Refactored quereus-vscode server for testability — extracted pure handler functions
prereq: []
files:
  - packages/quereus-vscode/server/src/handlers.ts
  - packages/quereus-vscode/server/src/server.ts
  - packages/quereus-vscode/server/test/handlers.spec.ts
---

# VS Code Server Testability Refactor — Complete

## Summary

Extracted all handler logic from `server.ts` into pure functions in `handlers.ts`. `server.ts` is now a thin wiring layer (~85 lines) that connects LSP events to the pure functions.

## Key exports in `handlers.ts`

- `getCompletions(db, externalSchema, keywords)` — builds completion items
- `computeDiagnostics(text, Parser)` — parses SQL, returns diagnostics array
- `tokenize(text, keywords)` — regex-based tokenization returning `RawToken[]`
- `buildSemanticTokens(tokens, doc, lines)` — converts raw tokens into LSP `SemanticTokens`
- Helpers: `toRange`, `sortAndMergeSpans`, `isInsideSortedSpans`
- Constants: `SQL_KEYWORDS`, `tokenTypes`, `tokenTypeToIndex`

## Testing

26 tests in `handlers.spec.ts` covering all public functions:
- `getCompletions` — null db, real db, external schema
- `computeDiagnostics` — valid, invalid, incomplete SQL
- `tokenize` — keywords, functions, strings, numbers, comments, exclusion zones, operators, sort invariant
- `buildSemanticTokens` — single-line and multiline
- `sortAndMergeSpans` — empty, overlapping, non-overlapping, adjacent
- `isInsideSortedSpans` — inside, outside, boundary
- `toRange` — 1-indexed to 0-indexed conversion

31 total tests pass (26 handler + 5 schema-bridge).

## Review notes

- Code is clean, DRY, and well-modularized
- All exported interfaces have test coverage
- Tests approach interface surface area without implementation bias
- Build (esbuild bundle) succeeds
