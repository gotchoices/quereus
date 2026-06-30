description: Declarative seed data now reports an error when a seed row breaks a table rule (a CHECK, a required column, or a foreign key) instead of silently dropping it, so a typo in seed data no longer vanishes without warning.
prereq:
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # seed insert: ON CONFLICT (pk) DO NOTHING + buildSeedConflictClause
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # malformed-seed-row section + composite-PK reseed + comment accuracy
  - packages/quereus-store/test/seed-reopen-idempotent.spec.ts # comment-only accuracy updates
  - docs/schema.md                                            # Seed Data § rewritten
difficulty: medium
---

## What shipped

Declarative seed application (`apply schema … with seed`, in `emitApplySchema`)
previously wrote each seed row with `INSERT OR IGNORE`, which per SQLite
semantics silently skips a row on **any** constraint failure — so a malformed
seed row (CHECK / NOT NULL / child-side FK violation) was dropped on the first
apply with no diagnostic.

The seed insert now emits, per row:

```sql
insert into <table> values (…) on conflict (<pk-cols>) do nothing
```

The conflict target names only the seed table's PRIMARY KEY columns
(`buildSeedConflictClause`, built from `tableSchema.primaryKeyDefinition`), so:

- **PK already present** (reseed / idempotency) → suppressed (skip, no delete) →
  cascade-avoidance and user-edit preservation unchanged.
- **CHECK / NOT NULL / child-FK violation** → not a PK conflict → the
  `ConstraintCheckNode` (which receives `stmt.onConflict`, undefined for a
  `DO NOTHING` upsert) resolves to ABORT → apply aborts with a clear error.

Empty-PK singleton (`primary key ()`) falls back to untargeted
`on conflict do nothing`.

## Review findings

### Approach taken
Read the implement-stage diff (`4c7caffb`) first, then verified the central
correctness claim against the code rather than the handoff prose:
- `planner/building/insert.ts` constructs `ConstraintCheckNode` with
  `stmt.onConflict` (the `OR …` clause), while `DO NOTHING` rides a separate
  `stmt.upsertClauses` path — so a bare `ON CONFLICT (pk) DO NOTHING` leaves
  `stmtOR` undefined at the constraint check.
- `runtime/emit/constraint-check.ts` `pickAction(stmtOR, constraintDefault)`
  returns ABORT when both are undefined. Confirmed: CHECK/NOT NULL/FK abort.
- `schemaManager.getTable(schemaName, tableName)` signature (manager.ts:1605,
  lowercases schema) and `primaryKeyDefinition[i].index → columns[].name` usage
  are correct.
- `matchUpsertClause` `isPkMatch` short-circuit (dml-executor.ts ~250) confirms
  the disclosed secondary-UNIQUE gap is real and unchanged behavior.

### Correctness / type safety / error handling
No defects found. The implementation is sound; the `getTable` not-found guard,
the empty-PK fallback, and the constraint-check ordering all hold up. Column
names in the conflict target are quoted via `quoteIdentifier`; seed literals are
author-controlled (schema AST), not runtime input.

### Tests — checked and **extended**
- Ran the implementer's coverage: `50-declarative-schema.sqllogic` (1 passing),
  `quereus-store/test/seed-reopen-idempotent.spec.ts` (4 passing), full
  memory-backed quereus suite (**6421 passing, 9 pending** — no regressions).
- **Added (minor, inline):** a composite-PRIMARY-KEY reseed idempotency case
  (`decl_seed_composite`) — the new multi-column `on conflict (a, b) do nothing`
  clause was otherwise entirely untested. Pins: idempotent reseed, a non-PK
  user edit surviving, and a non-seed row preserved. Passes.

### Docs — found stale, **fixed inline (minor)**
The implement diff updated the new test section and the store-spec comments but
left **four** pre-existing comment blocks in `50-declarative-schema.sqllogic`
(the `decl_seed_idem` and `decl_seed_cascade` sections) still describing the
mechanism as `INSERT OR IGNORE`. Rewrote all four to `ON CONFLICT (<pk>) DO
NOTHING`, preserving the `OR REPLACE` cascade-contrast rationale.
`docs/schema.md` § Seed Data was already rewritten by the implementer and is
accurate (including an honest secondary-UNIQUE caveat).

### Major finding — filed as new ticket (not fixed here)
**Secondary-`UNIQUE` seed collisions are still silently skipped** (disclosed
gap #1). A seed row duplicating a value on a secondary `UNIQUE` index (distinct
PK) is skipped, not aborted — the same footgun class this ticket fixed for
PK/CHECK/NN/FK, surviving for secondary UNIQUE. Root cause: `matchUpsertClause`
treats a PK-targeted `DO NOTHING` as matching any unique conflict because the
vtab result does not carry which constraint fired. Closing it needs
constraint-identity tracking in the UPSERT matcher (upsert-semantics blast
radius), so it is out of scope here. Filed as
`tickets/backlog/seed-secondary-unique-silently-skipped.md`.

### Deferred / not pursued (acceptable, with reasons)
- **Multi-row seed atomicity (disclosed gap #2):** not pinned with a dedicated
  test. `_execWithinTransaction` runs the batched seed inside the `apply schema`
  statement's implicit transaction (database.ts: implicit-transaction rollback
  on throw), so a malformed row rolls the whole apply back atomically — but I
  did not add a post-state assertion. Low value vs. the single-bad-row pins that
  already lock the contract ("malformed → clear error"); not worth the test
  fragility.
- **Empty-PK singleton fallback (disclosed gap #3):** rare shape, untested;
  left as-is. The untargeted `on conflict do nothing` there can only conflict on
  the singleton key, and CHECK/NN still abort, so risk is minimal.
- **Store-backend run of the new sqllogic cases (`yarn test:store`):** not run
  (full store re-run exceeds agent wall-clock budget). The store seed spec was
  run directly and passes; flag for a CI/manual store pass before release.

## Validation run (this review)
- `yarn typecheck` (quereus) — clean
- `eslint src/runtime/emit/schema-declarative.ts` — clean
- `node test-runner.mjs --grep "50-declarative-schema"` — 1 passing (incl. new
  composite-PK case)
- `node test-runner.mjs` (full memory suite) — 6421 passing, 9 pending
- `quereus-store` `seed-reopen-idempotent.spec.ts` (mocha) — 4 passing
