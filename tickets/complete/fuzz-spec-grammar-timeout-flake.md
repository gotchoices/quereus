description: The grammar SQL fuzz tests now print a seed at startup and can be replayed exactly by setting that seed in an environment variable, so a future random timeout is reproducible instead of a dead end.
prereq:
files:
  - packages/quereus/test/fuzz.spec.ts   # seed machinery + seeded fc.assert/fc.sample + AbortSignal tripwire NOTE
  - docs/architecture.md                 # testing section: "Grammar-Based SQL Fuzzing" bullet documenting QUEREUS_FUZZ_SEED
---

## What shipped

`fuzz.spec.ts` is now fully reproducible from a single base seed, while staying
random by default. `QUEREUS_FUZZ_SEED` (env var) pins the base seed; otherwise a
fresh random 32-bit value is used. The seed is printed once at module load
(`[fuzz] QUEREUS_FUZZ_SEED=<n> …`), which is the only record when a Mocha timeout
kills the test before fast-check can report its own seed. The seed feeds every
`fc.assert` (21 sites — property inputs) and every `fc.sample` (10 sites — the SQL
strings and seed rows drawn inside property bodies); seed data is varied per table
(`FUZZ_SEED + tableIndex`) so same-shaped tables don't get byte-identical rows,
while the paired optimizer DBs still receive identical data. Test-file + docs only;
no production code changed.

The implement-stage handoff is accurate. See the prior `tickets/review/` body
(now superseded by this file) for the full design rationale and the accepted
within-run-diversity tradeoff vs. the `fc.gen()` upgrade path.

## Review findings

Adversarial pass over commit `39affd74`. Effort: read the full diff fresh,
re-ran all validation, audited scope and the tripwire's truthfulness.

**Correctness / determinism (core deliverable) — checked, no defects.**
- All 21 `fc.assert` call sites and all 10 `fc.sample` call sites carry the seed
  (verified by grep; the 22nd `fc.assert` match is a comment). No unseeded
  generation site remains in the suite's path.
- The only `Math.random()` is the fallback when no env var is set — unreachable
  once a seed is pinned, so a pinned run is fully deterministic. No `Date.now()`/
  `new Date()` in the file. Mocha runs describes in file order and each property
  body iterates sequentially, so the executed-query sequence is deterministic
  given the seed.
- `fc.sample(arb, { numRuns, seed })` and `fc.assert(..., { seed })` are valid
  fast-check 4.8 signatures (typecheck clean; tests iterate the samples correctly,
  so `numRuns` count semantics are preserved).
- The `seedTable` signature change (added `seed` param) is contained — its only
  caller is `setupSchema`; the other `seedTable*` hits in the repo are unrelated
  (`seedTableForeignKeyInds`, store-test helpers, `seedTableName`).
- Seed-resolution edge cases handled: empty/whitespace → random; non-finite
  (`abc`, `Infinity`) → warn + random; fractional → truncated; numeric → used.

**Validation re-run by the reviewer — all green.**
- `eslint test/fuzz.spec.ts` → exit 0.
- `typecheck:test` (all test files) → exit 0.
- `node test-runner.mjs --grep "Fuzzing|Algebraic Identities|Optimizer Equivalence"`
  with `QUEREUS_FUZZ_SEED=42` → 21 passing, twice, deterministically.
- Default (no env var) → fresh `[fuzz] QUEREUS_FUZZ_SEED=<n>` printed each run,
  passes. `QUEREUS_FUZZ_SEED=abc` → warning + random fallback, passes.
- Not run (same deferral as implement, agreed): the full ~8-min suite under the
  non-streaming `min` reporter (idle-timeout risk). Change is test-file-scoped and
  type-checks; flag for a CI/manual full pass. No `.pre-existing-error.md` needed —
  every test the reviewer ran passed.

**Tripwire verified truthful (not a ticket).** The `NOTE:` comment above the
Phase-3 harness in `fuzz.spec.ts` proposes wrapping the execs in an `AbortSignal`
*if* a real hang ever appears. Confirmed actionable, not fictional: `db.exec`,
`db.eval`, and `db.get` accept `options.signal` (`StatementOptions`) and honor it
at row boundaries via `throwIfAborted` (`src/core/database.ts`,
`src/core/statement.ts`). Correctly left as a conditional tripwire — no per-query
budget is wired now (the original ticket's direction 2, deliberately deferred).

**Accepted tradeoffs — confirmed acceptable, no action.**
- Constant `FUZZ_SEED` on every `fc.sample` means two property runs drawing the
  *same schema shape within one process* sample identical SQL/data (reduced
  within-run diversity). Compensated by the random per-run base seed, so the space
  is still explored cumulatively across runs. `fc.gen()` is the documented upgrade
  path if maximal within-run diversity is ever wanted.
- Cross-test seed reuse (same-signature properties see the same schema sequence
  within a run) does not mask coverage: each property still generates many distinct
  schemas across its `numRuns` iterations, and the tests exercise different query
  *types* over those schemas.

**Conditional note (no ticket, no tripwire site warranted).** Other property-based
specs (`property.spec.ts`, `property-planner.spec.ts`,
`emit-roundtrip-property.spec.ts`, `query-rewrite-equivalence.spec.ts`,
`incremental/maintenance-equivalence.spec.ts`, `optimizer/inclusion-dependencies.spec.ts`)
use fast-check without the print-seed/reproducibility wiring. They are out of scope
(only `fuzz.spec.ts` had the timeout flake) and not currently flaky. If one of them
flakes opaquely later, the same seed-and-print pattern is the fix — recorded here
in the index only, deliberately not filed as work.

**Empty categories.** No minor inline fixes were needed — the implementation was
clean as delivered. No major findings → no new fix/plan/backlog tickets. No docs
drift: the `docs/architecture.md` "Grammar-Based SQL Fuzzing" bullet accurately
describes `QUEREUS_FUZZ_SEED`, the print-at-startup behavior, and the replay
command, matching the code.

## Outstanding / honest gaps (carried from implement, still true)

- The original flake is **not proven fixed — it is made diagnosable.** No hang was
  ever reproduced; this work makes any future occurrence replayable. The 120s
  describe-level Mocha timeout is unchanged by design.
- Full-suite (~8 min) pass left to CI/manual due to the non-streaming `min`
  reporter's idle-timeout risk under the agent runner.
