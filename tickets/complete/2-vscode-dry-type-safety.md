---
description: DRY violations and type safety fixes in quereus-vscode
prereq: []
files:
  - packages/quereus-vscode/shared/types.ts
  - packages/quereus-vscode/client/src/schema-sync.ts
  - packages/quereus-vscode/server/src/commands.ts
  - packages/quereus-vscode/server/src/schema-bridge.ts
  - packages/quereus-vscode/server/src/server.ts
  - packages/quereus-vscode/server/src/handlers.ts
  - packages/quereus-vscode/server/tsconfig.json
  - packages/quereus-vscode/client/tsconfig.json
  - packages/quereus-vscode/tsconfig.test.json
---

# VS Code Extension DRY & Type Safety — Complete

## Changes

1. **SchemaSnapshot types extracted to `shared/types.ts`** — previously duplicated in three files. All consumers import from the shared location. tsconfigs updated with `rootDir: ".."` and `include` entries for `shared/`.

2. **Double cast removed** — `connection as unknown as any` in `server.ts` eliminated by aligning the `Connection` import in `commands.ts` to `vscode-languageserver/node` (matching `server.ts`).

3. **Hardcoded keywords replaced** — `SQL_KEYWORDS` in `handlers.ts` now derived via `Object.keys(KEYWORDS)` from the engine's lexer export, keeping the list automatically in sync.

## Validation

- 31 tests pass (schema-bridge + handlers test suites)
- TypeScript typecheck clean for both server and client
- No remaining `as unknown as any` casts for these areas
- No duplicate `SchemaSnapshot` definitions
