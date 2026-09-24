description: Callers sharing one database connection can now run a group of statements as a single all-or-nothing transaction that nobody else's statements can slip into, and asking to start or end a transaction no longer fails or silently does nothing just because another caller's write happens to be in flight.
architecture: docs/usage.md#transactions
files: packages/quereus/src/core/database.ts, packages/quereus/src/core/database-transaction.ts, packages/quereus/src/common/types.ts, packages/quereus/src/common/errors.ts, packages/quereus/src/index.ts, packages/quereus/test/core-api-transactions.spec.ts, packages/quereus/test/logic/101-transaction-edge-cases.sqllogic, docs/usage.md, docs/sql-txn.md, docs/errors.md
----
# Complete: transactional `exec` batch, and transaction-state checks taken under the mutex

Planned, implemented and reviewed 2026-09-24. Implement commit `c391e4c8`; the review pass added the changes listed under *What the review changed* below.

## What shipped

**Arm 1 — `exec(sql, params, { transaction: true })`.** A new `ExecOptions` (extends `StatementOptions`) in `common/types.ts` widens `Database.exec`'s `options` parameter. `exec` splits into two named private methods instead of threading a flag through one loop: `_execBatchAutocommit` (the unchanged per-statement implicit-transaction loop, still the default) and `_execBatchAsTransaction`. The latter refuses with `TransactionActiveError` if any transaction is open, begins one explicit transaction, runs every statement with no per-statement commit, re-checks the abort signal, and commits — all under a single hold of the execution mutex, with the rollback on failure taken inside that same hold. A module-level `assertNoTransactionControl` refuses, before the mutex is taken, any batch spelling `begin`, `commit`, or a bare `rollback`; savepoint statements stay allowed because they cannot end the batch's transaction.

**Arm 2 — state checks moved under the mutex.** `beginTransaction()` / `commit()` / `rollback()` now take `_withMutex` directly, check inside it, and call `_beginTransaction('explicit')` / `_commitTransaction()` / `_rollbackTransaction()` — exactly what `runtime/emit/transaction.ts` does — instead of pre-checking and then running `exec("BEGIN TRANSACTION")`. They no longer refuse (or silently no-op) merely because another caller's autocommit write is in flight.

**New error class.** `TransactionActiveError extends QuereusError` with `StatusCode.BUSY`, exported from `src/index.ts` alongside the `ExecOptions` type, and raised by both SQL `begin` and JS `beginTransaction()`.

Docs: `docs/usage.md` gained an *Atomic Batches* section and rewrote the transaction-control API entry; `docs/sql-txn.md` §8.1/§8.2/§8.6 and `docs/errors.md` were updated to match.

## Review findings

Read the implement diff before the handoff summary. Categories with nothing in them are called out explicitly rather than dropped.

**Correctness — nothing broken found.** The four questions the handoff raised all resolve clean, and each was checked against the code rather than taken on the summary's word:

- *Is the default path unchanged?* Yes — `_execBatchAutocommit` is the old loop verbatim, and `ExecOptions extends StatementOptions`, so every existing `exec` call site keeps its meaning and its types.
- *Is the `isInTransaction()` guard before the rollback right for every failure shape?* Yes, and for a broader reason than the handoff gave. `TransactionManager.commitTransaction` clears `inTransaction` in a `finally`, and its `catch` already rolls every connection back — so a **connection-level** commit error, not just a deferred-constraint failure, leaves the guard correctly false. The one remaining shape, `insert or rollback`, ends the transaction from *inside* a statement via `_finalizeImplicitTransaction` (which honours OR ROLLBACK against explicit transactions too) before the batch's own catch runs; the guard handles that identically. It was untested, so a test now covers it.
- *Can `begin`/`commit` be reached some other way, past `assertNoTransactionControl`?* No. The engine synthesizes no transaction AST node anywhere (`grep` for `type: 'commit'` / `'begin'` / `'rollback'` outside the parser returns nothing), so the emitter in `runtime/emit/transaction.ts` is only ever reached from parsed SQL — which the assertion sees. `release` of the outermost savepoint does **not** commit here (`TransactionManager.releaseSavepoint` only merges layers), so the allow-list is right. DDL under an `'auto-commit'`-tier module force-commits at the *module* level only, leaving engine transaction state consistent — the same exposure a hand-written `BEGIN` has, already documented.
- *Did arm 2 lose anything observable by skipping the planner?* One thing, and it was undocumented: `_executeSingleStatement` is where `instructionTracer` and the `runtime_stats` metrics flag are wired, so `beginTransaction()` / `commit()` / `rollback()` now emit no instruction trace and no stats row, where SQL `begin`/`commit`/`rollback` still do. Nothing in-tree consumes it. Recorded as a tripwire (see below).

**Fixed in this pass (minor):**

