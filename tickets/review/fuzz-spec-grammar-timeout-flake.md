description: The grammar SQL fuzz tests now print a seed at startup and can be replayed exactly by setting that seed in an environment variable, so a future random timeout is reproducible instead of a dead end.
prereq:
files:
  - packages/quereus/test/fuzz.spec.ts   # seed machinery + seeded fc.assert/fc.sample + AbortSignal tripwire NOTE
  - docs/architecture.md                 # testing section: new "Grammar-Based SQL Fuzzing" bullet documenting QUEREUS_FUZZ_SEED
difficulty: medium
---

## Problem (recap)

`fuzz.spec.ts` intermittently hit the per-test 120s Mocha timeout under
full-suite load. The prior fix-stage investigation could not reproduce a
pathological/hanging query (~15k generated queries, slowest 20ms) and concluded
the most likely cause is environmental contention — but a rare engine hang could
not be *fully* excluded. The blocker for diagnosing either case was the same:
the fuzzer used **no seed**, so a timeout named no SQL and was not replayable.

Decision on the ticket: **seed the fuzzer** (direction 1).

## What shipped

The suite is now fully reproducible from a single base seed, while staying
random by default so it keeps exploring new inputs run-to-run.

- **Base seed resolution** (top of `fuzz.spec.ts`): `FUZZ_SEED` is taken from
  the `QUEREUS_FUZZ_SEED` env var when set (non-numeric is warned + ignored),
  otherwise a fresh random 32-bit value. It is printed once at module load:
  `[fuzz] QUEREUS_FUZZ_SEED=<n> — set this env var to reproduce this run …`.
  Printing matters specifically because a **Mocha timeout kills the test before
  fast-check can report its own seed** — so the startup line is the only record.

- **Every `fc.assert` is seeded** (`seed: FUZZ_SEED`, 21 call sites) → the
  property inputs (schema, row counts, sample counts, limits) are reproducible.

- **Every `fc.sample` is seeded** (10 call sites) → the SQL strings and seed
  rows drawn *inside* each property body are reproducible too. This is essential:
  seeding only `fc.assert` would reproduce the schema but still draw random SQL,
  so the offending query would not reappear on replay.

- **Seed data varied per table** (`setupSchema`, `createPairedDatabases` now pass
  `FUZZ_SEED + tableIndex`) so two same-shaped tables in one schema don't get
  byte-identical data (which would weaken the cross-table Algebraic/Optimizer
  tests). The paired optimizer DBs still receive identical data as required.

No production/source code changed — this is test-file + docs only.

## Design decision & the tradeoff to scrutinize

Two reproducibility approaches were viable in fast-check 4.x:

1. **`fc.gen()`** — generate inside the predicate from the property's own seeded
   stream. Fully reproducible *and* gives fresh values every property run.
   Cost: threading a `gen` param through ~4 helpers and ~21 property bodies
   (~50 edits).
2. **Constant base seed on every `fc.sample`** (chosen) — ~13 edits, far smaller
   blast radius on a file that is itself a safety net.

**Accepted tradeoff of the chosen approach:** because each `fc.sample` uses the
same constant `FUZZ_SEED`, two property runs that happen to draw the *same
schema shape within a single process* will sample the *same* SQL/data — i.e.
reduced within-run input diversity (some runs duplicate). This is compensated by
the default base seed being **random per run**, so across runs the full space is
still explored cumulatively. The reviewer should confirm this tradeoff is
acceptable; if maximal within-run diversity is later wanted, `fc.gen()` is the
upgrade path (documented here so it isn't rediscovered).

## How to validate (use cases)

- **Reproducibility (the core deliverable):**
  `QUEREUS_FUZZ_SEED=42 node packages/quereus/test-runner.mjs --grep Fuzzing`
  twice → identical generated SQL/behavior. (Proven during implement with a
  standalone harness mirroring the exact wiring: same seed → byte-identical query
  stream; different seed → different stream.)
- **Default-random + printed:** run with no env var → a fresh
  `[fuzz] QUEREUS_FUZZ_SEED=<n>` line each run; that `<n>` replays it.
- **Bad input:** `QUEREUS_FUZZ_SEED=abc …` → warning + random fallback, still
  passes.
- **Replaying a real timeout (the intended workflow):** when CI logs a timeout,
  grep the `[fuzz]` line from that run, re-run with that seed set, and the same
  SQL is regenerated — at which point a real hang can be bisected, or a clean
  pass confirms it was environmental.

## Things for the reviewer to check / known gaps

- **The original flake is NOT proven fixed — it is made *diagnosable*.** This
  ticket does not eliminate a hang (none was ever found); it makes any future
  occurrence replayable. The 120s describe-level timeout is unchanged
  (intentionally — direction 1 only).
- **Cross-test seed reuse:** all `fc.assert` calls share `FUZZ_SEED`, so tests
  beginning with `arbSchemaInfo` see the same schema sequence *within one run*.
  Harmless (each test runs different query types), but worth a glance — confirm
  it isn't masking coverage you'd expect to differ across tests.
- **Tripwire parked (NOT a ticket):** queries still run without a per-query time
  budget, so a genuine hang only surfaces as the opaque 120s timeout. Recorded as
  a `NOTE:` code comment at the Phase-3 harness in `fuzz.spec.ts` (just above
  `execAndDrain`): *if* a real hang ever shows up, wrap the execs in an
  `AbortSignal` (`db.exec`/`db.eval` accept an `options.signal`, verified in
  `src/core/database.ts`) timed above the slowest legitimate query (~20ms) so it
  fails fast and names the SQL. This is direction 2 from the original ticket,
  deliberately deferred.

## Validation run (this implement stage)

- `yarn typecheck:test` (all test files) — clean (exit 0)
- `yarn eslint 'test/fuzz.spec.ts'` — clean (exit 0)
- `node test-runner.mjs --grep "Fuzzing|Algebraic Identities|Optimizer Equivalence"`
  — **21 passing** with `QUEREUS_FUZZ_SEED=12345`, again with `=42`, and once
  with the default random seed.
- End-to-end reproducibility proven with a throwaway harness replicating the
  spec's seed wiring (same seed → identical stream; different seed → different).
- **Not run:** the full `node packages/quereus/test-runner.mjs` suite (~8 min,
  `min` reporter does not stream → idle-timeout risk). Change is test-file-scoped
  and all test files type-check; flag for a CI/manual full pass.
