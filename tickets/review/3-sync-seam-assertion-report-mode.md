description: Review the engine change that lets external-row ingestion report a commit-time assertion violation back to the caller instead of aborting the batch, so trusted inbound data and its derived effects still commit.
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

# Review: ingestion-seam report mode for commit-time global assertions

## What landed

The engine half of `3-sync-seam-throw-retry-mv-divergence`: a **report mode** for
the external-row ingestion seam (`Database.ingestExternalRowChanges`) where a
commit-time global-assertion violation is **collected and returned** to the caller
instead of throwing — so the trusted inbound data and its derived effects
(materialized-view backing deltas, change-capture/watch entries) still commit. The
default (`'throw'`) is **unchanged** — every existing DML-commit and seam-throw path
behaves byte-for-byte as before.

This is consumed by the dependent ticket `3.1-sync-seam-assertion-violation-event`
(in `packages/quereus-sync`), which sets `assertionFailureMode: 'report'` and
surfaces the returned violations to the host.

### Change set

- **`database-assertions.ts`** — new exported `AssertionViolation` interface; a
  transient `private violationSink: AssertionViolation[] | null` on
  `AssertionEvaluator`; new private `raiseViolation(name, samples)` that pushes to
  the sink (report) or throws (default). `executeViolationOnce` and
  `executeResidualPerTuple` now route through `raiseViolation`.
  `runGlobalAssertions(sink?)` installs the sink in a try/finally (restores null),
  so the no-dependency direct loop and the kernel walk **collect all** violations
  in report mode instead of aborting on the first.
- **`database-transaction.ts`** — `TransactionManagerContext.runGlobalAssertions`
  widened to accept `sink?`; a `pendingCommitAssertionSink` field +
  `setPendingCommitAssertionSink(sink)` setter; `commitTransaction()`
  **read-and-clears** the pending sink and passes it to `runGlobalAssertions`.
- **`database.ts`** — `runGlobalAssertions(sink?)` forwards the arg; new `@internal`
  `_setPendingCommitAssertionSink(sink)`; `ingestExternalRowChanges` return type
  `Promise<void>` → `Promise<IngestExternalChangesResult>`.
- **`database-internal.ts`** — `assertionFailureMode?: 'throw' | 'report'` option;
  new `IngestExternalChangesResult { assertionViolations }`; interface return type
  updated.
- **`database-external-changes.ts`** — `ingestExternalRowChangeBatch` returns the
  result; installs the sink (try/finally clears it) only around the **seam-owned
  implicit commit** when `assertionFailureMode === 'report' && captureChanges`;
  returns `{ assertionViolations: [] }` everywhere else.
- **`index.ts`** — exports `AssertionViolation`, `IngestExternalChangesResult`.
- **docs/materialized-views.md** — §Facets (`assertionFailureMode`), §Trust
  boundary (detect-and-notify rationale), §Transaction & visibility (report mode
  honored only for the seam-owned implicit transaction).

## Validation done

- `yarn workspace @quereus/quereus run build` — clean.
- `yarn workspace @quereus/quereus test` — **6342 passing, 9 pending, 0 failing**.
- `yarn workspace @quereus/quereus run lint` — clean (eslint + `tsc -p
  tsconfig.test.json`, so the spec call sites type-check too).
- Verified the only downstream caller (`packages/quereus-sync/.../store-adapter.ts:223`)
  ignores the return value, so the `void`→object widening is source-compatible.

### New tests (in `external-row-change-ingestion.spec.ts`, `… commit-time global assertions` block)

- **report mode collects, commits, watch fires** — resolves with
  `assertionViolations` (assertion name + non-empty `samples`),
  `getAutocommit() === true`, and the row's watch **did** fire (direct contrast to
  the throw-mode test where it did not).
- **report mode + covering MV converges** — MV row present and equal to the base
  row (derived effects persisted); no refresh.
- **report mode collects ALL violated assertions** — two assertions, two entries.
- **no-dependency assertion** (`CHECK (1=0)`) collected in report mode (direct
  loop, not just the kernel walk).
- **report mode inside an explicit caller transaction does not collect** — returns
  empty; the caller's own `commit` still throws (throw mode).
- **`assertionFailureMode: 'throw'` (explicit)** behaves identically to the default
  (kept the original default-mode test too).

## Use cases / what to probe in review

- **Default unchanged.** Confirm the throw path is genuinely untouched: a violation
  with no/`'throw'` mode still rolls back the implicit commit, resets to autocommit,
  fires no watch, discards batched events. (Covered, but it's the load-bearing
  invariant.)
- **Collect-all semantics.** The kernel walk (`DeltaExecutor.runAll`) only visits
  every subscription because `apply` no longer throws in collect mode — verify no
  path still throws mid-walk in report mode and silently drops later assertions.
- **Sink lifecycle / re-entrancy.** The pending sink is read-and-cleared by
  `commitTransaction` AND cleared in the seam's `finally`. Check that a
  **non-assertion** commit failure in report mode (connection commit error, or a
  deferred row constraint — which still throws, out of scope) still throws, rolls
  back, and leaves no stale sink so the next commit isn't silently in collect mode.
  FK-cascade DML runs **inside the batch savepoint before** the sink is installed
  (the sink wraps only the final `_commitTransaction()`), so a cascade should never
  observe the sink — worth confirming.

## Known gaps / deliberate choices to scrutinize

- **Per-tuple residual collects ONE sample, then returns.** When an assertion
  dispatches via `executeResidualPerTuple`, report mode pushes a single violation
  (`samples = [bindingKeyTuple]`) on the first violating tuple and returns from the
  method — a faithful mirror of the throw (which also surfaced only the first). So a
  per-tuple-dispatched assertion violated by N tuples yields **one** entry, not N.
  This is intentional (fidelity to throw mode); flagging in case review wants
  per-tuple accumulation up to `MAX_VIOLATION_SAMPLES` instead. The new tests use a
  global-binding assertion (`not exists (select 1 from t where v < 0)`), so the
  per-tuple sample shape is **not** directly exercised — a reviewer wanting to nail
  down `samples` contents for the residual path should add a row/group-binding
  assertion test.
- **`samples` shape is path-dependent.** Full-violation query → query output rows;
  per-tuple residual → the single binding-key tuple. Documented on
  `AssertionViolation` and in the docs, but the dependent host-event ticket should
  set expectations accordingly (diagnostic only).
- **No `quereus-store` run.** Validated against the default memory vtab only
  (`yarn test`), not `yarn test:store`. The change is in core transaction/assertion
  plumbing, not storage, so store-specific divergence is unlikely — but not proven.
- **Deferred row constraints still throw** in report mode (out of scope per the
  plan; they arise only from opt-in FK-cascade DML, not the assertion path).
