description: Sweep MEMORY_ONLY_FILES for sqllogic exclusions whose underlying bug has since been fixed; remove ones that now pass under store mode
files:
  packages/quereus/test/logic.spec.ts
----

## What was built

Re-tested the four candidate exclusions in `packages/quereus/test/logic.spec.ts:MEMORY_ONLY_FILES` against `yarn test:store`.  Three now pass and were removed; one remains skipped with a new root-cause comment, and a follow-up fix ticket was filed.

| File | Outcome |
|------|---------|
| `10.1-ddl-lifecycle.sqllogic` | Removed — passes |
| `102-schema-catalog-edge-cases.sqllogic` | Removed — passes |
| `40.1-pk-desc-direction.sqllogic` | Removed — passes |
| `41-alter-table.sqllogic` | Retained — comment updated to point at `IsolationModule.renameTable` gap |

## Key files

- `packages/quereus/test/logic.spec.ts` — only file touched in production code
- `tickets/fix/3-isolation-rename-table-forwarding.md` — follow-up fix ticket created

## Testing notes

- `yarn test:store` — 2436 passing, 9 pending (skipped) ✅
- `yarn test` (memory mode) — 2443 passing, 2 pending ✅

The three formerly-excluded files now run (no longer skipped) and pass under the LevelDB-backed store/isolation layer.

## Usage

No production code changed.  Future sweeps of `MEMORY_ONLY_FILES` should follow the same pattern: run `yarn test:store --grep <file>` for each excluded file; if it passes, remove it; if not, update the comment with the current root cause and file a fix ticket if one does not already exist.
