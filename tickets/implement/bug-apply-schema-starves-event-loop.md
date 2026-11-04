description: Applying a schema never lets timers or interface events run when the storage backend does no real waiting, so a caller's timeout cannot fire and a browser or mobile interface freezes until the migration ends. Give up the thread periodically during a long apply, and close the two gaps that would otherwise let other code see or damage a half-applied schema.
architecture: docs/schema-declarative.md#failure-and-restoration
repro: verified
files:
  - packages/quereus/src/runtime/emit/schema-declarative.ts # emitApplySchema (seed loop, flag try/finally), runBatchedMigrationLoop, runStepsWithUndoJournal, unwindJournal, runJournalInReverse
  - packages/quereus/src/core/database.ts # _executeSingleStatement (closed check), _isConcurrentReadEligible (apply check) and its NOTE, a new internal flag beside _setSchemaUnwinding
  - packages/quereus/src/util/ # new helper for the time-budgeted yield
  - packages/quereus/src/vtab/test-support/commit-stall.ts # settleMacrotasks: reuse the new one-turn primitive
  - packages/quereus/test/apply-schema-restore.spec.ts # conventions to follow: setDefaultVtabName, rejection(), restoreFingerprint()
  - docs/schema-declarative.md
  - docs/sql-txn.md # section 8.6
  - docs/usage.md # concurrent reads, db.close()
  - docs/architecture.md # concurrent committed-read path bullet
----

From GitHub issue #34. `apply schema` runs its whole plan inside one macrotask (one turn of the JavaScript event loop) when a module's schema hooks do no real I/O, because each `await` then settles as a microtask. A caller's `Promise.race` against a timeout cannot win, and on React Native or in a browser the interface freezes. The reporter saw a 7 min 20 s freeze with a dead 45 s timeout. Nothing is corrupted; the apply cannot be bounded, reported on or kept responsive.

## Reproduction

On the 4.25.0 build, with the default memory module and no plugins, a `setTimeout(fn, 0)` scheduled before a 200-table `apply schema main` had not fired when the apply finished, 16 ms later. A 5000-row seed held the thread for its entire 1005 ms.

## What a yield exposes

The findings below come from a scratchpad copy of the build with a macrotask patched in after every migration step, driving other work from timers. All of them were run, not inferred.

| Issued from a timer mid-apply | Without further changes | Conclusion |
| --- | --- | --- |
| `exec` write, DDL, serialized read, `begin`/`commit` | All ran after the apply and saw the finished catalog | Safe. The apply holds the execution mutex (the lock that serializes statements) for its whole duration, and its steps run through the no-mutex nested path. |
| `readConcurrency: 'committed'` read | Compiled against the half-applied catalog and answered mid-apply | **Gap 1.** Fix below. |
| `db.close()` | Returned in 0.3 ms. The apply kept going, re-created 27 tables on the closed database, and **resolved as success** | **Gap 2.** Fix below. |
| A step failing after yields | Journal unwound, catalog verified back, no schema events | Safe. The undo journal is a local array, its SQL is rendered at plan time, and nothing queued can reach the catalog. |
| `prepare` / `getColumnNames` | Harmless; the statement ran correctly afterwards | Safe. Execution stays behind the mutex and plans are invalidated on schema change. |

Also checked by reading the code, not run: `_isExecuting()` stays true across a yield, so sync maintenance still defers. Auto-analyze and materialized-view refresh timers take the mutex. `withPublicEventsSuppressed` and the foreign-key suppression flag scope inside one step, so a yield between steps is outside them. `_setSchemaUnwinding` and `_setPrimaryKeyRebuildRefused` are only read by statements, which are behind the mutex.

**Synchronous catalog APIs are not closed off.** `db.defineTable`, `db.registerModule`, direct `db.schemaManager` access and option setters take no mutex, so a timer can call them mid-apply. A real-I/O module already exposes this. If such a call changes the catalog, the restore check notices on the failure path. Document it; do not gate it.

### Gap 1: committed reads see a catalog that may never exist