- `TransactionManager.rollbackTransaction` cleared `inTransaction` / `isAutocommit` / `transactionSource` and the change log on its *success* path only, unlike `commitTransaction`, which does it in a `finally`. A throw from `discardBatch()` or `getAllConnections()` would therefore have released the execution mutex with the transaction still marked open, stranding the next queued caller inside a transaction nobody owns — precisely the failure this ticket exists to prevent. Moved into a `finally`. This is the invariant behind the handoff's "the rollback-failed path is untested" gap: the path is still unreachable in-tree (connection rollback errors are swallowed per-connection and `Promise.allSettled` cannot reject), but it can no longer strand, so the untested `catch` in `_execBatchAsTransaction` is now only about surfacing the error, not about state. That method's comment was corrected accordingly — engine-side state is *not* in doubt there; only some connection's is.
- The literal `'Cannot begin transaction: a transaction is already active'` was written three times — once as the `TransactionActiveError` constructor default and again at both call sites that pass exactly that default. Both arguments dropped.
- `docs/usage.md` § Atomic Batches and `docs/sql-txn.md` §8.6 did not mention an availability consequence a caller weighing the option needs: `_isConcurrentReadEligible` disqualifies the mutex-free committed-read path while **any** explicit transaction is open, and the engine cannot tell whose it is — so a concurrent `readConcurrency: 'committed'` read serializes behind an atomic batch for its whole duration, where under a plain multi-statement `exec` (implicit transactions) it would have run concurrently. Correctness is unaffected; read latency is. Added to both files.

**Test gaps closed (the implementer's 15 cases were treated as a floor):** two cases added to `packages/quereus/test/core-api-transactions.spec.ts` for the interactions the batch's error path actually depends on and nothing exercised —

- `insert or rollback` mid-batch: the whole batch rolls back, no double rollback, and the database is immediately reusable by a second atomic batch.
- `savepoint` + `release` inside a batch: `release` must not end the batch's transaction, so statements after it still ride the closing commit.

`packages/quereus` now reports 10657 passing, 0 failing.

**Tripwires recorded, not filed as tickets:**

- `packages/quereus/src/core/database.ts`, on `beginTransaction()` — a `NOTE:` that the three JS transaction-control methods bypass per-statement instrumentation (no instruction trace, no `runtime_stats` row), with the route back if a tracing consumer ever needs them.
- `packages/quereus/src/core/database-transaction.ts`, on the new `finally` in `rollbackTransaction` — states why the reset is unconditional, so a future edit does not quietly move it back onto the success path.

**No tickets filed.** Every finding either resolved inline at its own site or is genuinely conditional. Nothing reached the filing bar: none names a class-level invariant needing its own change, and no latent defect survived the check above.

**Considered and declined, with reasons:**

- *Partial `begin` across connections.* If `connection.begin()` throws midway through `TransactionManager.beginTransaction`, connections that already began are left begun and `inTransaction` stays false. Pre-existing, identical for SQL `BEGIN`, and outside this diff — not this ticket's to fix, and not worth a speculative ticket without a module that can actually fail there.
- *`database.ts` size.* 3000+ lines, but this change reduced per-method size rather than adding to the pile, and the split is a separate concern with no anchor here.
- *Re-entrancy.* `exec(…, { transaction: true })` from a context already holding the mutex deadlocks exactly as plain `exec` does; `_isExecuting()` remains the caller's check. Unchanged behavior, and a test for it would hang. Left as the handoff described.

## Validation

From the repo root, all green: `yarn lint` (workspace-wide; `@quereus/quereus`'s real eslint + test-file `tsc` pass re-run alone afterwards, exit 0), `yarn build`, `yarn typecheck`, `yarn test` (10657 passing in `packages/quereus`, every other workspace passing, exit code 0).

`yarn test:store` was **not** run, in this pass or the implement pass — the LevelDB store path's wall-clock is well past the 10-minute agent budget. Transactions are the subsystem that path stresses hardest, so a store run remains the single most valuable out-of-band validation for this change, for a human or CI.

## Behavior changes any consumer should know

- A double `begin` / double `beginTransaction()` now raises `TransactionActiveError` with `StatusCode.BUSY` (5) and the message `Cannot begin transaction: a transaction is already active`, where it was a bare `QuereusError` with `StatusCode.ERROR` (1). One in-tree expectation was updated (`packages/quereus/test/logic/101-transaction-edge-cases.sqllogic:36`); an out-of-tree consumer matching the old code or text sees a change.
- `commit()` / `rollback()` called while another caller's autocommit write is in flight used to resolve silently (the pre-check passed, the internal commit then no-opped); they now reject with `No transaction active`. That is the truth, and what the ticket asked for, but it breaks any consumer relying on the silent success.

## Out of scope, still parked

The callback form `db.transaction(async tx => …)` stays in backlog as `feat-database-transaction-callback-scope`, as the plan ticket specified.

## Environment incident during the implement run

The implement-stage handoff reported that at 13:22 local, mid-implementation, every file under `packages/quereus` was deleted from the working tree by something outside that session's edits (1425 tracked files, plus untracked `dist/` and `node_modules/`), root cause unidentified. That session recovered with `git checkout -- packages/quereus` from HEAD `42254ef7`, then `yarn install` and `yarn build`, and re-applied its own edits by hand. Uncommitted work anyone else had under `packages/quereus` at that moment was destroyed by the deletion itself and is not recoverable past HEAD. Recorded here so it is not lost with the review ticket; the review pass found the tree consistent and the full suite green, but nobody has audited whether another agent's in-flight work went missing.
