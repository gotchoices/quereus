description: Nothing type-checks packages/quereus test files — tsconfig.test.json inherits `exclude: ["test"]` from the base tsconfig, silently emptying its `"include": ["test/**/*", "src/**/*"]`; ts-node runs transpileOnly and eslint's type-aware parse does not surface TS diagnostics. ~136 pre-existing TS errors currently hide in test/ (e.g. stale call signatures, schema-shape drift). Surfaced when a required-parameter addition to predicateImpliesGuard left 36 stale 7-arg test call sites undetected by build, lint, and the full test run.
files:
  - packages/quereus/tsconfig.json        # base: exclude ["test"] is inherited
  - packages/quereus/tsconfig.test.json   # include is a no-op today (verify with --listFiles)
  - packages/quereus/tsconfig.eslint.json # already overrides exclude — `tsc -p tsconfig.eslint.json --noEmit` reproduces the ~136 errors
  - packages/quereus/package.json         # typecheck script targets src only
----

# Test files have zero TypeScript diagnostics coverage

## Current state

- `yarn typecheck` (`tsc --noEmit`) covers `src/` only.
- `tsconfig.test.json` *looks* like it covers tests, but the inherited
  `exclude: ["test"]` wins — `tsc -p tsconfig.test.json --listFiles` shows no
  spec files. It currently passes vacuously.
- Mocha runs through ts-node with `transpileOnly: true` (no checking).
- ESLint parses tests with type information (tsconfig.eslint.json) but lint
  rules don't report raw TS compile errors like wrong argument counts.

Net effect: a test file can drift arbitrarily far from the source's types and
every CI signal stays green as long as the drifted code paths happen not to
throw at runtime. Concrete instance: `predicateImpliesGuard` gained a required
8th parameter; all 36 unit-test call sites kept passing 7 args and kept
passing at runtime only because each case short-circuited before invoking the
`undefined` callback. (Those 36 were fixed in the
`collation-blind-equality-fact-extraction` review pass; ~100 other
pre-existing errors remain.)

## Expected behavior

- A `typecheck:test` (or widened `typecheck`) script that actually includes
  `test/**` (fix the exclude inheritance in tsconfig.test.json with an
  explicit `"exclude": ["node_modules", "dist"]`).
- The ~136 existing errors triaged: most look like mechanical drift
  (missing required properties on schema literals, fast-check generic
  constraints, enum-typed literals in negative tests). Negative tests that
  *deliberately* pass invalid values should use targeted `// @ts-expect-error`
  so the intent is explicit and checked.
- Wire it into whatever gate runs lint today so future signature changes
  cannot silently strand test call sites.
