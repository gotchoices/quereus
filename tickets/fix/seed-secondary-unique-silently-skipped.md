description: A typo in declarative seed data that duplicates a value in a secondary uniqueness rule (one that is not the table's primary key) still vanishes silently instead of reporting an error — the same footgun we just fixed for other rule violations, but for this one case it is not yet fixed.
prereq:
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts          # matchUpsertClause — isPkMatch short-circuit (~line 250)
  - packages/quereus/src/runtime/emit/schema-declarative.ts     # buildSeedConflictClause / seed insert
  - docs/schema.md                                              # Seed Data § "Caveat — secondary UNIQUE collisions"
difficulty: hard
---

## Background

Ticket `seed-or-ignore-masks-malformed-rows` changed declarative seed
application from `INSERT OR IGNORE` to per-row
`INSERT INTO <tbl> VALUES (…) ON CONFLICT (<pk-cols>) DO NOTHING`. That restored
error visibility for a malformed seed row that violates a `CHECK`, a `NOT NULL`
column, or a child-side FK: those are not PK conflicts, so they abort the apply
with a clear diagnostic instead of being silently dropped.

One case was deliberately left unfixed and is now documented as a known caveat:
**a seed row that duplicates a value on a *secondary* `UNIQUE` index (distinct
PK) is still silently skipped**, exactly as it was under `OR IGNORE`. This is the
same class of footgun the parent ticket set out to eliminate (a typo'd seed row
vanishes without a diagnostic) — it just survives for secondary-UNIQUE
collisions.

## Root cause

`matchUpsertClause` in `runtime/emit/dml-executor.ts` (~line 250) short-circuits
on `isPkMatch`: a PK-targeted `DO NOTHING` clause is treated as matching *any*
unique-constraint violation, because the vtab's constraint-violation result does
not carry *which* constraint fired. So when a seed insert with
`ON CONFLICT (<pk>) DO NOTHING` collides on a secondary `UNIQUE` index, the
matcher still finds the PK-targeted `DO NOTHING` clause and skips the row rather
than letting it abort.

```
matchUpsertClause(existingRow, proposedRow, clauses):
  for clause in clauses:
    if no conflictTargetIndices: return clause          // untargeted → any conflict
    isPkMatch = conflictTargetIndices == pkColumnIndicesInSchema
    if isPkMatch: return clause          // ← matches a SECONDARY unique conflict too
    ...
```

## Desired behavior

A seed row that conflicts on a constraint *other than* the named conflict target
(`<pk-cols>`) should abort the apply with a clear `UNIQUE constraint failed: …`
error — consistent with the PK / CHECK / NOT NULL / FK cases — rather than being
silently skipped. A genuine reseed PK collision (the idempotency case) must
remain suppressed.

## Why this is non-trivial (the reason it was deferred)

Fixing it correctly requires **constraint-identity tracking** in the UPSERT
matcher: the vtab constraint-violation result must report which unique
constraint (PK vs which secondary index) actually fired, so `matchUpsertClause`
can match a `DO NOTHING` clause *only* when the conflict is on its declared
target columns. That touches the UPSERT matching path used by all
`INSERT … ON CONFLICT … DO NOTHING/UPDATE` statements, not just seed inserts, so
it carries upsert-semantics blast radius and needs its own regression coverage
(general upsert conflict-target matching, not only seed data).

## Acceptance

- A declarative seed row that duplicates a secondary `UNIQUE` value aborts
  `apply schema … with seed` with a `UNIQUE constraint failed` error.
- A reseed that re-presents an already-present PK is still skipped (idempotency
  preserved; no cascade fires) — the existing `decl_seed_idem` / `decl_seed_cascade`
  pins still pass.
- General `INSERT … ON CONFLICT (<target>) DO NOTHING` only suppresses conflicts
  on `<target>`, not on other unique constraints — with direct (non-seed) test
  coverage.
- Remove the "Caveat — secondary `UNIQUE` collisions" note from
  `docs/schema.md` § Seed Data once the gap is closed.
