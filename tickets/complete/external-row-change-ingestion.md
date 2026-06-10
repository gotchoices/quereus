description: Batch ingestion seam (`Database.ingestExternalRowChanges`) — externally-applied row changes drive change capture, batch-amortized row-time MV maintenance, and opt-in FK actions inside the coordinated transaction. Reviewed and hardened.
files:
  - packages/quereus/src/core/database-external-changes.ts        # batch driver (savepoint lifecycle, facet dispatch, flush, implicit-txn finalization, per-op shape validation)
  - packages/quereus/src/core/database-internal.ts                # ExternalRowChange + IngestExternalChangesOptions types; ingestExternalRowChanges declaration
  - packages/quereus/src/core/database.ts                         # public ingestExternalRowChanges; notifyExternalChange jsdoc now back-references the seam
  - packages/quereus/src/index.ts                                 # exports ExternalRowChange, IngestExternalChangesOptions, BackingRowChange
  - packages/quereus/test/external-row-change-ingestion.spec.ts   # 26 tests
  - docs/materialized-views.md                                    # § External row-change ingestion
  - docs/incremental-maintenance.md                               # external-writes blockquote + cross-reference entry
----

# External row-change ingestion (complete)

## What was built

`Database.ingestExternalRowChanges(changes, options?)` — a batch seam for writes a
host applied directly to module storage (bypassing the DML executor). Per ordered
change, in DML-executor order: (a) change capture (`_record*` → watch post-commit
dispatch + commit-time global assertions, default ON), (b) row-time MV maintenance
(default ON, batch-amortized: one `BackingConnectionCache`, one deferred
full-rebuild set, one flush per batch), (c) parent-side FK actions (default OFF —
POST-application transitive RESTRICT walk, then CASCADE/SET NULL/SET DEFAULT, both
`lensRouted = false`). No new maintenance machinery — the driver orchestrates
existing pieces. Batch lifecycle mirrors `runWithStatementSavepoints`: exec mutex
for the whole batch → `_ensureTransaction` → `__external_batch_<n>` savepoint
broadcast → facet loop → flush deferred rebuilds before savepoint release → on
throw, rollback-and-release savepoint (+ roll back a seam-started implicit txn) →
on success, commit the implicit txn (watch dispatch fires there). The full
contract (facet semantics, trust boundary, transaction & visibility rules,
DML-replay decision matrix) is in docs/materialized-views.md § External
row-change ingestion.

## Review findings

### What was checked

