description: Hardening test coverage for compilePredicate's engine-aligned truthiness — operator-nested bare-value paths (NOT, AND/OR) and the bare-BLOB branch of isTruthy. Test-only change to 10.5.1-partial-indexes.sqllogic; § 9 added.
files: packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic, packages/quereus/src/vtab/memory/utils/predicate.ts, packages/quereus/src/util/comparison.ts
----

# rowtime-mv-predicate-truthy-extra-tests (complete)

## What was done

Added `§ 9` to `packages/quereus/test/logic/10.5.1-partial-indexes.sqllogic`,
extending the regression coverage for `compilePredicate`'s engine-aligned
truthiness (`predicateTruthy` → canonical `isTruthy`). `§ 8` pins the top-level
bare-value path; `§ 9` pins the same `isTruthy` delegation reached through the
operator-nested `predicateTruthy` call sites (NOT, AND/OR) plus the blob branch.
Each case is an observable partial-UNIQUE accept/reject:

- **9a** — `where not flag` (compileUnary NOT, `predicate.ts:161-165`)
- **9b** — `where flag and othercol > 0` (compileBinary AND, `predicate.ts:201-210`)
- **9c** — `where flag or othercol > 0` (compileBinary OR, `predicate.ts:211-220`)
- **9d** — `where blobcol` (isTruthy blob branch, `comparison.ts:414`)

**Test-only change — no source edits.**

## Review findings

### Scope checked
Implement-stage diff (`dfd2b11e`) read first, fresh, before the handoff summary.
Verified against source: `predicate.ts` (compilePredicate / predicateTruthy /
compileUnary / compileBinary), `isTruthy` (`comparison.ts:395-416`), and the
existing `§ 8` / `§ 7j` of the fixture. Aspect angles applied: correctness,
coverage completeness, discrimination power (vs. tautology), DRY/style
consistency with the file, both-backend exercise.

### Findings

- **Call-site coverage is complete (verified).** `predicateTruthy` is invoked at
  exactly four logical sites — top-level (`predicate.ts:57`, pinned by `§ 8`),
  NOT (`:163`, 9a), AND left+right (`:204`,`:206`, 9b), OR left+right
  (`:214`,`:216`, 9c) — plus the `isTruthy` `Uint8Array` branch (`:414`, 9d).
  Enumerated via `find_references(predicateTruthy)`; no untested site remains.
  The `IN` path (compileIn) returns boolean/null directly and does not route a
  *bare value* through predicateTruthy, so it is correctly out of scope for this
  truthiness-hardening pass.

- **All four cases genuinely discriminate old-vs-new behavior — not tautological
  (traced).** Under the prior divergent rule (`non-(false|0|0n|'') ⇒ true`):
  9a's `'abc'` rows would fall OUT of scope, so insert #2 would succeed and the
  expected `-- error: UNIQUE` would be missing → test fails. 9b/9c's `'abc'` rows
  and 9d's blobs would fall IN scope, so the second (un-annotated, expected-to-
  succeed) insert would raise an *unexpected* UNIQUE error → test fails. Each
  case therefore fails loudly on a truthiness regression. Confirmed the SQL-logic
  harness treats an unexpected error during an un-annotated statement as a
  failure (same mechanism `§ 8` relies on).

- **Logic verified line-by-line.** `isTruthy`: `'abc'`→`Number('abc')`=NaN→false;
  `'1'`→1→true; `Uint8Array`→false. Three-valued AND/OR short-circuiting in
  `compileBinary` matches the test data (9b holds `othercol > 0` TRUE so bare
  `flag` decides; 9c holds it FALSE so bare `flag` decides). Final selects carry
  no flag-filtering WHERE, so no planner-side FD discharge is involved — the
  assertions isolate runtime index membership, as intended.

- **Both backends genuinely exercised.** Memory (`manager.ts` →
  `checkUniqueByScanning`) and store (`store-table.ts` / `store-module.ts`) both
  route partial-UNIQUE enforcement through `compilePredicate`. Tests run green in
  both (memory: 1 passing; store: 1 passing).

- **9d one-directional limitation — acceptable, not a defect.** 9d only exercises
  the falsy/allow direction because no truthy blob value exists under `isTruthy`.
  The combination of `§ 8` (proves bare-column partial-UNIQUE *rejects* in-scope
  dups) and 9a–9c (prove operator-predicate enforcement works) establishes that
  9d's "allow both" is meaningful rather than a no-op index passing for the wrong
  reason. The regression guard (unexpected UNIQUE error if blobs became truthy) is
  a valid loud signal. No stronger probe is achievable; left as-is.

- **Docs:** no doc changes required. The truthiness change itself landed and was
  documented under `rowtime-mv-minor-cleanups`; `predicate.ts`'s header comment on
  `predicateTruthy` already describes the engine-aligned rule. This ticket adds
  only fixture coverage.

### Disposition
- **Minor:** none requiring an inline fix — the addition is correct, complete
  relative to the implementation, and discriminating.
- **Major:** none; no new tickets filed.

### Verification run
```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/logic.spec.ts" --grep "10.5.1-partial"        # memory: 1 passing
QUEREUS_TEST_STORE=true  (same command)                                # store:  1 passing
```
Lint not run: change is a single `.sqllogic` fixture with no TypeScript touched,
and the `eslint` script only covers TS/JS source — running it would re-lint
unchanged code. `yarn build`/full suite likewise skipped for the same reason
(no source change to compile or broadly regress).
