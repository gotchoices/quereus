description: Teach the engine's external-row ingestion seam a mode where a commit-time global-assertion violation is collected and returned to the caller instead of aborting the batch, so the trusted inbound data and its derived effects (materialized-view updates, change notifications) still land.
prereq:
files:
  - packages/quereus/src/core/database-assertions.ts          # collect-not-throw + AssertionViolation type
  - packages/quereus/src/core/database-transaction.ts         # commitTransaction passes the pending assertion sink
  - packages/quereus/src/core/database-external-changes.ts    # assertionFailureMode option + sink install + return violations
  - packages/quereus/src/core/database.ts                     # ingestExternalRowChanges return type; sink setter; runGlobalAssertions(sink)
  - packages/quereus/src/core/database-internal.ts            # IngestExternalChangesOptions + return-type interface
  - packages/quereus/src/index.ts                             # export AssertionViolation / IngestExternalChangesResult
  - packages/quereus/test/external-row-change-ingestion.spec.ts  # report-mode engine tests
  - docs/materialized-views.md                                # § Facets / § Trust boundary / § Transaction contract
difficulty: hard
----

# Ingestion-seam report mode for commit-time global assertions

## Why

`Database.ingestExternalRowChanges` (the external-row ingestion seam) replays
the post-write pipeline for rows a caller already applied directly to module
storage. Its `captureChanges` facet feeds **commit-time global assertions**, and
on a violation the implicit-transaction commit **throws** — which rolls back the
batch's *derived* effects (MV backing deltas, capture/watch entries) while the
externally-applied **storage rows stay applied** (trust-the-origin: the caller
owns storage). For the sync store adapter this throw is the head of a chain that
ends in silent MV/watch divergence for the violating row (see the originating
plan ticket `3-sync-seam-throw-retry-mv-divergence` and
`packages/quereus-sync` ticket `sync-seam-assertion-violation-event`, which
consumes this work).

The settled posture (resolved in plan): for the inbound-merge case the data
**must** land (trust-the-origin), so a commit-time assertion can only usefully
**detect-and-notify**, never block. A blocking throw produces an incoherent
half-state (storage has the row; derived projections do not) and, on the sync
retry, never re-drives the derived effects. The engine keeps **evaluating**
assertions over inbound merges (the deliberate, documented reason: a cross-origin
column-LWW merge can produce a global-invariant state no single origin ever saw)
but gains a **report mode** where the violation is returned to the caller and the
batch still commits — derived effects persist, watch dispatches, no divergence.
The caller (the sync adapter, in the dependent ticket) surfaces the violation to
the host.

This ticket is the **engine half**: the report-mode seam + a structured
`AssertionViolation` return. It changes **no default behavior** — throw mode stays
the default and every existing DML-commit and seam-throw path is untouched.

## Design

### `AssertionViolation` (new, exported)

```ts
// database-assertions.ts, re-exported from packages/quereus/src/index.ts
export interface AssertionViolation {
  /** Name of the violated assertion. */
  readonly assertion: string;
  /** Up to MAX_VIOLATION_SAMPLES sample rows from the assertion's violation
   *  query (diagnostic; the assertion SELECT's output shape, not table rows). */
  readonly samples: SqlValue[][];
}
```

### Collect-not-throw in `AssertionEvaluator`

The violation is raised in exactly two places — `executeViolationOnce` and
`executeResidualPerTuple` — both via `buildViolationError`. Add a transient
`private violationSink: AssertionViolation[] | null = null` on the evaluator.
When the sink is set, those two methods **push** `{ assertion, samples }` to the
sink and **return** instead of throwing; when null they throw exactly as today.

`runGlobalAssertions(sink?: AssertionViolation[]): Promise<void>` sets
`this.violationSink = sink ?? null` for the duration (try/finally to restore
null). Because `apply` no longer throws in collect mode, `executor.runAll()`
walks **every** live assertion subscription, so all violations across the batch
are collected, not just the first. The no-dependency-assertion direct loop
(`baseTablesInPlan.size === 0`) collects too.

