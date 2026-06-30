description: Declarative seed data now reports an error when a seed row breaks a table rule (a CHECK, a required column, or a foreign key) instead of silently dropping it, so a typo in seed data no longer vanishes without warning.
prereq:
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts   # seed insert now ON CONFLICT (pk) DO NOTHING + buildSeedConflictClause
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # new malformed-seed-row test section
  - packages/quereus-store/test/seed-reopen-idempotent.spec.ts # comment-only accuracy updates
  - docs/schema.md                                            # Seed Data § rewritten
difficulty: medium
---

## What changed

Declarative seed application (`apply schema … with seed`, in `emitApplySchema`)
previously wrote each seed row with `INSERT OR IGNORE`. Per SQLite semantics
`OR IGNORE` silently skips a row on **any** constraint failure, so a malformed
seed row (CHECK / NOT NULL / child-side FK violation) was dropped on the very
first apply with no diagnostic — a typo in seed data simply vanished.

The seed insert now emits, per row:

```sql
insert into <table> values (…) on conflict (<pk-cols>) do nothing
```

This is the surgical formulation the ticket proposed. The conflict target names
only the seed table's PRIMARY KEY columns, so:

- **PK already present** (the idempotency / reseed case) → suppressed (skip, no
  delete) → cascade-avoidance and user-edit-preservation are unchanged.
- **CHECK / NOT NULL / child-FK violation** → NOT a PK conflict. These are
  evaluated by the `ConstraintCheckNode` above the DML executor, which sees no
  statement-level `OR` clause (`stmt.onConflict` is undefined for an
  `ON CONFLICT … DO NOTHING` insert — that lives on `stmt.upsertClauses`), so it
  resolves to ABORT and the apply aborts with a clear error.

A new helper `buildSeedConflictClause(tableSchema)` builds the clause from
`tableSchema.primaryKeyDefinition`. An empty PK (`primary key ()` singleton)
falls back to the untargeted `on conflict do nothing` (no columns to name).

### Why this is the chosen path (Acceptance option (a))

The ticket left open whether to (a) raise an error or (b) document the silent
skip. I took **(a)** — restoring error visibility — because a silently-vanishing
seed row is a genuine footgun and the fix is cheap (PK is already on the schema).

## Key mechanism the reviewer should sanity-check

The whole correctness argument rests on: **`ON CONFLICT … DO NOTHING` does NOT
flow into the constraint-check node's conflict resolution.** Verified in
`planner/building/insert.ts` — the `ConstraintCheckNode` is constructed with
`stmt.onConflict` (the `OR …` clause), while the `DO NOTHING` upsert clause is a
separate `stmt.upsertClauses` path. So with a bare `INSERT … ON CONFLICT (pk) DO
NOTHING`, `stmtOR` at the constraint check is `undefined` ⇒ ABORT. (`pickAction`
in `runtime/emit/constraint-check.ts` returns ABORT when both stmt-OR and the
per-constraint default are absent.) The constraint check runs *before* the vtab
insert (it is the executor's source), so CHECK/NOT NULL/FK abort before any
PK-conflict resolution is reached.

## Tests / what is pinned

`test/logic/50-declarative-schema.sqllogic`, new section after `decl_seed_cascade`:

- **Positive control** (`decl_seed_good_check`): valid rows on a CHECK-constrained
  table seed cleanly AND a re-apply stays idempotent (PK-targeted clause skips
  existing rows; the CHECK does not re-fire into an error).
- **CHECK** (`decl_seed_bad_check`): a row failing `check (n < 10)` → `-- error:
  CHECK constraint failed`.
- **NOT NULL** (`decl_seed_bad_nn`): a `(1, NULL)` row into a `NOT NULL` column →
  `-- error: NOT NULL constraint failed`.
- **Child-side FK** (`decl_seed_bad_fk`, `pragma foreign_keys = true`): a child
  seed row referencing a missing parent → `-- error: CHECK constraint failed`
  (the FK existence check is synthesized as a CHECK and shares that prefix).

The pre-existing idempotency/cascade pins (`decl_seed_idem`, `decl_seed_cascade`
in the same file; all four cases in `quereus-store/test/seed-reopen-idempotent.spec.ts`)
still pass unchanged — they exercise the new conflict clause and confirm reseed
behavior is preserved.

## Honest gaps — please scrutinize

1. **Secondary-UNIQUE seed collisions are still silently skipped** (NOT aborted).
   This is the one part of the ticket's "untargeted UNIQUE violations abort as
   usual" claim that does **not** hold in Quereus today. Root cause:
   `matchUpsertClause` in `runtime/emit/dml-executor.ts` (~line 250) short-circuits
   on `isPkMatch` — a PK-targeted `DO NOTHING` is treated as matching *any* unique
   conflict because the vtab result does not carry *which* constraint fired. So a
   seed row that duplicates a value on a secondary `UNIQUE` index (distinct PK) is
   skipped just as it was under `OR IGNORE`. This is **unchanged behavior**, not a
   regression, and it is now documented in `docs/schema.md` § Seed Data (the
   "Caveat — secondary UNIQUE collisions" note). I deliberately did **not** add a
   test asserting an abort here (it would fail), nor one pinning the skip (it would
   freeze arguably-undesirable behavior). **Reviewer decision:** if tightening is
   wanted, it needs constraint-identity tracking in the UPSERT matcher — a broader
   change with upsert-semantics blast radius — and should be a separate fix/backlog
   ticket. I judged it out of scope here.

2. **Multi-row seed atomicity is not asserted.** The malformed-row tests use a
   single bad row, so they pin "the apply errors" without depending on whether a
   good row earlier in the same batched seed exec rolls back. I did not pin the
   post-error table state (whether the table exists / is empty after a rolled-back
   apply that also created the table in the same implicit transaction). If the
   reviewer wants that nailed down, it is worth empirically checking
   `_execWithinTransaction` + implicit-transaction rollback interaction for a
   DDL+seed apply, then adding a post-state assertion.

3. **Empty-PK singleton fallback** (`primary key ()`) emits untargeted
   `on conflict do nothing`. Handled in code and documented, but not separately
   tested — it is a rare shape and the untargeted form there can only conflict on
   the singleton key. Low risk; flagging for completeness.

## Validation run

- `yarn typecheck` (quereus) — clean
- `node test-runner.mjs --grep "50-declarative-schema"` — 1 passing
- `node test-runner.mjs` (full memory-backed quereus suite) — 6421 passing, 9 pending
- quereus-store `seed-reopen-idempotent.spec.ts` — 4 passing
- `eslint src/runtime/emit/schema-declarative.ts` — clean; quereus-store `typecheck` — clean

Not run (deferred, out of agent wall-clock budget / not affected): `yarn test:store`
(full store re-run) and `yarn test:full`. The store seed spec was run directly and
passes; a store-mode run of the whole logic suite would additionally exercise the
new sqllogic section against the LevelDB-backed path. Worth a CI/manual store pass
before close if the reviewer wants store-backend coverage of the new malformed-row
cases.
