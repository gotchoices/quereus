description: Removed two unused, misleading SQLite-era config type declarations (write-ahead-log/journal/page-size knobs Quereus never implemented) from the shared public types file.
files:
  - packages/quereus/src/common/types.ts
----

## What changed

Deleted `DatabaseInfo` and `DatabaseConfig` interfaces from
`packages/quereus/src/common/types.ts` (previously lines ~111–176). Both were
dead: zero references anywhere in the monorepo before this change, confirmed
via `find_references` (project index) and a repo-wide `grep`. They described
SQLite features Quereus does not implement (WAL, journal mode, page size,
synchronous pragma) and were never imported, constructed, or exported through
`src/index.ts`'s public barrel — that barrel only re-exports specific named
types (`SqlValue`, `RowOp`, `ConstraintType`, etc.), and `DatabaseInfo`/
`DatabaseConfig` were never among them, so no barrel edit was needed.

One incidental hit during the search: `packages/quereus-plugin-indexeddb/src/manager.ts`
has an unrelated *local* inline type also named `DatabaseInfo` (an anonymous
`{ version, objectStores }` return shape for a private method) — not
imported from `common/types.ts`, untouched, out of scope.

`docs/review.html` also matched the grep — it's a generated doc artifact, not
source; left as-is (regenerating docs is out of scope for this ticket and it's
not part of build/lint).

## Validation performed

- `yarn build` (packages/quereus) — clean, exit 0.
- `yarn lint` (packages/quereus; eslint + tsc -p tsconfig.test.json --noEmit) — clean, exit 0.
- `yarn test` (repo root, full workspace suite) — all green, exit 0 (429 passing in quereus logic suite + all other workspace packages).

## Gaps / what reviewer should double check

- This is a pure type deletion with no behavioral surface — there is no new
  runtime path to exercise, so no new test was added (nothing to test; the
  point of the ticket was removing dead code).
- Did not grep outside the monorepo (e.g. published npm consumers) — ticket
  scope was "whole monorepo", which this covers. If any external plugin
  package outside this repo imported these types, that's an out-of-band
  break, but they were unexported implementation-adjacent types, not part of
  any documented public API.
