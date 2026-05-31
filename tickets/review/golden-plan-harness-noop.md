---
description: Golden-plan regression harness now runs real comparisons. Test registration is synchronous (was dead code inside a `before()` hook), the serializer reflects the physical-properties surface with Map-aware `$map` rendering, 3 optimized-plan goldens are committed, and a mismatch fails the suite. Review the test-only global-id-counter reset and the estimate/physical fields baked into the goldens.
prereq:
files:
  - packages/quereus/test/plan/golden-plans.spec.ts
  - packages/quereus/test/plan/_helpers.ts
  - packages/quereus/test/plan/README.md
  - packages/quereus/test/plan/basic/simple-select.plan.json
  - packages/quereus/test/plan/aggregates/group-by.plan.json
  - packages/quereus/test/plan/joins/simple-join.plan.json
---

## What landed

The golden-plan corpus was a **no-op**: the per-`.sql` comparison `it()`s were
registered from inside a Mocha `before()` hook, which fires *after* the suite's
test list is already fixed — so they attached to the suite but never ran. Only an
informational `should have test cases` test executed. No golden JSON was
committed either, so even a registration fix would have thrown "Missing golden
files". The corpus caught nothing.

This change makes it run for real:

1. **Synchronous registration** (`golden-plans.spec.ts`). `findTestCases()` is now
   a synchronous `readdirSync` recursion called directly in the `describe` body;
   `it()`s are created at definition time in a `for` loop. The `before` hook is
   gone. A single guard `it('discovers at least one golden plan test case')` fails
   loudly if the corpus is empty rather than passing vacuously.

2. **Map-aware serializer reflecting the EXPLAIN surface** (`_helpers.ts`,
   `serializePlanForGolden`). Walks `node.getChildren()` and emits per node:
   `{ nodeType, op, detail, logical, physical, children }`, serialized with
   `util/serialization.ts`'s `safeJsonStringify`. This replaces the old
   `serializePlanTree` path, whose `processValue` renders any `Map` as the opaque
   string `[COMPLEX_OBJECT]`. With `safeJsonStringify`, a `Map` renders as the
   bounded `{ $map: [[k,v],…], size }` summary — the same surface `query_plan()`
   and EXPLAIN now emit — so a future `Map`-valued physical field shows real
   content. `detail` is `node.toString()` with the unstable global id token
   stripped; cost/`getTotalCost()`/node `id` are **not** added as top-level fields
   (they churn on unrelated optimizer/stats edits). Keys are sorted and any
   residual `id`/`timestamp` keys dropped for diff stability.

3. **Single optimized-plan artifact** (`{name}.plan.json`). `Database.getPlan()`
   and `Statement.compile()` both return the **optimized** plan, so the old
   `.logical.json` / `.physical.json` split serialized the same tree twice
   (byte-identical). Collapsed to one `.plan.json` per `.sql`. A genuine
   logical-vs-physical pair would need a pre-`optimize()` `_buildPlan` accessor
   that isn't exposed today — deferred, breadcrumb left in the README.

4. **Committed goldens**: `basic/simple-select` (10 nodes), `joins/simple-join`
   (15 nodes), `aggregates/group-by` (19 nodes), regenerated via
   `UPDATE_PLANS=true`.

5. **README** updated to the single-file convention and the `$map`/physical
   surface.

## The part most worth reviewing — determinism (`withDeterministicPlanIds`)

`PlanNode` allocates `id` and attribute ids from **process-global static counters**
(`private static nextId` / `nextAttributeId`) that are **never reset per-database**.
A probe (two fresh DBs, counters *not* reset between them — simulating golden-plans
running mid-suite) proved these ids leak into the snapshot and are **not
offset-invariant**: `attrId`/`attributeId`, join condition `left`/`right`, and
`detail` strings like `INNER HASH JOIN on [7=8]` all shifted by the counter
offset. A golden generated in isolation would therefore never match under full
`yarn test`, where ~thousands of ids are allocated by earlier specs first.

The fix: `withDeterministicPlanIds()` resets the counters to 0 around each
snapshot and restores the high-water mark in `finally`. **It reaches into the
`private static` fields via a `PlanNode as unknown as {...}` cast** (test-only; no
production change). Reviewer should scrutinize this coupling:

