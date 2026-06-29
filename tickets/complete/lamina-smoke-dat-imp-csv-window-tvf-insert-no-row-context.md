---
description: Reviewed and completed the fix that stops "No row context found" crashes when a table-valued function yields rows narrower than its declared column schema (e.g. a CSV import narrower than its fixed import shape).
files:
  - packages/quereus/src/runtime/emit/table-valued-function.ts
  - packages/quereus/src/func/registration.ts
  - packages/quereus/test/tvf-row-padding.spec.ts
---

# Pad TVF rows to declared column width — review complete

## What was done (implement stage)

Added a `normalizeRow` helper in `emitTableValuedFunctionCall`
(`packages/quereus/src/runtime/emit/table-valued-function.ts`) that normalizes every
row a TVF yields to its declared column count (`plan.getAttributes().length`): short
rows padded with `null`, over-wide rows truncated, exact-width rows passed through
zero-alloc. Applied in both the `runIntegrated` and `run` yield loops. Regression
spec `tvf-row-padding.spec.ts` covers a plain SELECT (NULL padding) and the
`INSERT…SELECT … row_number() over` crash shape from the ticket.

## Review findings

### Scope anomaly (MAJOR — filed as a new ticket)

The implement commit (`d4167102`) bundles an **entirely unrelated second feature**:
cooperative `AbortSignal` cancellation of `Database.exec`/`eval` (`errors.ts`,
`common/types.ts`, `database.ts`, `statement.ts`, `scan.ts`, `runtime/types.ts`,
`index.ts`, plus a 146-line `exec-eval-abort-signal.spec.ts`). It is not mentioned in
the implement handoff, and no ticket in the tree tracks it — it appears to be
concurrent in-flight work the runner swept into this commit. Per the "never sanitize
the working tree" rule it was **not** reverted or deeply audited here. Filed
`backlog/exec-eval-abort-signal-feature-review.md` so the orphaned feature gets a
dedicated review (or is closed as a duplicate if already tracked).

### Mis-diagnosed "pre-existing" failure (resolved upstream)

The implementer's `tickets/.pre-existing-error.md` claimed the `fork-contract.spec.ts`
`TS1360` lint break was pre-existing. It was **not** — it was caused by this commit's
own addition of `signal` to `RuntimeContext` (the fork-contract `satisfies` clause
forces a policy for every field). A separate triage commit (`309feeb7`) correctly
fixed it (added `signal: 'shared-frozen'` to `EXPECTED_FORK_POLICY` and forked the
signal in `parallel-driver.ts`). Confirmed: `yarn lint` now exits 0. No action needed
beyond noting the misattribution (captured in the backlog ticket above).

### TVF fix correctness — checked

- **Both yield paths covered.** `run` and `runIntegrated` are the only two row-yield
  loops in the emitter; normalization is applied to both. Verified by reading the
  whole file — no other `slot.set`/yield sites.
- **Truncation-to-zero sharp edge (fixed inline).** `declaredColumnCount` derives
  purely from `returnType.columns` (`TableFunctionCallNode.getAttributes`). A TVF
  registered with **no `returnType`** (e.g. the built-in `split_string`) has
  `declaredColumnCount === 0`, so the original helper's `row.slice(0, 0)` truncated
  **every** row to empty. Empirically this was not an *observable* SQL regression —
  a columnless TVF has no attributes, so projection was already empty and row count
  is preserved (`select * from split_string('a,b,c', ',')` → `[{},{},{}]` before and
  after). But truncating real payload to zero is a latent foot-gun, so I added a
  guard: a TVF declaring no columns now opts out of normalization (passes rows
  through unchanged). **Minor fix applied** in `table-valued-function.ts`.
- **DRY / altitude.** `plan.getAttributes()` is called twice (descriptor + length);
  left as-is — `getAttributes()` is `Cached`, so the second call is O(1), not worth
  a local. Helper is a small single-purpose function. No concerns.
- **Type safety.** `new Array(n).fill(null)` spreads into a `Row` (`null` is a valid
  `SqlValue`). Lint/type-check clean.
- **Performance.** Allocates a new array only on short/wide rows; exact-width common
  case is zero-alloc. Acceptable; noted in handoff, no change warranted.

### Docs — updated

No central doc described the TVF row-width contract. Added the normalization contract
(pad-with-NULL / truncate, columnless opt-out) to the `createTableValuedFunction`
JSDoc in `registration.ts`, per the implement ticket's doc TODO.

### Tests

- New regression spec `tvf-row-padding.spec.ts`: 2 passing. Covers the happy path
  (NULL padding read-back) and the exact `INSERT…SELECT row_number()` crash shape.
  Edge cases (over-wide truncation, columnless opt-out) are exercised indirectly via
  the existing `split_string`/`json_each` suites and the empirical check above; the
  positive contract is locked. Adequate for the fix's surface.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`): **exit 0**.
- Full suite `node test-runner.mjs`: **6405 passing, 9 pending, 0 failures**.
- Targeted tvf/window/json/abort/fork-contract run: **89 passing, 4 pending, 0
  failures**.

### Empty categories

- **No new fix/plan tickets for the TVF fix itself** — the only defect found (zero
  truncation) was minor and fixed inline. The lone major finding is the unrelated
  bundled feature, handled via the backlog ticket above.
- **No security/resource-cleanup concerns** — the slot is `close()`d in a `finally`
  in both paths (unchanged by the fix); normalization adds no new resource.

## Net changes applied during review

- `table-valued-function.ts`: guard `normalizeRow` against `declaredColumnCount === 0`.
- `registration.ts`: document the row-width normalization contract.
- New `backlog/exec-eval-abort-signal-feature-review.md` for the bundled feature.