Key invariant to preserve: collect mode must **gather all** violations (do not
early-return from `runGlobalAssertions` on the first), and each violation's
`samples` is capped at `MAX_VIOLATION_SAMPLES` as today.

### Thread the sink through commit

`TransactionManager.commitTransaction()` calls `this.ctx.runGlobalAssertions()`
before committing connections (`database-transaction.ts`). Add a transient
**pending sink** the seam installs:

- `TransactionManagerContext.runGlobalAssertions(sink?: AssertionViolation[])`
  (interface widened; `Database.runGlobalAssertions` forwards the arg).
- A pending-sink field on the manager + a setter
  (`setPendingCommitAssertionSink(sink: AssertionViolation[] | null)`), surfaced
  on `Database` as an `@internal` method (e.g. `_setPendingCommitAssertionSink`).
- `commitTransaction()` reads the pending sink, passes it to
  `runGlobalAssertions(sink)`, and **clears it** (so the next ordinary commit
  throws). When no sink is set, behavior is byte-for-byte unchanged (throws on
  violation → existing catch rolls back all connections, discards batched
  events).

When a sink IS set and an assertion is violated: `runGlobalAssertions` does not
throw → `runDeferredRowConstraints()` runs → connections commit →
`commitSucceeded = true` → post-commit watchers fire → batched events flush. The
derived effects persist and watch dispatches. (Deferred row constraints still
throw — out of scope; they arise only from opt-in FK-cascade DML, not from the
assertion path.)

### Seam: `assertionFailureMode` option + structured return

```ts
// database-internal.ts
interface IngestExternalChangesOptions {
  maintainMaterializedViews?: boolean;  // default true
  captureChanges?: boolean;             // default true
  applyForeignKeyActions?: boolean;     // default false
  assertionFailureMode?: 'throw' | 'report';  // NEW, default 'throw'
}

interface IngestExternalChangesResult {
  /** Empty in throw mode, when no assertion is violated, or when report mode
   *  was requested but an explicit caller transaction owns the commit. */
  readonly assertionViolations: AssertionViolation[];
}
```

`Database.ingestExternalRowChanges` return type changes `Promise<void>` →
`Promise<IngestExternalChangesResult>`. The only production caller (the store
adapter) currently ignores the return; widening void → object is
source-compatible for callers that ignore it.

In `ingestExternalRowChangeBatch`:

