description: "Grammar-Based SQL Fuzzing" (fuzz.spec.ts) intermittently hits the per-test 120s Mocha timeout during full-suite runs; not reproducible in isolation — likely environmental contention, but a rare pathological-query hang cannot be fully excluded
difficulty: medium
prereq: none
files:
  packages/quereus/test/fuzz.spec.ts
  packages/quereus/test-runner.mjs
---

## Failing test

```
node packages/quereus/test-runner.mjs
```

```
1) Grammar-Based SQL Fuzzing
   Error: Timeout of 120000ms exceeded. For async tests and hooks, ensure "done()"
   is called; if returning a Promise, ensure it resolves.
   (packages/quereus/test/fuzz.spec.ts)
```

The three `describe` blocks in `fuzz.spec.ts` each set `this.timeout(120_000)`.
The failure is a wall-clock timeout on one individual `it`, not an assertion
failure. The fuzzer uses **no fixed seed** (`fc.assert(..., { numRuns: 100–200 })`),
so each run executes different random SQL and the failure is non-deterministic.

## Reproduction attempts (could NOT reproduce at HEAD)

- `--grep "Grammar-Based SQL Fuzzing"` in isolation: **9/9 passing in ~5s**, 5×.
- Full `fuzz.spec.ts` (Grammar + Algebraic + Optimizer Equivalence, 21 tests):
  **10 sequential runs all pass in 7–8s**; slowest individual test ~1.2s.
- **6 instances run in parallel** (to simulate the loaded "agent box"): all pass;
  full run stretches to ~17s and the slowest single test reaches only ~2.5s.
  Contention roughly doubles timings — it does not approach a 100× blow-up to 120s.
- Targeted hunt: a standalone driver replicating the spec's generators ran
  **2,500 random schemas × 6 `statement` queries = ~15,000 generated SQL strings**,
  each executed with a 4s `AbortSignal` budget and timed. **Slowest single query: 20ms.
  Zero queries flagged** (threshold 1.5s). The `statement` arbitrary subsumes
  `select` / `dml` / `cte` / `windowSelect` / `recursiveCte`, so the query space
  the failing tests draw from is well covered.

## What was ruled out

- **No deterministic pathological / hanging query** was found in ~15k generated
  queries (slowest 20ms ≈ 1/6000 of the 120s budget) nor across ~22 full-suite runs.
- **Pure contention is an insufficient explanation on its own**: even 6× parallel
  load only ~2× the timings, leaving a ~48× margin under the 120s budget. The
  report's box ran the full ~8-min `packages/quereus` suite alongside a background
  ticket runner; a transient stall (GC thrash / memory pressure / swap) on that box
  is the most plausible trigger, consistent with the contention note already in
  `test-runner.mjs` (lines 86–91) about fast-check tests being starved under load.

## Why no fix was applied

No code defect was identified, so there is no confident, tightly-scoped fix. The
generated query space is bounded (≤3 tables, ≤15 rows, expr depth ≤5, recursive
CTE depth ≤20 + `limit 50`) and executes in tens of milliseconds.

## Suggested directions (pick one)

1. **Seed the fuzzer** for reproducibility — pass a fixed `seed` to `fc.assert`
   (e.g. via env var, default-random in CI but printed on failure) so a future
   timeout is replayable and a real hang can be bisected.
2. **Per-query safety budget** — wrap each generated query in the harness with an
   `AbortSignal` (the API now supports `{ signal }`) timed well under the test
   budget, so a genuine engine hang fails fast and *names the offending SQL*
   instead of producing an opaque 120s timeout. (Tune the budget above the slowest
   legitimate query — observed ≤20ms — to avoid false positives under contention.)
3. **Accept as environmental** — if (1)/(2) confirm no hang over a large seeded
   sweep, treat this as load-induced flakiness and rely on the existing 120s budget,
   optionally documenting it as a known intermittent.
