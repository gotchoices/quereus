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

# Complete: extend AbortSignal cancellation to the full execution API

## What shipped

Cooperative cancellation (`{ signal }` options bag → `AbortError`), previously
only on `Database.exec` / `Database.eval`, now spans the whole public surface:

- `Database.get(sql, params?, options?)` — pre-flight `throwIfAborted` before
  `prepare`, threads the signal into `Statement.get`.
- `Statement.run` / `Statement.get` — synchronous pre-flight before the mutex,
  signal threaded into `_iterateRowsRaw(params, signal)`.
- `Statement.iterateRows` / `Statement.all` — signal threaded in; `all`'s
  pre-flight fires lazily inside `_allGenerator` (mirrors `eval`).

All additions are trailing optional params — every existing call site is
unchanged. `StatementOptions` was already exported from `index.ts`.

A new cooperative checkpoint (`throwIfAborted(ctx.signal)`) sits at the top of the
shared DML drain loop in `runWithStatementSavepoints` (`emit/dml-executor.ts`),
which every INSERT/UPDATE/DELETE drains its source rows through. This closes the
scan-less / output-less mutation gap (e.g. `INSERT … VALUES`, or `INSERT … SELECT`
from a TVF/CTE with no base-table read), where neither the scan-leaf nor the
output-row checkpoint can observe an abort. The throw routes through the existing
savepoint rollback, unwinding partial writes exactly like a mid-statement failure.

The implementer **declined** the scheduler between-instruction poll the ticket
floated (documented in `docs/usage.md` + `docs/errors.md`): the synchronous fast
path cannot observe an abort at all, and a between-instruction poll cannot reach
intra-instruction loops, so it would add hot-path cost for ~zero coverage. The
DML-drain checkpoint covers the real scan-less-mutation gap instead.

## Review findings

Adversarial pass over the implement diff (`74b96b37`). Read the full diff with
fresh eyes before the handoff, then audited every touched file and the call sites.

### Correctness / design — clean
- **Signal threading verified end-to-end.** All four `_iterateRowsRaw` ingress
  points (`run`, `get`, `all`/`_allGenerator`, `iterateRows`) and the two
  `database.ts` paths (`get`, `eval`) thread the signal consistently;
  `_iterateRowsRawInternal` lands it on `runtimeCtx.signal` and `_iterateWithSignal`.
- **No signature drift.** `_iterateRowsRaw` gained a trailing optional `signal`;
  every internal caller (assertions, alter-table, MV helpers, FK actions,
  constraint-builder, manager) calls it arg-less — all back-compatible. The four
  public execution methods (`run`/`get`/`all`/`iterateRows`) are the complete
  set that takes params; no `step`/`each`/`first` were missed.
- **DML checkpoint placement is correct.** `runWithStatementSavepoints` is the
  single drain path for all three of INSERT/UPDATE/DELETE (`runInsert`/`runUpdate`/
  `runDelete` all `yield*` it), so one checkpoint covers every DML form. The throw
  routes to the inner `catch` → statement-savepoint rollback (non-FAIL) and is a
  no-op when `ctx.signal` is `undefined`, so existing non-signal paths are untouched.
- **No statement leak on pre-flight abort.** `Database.get` throws before
  `prepare`, so an already-aborted signal creates no statement to finalize.

### Tests — gap closed inline (minor)
- Added `stmt.run interrupts a mid-execution scan and rolls back partial writes`:
  a non-deterministic predicate UDF trips the abort on the third probed row of an
  `UPDATE … WHERE tick(id) >= 0`, then asserts `AbortError` **and** that every row
  retains its original value (implicit-transaction rollback unwound any partial
  write). This closes the implementer's flagged "mid-run `stmt.run` only covered
  indirectly" gap with a robust invariant (full rollback) rather than a step count.
- Existing 21 abort tests reviewed: pre-aborted rejection for `db.get`/`stmt.get`/
  `stmt.run`/`stmt.iterateRows`, mid-stream `stmt.all`, 2-arg back-compat, and the
  scan-less bulk-INSERT drain checkpoint. Subset now 22/22 green.

### Not changed (documented, not defects)
- **OR FAIL + abort + explicit transaction** left untested. Building a
  *deterministic* assertion here is fragile: whether prior rows survive depends on
  eager-vs-lazy `VALUES` evaluation (the implementer's own caveat). The behavior is
  consistent with existing FAIL semantics (the abort is just another throw); pinning
  it would require a TVF source with observable per-row pulls. Not worth a brittle
  test; noted for a future targeted ticket if FAIL-mode cancellation becomes a
  contract someone depends on.
- **Single-instruction internal loops stay uninterruptible** (tight CPU loop,
  in-memory sort over a drained array, one heavy DDL op). This is the documented
  final contract in `docs/usage.md` / `docs/errors.md`; doc wording matches the
  code reality. Verified the docs were genuinely updated (not stale).
- **Store-backed run not exercised.** The DML-drain checkpoint is module-agnostic
  (polls before `processRow`/`vtab.update`), so the LevelDB path shouldn't differ;
  `yarn test:store` is a slow store-specific pass left for CI/out-of-band.

### Validation
- `node packages/quereus/test-runner.mjs --grep "Abort"` → **22 passing**.
- `yarn lint` (eslint + `tsc -p tsconfig.test.json`) → **clean** (also type-checks
  test call sites, confirming no signature drift).
- Full `node packages/quereus/test-runner.mjs` → all passing except **one
  environmental timeout** in the randomized `fuzz.spec.ts` (120s mocha budget blown
  on a loaded agent box; the fuzzer passes no `{ signal }`, so the new code is an
  inert no-op there). Flagged in `tickets/.pre-existing-error.md` for the triage
  pass; not chased here per ticket rules.

## End
