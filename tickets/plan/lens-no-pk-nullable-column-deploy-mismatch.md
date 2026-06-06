description: |
  A logical lens table declared with NULLABLE columns and NO primary key trips a
  `lens.nullability-mismatch` deploy error (the prover treats a `null`-declared logical
  column as NOT NULL against a nullable basis), whereas the identical column declarations
  deploy cleanly when the logical table HAS a primary key, or when the columns are NOT NULL.
  Surfaced incidentally while writing the decomposition-fanout `new.<col>` property test
  (lens-decomposition-fanout-new-row-context); worked around there by declaring NOT NULL
  columns. Pre-existing lens-deploy behaviour, unrelated to that change.
files:
  - packages/quereus/src/schema/lens-prover.ts        # checkTypeAndNullability — the lens.nullability-mismatch emit site
  - packages/quereus/test/lens-prover.spec.ts         # existing nullability-mismatch coverage
  - docs/lens.md                                       # § Coverage checklist (nullability rule)
----

# Lens deploy: a no-PK logical table with nullable columns spuriously trips `lens.nullability-mismatch`

## Symptom

Declaring a logical lens table with **nullable** columns and **no primary key** fails to
deploy with `lens.nullability-mismatch` — the prover reports the `null`-declared logical
column as NOT NULL over a nullable basis expression. The same column declarations deploy
fine in two neighbouring cases:

- the logical table declares a primary key (any column), or
- the columns are declared NOT NULL.

This forced the `lens-decomposition-fanout-new-row-context` property test to use NOT NULL
columns rather than the more natural `integer null`, so the inconsistency is at least one
real ergonomic stumbling block.

## Why this is suspect

`checkTypeAndNullability` (`schema/lens-prover.ts`) errors when
`col.notNull && outType.nullable === true && col.defaultValue === null`. The error firing
for a column the author wrote as `null` implies `col.notNull` is being set true somewhere
for a no-PK logical table — most likely a no-PK table synthesizing an all-columns key (or
otherwise promoting columns to NOT NULL) before the prover runs, so columns the author
declared nullable are seen as NOT NULL. That interaction is the thing to pin down.

## What to determine (specification, not yet a plan)

- Confirm the exact repro and the minimal shape (no-PK + `<col> null`) — see the worked-around
  test in `lens-decomposition-fanout-new-row-context` for a starting fixture, and the
  existing `nullability-mismatch` case in `test/lens-prover.spec.ts` for the inverse.
- Establish whether the **intended** semantics are: (a) a no-PK logical table's nullable
  columns should stay nullable (current behaviour is a bug — fix the promotion), or (b) a
  no-PK logical table legitimately promotes columns and the error is correct but its
  *message/diagnostic* is misleading (should say so). Decide which before changing code.
- Whichever way it resolves, add a lens-prover (or sqllogic) test pinning the no-PK +
  nullable-column deploy outcome so it cannot silently drift, and align `docs/lens.md`
  § Coverage checklist if the rule's scope changes.

## Out of scope

The `new.<col>` fan-out work that surfaced this (already complete) — this ticket is purely
the no-PK nullability deploy behaviour.
