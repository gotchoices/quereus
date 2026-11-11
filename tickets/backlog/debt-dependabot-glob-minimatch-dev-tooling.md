description: Two open Dependabot alerts (glob, minimatch) are in development and build tooling only, not in any published package, and neither can be cleared by refreshing the lockfile because the patched versions are a major version above what the tools ask for.
files:
  - yarn.lock
  - package.json   # root `resolutions`, if overriding
severity: edge-case
likelihood: unusual
tradeoffs: The vulnerable code runs only on developer and CI machines over our own files; forcing a major version under eslint, mocha or stryker through `resolutions` risks breaking the tool for a low-risk advisory, while waiting for upstream releases costs nothing.
----

# Dependabot: glob and minimatch in dev tooling

Checked 2026-11-10, after v5.4.0.

| Alert | Package | Advisory | Vulnerable | Patched | Resolved here | Pulled in by |
|---|---|---|---|---|---|---|
| #217 (medium) | minimatch | GHSA-g3hv-75wg-m249, DoS via globparts amplification | >= 7.0.0, < 11.0.1 | 11.0.1 | 10.2.6 (also 3.1.5, outside the range) | `@typescript-eslint/typescript-estree` (^10.2.2), `@stryker-mutator/core` (~10.2.4) |
| #215 (medium) | glob | GHSA-3g3m-2fjr-6pw4, AbortSignal cancellation bypass | >= 9.0.0, <= 14.0.1 | 14.0.2 | 10.5.0, 13.0.6 | `mocha` (^10.4.5), `rimraf` (^13.0.3), `test-exclude` (^13.0.6), `cacache` via node-gyp (^13.0.0), `@joshwooding/vite-plugin-react-docgen-typescript` (^13.0.1) |

None of the 14 published packages depends on either, directly or through a runtime dependency (`yarn why`); every path is linting, testing, mutation testing, cleaning, native builds or Storybook. Dependabot labels them "runtime" because it reads `yarn.lock`, which does not record dev scope.

## Options

1. **Wait for upstream** (recommended): re-run `yarn up -R glob minimatch` and recheck the alerts after the next eslint / typescript-eslint / mocha / rimraf / stryker releases that widen their ranges. Dismiss the alerts as "vulnerable code not actually used" in the meantime if the noise matters.
2. **Force with root `resolutions`** (`"minimatch@^10": "^11.0.1"`, `"glob@^10 || ^13": "^14.0.2"`), then run `yarn check` and `yarn test:store`. Both are semver-major jumps, so verify lint, mocha's file discovery, `yarn clean` (rimraf), coverage and Storybook builds still work.
3. **Bump the direct dev dependencies** (mocha, rimraf, typescript-eslint, stryker) to newer majors if they already require the patched versions.
