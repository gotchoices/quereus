description: The golden-plan regression harness (`packages/quereus/test/plan/golden-plans.spec.ts`) provides ZERO coverage. Its per-case comparison `it()`s are registered inside a Mocha `before()` hook, so Mocha never schedules them — only the informational `should have test cases` test runs. Compounding this, no `.logical.json` / `.physical.json` golden fixtures are committed (only the `.sql` inputs), so even if the dynamic tests ran they would throw "Missing golden files". The corpus is dead: it cannot catch plan-shape or serialization churn. This was surfaced during review of `view-mutation-map-serialization`, whose risk-mitigation premise ("regenerate goldens, confirm no churn") rests on this non-functional mechanism, and whose follow-up `view-mutation-physical-lineage` ticket is expected to rely on golden coverage of `PhysicalProperties`.
prereq:
files: packages/quereus/test/plan/golden-plans.spec.ts (the `before()`-registered dynamic `createTest`/`it` at lines ~230-235; `getPlans` at ~115; `findTestCases` at ~60; `UPDATE_PLANS` writer), packages/quereus/test/plan/basic/simple-select.sql, packages/quereus/test/plan/aggregates/group-by.sql, packages/quereus/test/plan/joins/simple-join.sql (the 3 .sql inputs with NO committed golden JSON), packages/quereus/src/planner/debug.ts (serializePlanTree → processValue — the serializer the golden path actually exercises; renders a Map value as `[COMPLEX_OBJECT]`)

# Golden-plan harness runs no comparisons

## Problem

`describe('Golden Plan Tests', ...)` in `golden-plans.spec.ts` builds its real
assertions like this:

```js
before(async () => { testCases = await findTestCases(); });   // async discovery
// ...
before(function() {                                            // (!!) registers tests in a hook
  for (const testCase of testCases) createTest(testCase);      // createTest calls it(...)
});
it('should have test cases', () => { /* always passes */ });
```

Mocha computes a suite's test list when the `describe` body runs, **before** any
`before` hook fires. `it()` calls made inside a `before` hook are attached to the
suite object but are never scheduled, so the `should match golden plan for <name>`
tests **do not execute**. The plan-test run confirms this empirically: under
"Golden Plan Tests" only `Found 3 golden plan test cases` + `✔ should have test
cases` appear — no per-case lines.

Independently, `git ls-files packages/quereus/test/plan/` shows only `.sql`
inputs are committed; there are no `.logical.json` / `.physical.json` golden
fixtures. So even if the dynamic tests ran, `readFileIfExists` would return
`undefined` and `createTest` would throw "Missing golden files for <name>. Run
with UPDATE_PLANS=true".

Net effect: the golden corpus is a no-op. Plan-shape / serialization regressions
in the EXPLAIN-style serialized tree are not caught by this suite. (The other
`test/plan/*.spec.ts` files — aggregate strategy, constant folding, pushdown,
etc. — are real and do run; this ticket is only about the JSON golden corpus.)

## Why it matters now

This was found reviewing `view-mutation-map-serialization`. That ticket's stated
safety check was "regenerate goldens and confirm no churn," and its handoff
claimed "3 golden fixtures byte-identical, zero churn." Both are vacuous given the
above — nothing is compared. The shipped serializer change is nonetheless correct
(verified by its own unit spec + a clean full-suite run), but the golden evidence
cited for it does not exist. The follow-up `view-mutation-physical-lineage` ticket
intends to expose `Map`-valued `PhysicalProperties` (`updateLineage`,
attribute→default) and verify it via plan/golden output — it needs a working
golden harness, or it will silently have no regression net.

## Expected behavior

- The per-`.sql` golden comparison tests must actually run under `yarn test` /
  `test:plans`.
- Golden JSON fixtures must be committed and compared, with `UPDATE_PLANS=true`
  regenerating them.
- A missing or mismatched golden must fail the suite (not silently pass).

## Notes / landmines for the implementer

- **Dynamic test generation in Mocha must be synchronous at definition time.**
  Options: make `findTestCases` synchronous (the `.sql` discovery is plain fs —
  `fs.readdirSync`) and call `createTest` directly in the `describe` body; or use
  Mocha `--delay` + `run()`; or top-level-await the discovery before `describe`.
  Do NOT keep generating `it()`s from inside `before`.
- **Decide which serializer the golden corpus should reflect.** Today `getPlans`
  uses `serializePlanTree` (`planner/debug.ts`), whose `processValue` renders a
  `Map` as the literal string `[COMPLEX_OBJECT]` and AST nodes as SQL strings —
  this is a DIFFERENT serializer from the `safeJsonStringify(node.physical)` path
  used by `EXPLAIN` / `query_plan()` (which now renders Maps as a `$map` summary,
  see `view-mutation-map-serialization`). If the golden corpus is meant to guard
  the physical-properties surface that view-mutation will expose, it likely needs
  to serialize via the EXPLAIN/`query_plan` path (or `processValue` needs Map
  handling) — otherwise a future `Map` physical field shows up as
  `[COMPLEX_OBJECT]` rather than its real content. Pin this down before
  regenerating fixtures.
- `normalizePlan` already strips non-deterministic node ids; confirm it also
  neutralizes any other unstable fields before committing fixtures.
- Once fixed, regenerate with `UPDATE_PLANS=true node test-runner.mjs` (or the
  `test:plans` script) and commit the JSON so the diff is reviewable.
