description: Enable foreign_keys pragma by default; make 'ignore' action skip all enforcement
prereq: none
files:
  - packages/quereus/src/core/database.ts (foreign_keys option registration ~line 250)
  - packages/quereus/src/planner/building/foreign-key-builder.ts (child-side & parent-side FK checks)
  - packages/quereus/src/runtime/foreign-key-actions.ts (cascading action guard)
  - packages/quereus/test/logic/41-foreign-keys.sqllogic
  - packages/quereus/test/logic/41-fk-cross-schema.sqllogic
  - docs/sql.md (§7.6 FOREIGN KEY Constraint)
  - docs/usage.md (options table)
  - docs/memory-table.md (limitations section)
----

## Summary

Two coordinated changes so that explicit FK action clauses (e.g. `ON DELETE CASCADE`) work out of the box, while the default (no clause) remains non-enforcing:

1. **`foreign_keys` pragma defaults to `true`** — previously required `PRAGMA foreign_keys = ON`.
2. **`ignore` action means no enforcement** — the default FK action (no clause) generates no constraint checks or cascading actions.

### Key behavior

| FK definition | Behavior |
|---|---|
| `REFERENCES t(id)` (no action clause) | No enforcement (informational only) |
| `REFERENCES t(id) ON DELETE CASCADE` | CASCADE enforced |
| `REFERENCES t(id) ON DELETE RESTRICT` | RESTRICT enforced |

## Testing

- `41-foreign-keys.sqllogic`: comprehensive coverage — child-side INSERT/UPDATE validation, parent-side RESTRICT, NO ACTION = no enforcement, CASCADE DELETE/UPDATE, SET NULL, SET DEFAULT, UPSERT, INSERT OR REPLACE, multi-column FKs, NULL FK handling, cycle detection, pragma on/off.
- `41-fk-cross-schema.sqllogic`: verifies schema boundary respect for parent-side checks.
- 1416 passing, 2 pending. Build clean. No new lint issues.

## Review notes

- Code is clean, modular, and well-commented.
- `isRestrict` variable in `buildParentSideFKChecks` (line 273) is technically always `true` after the `restrict`-only filter on line 262, but serves as self-documenting intent — acceptable.
- Docs in `sql.md`, `usage.md`, and `memory-table.md` all accurately reflect the new defaults.
