description: Wire test-file type-checking into the dev gate — completed and reviewed
files:
  - packages/quereus/tsconfig.test.json
  - packages/quereus/package.json
  - AGENTS.md
---

# Wire test type-checking into the gate (complete)

Final of three prereq-chained tickets. The prior two fixed the ~136 type errors that
`tsconfig.test.json`'s vacuous `exclude` had been hiding; this ticket made the gap
impossible to reopen by giving the test-file typecheck a real script and wiring it
into the lint gate.

## What landed

- **`packages/quereus/tsconfig.test.json`** — added explicit `"exclude": ["node_modules", "dist"]`
  to override the base config's inherited `"test"` exclusion. The config now actually sees the
  test program (248 spec files) instead of passing vacuously on zero files.
- **`packages/quereus/package.json`** — added `"typecheck:test": "tsc -p tsconfig.test.json --noEmit"`
  and appended `&& tsc -p tsconfig.test.json --noEmit` to the `lint` script, so the gate runs
  everywhere `yarn lint` runs (local, and the root `check` → `yarn lint` fan-out).
- **`AGENTS.md`** (review-stage fix) — updated the Build & Test note so future agents know
  `yarn lint` now also type-checks the test files (and is therefore slower than eslint alone).

## Review findings

**Diff reviewed:** implement commit `ce28e5ab`, read fresh before the handoff summary.
Read every touched/related file: `tsconfig.test.json`, base `tsconfig.json`,
`tsconfig.eslint.json`, root + package `package.json`, plus the `tsconfig.test.json`
consumers (`eslint.config.mjs`, `register.mjs`, `register-cjs-compat.mjs`, `stryker.config.mjs`).

**Correctness / behavior — verified independently (not trusting the handoff):**
- Gate green on entry: `tsc -p tsconfig.test.json --noEmit --listFiles` → exit 0, **248** test
  files in the program (was 0). Confirms the exclude fix is real and the test program type-checks clean.
- Gate bites: injected a bogus `const _bogus: number = "nope"` spec → `tsc` exited **2** with
  `TS2322`; file removed, working tree clean afterward. The gate genuinely fails on test-file type errors.
- Script wiring: root `check` → `yarn lint` → `@quereus/quereus run lint` (eslint + tsc). The `&&`
  short-circuits correctly, so a red typecheck fails `lint` and therefore `check`.

**Dead-code / DRY:** `tsconfig.eslint.json` is **not** removable — it is referenced by
`eslint.config.mjs` (`parserOptions.project`). The handoff's "dedupe via extends" note is
correctly framed as optional follow-up, not a defect. No new ticket warranted.

**Interactions (ts-node / Stryker):** `register.mjs` and `register-cjs-compat.mjs` set
`TS_NODE_PROJECT` to `tsconfig.test.json`; ts-node transpiles per file and is unaffected by the
`include`/`exclude` edit (implementer's `yarn test` → 6077 passing corroborates). Stryker's
`tsconfigFile` now resolves test files into its checker Program — benign, as noted.

**Documentation:** searched all `*.md` for gate/lint/typecheck references. The only stale spot
was `AGENTS.md:68` (described `lint` as eslint-only) — **fixed inline** this pass. No `docs/`
file documents the lint/typecheck gate, so nothing else to update.

**Type safety / error handling / resource cleanup / performance:** N/A as code dimensions — this
is a build-config + npm-script change with no runtime logic. The only runtime cost is the added
`tsc` pass on `yarn lint` (~60–90s), which is the intended tradeoff and now documented.

**New tickets filed:** none — no major findings. Minor doc drift was fixed inline.

**Not run:** Stryker mutation pass (out-of-band, long; change to its Program is type-resolution
only). Full `yarn lint` eslint pass was not re-run end-to-end (implementer reported exit 0; the
tsc half — the only part this ticket changed — was independently re-verified above).
