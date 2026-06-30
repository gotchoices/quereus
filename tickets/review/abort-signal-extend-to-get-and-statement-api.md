---
description: Query cancellation via AbortSignal, previously only on two engine methods, now works on the rest of the public query/statement API and on bulk writes that never read a table, so a caller's timeout can stop them.
prereq:
files:
  - packages/quereus/src/core/database.ts
  - packages/quereus/src/core/statement.ts
  - packages/quereus/src/common/types.ts
  - packages/quereus/src/runtime/emit/dml-executor.ts
  - packages/quereus/test/exec-eval-abort-signal.spec.ts
  - docs/usage.md
  - docs/errors.md
difficulty: medium
---

# Review: extend AbortSignal cancellation to the full execution API

## What landed

Cooperative cancellation (`{ signal }` options bag → `AbortError`) previously
existed only on `Database.exec` and `Database.eval`. This work extends it across
the rest of the public surface and adds one new runtime checkpoint.

**API surface — `{ signal }` now accepted by:**

- `Database.get(sql, params?, options?)` — threads the signal into the underlying
  `Statement.get`. Pre-flight `throwIfAborted` before `prepare`.
- `Statement.run(params?, options?)` — pre-flight before the mutex; threads into
  `_iterateRowsRaw(params, signal)`.
- `Statement.get(params?, options?)` — pre-flight before the mutex; threads in.
- `Statement.iterateRows(params?, options?)` — threads in (pre-flight is lazy,
  fired by `_iterateRowsRawInternal` on first pull, matching `eval`).
- `Statement.all(params?, options?)` — threads into `_allGenerator(params, signal)`,
  which now does a pre-flight `throwIfAborted` before acquiring the mutex (mirrors
  `_evalGenerator`).

All are **purely additive trailing optional params** — every existing 1-arg/2-arg
call site is unchanged (build + lint + 6420 tests green confirm no signature drift).
`StatementOptions` was already exported from `index.ts`; only its doc comment changed.

**New runtime checkpoint — DML drain loop (`emit/dml-executor.ts`):**

A single `throwIfAborted(ctx.signal)` at the top of the shared
`runWithStatementSavepoints` `for await (const flatRow of rows)` loop. This is the
loop every INSERT/UPDATE/DELETE drains its source rows through. It closes the
**scan-less / output-less mutation** gap: a bulk `INSERT … VALUES` or
`INSERT … SELECT` from a TVF/CTE with no base-table read is reached by neither the
scan-leaf checkpoint nor the output-row boundary, so before this an abort could only
take effect once the whole drain finished. The throw routes through the existing
inner `catch` → statement-savepoint rollback, so partial writes are unwound exactly
like a mid-statement constraint failure.

## Design decision — scheduler poll DECLINED (read this)

The ticket asked me to decide whether the `Scheduler` run loop should poll
`runtimeCtx.signal` *between instructions*. **I declined it** and instead added the
DML-drain checkpoint above. Rationale (also documented in `docs/usage.md` and
`docs/errors.md`):

- The synchronous fast path (`runOptimized`) cannot observe an abort at all — the
  timer/microtask that calls `controller.abort()` cannot run while synchronous
  engine code holds the JS thread. Polling there is pointless.
- A between-instruction poll on the async path **cannot reach the loops the ticket
  cites** (a tight CPU loop, an in-memory sort, a bulk-DML drain, a heavy single DDL
  op) — those all run *inside one instruction*, not between instructions. So it would
  add per-instruction hot-path cost for ~zero additional real coverage, and it is not
  cleanly testable (you can't isolate it from the scan/output checkpoints).
- The DML-drain checkpoint, by contrast, sits exactly where scan-less bulk-mutation
  work happens, is one line on a path that already `await`s a `vtab.update()` per row
  (negligible relative cost), and is directly testable.

**Note for reviewer:** the ticket's `files:` hint listed `scheduler.ts`; I did
**not** touch it. The checkpoint went into `dml-executor.ts` instead — a deliberate
relocation, not an oversight. If you disagree, it's a one-line revert.

The ticket's `files:` also pointed at `packages/quereus/docs/usage.md`; the real docs
live at repo-root `docs/usage.md` + `docs/errors.md` (no `packages/quereus/docs/`).
Those root files were the ones updated.

## Validation / test guidance

`packages/quereus/test/exec-eval-abort-signal.spec.ts` gained two new `describe`
blocks (21 abort tests total now pass). Run just these:

```
node packages/quereus/test-runner.mjs --grep "Abort" --reporter spec
```

Covered:
- **Pre-aborted rejects before work** — `db.get`, `stmt.get`, `stmt.run`,
  `stmt.iterateRows` each reject with `AbortError` on an already-aborted signal,
  with no row side effects.
- **Mid-stream abort interrupts at next boundary** — `stmt.all` consumes exactly the
  first two rows then halts (mirrors the existing `eval` mid-stream test).
- **2-arg forms unchanged** — `db.get`, `stmt.get`, `stmt.all` all verified with no
  options bag.
- **Scan-less bulk INSERT** — `insert into dest values (trip(1)),(trip(2)),(trip(3))`
  with a non-deterministic UDF that aborts on first call: asserts `AbortError` and
  that `dest` is empty (implicit txn rolled back). A companion test confirms the same
  shape inserts normally with no signal.

Full suite: `node packages/quereus/test-runner.mjs` → 6420 passing / 9 pending / 0
failing. `yarn lint` (eslint + `tsc -p tsconfig.test.json`) clean. `yarn build` clean.

## Known gaps / things to probe (treat my tests as a floor)

- **Single-instruction internal loops stay uninterruptible by design** — a tight
  computational loop, an in-memory sort over an already-drained array, a recursive-CTE
  internal loop, a TVF drain inside a scalar subquery, or one heavy DDL op. This is now
  the *documented* final contract, but it IS a real limitation; confirm the doc wording
  matches your read of the contract.
- **The scan-less DML test asserts robust invariants, not a step count.** It checks
  `AbortError` + empty `dest`, which hold whether `VALUES` is evaluated eagerly (abort
  caught at the first loop iteration) or lazily (row 1 inserted then rolled back). It
  does **not** pin how many rows were processed before the abort. If you want a
  stricter "N rows then stop" assertion, a TVF source with observable per-row pulls
  would be needed.
- **`Statement.get` / `Statement.run` mid-execution abort** is only covered indirectly
  (pre-aborted is tested directly; mid-run relies on the same scan/DML/output
  checkpoints as `exec`/`eval`, which are tested there). A dedicated mid-run `stmt.run`
  test over a scan source would tighten this.
- **OR FAIL + abort + explicit transaction** is untested. The DML-drain throw in FAIL
  mode (no statement savepoint) keeps prior rows within the transaction; an implicit
  txn still rolls back fully via `_finalizeImplicitTransaction(success=false)`, but
  inside an explicit txn the surviving rows persist until the user commits/rolls back.
  This is consistent with existing FAIL semantics (the abort is just another throw),
  but it's an untested interaction worth a sanity check.
- **`db.exec` multi-statement batch** already threaded the signal per-statement before
  this work; not re-touched. The `db.eval` multi-statement path likewise (existing).
- **No store-backed run.** Only the default in-memory vtab was exercised
  (`yarn test`). The DML-drain checkpoint is module-agnostic (it polls before
  `processRow`/`vtab.update`), so a LevelDB run shouldn't differ, but `yarn test:store`
  was not run.