- Implement-stage diff read fresh (commit e1e117e5) before the handoff summary.
- Every helper the driver leans on was verified at its definition: `_record*`
  signatures and pk-index derivation (`primaryKeyDefinition.map(d => d.index)` —
  identical to the executor's `pkColumnIndicesInSchema`), `_maintainRowTimeCoveringStructures`
  / `_hasRowTimeCoveringStructures` / `_flushDeferredRebuilds`, the savepoint
  broadcast trio, `_acquireExecMutex`, FK helper signatures (`lensRouted` defaults
  false; `op` narrowed to `'delete'|'update'` by the `!== 'insert'` guard — type-correct).
- Transaction-lifecycle parity audited against both engine drivers: the seam's
  ensure → run → commit/rollback-inside-mutex shape matches `Database.exec`
  (the stronger pattern; `Statement.all()` finalizes outside the mutex).
- Implicit-commit failure path: initially looked like a gap (the seam's commit
  sits outside its try/catch, and a capture-fed **global assertion violation
  throws exactly there**) — verified NOT a bug: `TransactionManager.commitTransaction`
  self-cleans on failure (rolls back all connections, resets
  `inTransaction`/`transactionSource`, clears the change log, discards batched
  events in its own catch/finally). Confirmed by a new test.
- Savepoint broadcasts verified not to upgrade implicit→explicit (only the
  SAVEPOINT SQL statement path does), so the `_isImplicitTransaction()` gate at
  finalization is sound.
- Assertion evaluation verified gated on the captured change log
  (`getChangedBaseTables()`), so `captureChanges: false` genuinely opts a batch
  out of assertion evaluation. Confirmed by a new test.
- Capture/watch key parity (`schemaName.tableName` from the RESOLVED schema),
  per-batch schema memo soundness under the mutex (no DDL can interleave),
  batch-savepoint name uniqueness vs. nested cascade statement savepoints.
- Docs read end-to-end (materialized-views.md, incremental-maintenance.md, both
  seam jsdocs); lint + build + full `yarn test` (all workspaces) run green.

### Found and fixed in this pass (minor)

- **Shape validation promoted from arity-only to per-op** (`database-external-changes.ts`):
  the old `if (row !== undefined) assertRowArity(...)` silently skipped a missing
  required image, so a JS caller's `{op: 'update'}` without `oldRow` died as a
  `TypeError` deep inside capture, and an unrecognized `op` string fell through
  the capture switch as a silent no-op. Now `assertChangeShape` requires the
  images each op demands (insert: new, delete: old, update: both) and rejects
  unknown ops — all `MISUSE`, the runtime mirror of the `BackingRowChange`
  discriminated union. Docs sentence updated to match ("shape-checked").
- **`notifyExternalChange` jsdoc back-reference added**: the handoff claimed the
  two seams were cross-referenced both ways; the markdown docs were, but the
  `notifyExternalChange` API jsdoc itself never pointed at the new seam.
- **Six tests added** (20 → 26), covering the handoff's flagged gaps:
  - global assertion violated by an inbound batch → implicit commit fails with
    the assertion error, state resets to autocommit, no watch dispatch; and
    `captureChanges: false` opts out of assertion evaluation;
  - explicit-txn mid-batch error → caller transaction left OPEN, only the failed
    batch's savepoint unwound, the earlier batch's capture still dispatches at
    the caller's commit;
  - positive non-default-schema batch (`schemaName: 'temp'`) → resolution +
    capture key parity (watch on `temp.t2` fires);
  - update missing `oldRow` → MISUSE; unrecognized op → MISUSE.

### Accepted as-is (with reasons; no new tickets)

- **Residual-recompute / prefix-delete / join-residual arms not driven through the
  seam directly**: the seam calls the same `maintainRowTime` entry the executor
  uses with the same per-statement amortization arguments; the arms themselves are
  covered by the maintenance-equivalence suites. Duplicating them through the seam
  would test the shared callee twice.
- **Full-rebuild "exactly one rebuild per batch" asserted by final state, not an
  instrumented counter**: the one-flush-per-batch property is structural (one
  `deferred` set drained once); a counter assertion would only re-prove the shared
  `flushDeferredRebuilds` contract.
- **No store-module run** (`yarn test:store` skipped): the seam touches no store
  code path; per AGENTS.md the store suite is for store-specific diagnosis.
- **Do-not-call-from-within-a-statement deadlock contract is documentation-only**:
  a runtime guard cannot distinguish "legitimately waiting for another caller's
  statement" from "self-deadlock from inside my own statement" without
  async-context tracking (AsyncLocalStorage — not cross-platform: browser/RN).
  Both seam jsdocs and the docs section state the rule and route in-statement
  callers to the two-arg `_maintainRowTimeCoveringStructures`.
- **No guard against reporting changes on an MV backing table (`_mv_x`)**:
  documented as out of contract (engine-owned table); consistent with the trust
  boundary, and a name-prefix guard would be a heuristic.
- **Theoretical implicit-txn handoff race with `Statement.all()`** (statement
  finalizes its implicit txn after releasing the mutex, so the seam could in
  principle observe a not-yet-finalized implicit txn): pre-existing engine-wide
  pattern shared by any two consecutive statements, benign outcome (whoever
  finalizes first wins; the other's finalize no-ops), not introduced by this
  ticket.

### Security / robustness

Nothing exploitable beyond the documented trust boundary (the seam is explicitly
a trusted-origin surface; it validates shape, never semantics). Error paths unwind
via the swallowing `_rollbackAndReleaseSavepointBroadcast` + self-cleaning commit;
the mutex releases in `finally` on every path.

## Validation

`yarn build` (quereus), `yarn lint` (clean), root `yarn test` (all workspaces
green; quereus 5616 passing / 9 pending, incl. the 26 seam tests).
