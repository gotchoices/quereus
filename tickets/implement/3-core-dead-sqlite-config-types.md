description: Some leftover configuration types describe database features Quereus does not actually have, and they are used nowhere, so they only mislead plugin authors into thinking those features exist.
files:
  - packages/quereus/src/common/types.ts (DatabaseInfo, DatabaseConfig — around lines 111–176)
difficulty: easy
----

## Problem

`common/types.ts` (~111–176) defines `DatabaseInfo` and `DatabaseConfig`, carried
over from a SQLite-era design. They describe features Quereus does not implement —
write-ahead logging, journal mode, page size — and have **zero references** in the
codebase. Their only effect is to mislead plugin authors reading the public types
into believing those knobs exist and do something.

## Expected behavior

Delete `DatabaseInfo` and `DatabaseConfig`. Remove any now-dead exports/imports
that referenced them.

## Edge cases

- Before deleting, confirm zero references remain (search the whole monorepo, not
  just `packages/quereus`, and include re-exports through barrel/index files).
- If a public `index.ts` re-exports these types, remove those re-exports too so the
  build stays clean.
- Ensure `yarn build` and `yarn lint` pass after removal.

## TODO

- Confirm `DatabaseInfo` and `DatabaseConfig` have no references anywhere in the monorepo (including re-exports).
- Delete both type declarations from `common/types.ts`.
- Remove any barrel/index re-exports of them.
- Run build + lint to confirm nothing depended on them.
