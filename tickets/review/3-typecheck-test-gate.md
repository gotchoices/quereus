description: Review the test type-checking gate wired by implement ticket 3-typecheck-test-gate
prereq: typecheck-test-fix-schema-planner
files:
  - packages/quereus/tsconfig.test.json
  - packages/quereus/package.json
difficulty: easy
----

# Review: Wire test type-checking into the gate

## What was done

Three small changes landed:

**`packages/quereus/tsconfig.test.json`** — added explicit `"exclude": ["node_modules", "dist"]` so the base tsconfig's inherited `"test"` exclusion is overridden. Before this fix the config was vacuous (0 test files seen by `--listFiles`); now it picks up all 248 spec files.

**`packages/quereus/package.json`** — added `"typecheck:test": "tsc -p tsconfig.test.json --noEmit"` and appended `&& tsc -p tsconfig.test.json --noEmit` to the existing `lint` script so the gate runs everywhere `yarn lint` runs (locally and via the root `yarn check`).

## Verification performed

- `tsc -p tsconfig.eslint.json --noEmit` → exit 0 (prereq gate confirmed clean)
- `--listFiles` count via `tsconfig.test.json` went from 0 to 248 test files
- `yarn typecheck:test` → exit 0
- `yarn lint` → exit 0 (eslint + typecheck:test)
- Smoke-test: injected `const _bogus: number = "this is a type error"` into `test/basic.spec.ts`; `yarn typecheck:test` exited 2 with TS2322; reverted cleanly
- `yarn test` → 6077 passing, 9 pending, 0 failing — ts-node unaffected by the exclude change

## Known gaps / follow-up notes

- **`tsconfig.eslint.json` dedupe.** It remains a near-duplicate of `tsconfig.test.json` (both cover src+test, both exclude node_modules/dist). Could later `"extends": "./tsconfig.test.json"` to deduplicate. Not blocking.
- **Stryker Program change (benign).** `stryker.config.mjs` points `tsconfigFile` at `tsconfig.test.json`. Its TypeScript checker Program now includes test files (previously it didn't, due to the vacuous exclude). Mutation runs are long/out-of-band and were not run for this ticket; the change is expected to be harmless since Stryker only type-checks files in its configured `mutate` subsystem.
- **`composite`/`.tsbuildinfo`.** Base config sets `composite: true`. The `--noEmit` CLI flag overrides emit cleanly for `typecheck:test`; no `.tsbuildinfo` was written during testing (confirmed by absence of new build artifacts).
