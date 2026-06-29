---
description: A statement-cancellation feature (stop a running query when a caller's timeout fires) was committed bundled inside an unrelated bug-fix and was never given its own code review — give it a dedicated review or confirm it is already tracked.
prereq:
files:
  - packages/quereus/src/common/errors.ts
  - packages/quereus/src/common/types.ts
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/runtime/emit/scan.ts
  - packages/quereus/src/runtime/types.ts
  - packages/quereus/src/index.ts
  - packages/quereus/test/exec-eval-abort-signal.spec.ts
  - packages/quereus/test/runtime/fork-contract.spec.ts
  - packages/quereus/src/runtime/parallel-driver.ts
difficulty: medium
---

# Review (or de-duplicate) the bundled AbortSignal cancellation feature

## Why this exists

While reviewing the TVF row-padding fix
(`lamina-smoke-dat-imp-csv-window-tvf-insert-no-row-context`), the reviewer found
that the implement commit (`d4167102`) bundled a **second, entirely unrelated
feature**: cooperative cancellation of `Database.exec` / `Database.eval` via an
`AbortSignal`. None of it was mentioned in the implement handoff, and a search of
the `tickets/` tree found **no ticket** tracking it. It appears to be concurrent
in-flight work that the runner swept into this ticket's commit.

Because the runner warns that uncommitted tree edits "are not yours to undo," the
reviewer deliberately did **not** revert or deeply audit it. This ticket exists so
the work is not lost to the gap between tickets: it either needs its own adversarial
review pass, or — if it is already tracked by an out-of-band effort — this ticket
should simply be closed as a duplicate.

## What landed (public API surface — note this shipped unreviewed)

- `StatementOptions { signal?: AbortSignal }` — new 3rd arg to `exec`/`eval`.
- `AbortError extends QuereusError` (StatusCode.ABORT, `name === 'AbortError'`) and
  `throwIfAborted(signal?)`, both exported from `src/index.ts`.
- `signal?: AbortSignal` added to `RuntimeContext` (fork policy: `shared-frozen`).
- Cancellation checkpoints in the seq-scan leaf (`scan.ts`) and a row-boundary
  re-yield wrapper in `statement.ts` (`_iterateWithSignal`).
- Spec `exec-eval-abort-signal.spec.ts` (6 cases) — all passing.

## Things a dedicated review should scrutinize

- **Coverage of the cancellation checkpoint.** It currently lives in the seq-scan
  leaf and the statement output re-yield. Long-running statements with *no* table
  scan and no row output (e.g. a heavy pure-DDL op, or a tight computational loop
  inside a single instruction) are only checked at the pre-flight boundary. Confirm
  this matches the intended contract and is documented.
- **Error-identity preservation.** `scan.ts` re-throws `AbortError` unwrapped, but
  the TVF emitter's catch (`table-valued-function.ts`) wraps *all* errors into
  "Table-valued function X failed" — an abort surfacing through a TVF body would
  lose its `AbortError` identity. Decide whether that path matters.
- **Mis-triaged "pre-existing" failure.** The implementer's `.pre-existing-error.md`
  labeled the `fork-contract.spec.ts` `TS1360` break as pre-existing; it was in fact
  *caused* by adding `signal` to `RuntimeContext`. A later triage commit
  (`309feeb7`) correctly fixed it (added the `signal` fork policy + parallel-driver
  forking). Verify that fix is complete and the diagnosis note is not relied upon
  elsewhere.
- **Docs.** No user-facing doc (e.g. `docs/usage.md`) describes the cancellation
  option; the fix-stage commit touched `docs/usage.md`/`docs/errors.md` — confirm
  those edits actually cover this feature and are accurate.

## Disposition

If a human confirms this feature is already tracked / intentionally landed, close
this ticket. Otherwise promote it to give the feature the review it skipped.