- It assumes Mocha runs serially, so no other code allocates ids during the
  awaited `db.exec`/`getPlan` gaps. True today; would break under in-process
  parallel specs.
- It mutates a production global from test code. The full quereus suite (4092
  passing, 0 failing) ran with this active, which is positive evidence it does
  **not** cause id collisions for other specs (the `finally` restore is doing its
  job) — but it is still a global-state hack and an alternative (a sanctioned
  test-only reset hook on `PlanNode`) is worth a thought.

## Known gaps / things to scrutinize (this is a floor, not a finish)

- **Estimate fields ARE baked into the goldens.** The serializer omits *top-level*
  cost/rows, but it captures `getLogicalAttributes()` and `node.physical`
  **wholesale**, and those bags contain `estimatedRows` (×11 across goldens),
  `estimatedCost`/`filterInfo.estimatedCost` (×5), and `estimates.rows` (×5).
  They are stable here only because the test tables are **empty** (rows = 0) and
  the index heuristic uses fixed constants (`estimatedCost 1000.01, estimatedRows
  1000`). They couple the corpus to cost-model defaults — a real churn vector. The
  ticket scoped `normalizeSnapshot` to strip only `id`/`timestamp`; the reviewer
  should decide whether to also strip estimate fields or accept them as part of
  the physical-surface net.
- **Thick snapshots.** The full physical surface (`fds`, `monotonicOn`, `ordering`,
  `accessCapabilities`, `concurrencySafe`, …) is captured, so *any* optimizer or
  physical-property change churns all 3 goldens. That is the intended regression
  net, but it is the opposite tradeoff from the assertion-based plan-shape specs —
  worth a conscious sign-off.
- **The `$map` branch is structurally present but NOT exercised by any committed
  golden** (`grep '$map'` → 0 hits). None of the 3 sample queries has a Map-valued
  physical/logical field, so the Map-aware rendering is verified only by the
  `safeJsonStringify` code path, not by a real fixture. The follow-up
  `view-mutation-physical-lineage` ticket is expected to introduce the first
  Map-valued field; until then the "Map-aware" claim is unproven end-to-end here.
- **`logical` is not a true logical plan** — it's `getLogicalAttributes()` on the
  *optimized* node. The logical/physical distinction the old filenames implied does
  not exist in the committed artifact (documented in README).

## Validation (all run this session, foreground/streamed)

- **Harness runs:** isolated `golden-plans.spec.ts` → `4 passing` (guard + 3
  cases), exit 0.
- **Mismatch fails:** hand-corrupted `simple-select.plan.json`
  (`main.users`→`main.usersZ`) → `3 passing, 1 failing` with `AssertionError`,
  exit 1; golden restored byte-for-byte (verified by the subsequent full-suite
  pass).
- **Offset-invariance in practice:** full `yarn workspace @quereus/quereus test`
  (memory vtab) → **4092 passing, 0 failing**. golden-plans matches the runner
  glob (`test/**/*.spec.ts`) and runs after the logic suite has allocated many
  ids, so the green run is the real offset-invariance proof. (Default `min`
  reporter prints only the summary + failures, so per-test lines aren't in the
  log; the isolated run above shows the 3 named cases.)
- **Determinism of generation:** regenerated twice → SHA-identical (per prior run
  log).
- **`yarn workspace @quereus/quereus run typecheck`** → 0 errors.
- **`yarn workspace @quereus/quereus run lint`** → clean, exit 0.
- `test:store` not run — planner/serialization-only, no store code path (per
  ticket).

### Reviewer repro

```bash
# runs (expect 4 passing):
node --import ./packages/quereus/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus/test/plan/golden-plans.spec.ts"
# regenerate goldens if an intentional plan change lands:
UPDATE_PLANS=true node --import ./packages/quereus/register.mjs \
  node_modules/mocha/bin/mocha.js "packages/quereus/test/plan/golden-plans.spec.ts"
```

## Notes

- A scratch determinism probe (`_helpers`-importing `_probe.ts`) was used to
  diagnose the id leak and has been **deleted** — not committed. The reasoning it
  validated is preserved in the `withDeterministicPlanIds` doc comment.
- Unrelated untracked file `tickets/implement/temporal-filter-raw-literal-comparison-test.md`
  was present during this run and left untouched — not part of this ticket.
