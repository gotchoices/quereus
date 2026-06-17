description: Reviewed and accepted the engine change that lets external-row ingestion report a commit-time assertion violation back to the caller instead of aborting the batch, so trusted inbound data and its derived effects still commit.
prereq:
files:
  - packages/quereus/src/core/database-assertions.ts
  - packages/quereus/src/core/database-transaction.ts
  - packages/quereus/src/core/database-external-changes.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/database-internal.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/external-row-change-ingestion.spec.ts
  - docs/materialized-views.md
difficulty: hard
----

# Complete: ingestion-seam report mode for commit-time global assertions

## What landed

A **report mode** for the external-row ingestion seam
(`Database.ingestExternalRowChanges`): when `assertionFailureMode: 'report'`
is set and the seam owns the implicit commit (capture on), a commit-time
global-assertion violation is **collected and returned** to the caller
(`IngestExternalChangesResult.assertionViolations`) instead of throwing — so the
trusted inbound data and its derived effects (MV backing deltas, change-capture /
watch entries) still commit. The default (`'throw'`) is unchanged: every existing
DML-commit and seam-throw path behaves exactly as before.

Consumed by `3.1-sync-seam-assertion-violation-event` in `packages/quereus-sync`.

See the implement commit `dcd38faa` for the full change set and rationale.

## Review findings

### What was checked

- **Read the implement diff (`dcd38faa`) with fresh eyes** — all six source
  files, the docs delta, and the new test block — before the handoff summary.
- **Default-unchanged invariant.** In throw mode `raiseViolation` throws the same
  `buildViolationError` (CONSTRAINT) as the old direct `throw`; the new
  try/finally in `runGlobalAssertions` restores `violationSink = null` (already
  null on the ordinary path), and the added `return` after `raiseViolation` in
  `executeResidualPerTuple` is unreachable when raiseViolation throws. Behavior is
  byte-for-byte. The only place a sink is ever passed is `commitTransaction`'s
  `runGlobalAssertions(assertionSink ?? undefined)`, and `pendingCommitAssertionSink`
  is set only by the seam — so every ordinary DML commit still passes `undefined`
  → throw mode. ✓
- **Collect-all semantics.** Verified `DeltaExecutor.runAll` / `runOne`
  (`runtime/delta-executor.ts`): in report mode `apply` no longer throws, so the
  walk visits every impacted subscription and gathers all violations. ✓
- **No double-collection between the no-dependency direct loop and the kernel
  walk.** No-dependency assertions (`baseTablesInPlan.size === 0`) have empty
  `dependencies`, so `runOne`'s quick-skip returns before dispatching them — they
  run *only* in the direct loop, never twice. ✓ (covered by the new
  `CHECK (1=0)` test.)
- **Sink lifecycle / re-entrancy.** `commitTransaction` read-and-clears
  `pendingCommitAssertionSink` before running assertions, and the seam clears it in
  a `finally`; `AssertionEvaluator.violationSink` is restored to null in a
  `finally`. A non-assertion commit failure (connection error, deferred row
  constraint) therefore leaves no stale sink — the next commit is never silently in
  collect mode. `executeViolationOnce` uses `_iterateRowsRaw()` (no nested
  commit), so no re-entrancy into `runGlobalAssertions`. ✓ (the explicit-transaction
  test exercises the "sink never consumed" path.)
- **FK-cascade ordering.** Cascade DML runs inside the batch savepoint loop, before
  the sink is installed (the sink wraps only the final `_commitTransaction()`), so a
  cascade never observes the sink. ✓
- **Source-compatibility of the `void`→object return widening.** The only
  production caller, `packages/quereus-sync/src/sync/store-adapter.ts:223`, ignores
  the return value. `DatabaseInternal` interface return type updated and
  type-checked by lint. ✓
- **Docs.** `docs/materialized-views.md` Facets / Trust-boundary / Transaction &
  visibility sections accurately describe report mode, the honored-only-for-the-
  seam-owned-implicit-commit scope, and the detect-and-notify rationale. The
  `#facets-...` anchor resolves to the actual heading. ✓
- **Gates.** `yarn workspace @quereus/quereus run lint` — clean (eslint + test
  tsc). `yarn workspace @quereus/quereus test` — **6342 passing, 9 pending, 0
  failing.**

### Findings

- **Minor — per-tuple residual `samples` path untested (left as documented gap, no
  fix).** When an assertion dispatches via `executeResidualPerTuple` (a row/group
  binding rather than the global `not exists (...)` shape), report mode collects a
  single violation (`samples = [bindingKeyTuple]`) on the first violating tuple and
  returns — a faithful mirror of throw mode, which also surfaced only the first.
  The new tests all use global-binding assertions, so the residual `samples` shape
  is not directly exercised. Every assertion in the entire test corpus uses the
  global `not exists` shape; constructing a row/group-binding assertion to exercise
  the residual path requires deep delta-binding analysis and risks a rabbit hole
  for a **diagnostic-only** value that faithfully mirrors throw mode. Judged not
  worth fixing inline. Filed nothing — if the dependent host-event work ever needs
  the residual `samples` contract nailed down, add a row-binding assertion test
  then.
- **Minor — doc says "one entry per violated assertion"; technically a
  multi-relation per-tuple assertion could yield more (no action).** In `apply`,
  each violated per-relation residual and a global re-evaluation can each push an
  entry for the *same* assertion, so a multi-binding assertion violated on several
  relations could appear more than once. Harmless for diagnostic data, not
  exercised by any realistic assertion shape, and the doc statement is an accurate
  simplification for the common (single-binding) case. No change.
- **No correctness, resource-cleanup, type-safety, or default-path-regression
  findings.** The sink is transient instance state cleared on every exit path; no
  array aliasing (each `samples` is freshly allocated per violation); no `any`
  introduced; no eaten exceptions.

### Out-of-scope / deliberate (carried forward from implement, confirmed acceptable)

- **Deferred row constraints still throw in report mode.** They run after the
  collected-assertion pass in `commitTransaction` and a violation rolls everything
  back (discarding the collected list). They arise only from opt-in FK-cascade DML,
  not the assertion path — correctly out of scope per the plan.
- **No `quereus-store` run.** Validated against the default memory vtab only. The
  change is in core transaction/assertion plumbing, not storage; store-specific
  divergence is unlikely but unproven — defer to CI / a release pass per the
  agent-runnable-time guidance.

## End