- Report mode is honored **only when the seam owns the commit** — i.e. the
  implicit-transaction branch (`db._isImplicitTransaction()` at commit time) AND
  `captureChanges` is on (assertions don't run at all with capture off). In that
  branch: allocate `const sink: AssertionViolation[] = []`, call
  `db._setPendingCommitAssertionSink(sink)` in a try/finally that clears it
  (`_setPendingCommitAssertionSink(null)`) even if commit throws for another
  reason, then `await db._commitTransaction()`, then return
  `{ assertionViolations: sink }`.
- Throw mode (default) and the explicit-caller-transaction case: no sink;
  assertions evaluate as today (throw at the owning commit). Return
  `{ assertionViolations: [] }`.
- Empty batch / bootstrap-style early returns: `{ assertionViolations: [] }`.

## Edge cases & interactions

- **Default unchanged.** With `assertionFailureMode` omitted/`'throw'`, the
  existing `external-row-change-ingestion.spec.ts` test "a violating inbound
  batch fails the implicit commit; state resets cleanly" must stay green
  (throw → autocommit reset, no watch).
- **Multiple assertions violated in one batch** — collect ALL (one entry per
  violated assertion); `executor.runAll()` must not abort early.
- **No-dependency assertion** (`CHECK (1=0)`, `baseTablesInPlan.size === 0`) —
  collected via the direct loop, not just the kernel walk.
- **Report mode inside an explicit caller transaction** — the seam's
  `_commitTransaction()` is a no-op (caller owns commit), so the sink is never
  consumed and assertions fire at the caller's commit in **throw** mode; the
  seam returns `{ assertionViolations: [] }`. Document this clearly: report mode
  is only meaningful for the seam-owned implicit transaction.
- **`captureChanges: false` + report mode** — assertions never run; result is
  empty. (Report mode requires capture on; document, don't error.)
- **Report mode + a NON-assertion commit failure** (e.g. a connection commit
  error, a deferred row constraint from FK cascade) — must still throw and roll
  back; the pending sink must be cleared in `finally` so a subsequent commit is
  not silently put into collect mode.
- **Sink lifecycle / re-entrancy** — the pending sink is consumed-and-cleared by
  `commitTransaction`; the seam also clears in `finally`. A nested/cascade DML
  commit inside the batch must never observe a stale sink (the batch commits
  once, at the seam-owned boundary; FK-cascade DML runs inside the batch
  savepoint, not its own top-level commit).
- **Derived consistency under report mode** — after a reported violation, the MV
  backing reflects the violating row (row-time maintenance ran in the batch and
  committed), so the MV is **consistent with** the base table; watch fires for
  the row. This is the whole point — no divergence, no MV refresh needed.
- **Samples shape** — `samples` are the violation query's output rows (capped),
  not full table rows; document so the dependent ticket's host event sets
  expectations.

## Tests (engine; `external-row-change-ingestion.spec.ts`)

In the existing `change capture → commit-time global assertions` describe block:

- **report mode collects, does not throw, batch commits.** Direct-write a
  violating row, ingest with `{ assertionFailureMode: 'report' }`; assert the
  call resolves with `assertionViolations` containing the assertion name and a
  non-empty `samples`, `db.getAutocommit()` is true (committed, not rolled back),
  and a `db.watch` subscription on the row **did** fire (contrast the existing
  throw-mode test where it did not).
- **report mode + covering MV converges.** With an MV over the table, a reported
  violation still leaves the MV row present and equal to the base row (derived
  effects persisted) — no refresh.
- **multiple assertions** — two assertions both violated by one batch yield two
  entries.
- **no-dependency assertion** (`CHECK (1=0)`-style) collected in report mode.
- **throw mode still throws** — keep/period the existing test; add an explicit
  assertion that `assertionFailureMode: 'throw'` (and the default) behave
  identically.

## Docs

- `docs/materialized-views.md`:
  - § Facets — note `captureChanges` assertion evaluation now has a per-call
    `assertionFailureMode` (`throw` default / `report`); report returns
    violations and commits the batch.
  - § Trust boundary — the inbound seam DETECTS global-assertion violations but,
    in report mode, does not block (trust-the-origin: the data lands; the caller
    is notified).
  - § Transaction & visibility contract — report mode is honored only for the
    seam-owned implicit transaction.
- Update the `Database.ingestExternalRowChanges` doc comment in `database.ts`
  and the mirror in `database-internal.ts` for the new option + return.

## TODO

- Add `AssertionViolation` type + transient `violationSink` to
  `AssertionEvaluator`; make `executeViolationOnce` / `executeResidualPerTuple`
  push-or-throw; widen `runGlobalAssertions(sink?)` to collect-all.
- Thread a pending commit-assertion sink through `commitTransaction` (manager
  field + setter; `Database._setPendingCommitAssertionSink`;
  `runGlobalAssertions(sink?)` on context + `Database`).
- Add `assertionFailureMode` to `IngestExternalChangesOptions`; add
  `IngestExternalChangesResult`; change `ingestExternalRowChanges` return type;
  install/clear the sink around the implicit commit in
  `ingestExternalRowChangeBatch` and return collected violations.
- Export `AssertionViolation` / `IngestExternalChangesResult` from
  `packages/quereus/src/index.ts`.
- Add the report-mode engine tests above; keep the throw-mode test green.
- Update `docs/materialized-views.md` and the seam doc comments.
- `yarn workspace @quereus/quereus run build`, `yarn workspace @quereus/quereus test`,
  and `yarn workspace @quereus/quereus lint` (streaming with `tee`).
