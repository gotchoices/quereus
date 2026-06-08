description: Cross-platform test harness to verify core engine works in browser environments
files:
  - packages/quereus/test/cross-platform/browser.spec.ts
  - packages/quereus/test/cross-platform/env-compat.spec.ts
----

## What was built

Two test suites in `test/cross-platform/` verifying browser/edge/RN environment compatibility.

### Environment Compatibility Audit (`env-compat.spec.ts`)
Static analysis scanning all `.ts` source files for:
- `node:` prefix imports (22 modules)
- Bare Node.js built-in module imports (22 modules)
- `require()` calls
- Unguarded `process.*` access
- `Buffer` usage

Known exception: `runtime/scheduler.ts` uses `process.hrtime.bigint()` in optional metrics path.

### Browser Environment Smoke Test (`browser.spec.ts`)
Stubs Node.js globals (`process`, `Buffer`, `__dirname`, `__filename`) to `undefined`, then exercises: DB creation, table creation, insert, select, update, delete, aggregation, joins, subqueries. Globals restored in `afterEach` via `try/finally`.

## Review findings and changes

- **Fixed**: `url` was in `FORBIDDEN_NODE_PREFIXED` but missing from `BARE_NODE_MODULES` — added for consistency.
- **Added** `perf_hooks`, `string_decoder`, `querystring` to both module lists for broader coverage.
- **DRY**: Extracted `collectRows()` helper in `browser.spec.ts` to eliminate 7x repeated row-collection boilerplate.
- **Verified**: Global-stubbing correctly makes `typeof process === 'undefined'` — matches real browser behavior.
- **Verified**: All test data is deterministic (explicit `order by`, hardcoded values).
- **Verified**: `afterEach` uses `try/finally` for safe global restoration.

## Test results

- 14 tests, all passing
- Full suite: 277 passing, 1 pre-existing failure (unrelated `08.1-semi-anti-join.sqllogic`)
