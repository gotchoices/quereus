description: Sweep MEMORY_ONLY_FILES for sqllogic exclusions whose underlying bug has since been fixed; remove ones that now pass under store mode
files:
  packages/quereus/test/logic.spec.ts
----

## What was done

Tested each of the four candidate exclusions under `yarn test:store --grep <file>`:

| File | Result |
|------|--------|
| `10.1-ddl-lifecycle.sqllogic` | **Pass** — removed from `MEMORY_ONLY_FILES` |
| `102-schema-catalog-edge-cases.sqllogic` | **Pass** — removed from `MEMORY_ONLY_FILES` |
| `40.1-pk-desc-direction.sqllogic` | **Pass** — removed from `MEMORY_ONLY_FILES` |
| `41-alter-table.sqllogic` | **Fail** — retained with updated comment |

`41-alter-table.sqllogic` fails because `IsolationModule` does not implement `renameTable`, so RENAME TABLE data disappears through the isolation layer.  A new fix ticket `isolation-rename-table-forwarding` was filed.  The exclusion comment was updated to name this root cause.

## Changes

Single file changed: `packages/quereus/test/logic.spec.ts` — three entries removed from `MEMORY_ONLY_FILES`, one entry updated with a new comment.

## Validation

- `yarn test:store` — 2436 passing, 9 pending (skipped) ✅
- `yarn test` (memory mode) — 2443 passing, 2 pending ✅

## Use cases for review

- Confirm the three removed files (`10.1-ddl-lifecycle`, `102-schema-catalog-edge-cases`, `40.1-pk-desc-direction`) now run (not skipped) in store mode and pass.
- Confirm `41-alter-table.sqllogic` is still skipped in store mode with the updated comment.
- Confirm the new `isolation-rename-table-forwarding` fix ticket accurately describes the remaining root cause.
- No production code changed; review is lightweight.
