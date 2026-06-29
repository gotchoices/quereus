---
description: Query cancellation currently works only on two of the engine's run methods; extend it to the rest of the public API and to long-running queries that never touch a table, so a caller's timeout can reliably stop any statement.
prereq:
files:
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/common/types.ts
  - packages/quereus/src/runtime/scheduler.ts
  - packages/quereus/docs/usage.md
  - docs/errors.md
  - docs/usage.md
difficulty: medium
---

# Extend AbortSignal cancellation to the full execution API

## Background

A first cut of cooperative cancellation shipped (`AbortError`, `throwIfAborted`,
`isAbortError`, and a `{ signal }` options bag on `Database.exec` / `Database.eval`).
See the completed ticket `exec-eval-abort-signal-feature-review` for the review of
what landed.

During that review the docs (`docs/usage.md`, `docs/errors.md`) were found to
describe a **broader** surface than what was actually implemented. The docs were
corrected to match reality, but the gap they originally described is real and worth
closing. This ticket captures that gap so a human can decide whether to build it.

## Scope — what the docs originally promised but does not yet exist

- **`Database.get(sql, params?, options?)`** — accept `{ signal }` and thread it
  through to the underlying statement iteration (currently `get` has no signal arg).
- **`Statement.run` / `Statement.get` / `Statement.iterateRows` / `Statement.all`** —
  accept a `{ signal }` options bag. The internal plumbing already supports it:
  `Statement._iterateRowsRawInternal(params, { signal })` honors a signal, and
  `_iterateRowsRaw(params, signal)` forwards it. Only the *public* methods lack the
  parameter — they call `_iterateRowsRaw(params)` with no signal. Threading it
  through is mechanical but is a public-API surface change across five methods plus
  `StatementOptions`.

- **A checkpoint for scan-less / output-less statements.** Cancellation checkpoints
  today live only at the physical table-access leaf (`emitSeqScan`, covering
  SeqScan / IndexScan / IndexSeek) and at the statement output-row boundary
  (`Statement._iterateWithSignal`). A statement that neither scans a table nor
  streams output rows — e.g. a heavy pure-DDL operation, or a tight computational
  loop inside a single instruction — is only checked at the pre-flight boundary and
  then runs to completion. The docs originally claimed a "scheduler instruction
  boundary" checkpoint; none exists. Decide whether the `Scheduler` run loop should
  poll `runtimeCtx.signal` between instructions (mind the per-instruction overhead —
  this is on the hot path) or whether the current contract (documented in
  `docs/usage.md`) is acceptable as-is.

## Acceptance

- The chosen subset of the above is implemented with tests covering: pre-aborted
  signal rejects before work; mid-stream abort interrupts at the next boundary;
  the 2-arg forms remain unchanged.
- `docs/usage.md` and `docs/errors.md` are updated to describe the *new* (true)
  surface — currently they are scoped down to `exec` / `eval` only.
- If the scheduler-level checkpoint is declined, document the final contract
  explicitly rather than leaving the gap implicit.
