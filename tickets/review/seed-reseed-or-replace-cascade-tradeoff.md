description: Switch seed re-application from OR REPLACE to OR IGNORE so reopening a database with seed data does not fire ON DELETE CASCADE on unchanged rows or overwrite user edits.
prereq:
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # line 283: INSERT OR IGNORE (was OR REPLACE)
  - packages/quereus-store/test/seed-reopen-idempotent.spec.ts # case (d) updated to expect user-edit preserved
  - packages/quereus/test/logic/50-declarative-schema.sqllogic  # EOF idempotency section: id=2 now stays 'Edited'
  - docs/schema.md                                               # § Seed Data rewritten for OR IGNORE contract
---

## What was done

Implemented the human-approved decision to swap `INSERT OR REPLACE` → `INSERT OR IGNORE` for seed row application in `emitApplySchema`.

### One-line change
`packages/quereus/src/runtime/emit/schema-declarative.ts` line 283 — the seed SQL template now reads:
```javascript
return `INSERT OR IGNORE INTO ${qualifiedTableName} VALUES (${values})`;
```

### Supporting changes
- **`seed-reopen-idempotent.spec.ts` case (d)**: Description and expected values updated. With OR IGNORE, `id=2` that was user-edited to `'Edited'` now survives a reopen reseed as `'Edited'` (not overwritten back to `'Other'`). All 4 sub-cases now pass (675 store tests pass).
- **`50-declarative-schema.sqllogic` idempotency section**: The final `select` result for the re-apply scenario now expects `id=2 → 'Edited'` (user edit preserved) instead of `'Other'` (seed value re-asserted). Comments updated to match OR IGNORE semantics.
- **`docs/schema.md` § Seed Data**: Rewrote the bullet and the `> Why upsert…` callout. Removed the cascade caveat (it no longer applies), stated the OR IGNORE on-conflict contract (existing rows left untouched, only truly absent rows seeded), and explained why OR REPLACE was tried first before landing on OR IGNORE.

### Build note
The main quereus package must be compiled (`yarn build`) before store tests pick up changes to `schema-declarative.ts`, because `@quereus/store` imports quereus from `dist/`. Both packages were rebuilt and all tests pass (6410 quereus + 675 store).

## Test validation
- `yarn workspace @quereus/quereus run test` — 6410 passing, 9 pending, 0 failing
- `yarn workspace @quereus/store run test` — 675 passing, 0 failing

## Use cases for review

1. **First open with seed** — fresh table, no data: OR IGNORE inserts all seed rows (no conflict). Unchanged from prior behavior. Pinned by case (c) in spec and first `select` in sqllogic.

2. **Reopen, seed values unchanged** — same rows already seeded: OR IGNORE skips all seed rows (they exist, PK conflict). Table contents unchanged. Pinned by cases (a) and (b) in spec.

3. **Reopen, user edited a seed row** — seed declares `(2, 'Other')` but row is `(2, 'Edited')`: OR IGNORE skips the insert for id=2 because it exists. User edit survives. Pinned by case (d) in spec and the second `select` in sqllogic.

4. **ON DELETE CASCADE** — a seeded parent table referenced by cascading children: OR IGNORE never deletes the parent row (no delete-then-insert), so no cascade fires on reopen when values are identical. Not directly tested in the unit tests (no FK+CASCADE spec for seed tables), but follows directly from the behavior: nothing is written → no cascade.

## Known gaps / reviewer hints
- There is no integration test with a parent→child FK cascade to prove the cascade-avoidance property end-to-end. A reviewer could add one or note it as future coverage.
- The `schema-declarative.ts` comment block (lines 234-264) still describes the OR REPLACE rationale in detail. It was left in place because it accurately explains the history; the reviewer may want to trim or update it to reflect the final OR IGNORE choice.
- The `OR REPLACE` rationale still appears in those comments (e.g., "INSERT OR REPLACE never scans…"). This is historical context; the code itself is correct.

## Review findings
<!-- to be filled by reviewer -->
