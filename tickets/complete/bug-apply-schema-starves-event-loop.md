description: Applying a schema used to hold the thread until it finished, so a caller's timeout could not fire and a browser or mobile interface froze. It now gives up the thread periodically during a long apply, and other code cannot see or damage a half-applied schema while it does.
architecture: docs/schema-declarative.md#yielding-during-an-apply
repro: verified
files:
  - packages/quereus/src/util/event-loop.ts # yieldToEventLoop, createEventLoopPacer (16 ms budget)
  - packages/quereus/src/runtime/emit/schema-declarative.ts # pacer through the migration loop and unwind; one call per seed row (executeSeedRow)
  - packages/quereus/src/core/database.ts # _setSchemaMigrating and its check in _isConcurrentReadEligible; checkOpen in _executeSingleStatement
  - packages/quereus/src/vtab/test-support/commit-stall.ts # settleMacrotasks reuses yieldToEventLoop
  - packages/quereus/test/apply-schema-yields.spec.ts
  - docs/schema-declarative.md
  - docs/sql-txn.md
  - docs/usage.md
  - docs/architecture.md
  - tickets/backlog/bug-close-returns-while-statement-still-running.md # gained an arm from this review
----

From GitHub issue #34. When a module's schema hooks do no real waiting, `apply schema` ran entirely inside one turn of the event loop, so a `Promise.race` timeout could not win and an interface froze.

## What was built

- **The yield.** One pacer per apply, created at the top of the `run` in `emitApplySchema`. It is awaited after each migration step, each undo statement and each seed row, and gives up the thread only once 16 ms have passed since the last yield.
- **Seed rows** run as one `_execWithinTransaction` call per row, so the apply can yield inside a table's seed. The seed error names the failing row instead of embedding the whole table's SQL.
- **Committed reads.** `_isConcurrentReadEligible` returns false while `_schemaMigrating` is set, which covers `runBatchedMigrationLoop` only. Such a read falls back to the serialized path and waits for the apply. Seeding does not disqualify a read.
- **`close()` mid-apply.** `_executeSingleStatement` calls `checkOpen()`, so later steps, undo statements and queued `exec` statements are refused.

## Measurements (implement stage)

On one noisy Windows machine, from a 5000-row seed and a 2000-table apply. The prior build ran from compiled `dist` and the new code from source through the type-stripping loader, so the comparison of totals is inexact.

| Case | Prior build | This change |
| --- | --- | --- |
| 5000-row seed, timer turns during the apply | 0 | 119–138 |
| 5000-row seed, longest stall | the whole apply (1086–2878 ms) | 33 ms |
| 5000-row seed, median total, 2 passes of 7 runs | 1378, 1552 ms | 2954, 2900 ms |
| 2000-table apply, longest stall | the whole apply (56–126 ms) | 26–32 ms |
| 2000-table apply, total | 56–126 ms | 103–164 ms |

A long apply takes about twice as long on Windows, where one `setTimeout(0)` costs about 15 ms against the 16 ms budget. The reporter measured about 1 ms per yield on macOS, which was not re-measured here. Batched and per-row execution of the same 5000 statements had medians of 1802 and 1865 ms over 9 alternating runs, within the run-to-run spread.

## Review findings

Method: read the implement diff before the handoff, read `close()`, the statement entry points and the mutex users, then ran throwaway probes (since deleted) for the cases below.

**Fixed in this pass (minor)**

- `docs/schema-declarative.md` said `close()` always makes the apply reject with `Database is closed` and report not restored. Running it showed three cases where that is false, so the bullet now states them: `close()` on the yield after the plan's last step with no seeding resolves as success; just before a table's seed rows it rejects with `Cannot apply seed data: table … not found after migration`; during seeding it rejects with the seed error and no not-restored line. The wording now also limits the not-restored report to "once a migration step has landed", which closes the empty-journal gap the handoff listed. The empty-journal case itself was read from the code, not run.
- `docs/usage.md` said statements queued behind `close()` are refused with `Database is closed`. Running it showed `exec` does, while `db.get` and `stmt.get` report `Statement finalized`. Corrected.
- `docs/schema-declarative.md` now says synchronous reads such as `db.prepare(sql).getColumnNames()` see the mid-apply catalog (read from the code, not run), and that a module batch can span event-loop turns even when its hooks never wait.
- Removed the `budgetMs` parameter of `createEventLoopPacer`, which no caller passed.

**Major: none filed.** The `close()` cases above are instances of the existing `backlog/bug-close-returns-while-statement-still-running`, so they went in as an arm on that ticket rather than a new one. A check inside the pacer would not settle them cheaply: throwing there is outside the path that reports step failures as data, so it would skip the unwind.

**Checked and correct**

- Reads issued mid-apply: `db.get`, `stmt.all` and committed `db.get`/`db.eval` on a table a later step creates all wait and answer from the final catalog, with no early "not found" from the routing compile. `select *` on a table a later step alters returned the final columns, and after a failed apply it returned the restored columns, so the column names captured inside the mutex are not stale.
- A committed read during seeding of a table the apply just created saw 0 rows throughout, as documented.
- `close()` with the apply run through `db.eval` and through a prepared `run()` rejects the same way as `exec`, with no unhandled rejection. Queued `exec` batches and atomic batches are refused cleanly.
- `checkOpen` placement: every caller of `_executeSingleStatement` is a statement path, and no package outside `packages/quereus/src` calls `_execWithinTransaction` or `_execAstWithinTransaction`. External-change ingestion holds the mutex, so it queues like any statement.
- Seed semantics per row: the batch was already sequential single statements with no shared savepoint, so only the error text changes. A self-referencing foreign key seeded child-first still applies.

**Tests:** kept all seven. Each is tied to a contract in the docs section, and the implementer's mutation runs showed each fix is pinned. None added: the review's defects were documentation, and pinning the `close()` race outcomes would freeze behaviour the backlog ticket intends to change.

**Tripwires:** none new. The existing `NOTE:` on `yieldToEventLoop` covers hidden browser tabs.

**Not verified**

- Browsers and React Native were not run, and the hidden-tab slowdown was not measured.
- The backward-clock branch in the pacer has no test. It is one condition, and a test would need to fake `Date.now`.
- The macOS yield cost is the reporter's figure.
- `yarn test:store` was not re-run after this pass's edits, which were documentation and the removal of an unused parameter. It passed at the implement stage (10950 passing, 0 failing).

**Validation after the edits:** `yarn lint` passes. `yarn test` across all workspaces has no failures, including `@quereus/quereus` at 10957 passing, 25 pending. The implement stage had not run the other workspaces.

**Deliberately not done (carried from implement):** lens deployment is not paced, cancellation remains a separate request, and no comment was posted on issue #34. The reporter's `node:test` file was not ported.

## Usage

```ts
const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 45_000));
// The race can now be lost, but the apply keeps running after it does.
await Promise.race([db.exec('apply schema main'), timeout]);
```