Observed: mid-apply, `select count(*) from t0` returned `{c: 0}` for a table the plan had just created, and the plan's final step then failed and the table was undone. So the reader saw a table that never officially existed. A `select * from a1` returned an added column with its backfilled default (`{id:1, v:'one', w:7}`) before the apply finished. This contradicts the documented "coherent snapshot as of some commit boundary".

This is not wholly new. A loop chained on microtasks can already see a part-applied catalog today, and so can timers under a module that really waits. The yield would make it the ordinary case, for exactly the applications that poll during a migration. The `NOTE` on `_isConcurrentReadEligible` says compile "cannot observe half-applied multi-step DDL". That holds for one DDL statement, not for a multi-step apply.

**Fix:** treat a migrating apply like an atomic `exec` batch, which already disqualifies committed reads for its whole duration, and whose availability cost is already documented in `docs/usage.md`. Add an internal flag on `Database`, set only around `runBatchedMigrationLoop` in the existing `_setPrimaryKeyRebuildRefused` try/finally, and have `_isConcurrentReadEligible` return false while it is set. Falling back to the serialized path is already defined as always correct. A compile error on the half-applied catalog already falls back too, so it needs no change.

The prototype confirmed both cases: the read waits for the apply, and after a restored failure it reports `Table 't0' not found`.

The flag covers the migration loop only. Seed rows are uncommitted and so invisible anyway, and the catalog is final by then. `backlog/debt-concurrent-reads-schema-gate` is a different concern (a module that cannot pin a scan across a schema change) and stays open.

Rejected: accepting and documenting the behaviour. The fix is three lines and has precedent, and a reader that opted into `'committed'` gave up ordering, not coherence.

### Gap 2: closing mid-apply is ignored

`Database.close()` takes no mutex and does not wait, and nested statements never check that the database is open. This is the natural thing for a caller to do when its timeout fires, and the yield is what lets it happen on a module that does no real waiting.

**Fix:** call `this.checkOpen()` at the top of `_executeSingleStatement`. The next step then fails, the unwind fails the same way, `endSchemaBatch(error)` still fires so the module discards its batch, and the apply rejects. The prototype confirmed this: the apply rejected with `Failed to execute DDL: … Error: Database is closed` plus the partially-migrated line, and the closed database held 0 tables. A statement queued behind the mutex when close ran now gets the same refusal instead of running on a torn-down database.

A step already inside a module hook when close runs still finishes. That wider defect, and iterators that keep reading after close, are in `backlog/bug-close-returns-while-statement-still-running`. The yield sits between steps, so the interval it opens is fully covered.

## The yield

A helper in `src/util/`, for example:

```ts
/** One event-loop turn. setTimeout is the one primitive on node, browsers and React Native. */
export function yieldToEventLoop(): Promise<void>;

/** Yields only once the thread has been held for budgetMs since the last yield. Never throws. */
export function createEventLoopPacer(budgetMs?: number): () => Promise<void>;
```

Make `settleMacrotasks` call `yieldToEventLoop` so the primitive exists once.

**Budget: 16 ms (one 60 Hz frame).** Measured on this Windows machine, where one `setTimeout(0)` costs about 15 ms. That cost is why per-step yielding is not viable: 400 tables went from 9 ms to 5946 ms.

| Tables | No yield | 8 ms budget | 16 ms budget |
| --- | --- | --- | --- |
| 80 | 3.7 ms | 3.7 ms, 0 yields | not measured |
| 400 | 9.2 ms | 19.2 ms, 1 yield | not measured |
| 2000 | 46–79 ms | 73 ms, 5 yields | 127–131 ms, 4 yields, longest stall 33 ms |
| 8000 | 224 ms | not measured | 235–294 ms, 9–11 yields, longest stall 53 ms |

These are noisy single-machine figures, taken from different runs. The reporter measured about 1 ms per yield on macOS. Use `Date.now()`: it exists everywhere, and a backward clock jump only delays one yield.

