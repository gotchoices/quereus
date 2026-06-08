description: Added c8 code coverage reporting to the quereus test suite
files: packages/quereus/package.json, .gitignore
----

## What was built

Added `c8` code coverage instrumentation to `packages/quereus`. Uses V8's built-in coverage (no source transforms), works with existing Mocha + ts-node/esm setup.

### Changes

- `c8@^11.0.0` added as devDependency
- `test:coverage` script added to `packages/quereus/package.json`:
  ```
  c8 --exclude 'test/**' --exclude 'bench/**' --exclude 'dist/**' --reporter text --reporter html node test-runner.mjs
  ```
- `coverage/` added to root `.gitignore`

### Review fix

Added `--exclude 'dist/**'` to prevent duplicate coverage reporting on compiled JS files alongside source-mapped TS files. This corrected the overall statement coverage from a misleading ~58% to the accurate ~84.5%.

## Testing

- `yarn test` — 1161 passing, 2 pending (no regression)
- `yarn test:coverage` — same test results + text summary in terminal + HTML report in `coverage/`
- Test files (`test/**`), bench files (`bench/**`), and compiled output (`dist/**`) excluded from metrics
- HTML report generated at `packages/quereus/coverage/index.html`

## Usage

```bash
cd packages/quereus
yarn test:coverage       # terminal summary + HTML report in coverage/
```
