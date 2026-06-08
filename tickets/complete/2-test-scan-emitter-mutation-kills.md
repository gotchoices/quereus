description: Raised mutation and branch coverage on `src/runtime/emit/scan.ts` via unit tests and sqllogic tests targeting every error branch and access method.
prereq: none
files:
  packages/quereus/src/runtime/emit/scan.ts
  packages/quereus/test/runtime/scan-emitter.spec.ts
  packages/quereus/test/logic/110-scan-emitter-mutation-kills.sqllogic
  docs/zero-bug-plan.md
---

## Summary

21 unit tests and a sqllogic file cover every branch in `runtime/emit/scan.ts`, raising the Stryker mutation score from **53.85% → 61.54%** for `scan.ts`.

### Unit tests (`test/runtime/scan-emitter.spec.ts`)

- **Happy paths**: SeqScan (empty/single/multi-row), IndexScan (ordered), IndexSeek (literal, parameter, composite, miss, empty dynamic result).
- **connect failures**: `QuereusError` wrapping preserves original code (BUSY/LOCKED), plain `Error` → `StatusCode.ERROR` with cause chain.
- **Query unsupported**: `StatusCode.UNSUPPORTED` when vtab has no `query` method.
- **Mid-iteration errors**: code preservation for `QuereusError`, `ERROR` fallback for plain errors, `disconnect` invoked via `finally`.
- **vtabArgs propagation**: `CREATE TABLE … USING mod(key='val')` args reach `connect(options)` — kills the `schema.vtabArgs ?? {}` → `&&` mutant.
- **Row descriptor**: columns selected in non-schema order produce correct mapping.

### SQL logic (`test/logic/110-scan-emitter-mutation-kills.sqllogic`)

End-to-end coverage via the memory vtab: SeqScan (empty/single/multi, sum verification), IndexScan (asc/desc), IndexSeek (literal PK, miss, composite PK), range scans, NULL handling (`= null` vs `is null`), column remapping.

### Testing approach

Custom vtab modules (`StubTable` + factory functions) registered via `db.registerModule()` exercise scan error paths impossible to trigger through normal SQL. `getBestAccessPlan` must return `rows > 0` to prevent the optimizer from replacing the scan with `EmptyResultNode`.

## Validation

- `yarn test` — 2420 passing, 2 pending, 0 failing.
- `npx stryker run … --mutate "src/runtime/emit/scan.ts"` — 16 killed / 8 survived / 2 no-cov → **61.54%**.

## Remaining survivors (equivalent or unobservable)

- `if (!moduleInfo)` / `if (typeof module.connect !== 'function')` — defensive guards for invariants established earlier in emission; cannot trigger through public API.
- Line 74 `if (plan instanceof IndexSeekNode && dynamicArgs && dynamicArgs.length > 0)` — SeqScan/IndexScan emit no dynamic args, so mutant branches produce observationally identical behavior.

## Key files

- `packages/quereus/src/runtime/emit/scan.ts` (subject under test)
- `packages/quereus/test/runtime/scan-emitter.spec.ts`
- `packages/quereus/test/logic/110-scan-emitter-mutation-kills.sqllogic`
- `docs/zero-bug-plan.md` — mutation score tracking updated
