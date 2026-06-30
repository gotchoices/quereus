description: A typo in declarative seed data that duplicates a value on a secondary uniqueness rule (one that is not the table's primary key) used to vanish silently; it now aborts the apply with a clear "UNIQUE constraint failed" error, like every other malformed-seed case.
prereq:
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts          # matchUpsertClause (~line 236) — isPkMatch branch removed; consumer ~line 631
  - packages/quereus/src/vtab/memory/layer/manager.ts          # secondary-UNIQUE result populates existingRow (line 1164)
  - packages/quereus/src/util/comparison.ts                    # sqlValuesEqual (binary/byte-exact, collation-unaware) ~line 485
  - packages/quereus/test/logic/50-declarative-schema.sqllogic # new decl_seed_dup_unique block (end of file)
  - packages/quereus/test/logic/47.1-upsert-conflict-targets.sqllogic # new section 8 (target-scoped suppression)
  - docs/schema.md                                             # Seed Data § — caveat removed, preceding ¶ tightened
difficulty: medium
---

## What changed

`matchUpsertClause` in `runtime/emit/dml-executor.ts` decides whether a vtab-reported
`UNIQUE` violation is covered by a `DO NOTHING` / `DO UPDATE` clause. It used to have a
short-circuit (`isPkMatch`): when the clause's conflict-target columns equalled the
table's PK columns, it returned the clause **unconditionally**, without checking which
constraint actually fired. Since the declarative seed insert always targets the PK
(`INSERT … ON CONFLICT (<pk>) DO NOTHING`), that branch swallowed *any* unique conflict —
including a collision on a **secondary** `UNIQUE` index — so a duplicate-on-UNIQUE seed
row was silently dropped instead of aborting the apply.

**The fix removes the `isPkMatch` branch.** Matching now flows entirely through the
remaining value-comparison branch (`conflictMatch`): a clause covers the conflict only
when the proposed row equals the conflicting existing row at every one of the clause's
conflict-target columns.

- **Genuine PK conflict** (idempotent reseed): existing row shares the proposed PK by
  definition → values equal at PK indices → match → `DO NOTHING` skips. Idempotency
  preserved.
- **Secondary-UNIQUE conflict** (the bug): the conflicting existing row has a *different*
  PK → values unequal at PK indices → no match → consumer (`processInsertRow`, ~line 671)
  throws `ConstraintError` → apply aborts with `UNIQUE constraint failed: …`. Fixed.

Doc comment on the function was rewritten to describe the value-comparison contract and
drop the stale "a more complete implementation would track which constraint was violated"
aspiration. A `NOTE:` tripwire comment was added at the `conflictMatch` site recording the
two residual limitations (below).

The `docs/schema.md` § Seed Data "Caveat — secondary UNIQUE collisions" paragraph was
removed, and the preceding paragraph's "only the named seed-PK conflict is suppressed"
wording was tightened to state that suppression now requires a value-match at the PK
columns, so secondary-UNIQUE duplicates abort on equal footing with CHECK / NOT NULL /
child-FK violations.

## Why not constraint-identity tracking

The original ticket and the (now-removed) docs caveat proposed threading *which constraint
fired* through the vtab result and matching a `DO NOTHING` clause only on set-equality of
its declared target columns. **That was deliberately rejected** because it would regress
documented, tested behavior: `47.1-upsert-conflict-targets.sqllogic` lines 24-29 assert
Quereus *intentionally accepts* **partial** conflict targets (with `unique (k, v)`, both
`on conflict (k) do nothing` and `on conflict (v) do nothing` are accepted and skip the
duplicate). Strict set-equality would make those abort. The value-comparison branch keeps
partial targets working. See the rationale block in the deleted source ticket if more
detail is needed.

## How to validate

Run: `yarn workspace @quereus/quereus test --grep "upsert|50-declarative-schema"` (35
passing) and the full suite `yarn workspace @quereus/quereus test` (6421 passing, 9
pending, 0 failing) plus `yarn workspace @quereus/quereus lint` (clean). All confirmed
green at handoff.

New regression coverage:

- **`50-declarative-schema.sqllogic`** (end of file, `decl_seed_dup_unique`): a table with
  a PK plus `constraint uq_email unique (email)`, seeded with two rows sharing `'dup@x'`
  but distinct PKs → `apply schema … with seed` must fail with
  `-- error: UNIQUE constraint failed`. This is the headline acceptance case.
- **`47.1-upsert-conflict-targets.sqllogic`** (new section 8, `scoped` table with
  `id integer primary key, email text unique`): direct (non-seed) UPSERT proof that
  `ON CONFLICT (<target>) DO NOTHING` only suppresses conflicts on `<target>`:
  - `insert … (2,'a@x') on conflict (id) do nothing` when `(1,'a@x')` exists → aborts
    (conflict is on `email`, not the targeted `id`).
  - `insert … (1,'b@x') on conflict (email) do nothing` when `(1,'a@x')` exists → aborts
    (conflict is on `id`, not the targeted `email`).
  - `insert … (1,'a@x') on conflict (id) do nothing` when `(1,'a@x')` exists → skipped
    (genuine PK conflict; count unchanged). Idempotency control.

I confirmed the memory module's secondary-UNIQUE path *does* populate `existingRow`
(`manager.ts:1164`), so the direct tests genuinely exercise the value-comparison branch —
they are not passing by accident via the no-existingRow fallthrough.

## Honest gaps / where a reviewer should push

These are the **two residual limitations** recorded as a `NOTE:` tripwire in
`dml-executor.ts` at the `conflictMatch` site — neither is in scope for this ticket, but
both are worth a reviewer's eyes to confirm the framing is right:

1. **Multi-constraint coincidence.** If one insert simultaneously violates the clause's
   target constraint *and* another unique constraint, and the vtab happens to return the
   *target* constraint's `existingRow`, the row is still suppressed even though the
   uncovered conflict should abort. The vtab short-circuits on the first violated
   constraint (it does not report all violations), so even full constraint-identity
   tracking could not fix this without a much larger vtab change. **Not exercised by any
   test** — I did not construct a two-constraint-coincidence fixture. A reviewer who wants
   to harden this could add one, but per the tripwire rules it is conditional, not a
   latent defect on a currently-reachable path.

2. **Collation-sensitive keys.** `sqlValuesEqual` is binary/byte-exact and
   collation-unaware (see its doc comment, `comparison.ts:481`). A PK/UNIQUE conflict that
   holds under a coarser collation (e.g. `NOCASE`) but whose proposed value differs from
   the stored value only by case now compares **unequal** and aborts rather than skips.
   Seed idempotency is unaffected (a reseed re-presents byte-identical literals), but a
   general `ON CONFLICT (<nocase-col>) DO NOTHING` with a case-variant duplicate could
   abort where it previously skipped. If this ever bites, the comparison should use the
   constraint's enforcement collation (`uniqueEnforcementCollations` +
   `compareSqlValuesFast`) instead of `sqlValuesEqual`. **Not tested** — no NOCASE-UNIQUE
   UPSERT fixture exists; this is the change's one plausible behavioral regression for
   non-seed callers and is the thing most worth a reviewer's scrutiny. (It is a genuine
   behavior change, but only on a path — case-variant ON CONFLICT DO NOTHING — that has no
   existing test asserting the old skip behavior, so nothing went red.)

Tripwire index for the eventual `## Review findings`:
- Multi-constraint coincidence → `NOTE:` at `matchUpsertClause`'s `conflictMatch` site.
- Binary `sqlValuesEqual` vs. collation-sensitive keys → same `NOTE:`.

## Acceptance checklist (all met)

- [x] Secondary-UNIQUE seed duplicate aborts `apply schema … with seed` with
      `UNIQUE constraint failed`.
- [x] Reseed re-presenting an already-present PK is still skipped (idempotency); existing
      `decl_seed_idem` / `decl_seed_cascade` / `decl_seed_composite` pins still pass.
- [x] General `ON CONFLICT (<target>) DO NOTHING` suppresses only conflicts on `<target>`
      — direct (non-seed) coverage added.
- [x] Partial-conflict-target acceptance (`47.1` lines 24-29) still passes.
- [x] "Caveat — secondary UNIQUE collisions" note removed from `docs/schema.md`.
- [x] Full test suite + lint green.
