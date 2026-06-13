description: Wire test-file type-checking into the dev gate — fix tsconfig.test.json's vacuous exclude, add a typecheck:test script, and hook it into the lint gate so future signature changes can no longer silently strand test call sites. Final of three prereq-chained tickets; assumes the test program already type-checks clean.
prereq: typecheck-test-fix-schema-planner
files:
  - packages/quereus/tsconfig.json          # base: exclude ["node_modules","dist","test"] is inherited
  - packages/quereus/tsconfig.test.json     # include is a no-op today; needs explicit exclude
  - packages/quereus/tsconfig.eslint.json   # already correct (src+test, exclude node_modules/dist) — reference
  - packages/quereus/package.json           # add typecheck:test; wire into lint
difficulty: easy
----

# Wire test type-checking into the gate

## Background

`tsconfig.test.json` *looks* like it covers tests (`include: ["test/**/*",
"src/**/*"]`) but the base tsconfig's `exclude: ["test"]` is inherited and wins,
so `tsc -p tsconfig.test.json --listFiles` shows **no** spec files and it passes
vacuously. The two prereq tickets fixed all ~136 type errors that this gap had
been hiding; this ticket makes the gap impossible to reopen by giving the
test-file typecheck a real script and wiring it into the lint gate.

**Do not start the fix work here** — by the time this ticket runs, `tsc -p
tsconfig.eslint.json --noEmit` already reports zero errors (the prereqs ensure
it). If it does **not**, the prereq chain is incomplete; stop and report rather
than turning on a gate that is immediately red.

## Design decisions (resolved)

- **Which config the script targets.** Verified empirically: `tsc -p
  tsconfig.test.json --noEmit` (after the exclude fix) and `tsc -p
  tsconfig.eslint.json --noEmit` produce an **identical** 136-error set —
  byte-for-byte, no diff. They differ only in `module`/`moduleResolution`
  (test config: `ES2022`/`node`; eslint config inherits the build's
  `node18`/`node16`), which does not change the diagnostics here.
  **Decision:** fix `tsconfig.test.json` (per the original ticket) so it is no
  longer a vacuous lie — it is the conceptually-named "tests" config and is also
  consumed by ts-node (`TS_NODE_PROJECT`) and Stryker (`tsconfigFile`) — and
  point `typecheck:test` at it. `tsconfig.eslint.json` remains a near-duplicate;
  optionally note (don't require) that it could later `extends
  ./tsconfig.test.json` to dedupe.
- **ts-node / Stryker impact of the exclude change is benign.** ts-node
  transpiles per-file on demand and ignores `include`/`exclude` for resolution.
  Stryker's typescript checker building a Program that now *includes* test files
  is harmless (and more correct): it only type-checks files touched by the
  configured `mutate` subsystem; test files merely become resolvable.
- **Where the gate hooks.** The only package with a lint script is
  `packages/quereus` (`"lint": "eslint ..."`), and the root `check` runs `yarn
  lint`. Append the test typecheck to that package's `lint` script so it runs
  everywhere lint already runs (local `yarn lint`, root `yarn check`). Root
  `check` does not currently invoke `yarn typecheck` at all, so lint is the
  reliable hook.

## Changes

**`packages/quereus/tsconfig.test.json`** — add an explicit exclude that
overrides the inherited `["node_modules","dist","test"]`:

```jsonc
{
  "extends": "./tsconfig.json",
  "compilerOptions": { /* unchanged */ },
  "ts-node": { /* unchanged */ },
  "include": ["test/**/*", "src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

Confirm it now sees the specs: `npx tsc -p tsconfig.test.json --listFiles |
grep -c '/test/'` should be > 0 (currently 0).

**`packages/quereus/package.json` scripts** —

```jsonc
"typecheck:test": "tsc -p tsconfig.test.json --noEmit",
"lint": "eslint 'src/**/*.ts' 'test/**/*.ts' && tsc -p tsconfig.test.json --noEmit",
```

(Keep the existing single-quoted eslint globs — on Windows unquoted globs blow
the command-line length limit.) Equivalent acceptable wiring: keep `lint` as
pure eslint and instead add `yarn typecheck:test` to the root `check` script —
but appending to `lint` is the recommended default because it also covers
local `yarn lint` runs.

## How to verify

```
cd packages/quereus
npx tsc -p tsconfig.test.json --listFiles 2>&1 | grep -c '/test/'   # > 0
yarn typecheck:test                                                  # exits 0
yarn lint                                                            # exits 0 (eslint + test typecheck)
```

Then sanity-check the gate actually bites: temporarily introduce a bogus type
error in a spec (e.g. pass a wrong-arity call), confirm `yarn typecheck:test`
**fails**, then revert it. Do not leave the bogus edit in the tree.

`tsc` runs are ~60–90s — stream with `tee` if you log them; don't silently
redirect.

## Edge cases & interactions

- **Gate must be green on entry.** If `tsc -p tsconfig.eslint.json --noEmit` is
  not already at zero errors when this ticket starts, the prereqs did not fully
  land — do **not** wire the gate (it would block all future lint runs). Report
  the residual errors and stop.
- **`composite`/`noEmit`.** The base sets `composite: true`,
  `noEmitOnError: true`, `declaration: true`, `noEmit: false`. The CLI
  `--noEmit` overrides emit cleanly (already proven — `tsc -p
  tsconfig.eslint.json --noEmit` runs today against the same base). No
  `.tsbuildinfo` should be written for a `--noEmit` run; if one appears, ensure
  it's git-ignored (it already is for `dist`/build artifacts — verify).
- **Windows lint globs.** Must stay single-quoted (`'src/**/*.ts'`) — unquoted
  globs trigger "command line too long". Keep the existing quoting.
- **ts-node runtime unaffected.** After the exclude change, run the suite once
  (`yarn test 2>&1 | tee /tmp/test.log; tail -n 40 /tmp/test.log`) to confirm
  ts-node still resolves and runs tests — the `include`/`exclude` edit must not
  alter test execution.
- **Stryker.** `stryker.config.mjs` points `tsconfigFile` at
  `tsconfig.test.json`. No Stryker run is required for this ticket (mutation runs
  are out-of-band and long), but note in the handoff that its checker Program now
  includes test files (benign).
- **Don't regress the src-only `typecheck`.** Leave the existing `"typecheck":
  "tsc --noEmit"` (src only, used by the root `typecheck` fan-out) intact;
  `typecheck:test` is additive.

## TODO

- [ ] Confirm `tsc -p tsconfig.eslint.json --noEmit` reports **0** errors (prereqs done).
- [ ] Add explicit `exclude` to `tsconfig.test.json`; confirm `--listFiles` now includes specs.
- [ ] Add `typecheck:test` script; append the test typecheck to the package `lint` script.
- [ ] Verify `yarn typecheck:test` and `yarn lint` both exit 0.
- [ ] Smoke-test the gate bites (introduce + revert a bogus spec type error).
- [ ] Run `yarn test` once to confirm ts-node execution is unaffected.
- [ ] Update `docs/` / package README testing section if it documents the lint/typecheck gate.
- [ ] Review handoff: note the Stryker Program change (benign) and the optional
      `tsconfig.eslint.json extends tsconfig.test.json` dedupe follow-up.
