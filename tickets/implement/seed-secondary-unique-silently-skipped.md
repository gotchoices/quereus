description: A typo in declarative seed data that duplicates a value in a secondary uniqueness rule (one that is not the table's primary key) still vanishes silently instead of reporting an error; fix the UPSERT matcher so the duplicate aborts the apply like every other malformed-seed case.
prereq:
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts          # matchUpsertClause — the isPkMatch short-circuit (~line 250)
  - packages/quereus/src/util/comparison.ts                     # sqlValuesEqual (binary/byte-exact, collation-unaware)
  - packages/quereus/test/logic/50-declarative-schema.sqllogic  # seed tests (idempotency ~1300, malformed-row ~1412)
  - packages/quereus/test/logic/47.1-upsert-conflict-targets.sqllogic  # partial-target acceptance (lines 24-29) — must NOT break
  - packages/quereus/test/logic/47-upsert.sqllogic              # general upsert coverage
  - docs/schema.md                                              # Seed Data § "Caveat — secondary UNIQUE collisions" (line 744)
difficulty: medium
---

## Summary

When `apply schema … with seed` writes a declared seed row, it uses
`INSERT INTO <tbl> VALUES (…) ON CONFLICT (<pk-cols>) DO NOTHING`. A seed row that
duplicates a value on a **secondary** `UNIQUE` index (a uniqueness rule that is
*not* the primary key) is currently skipped silently instead of aborting the
apply with an error. Every other malformed-seed case (PK / `CHECK` / `NOT NULL` /
child-FK) already aborts loudly; this one slipped through.

## Root cause (confirmed by reading the code)

`matchUpsertClause` in `runtime/emit/dml-executor.ts` (~line 236) decides whether
a vtab-reported `UNIQUE` violation should be suppressed by a `DO NOTHING` /
`DO UPDATE` clause. It has three branches, in order:

1. **No conflict target** → matches any unique conflict. (Untargeted `DO NOTHING`.)
2. **`isPkMatch`** (lines ~250-255): if the clause's target columns equal the
   table's PK columns, return the clause **unconditionally** — *without checking
   which constraint actually fired*. **This is the bug.**
3. **`conflictMatch`** (lines ~259-264): compare the proposed row's values to the
   existing (conflicting) row's values *at the clause's conflict-target column
   indices* via `sqlValuesEqual`. Match only when they're equal.

The seed insert targets the PK, so branch 2 fires for *any* unique conflict —
including a secondary-`UNIQUE` collision, where the conflicting existing row has a
**different** PK. Branch 2 returns the clause, the matcher treats it as
`DO NOTHING`, and the row is dropped silently.

The constraint-violation result the vtab returns
(`UpdateResult` constraint variant in `common/types.ts`:
`{ status: 'constraint'; constraint: 'unique'; message?; existingRow? }`) does
**not** say which unique constraint fired — only the conflicting `existingRow`.

## Recommended fix — remove the `isPkMatch` short-circuit

**Delete branch 2 and let branch 3 (`conflictMatch`) handle PK-targeted clauses
too.** This is correct for every case that matters, and it is small and local
(one function, one consumer — `processInsertRow`):

- **Genuine PK conflict (idempotent reseed).** A PK conflict means the existing
  row shares the proposed row's PK by definition, so `conflictMatch` compares
  equal values at the PK indices → matches → `DO NOTHING` skips the row.
  Idempotency preserved (`decl_seed_idem` / `decl_seed_cascade` pins still pass).
- **Secondary-`UNIQUE` conflict (the bug).** The conflicting existing row has a
  *different* PK, so `conflictMatch` compares unequal values at the PK indices →
  no match → the matcher returns `undefined` → `processInsertRow` throws
  `ConstraintError` → the apply aborts with `UNIQUE constraint failed: …`. Fixed.

`isPkMatch` only ever *added* matches that branch 3 would not make, and every one
of those extra matches is exactly the bug (PK-targeted clause vs. a non-PK
conflict). For a true PK conflict the two branches already agree, so removing
branch 2 changes no correct behavior.

### Why NOT the "constraint-identity tracking" approach the original ticket and the docs caveat propose

The caveat in `docs/schema.md` (line 744) and the source ticket suggest threading
*which constraint fired* through the `UpdateResult` and matching a `DO NOTHING`
clause only when the conflict is on its **declared target columns** (set-equality
of clause target vs. violated-constraint columns). **Do not do this** — it would
regress documented, tested behavior:

`test/logic/47.1-upsert-conflict-targets.sqllogic` lines 24-29 assert that
Quereus *deliberately accepts* **partial** conflict targets: with
`unique (k, v)`, both `on conflict (k) do nothing` and `on conflict (v) do
nothing` are accepted and skip the duplicate (the test comment spells this out:
"Quereus accepts partial conflict targets that match any UNIQUE involving the
listed column(s)"). Strict set-equality identity matching would make those abort,
breaking that test and that design choice. The value-comparison branch, by
contrast, keeps partial targets working (it compares only the named target
columns, which match on a real conflict on those columns).

### Residual limitation (a tripwire, NOT additional work)

Value-comparison via `sqlValuesEqual` cannot perfectly disambiguate two corners.
Neither is in scope; record them as tripwires (see TODO):

- **Multi-constraint coincidence.** If a single insert simultaneously violates the
  clause's target constraint *and* another unique constraint, and the vtab happens
  to return the target constraint's `existingRow`, the row is still suppressed even
  though the *other* (uncovered) conflict should abort. The vtab short-circuits on
  the first violated constraint, so even full constraint-identity tracking could
  not fix this without the vtab reporting *all* violations — a much larger change.
- **Collation-sensitive keys.** `sqlValuesEqual` is binary/byte-exact and
  collation-unaware (see its doc comment in `util/comparison.ts`). A PK/UNIQUE
  conflict that holds under a coarser collation (e.g. `NOCASE`) but whose proposed
  value differs from the stored value only by case would now compare unequal and
  abort rather than skip. Seed idempotency is unaffected (reseed presents
  byte-identical literals), but a general `ON CONFLICT (<nocase-col>) DO NOTHING`
  with a case-variant duplicate could abort where it previously skipped. If this
  ever bites, the comparison should use the constraint's enforcement collation
  (`uniqueEnforcementCollations` + `compareSqlValuesFast`) instead of
  `sqlValuesEqual`.

## Acceptance (from the source ticket)

- A declarative seed row that duplicates a secondary `UNIQUE` value aborts
  `apply schema … with seed` with a `UNIQUE constraint failed` error.
- A reseed that re-presents an already-present PK is still skipped (idempotency;
  no cascade). `decl_seed_idem` / `decl_seed_cascade` still pass.
- General `INSERT … ON CONFLICT (<target>) DO NOTHING` only suppresses conflicts
  on `<target>`, not on other unique constraints — with direct (non-seed) test
  coverage.
- The partial-conflict-target acceptance in `47.1` (lines 24-29) still passes.
- Remove the "Caveat — secondary `UNIQUE` collisions" note from `docs/schema.md`.

## TODO

- In `runtime/emit/dml-executor.ts`, `matchUpsertClause`: remove the `isPkMatch`
  block (the early `return clause` when the target equals the PK columns). Keep the
  no-target branch and the `conflictMatch` value-comparison branch. Update the
  function's doc comment (it currently says "we match if the conflict target is the
  PK or a subset" / "A more complete implementation would track which specific
  constraint was violated") to describe the value-comparison contract and to drop
  the stale "more complete implementation" aspiration.
- Add a `NOTE:` tripwire comment at the `conflictMatch` site recording the two
  residual limitations above (multi-constraint coincidence; binary `sqlValuesEqual`
  vs. collation-sensitive keys) so a future reader meets them in place.
- Add a seed regression to `test/logic/50-declarative-schema.sqllogic` (alongside
  the malformed-row block ~line 1412): a table with a PK and a secondary `UNIQUE`,
  seeded with two rows sharing the unique value but distinct PKs, must make
  `apply schema … with seed` fail with `-- error: UNIQUE constraint failed`. For
  example:
  ```
  declare schema decl_seed_dup_unique using (default_vtab_module = 'memory') {
      table t {
          id INTEGER PRIMARY KEY,
          email TEXT,
          constraint uq_email unique (email)
      }
      seed t ( (1, 'dup@x'), (2, 'dup@x') )
  }
  -- run
  apply schema decl_seed_dup_unique with seed;
  -- error: UNIQUE constraint failed
  ```
- Add direct (non-seed) UPSERT coverage to
  `test/logic/47.1-upsert-conflict-targets.sqllogic` (or `47-upsert.sqllogic`)
  proving target-scoped suppression, e.g. on `create table t (id integer primary
  key, email text unique)`:
  - `insert into t values (2,'a@x') on conflict (id) do nothing;` when `(1,'a@x')`
    exists → aborts with `UNIQUE constraint failed` (conflict is on `email`, not the
    targeted `id`).
  - `insert into t values (1,'b@x') on conflict (email) do nothing;` when
    `(1,'a@x')` exists → aborts (conflict is on `id`, not the targeted `email`).
  - `insert into t values (1,'a@x') on conflict (id) do nothing;` when `(1,'a@x')`
    exists → skipped (genuine PK conflict; count unchanged). Idempotency control.
- Remove the "Caveat — secondary `UNIQUE` collisions" paragraph from
  `docs/schema.md` § Seed Data (line 744). Optionally tighten the preceding
  paragraph's "only the named seed-PK conflict is suppressed" wording so it remains
  accurate now that secondary-UNIQUE collisions also abort.
- Run `yarn workspace @quereus/quereus test` and `yarn lint`. Pay attention to the
  full `47-upsert.sqllogic` / `47.1-upsert-conflict-targets.sqllogic` and
  `50-declarative-schema.sqllogic` runs — confirm no existing case silently relied
  on the `isPkMatch` short-circuit. (Analysis says none should: every passing case
  with a PK-targeted clause is a genuine PK conflict, which `conflictMatch` matches
  identically.)
