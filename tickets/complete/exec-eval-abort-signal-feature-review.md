---
description: Adversarial review of the statement-cancellation feature (stop a running query via an AbortSignal / timeout) that had shipped bundled in an unrelated bug-fix without its own review.
prereq:
files:
  - packages/quereus/src/common/errors.ts
  - packages/quereus/src/common/types.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/runtime/emit/scan.ts
  - packages/quereus/src/runtime/emit/table-valued-function.ts
  - packages/quereus/src/runtime/types.ts
  - packages/quereus/src/runtime/parallel-driver.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/exec-eval-abort-signal.spec.ts
  - packages/quereus/test/runtime/fork-contract.spec.ts
  - docs/usage.md
  - docs/errors.md
difficulty: medium
---

# AbortSignal cancellation — review complete

The `AbortSignal` cancellation feature (`StatementOptions { signal }` on
`Database.exec` / `eval`, `AbortError`, `throwIfAborted`, scan-leaf + output
checkpoints) that had landed unreviewed inside commit `d4167102` was given a
dedicated adversarial review. The feature itself is sound; the principal defect
was **documentation that described a substantially larger surface than what
shipped**, including a copy-paste example importing a non-existent export.

Minor findings were fixed in this pass; the one major finding (the unimplemented
broader API surface) was filed as a backlog ticket.

## Review findings

### Cancellation-checkpoint coverage — checked, OK (with one documented gap)
- The scan-leaf checkpoint in `emitSeqScan` covers **all three** physical
  table-access nodes (SeqScan / IndexScan / IndexSeek route through the same
  `run`), not just seq-scan — the original ticket understated this. The output
  re-yield (`Statement._iterateWithSignal`) covers scan-less output streams
  (`values`, recursive CTEs).
- **Gap (by design):** a statement that neither scans a table nor streams output
  rows (heavy pure-DDL, a tight compute loop in one instruction) is only checked
  at the pre-flight boundary, then runs to completion. This is now stated
  explicitly in `docs/usage.md`. Closing it (a scheduler-instruction-boundary
  checkpoint) is deferred to the backlog ticket below — it is on the hot path and
  needs a perf-aware design.

### Error-identity preservation — found a real defect, fixed inline
- `scan.ts` and the statement-level catch (`statement.ts:352`,
  `if (e instanceof QuereusError) throw e` — and `AbortError extends QuereusError`)
  both correctly preserve `AbortError` identity.
- **The TVF emitter did NOT.** Both catch blocks in
  `runtime/emit/table-valued-function.ts` wrapped *every* thrown error — including
  an `AbortError` — into a generic `"Table-valued function X failed"` `QuereusError`,
  losing the `name`/`ABORT`-code identity. **Fixed** by mirroring the `scan.ts`
  pattern (`if (error instanceof AbortError) throw error;`) in both blocks. Added a
  regression test (`preserves AbortError identity when it surfaces through a
  table-valued function body`).

### Documentation accuracy — found major drift, corrected
- `docs/usage.md` and `docs/errors.md` claimed `{ signal }` is accepted by
  `Database.get` **and** `Statement.run` / `get` / `iterateRows` / `all` — **none
  of which actually accept it**. Scoped the docs down to the shipped surface
  (`exec` / `eval`).
- The usage example imported **`isAbortError`**, which **did not exist** — a
  copy-paste-broken example. Rather than gut the example, the documented helper was
  implemented: `isAbortError(e)` added to `errors.ts` and exported from `index.ts`,
  with unit tests (own `AbortError`, foreign `name === 'AbortError'` Error, negative
  cases). This is the documented contract; it is self-contained and low-risk.
- `docs/errors.md` described a `throwIfAborted` "scheduler instruction boundary"
  seam that **does not exist** — corrected to the real seams (physical
  table-access row-loop + statement output-row boundary + pre-flight entry).

### Mis-triaged "pre-existing" failure — verified the triage fix is complete
- The implementer's `.pre-existing-error.md` mislabeled the `fork-contract.spec.ts`
  `TS1360` break as pre-existing; it was in fact *caused* by adding `signal` to
  `RuntimeContext` (the spec's `satisfies Record<keyof RuntimeContext, ForkPolicy>`
  requires every field to declare a policy). Triage commit `309feeb7` correctly
  added `signal: 'shared-frozen'` to `EXPECTED_FORK_POLICY`, the parallel-driver
  fork, and removed `.pre-existing-error.md`. Verified: the policy classification is
  sound (the runtime only ever reads `signal`, shared by reference so all branches
  honor the same abort), `fork-contract.spec.ts` passes, and the stale diagnosis
  note is gone (not relied upon anywhere).

### Resource cleanup & semantics — checked, OK
- Scan `finally` closes the row slot and disconnects the vtab even on abort; the
  for-await unwind calls `.return()` on the underlying generators. Mid-stream abort
  discards the already-fetched next row without yielding it (matches the spec's
  `[1,2]`-then-abort expectation). Implicit transactions roll back on abort (covered
  by the existing `exec is interrupted mid-scan` test — `dest` ends empty).

### Validation
- `yarn lint` (eslint + `tsc -p tsconfig.test.json --noEmit`): clean.
- Full `packages/quereus` suite: **6410 passing, 0 failing, 9 pending** (pending =
  strict-fork tests gated behind `QUEREUS_FORK_STRICT`, unrelated).
- Targeted: all `exec/eval AbortSignal cancellation`, `isAbortError type guard`,
  `Fork contract`, and `TVF row padding` cases pass.

## Follow-up filed

- `backlog/abort-signal-extend-to-get-and-statement-api` — implement the broader
  surface the docs originally promised: `{ signal }` on `Database.get` and the four
  public `Statement` methods, plus a decision on a scheduler-level checkpoint for
  scan-less/output-less statements.
