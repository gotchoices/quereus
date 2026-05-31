description: Make the golden-plan regression harness actually run. Today the per-`.sql` comparison `it()`s are registered inside a Mocha `before()` hook (never scheduled), and no golden JSON is committed, so the corpus catches nothing. Fix test registration to be synchronous, switch the golden serializer to a Map-aware path that reflects the physical-properties surface (the EXPLAIN / `query_plan` `$map` rendering, not `serializePlanTree`'s `[COMPLEX_OBJECT]`), regenerate + commit fixtures, and prove a mismatch fails.
prereq:
files: packages/quereus/test/plan/golden-plans.spec.ts (registration bug at lines 230-235; `findTestCases` ~60; `getPlans` ~115; `normalizePlan` ~31; `generateGoldenFiles` ~249), packages/quereus/test/plan/README.md (documents the logical/physical two-file convention), packages/quereus/src/planner/debug.ts (`serializePlanTree`/`processValue` — current serializer, renders Map as `[COMPLEX_OBJECT]`), packages/quereus/src/util/serialization.ts (`safeJsonStringify`/`jsonStringify` — renders Map as `{$map, size}`, MAP_SUMMARY_ENTRY_CAP), packages/quereus/src/func/builtins/explain.ts (`query_plan` TVF — the canonical per-node serialization: nodeType/op/detail/properties/physical), packages/quereus/src/core/database.ts (`getPlan` ~1404, returns optimized plan), packages/quereus/src/core/statement.ts (`compile` ~127, returns optimized plan), packages/quereus/test/plan/basic/simple-select.sql, packages/quereus/test/plan/aggregates/group-by.sql, packages/quereus/test/plan/joins/simple-join.sql

# Make the golden-plan harness run real comparisons

## Background / confirmed diagnosis

Reproduced by running the spec in isolation:

```
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/plan/golden-plans.spec.ts"
# →  Golden Plan Tests
#      Found 3 golden plan test cases
#      ✔ should have test cases
#    1 passing
```

Only the informational test runs. The `should match golden plan for <name>`
tests are created by `createTest()` calls made **inside a `before()` hook**
(`golden-plans.spec.ts:231-235`). Mocha fixes a suite's test list when the
`describe` callback returns — before any `before` hook fires — so `it()`s added
from a hook are attached to the suite but never scheduled. Net: zero comparisons.

`git ls-files packages/quereus/test/plan/` confirms only `.sql` inputs are
committed (no `.logical.json` / `.physical.json`), so even with registration
fixed, `createTest` would throw "Missing golden files…" on first run until
fixtures are generated.

Two more facts established during fix research, which drive the design below:

- **`compile()` and `getPlan()` both return the OPTIMIZED plan.**
  `Statement.compile()` (`statement.ts:146-147`) does `_buildPlan(...)` then
  `optimizer.optimize(...)`; `Database.getPlan()` (`database.ts:~1422`) does the
  same. The current `getPlans()` serializes `stmt.compile()` for *both* the
  `logical` and `physical` outputs — so today's two golden files would be
  byte-identical. There is no real logical-vs-physical distinction captured.
- **Serializer divergence.** The golden path uses `serializePlanTree`
  (`debug.ts`), whose `processValue` returns the literal string `[COMPLEX_OBJECT]`
  for any non-plain object — including `Map`. The EXPLAIN / `query_plan` path
  uses `safeJsonStringify(node.physical)` (`serialization.ts`), which renders a
  `Map` as `{ $map: [[k,v],…], size }` (bounded by `MAP_SUMMARY_ENTRY_CAP = 64`).
  The follow-up `view-mutation-physical-lineage` ticket intends to expose
  `Map`-valued `PhysicalProperties` and verify them via golden output. If the
  golden corpus keeps using `serializePlanTree`, those Maps serialize as
  `[COMPLEX_OBJECT]` and the regression net is blind to their contents.

## Required behavior (acceptance)

- The per-`.sql` golden comparison tests **execute** under `yarn test` and
  `yarn test:plans` (visible `should match golden plan for <name>` lines, one per
  `.sql`).
- Golden JSON fixtures are **committed** and compared on a normal run; a missing
  or mismatched golden **fails** the suite (not a silent pass).
- `UPDATE_PLANS=true` regenerates the fixtures deterministically (same input →
  byte-identical output across repeated runs).
- The serialized golden reflects the **physical-properties surface** with
  Map-aware rendering (`$map`), so a future `Map`-valued physical field shows its
  real content, not `[COMPLEX_OBJECT]`.

## Design decisions (pinned)

**1. Synchronous test registration.** Replace the async `findTestCases()` +
`before`-hook registration with synchronous discovery (`fs.readdirSync` recursion
over `test/plan/`, collecting `.sql` files) called directly in the `describe`
body, then `for (const tc of testCases) createTest(tc);` at definition time. The
per-case `it` body may stay `async` (reading the SQL, planning, comparing). Do
**not** register `it()` from a hook. Drop the now-redundant `should have test
cases` fallback, or keep a single guard `it` that asserts `testCases.length > 0`
so an empty corpus fails loudly rather than passing vacuously.

**2. Map-aware serializer reflecting the EXPLAIN surface.** Do **not** keep
`serializePlanTree` for the golden corpus. Introduce a small dedicated tree
serializer (put it in `test/plan/_helpers.ts` so plan-shape specs can share it,
or inline in the golden spec) that walks `node.getChildren()` and, per node,
emits a plain object:

```
{
  nodeType: node.nodeType,
  op: node.nodeType.replace(/Node$/, '').toUpperCase(),
  detail: node.toString(),
  logical: node.getLogicalAttributes(),          // may be {} 
  physical: node.physical ?? null,               // PhysicalProperties or null
  children: [ ...recurse... ]
}
```

Serialize the whole tree with `safeJsonStringify(tree, 2)` (from
`util/serialization.ts`) so any `Map` inside `physical`/`logical` renders as the
bounded `{$map, size}` summary — matching what `query_plan()` and EXPLAIN now
emit. This keeps the golden corpus aligned with the user-facing introspection
surface and with `view-mutation-physical-lineage`'s needs.

Rationale for not patching `processValue` instead: `serializePlanTree` also bakes
in `estimatedCost` / `getTotalCost()` / `estimatedRows` / node `id` / `getType()`
— cost numbers and ids are unstable across optimizer/statistics changes and would
make goldens churn on unrelated edits. The dedicated serializer above
deliberately **omits** cost and id fields, capturing only shape + logical +
physical. (If you find a strong reason to reuse `serializePlanTree`, you must at
minimum: add `Map` handling to `processValue`, and strip cost/rows/id in
`normalizePlan` — but the dedicated serializer is cleaner and is the recommended
path.)

**3. Collapse to a single optimized-plan golden per case.** Because `compile()`
already returns the optimized plan, the `logical`/`physical` split is currently
vacuous (identical bytes). Collapse to one golden file per `.sql`, named
`{test-name}.plan.json`, serialized from the optimized plan
(`db.getPlan(sql)` or `stmt.compile()` — `getPlan` is cleaner since it doesn't
require `prepare`/`finalize`). Update `PlanTestCase`, `findTestCases`,
`createTest`, `generateGoldenFiles`, and `README.md` accordingly.

(No backward-compat concern per AGENTS.md. If the team later wants a genuine
logical-vs-physical pair, the *logical* side must be serialized from the
pre-optimization `_buildPlan` output, which is not exposed on the public
Statement/Database surface today and would need a new accessor — out of scope
here; note the deferral in the README if you want to leave a breadcrumb.)

**4. Determinism / normalization.** With cost and id omitted, `normalizePlan`
becomes largely unnecessary, but keep a thin normalization step that (a) sorts
object keys for stable diffs and (b) defensively strips any `id` / `timestamp`
keys. Generate fixtures **twice** and confirm byte-identical output before
committing (guards against Map iteration-order or other nondeterminism). The
`$map` entries are insertion-ordered and `size` is exact, so they are stable as
long as the underlying physical Maps are built deterministically — verify this
for the 3 sample queries.

**5. Test environment is already correct.** `getPlans()` creates `users(id,name,
age,dept_id)` and `departments(id,name,budget)` memory tables; all three sample
queries (`simple-select`, `group-by`, `simple-join`) reference only those, so no
schema-setup change is needed.

## Verification

- `node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js "packages/quereus/test/plan/golden-plans.spec.ts"`
  shows 3 `should match golden plan for …` passing lines.
- Hand-edit one committed golden (e.g. flip a value) → suite **fails** with a
  readable diff; revert.
- `yarn workspace @quereus/quereus run typecheck` and the package lint pass.
- Full `yarn test` (memory vtab) stays green. (`test:store` not required — this is
  a planner/serialization test, no store code path.)

## TODO

- [ ] Rewrite `findTestCases` to be synchronous (`fs.readdirSync` recursion) and
      register `createTest()` calls directly in the `describe` body; remove the
      `before`-hook registration. Keep one guard `it` that fails if zero cases.
- [ ] Add the dedicated Map-aware tree serializer (recommend `test/plan/_helpers.ts`)
      emitting `{nodeType, op, detail, logical, physical, children}` via
      `safeJsonStringify`; omit cost/rows/id.
- [ ] Switch `getPlans` to produce a single optimized-plan serialization (via
      `db.getPlan(sql)`); update `PlanTestCase`, `createTest`, `writePlan`, and
      `generateGoldenFiles` to a single `{name}.plan.json` artifact.
- [ ] Trim/adjust `normalizePlan` (sort keys; strip `id`/`timestamp`); confirm no
      other unstable fields leak.
- [ ] Generate fixtures with `UPDATE_PLANS=true` (run the spec twice; confirm
      byte-identical) and **commit** the 3 `*.plan.json` files.
- [ ] Confirm a deliberately-broken golden fails the suite; revert the edit.
- [ ] Update `test/plan/README.md` to describe the single-file `*.plan.json`
      convention and the `$map`/physical-properties surface.
- [ ] Run `yarn test`, typecheck, and lint; ensure green.
