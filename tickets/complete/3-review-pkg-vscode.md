---
description: Comprehensive review of quereus-vscode VS Code extension package
prereq: [review-core-api]

---

# VS Code Extension Review

## Goal

Adversarial review of the `@quereus/quereus-vscode` package: test from interface without implementation bias, inspect code quality, and ensure documentation accuracy.

## Scope

- **Server**: `packages/quereus-vscode/server/src/` — language server (server.ts, commands.ts, schema-bridge.ts)
- **Client**: `packages/quereus-vscode/client/src/` — extension entry (extension.ts, schema-sync.ts)
- **Tests**: `packages/quereus-vscode/server/test/` — schema-bridge tests (new)
- **Docs**: `packages/quereus-vscode/README.md`

## Tests Added

Created 1 test file with 5 interface-driven tests (from 0):

### schema-bridge.spec.ts (5 tests)
- returns empty snapshot for fresh database
- captures table names and columns after CREATE TABLE
- captures multiple tables
- functions array is currently empty
- reflects dropped tables

### Test Infrastructure

The package had no test setup. Added:
- `register.mjs` — ts-node ESM registration
- `tsconfig.test.json` — TypeScript config for tests
- `package.json` test script following monorepo pattern
- `server/test/package.json` with `"type": "module"`

Required `"type": "module"` in `server/package.json` for Node v24 compatibility (native type stripping loads `.ts` as CJS without it, breaking ESM named exports). Also changed `server/tsconfig.json` from `moduleResolution: "NodeNext"` to `"bundler"` — more appropriate for esbuild-bundled code and resolves subpath import resolution.

## Bugs Found (0)

No functional bugs in the tested surface. `snapshotSchema` correctly reflects schema state.

## Code Quality Observations

### Issues Noted (follow-up tasks created)

#### DRY & Type Safety (`tasks/fix/vscode-dry-type-safety.md`)
- **SchemaSnapshot x3**: `SchemaSnapshot`/`SchemaSnapshotTable` identically defined in `schema-sync.ts`, `commands.ts`, and `schema-bridge.ts`
- **Double cast**: `connection as unknown as any` in `server.ts:59` — masks type mismatch between `vscode-languageserver/node` and `vscode-languageserver` Connection types
- **Hardcoded keywords**: `DEFAULT_KEYWORDS` array duplicates `KEYWORDS` export from `@quereus/quereus`

#### Server Quality (`tasks/fix/vscode-server-quality.md`)
- **O(n²) span lookup**: `isInsideComment`/`isInsideSpans` do linear scan per regex match
- **Repeated split**: `pushMultiline` calls `doc.getText().split('\n')` per line
- **Re-implemented utility**: custom `positionAt()` duplicates `TextDocument.positionAt()`
- **Broad file watcher**: `**/*` should be scoped to SQL files
- **Swallowed errors**: `void` on async IIFE in `activate()` loses startup errors
- **Context-free completions**: `onCompletion` ignores cursor position
- **Stub hover**: `onHover` always returns null but capability is declared
- **Module-level side effects**: `connection`/`documents` at module scope hurts testability
- **Indentation**: `onInitialize` handler has extra tab indentation

### Positive Findings

- Clean client-server separation via LSP
- Lazy-loads `@quereus/quereus` engine to avoid blocking extension activation
- `snapshotSchema` is a pure function with no side effects — easy to test
- Schema-aware completions for tables/columns from both in-memory DB and external snapshots
- Semantic token provider handles comments, strings, keywords, functions, numbers, operators
- Proper overlap detection in token sorting prevents duplicate semantic highlights
- TextMate grammar provides fallback highlighting when semantic tokens aren't ready

## Documentation Review

- **README**: Accurate and current

## Follow-Up Tasks Created

- `tasks/fix/vscode-dry-type-safety.md` — SchemaSnapshot DRY, double-cast, hardcoded keywords
- `tasks/fix/vscode-server-quality.md` — Performance, error handling, testability, completions

## Files Modified

- `packages/quereus-vscode/server/package.json` — Added `"type": "module"`
- `packages/quereus-vscode/server/tsconfig.json` — Changed to `moduleResolution: "bundler"`, `module: "ESNext"`
- `packages/quereus-vscode/server/src/server.ts` — Added type annotations to event handler parameters (lines 116–117)
- `packages/quereus-vscode/package.json` — Added test script
- `packages/quereus-vscode/register.mjs` — New (ts-node ESM registration)
- `packages/quereus-vscode/tsconfig.test.json` — New (test TypeScript config)
- `packages/quereus-vscode/server/test/package.json` — New (`"type": "module"`)
- `packages/quereus-vscode/server/test/schema-bridge.spec.ts` — New (5 tests)

## Test Validation

5 passing. Run with:
```bash
node --import ./packages/quereus-vscode/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus-vscode/server/test/**/*.spec.ts" --colors
```