`setTimeout` over `MessageChannel`, `scheduler.yield()` or `setImmediate`: it is one code path on all three platforms, and the alternatives need a fallback that tests here would not exercise. Hidden browser tabs throttle timers to about once a second, so a long apply in a hidden tab gets much slower (not measured). Leave that as a `NOTE:` on the helper: if applies in hidden tabs matter, prefer `MessageChannel` where it exists, closing the port so node can exit.

## Where it goes

One pacer per apply, created at the top of the `run` in `emitApplySchema` so planning time counts toward the first yield, and awaited at three sites:

- **Migration steps:** in `runStepsWithUndoJournal`, after the journal push. A failed step returns above it.
- **Unwinding:** in `runJournalInReverse`, after each undo statement. A failed apply unwinds about as many steps as it ran, so without this it still freezes. The reporter left this out; it is included here because the safety argument is the same (mutex, flag, closed check) and it only needs one more parameter.
- **Seed rows:** this is the largest stall measured. Today each table's rows are one joined `_execWithinTransaction`, which cannot yield inside. Execute each row as its own call and await the pacer between rows. The per-row parse replaces the batch parse of the same text, so the overall cost should not move much (not measured). The error can then name the failing row rather than embedding the whole table's SQL; no test or doc pins the old text.

Seeding runs after `endSchemaBatch` and outside the flag; statements stay behind the mutex and its rows stay uncommitted.

## What remains uninterruptible, and what to document

- A single slow step cannot be split: one `ALTER` backfilling 50 000 rows held the thread for 77 ms. A module's own hook cannot be interrupted either.
- Planning is synchronous: 53 ms of stall at 8000 tables. Logical (lens) deployment is also synchronous and is not paced.

Add a short section to `docs/schema-declarative.md`, stating:

- A long apply gives up the thread between steps, between undo statements and between seed rows, so timers, I/O callbacks and interface events can run.
- **This does not cancel anything.** After `Promise.race` loses to a timeout, the apply keeps running and finishes or fails on its own, and statements issued meanwhile queue behind it. An `AbortSignal` passed to `exec` is only checked before each top-level statement, so it does not stop an apply either (from reading `_executeStatementBatch`, which passes no signal). Cancellation is a separate request.
- `db.close()` mid-apply makes the apply reject at its next step and reports the schema as not restored. Do not treat that as a clean rollback.
- Committed reads wait for a migrating apply; ordinary statements always did.
- The limits above, and that synchronous catalog APIs called mid-apply are not protected.

## TODO

- Add the pacer helper to `src/util/` with its `NOTE:` on hidden tabs, and reuse the primitive in `settleMacrotasks`.
- Pace the migration steps, the undo statements and the seed rows, with one pacer per apply. Split seed execution to one call per row and update the error text.
- Add the internal apply flag and the `_isConcurrentReadEligible` check. Update that method's doc comment and correct its `NOTE` to distinguish one DDL statement from a multi-step apply.
- Add `checkOpen()` to `_executeSingleStatement`. Confirm nothing in `close()` itself reaches it.
- Add `packages/quereus/test/apply-schema-yields.spec.ts`. Drive the steps with a `MemoryTableModule` subclass whose `create` busy-waits past the budget, registered through `setDefaultVtabName` (a table-level `using` in the declaration did not reach the module's hook in my probe). This makes yields deterministic without asserting elapsed time. Cover:
  - a 0 ms timer fires before the apply settles, during steps and during seed rows
  - a serialized statement issued from that timer runs after the apply and sees the whole catalog
  - a committed read issued from that timer on a plan that then fails does not see the undone table
  - `close()` from that timer rejects the apply and leaves no tables
  - a failing step after yields restores the catalog and announces no events
- Do not port the reporter's `node:test` file: it passes while the defect is present. The first case above is its inverted form.
- Update the docs listed above: `schema-declarative.md`, `sql-txn.md` section 8.6 (a bullet beside the explicit-`BEGIN` rule), `usage.md` (concurrent reads and `db.close()`), `architecture.md` (the committed-read bullet).
- Run `yarn workspace @quereus/quereus test` and `yarn lint`. Run `yarn test:store` once as well, because seed execution and the closed check touch paths the store backend also takes.
- Comment on GitHub issue #34 only if a human asks; it is outward-facing.
