description: Applying a schema used to hold the thread until it finished, so a caller's timeout could not fire and a browser or mobile interface froze. It now gives up the thread periodically during a long apply, and two gaps that this would have exposed are closed, so other code cannot see or damage a half-applied schema.
architecture: docs/schema-declarative.md#yielding-during-an-apply
repro: verified
files:
  - packages/quereus/src/util/event-loop.ts # new: yieldToEventLoop, createEventLoopPacer (16 ms budget)
  - packages/quereus/src/runtime/emit/schema-declarative.ts # pacer threaded through the migration loop and unwind; one call per seed row (executeSeedRow)
  - packages/quereus/src/core/database.ts # _setSchemaMigrating and its check in _isConcurrentReadEligible; checkOpen in _executeSingleStatement
  - packages/quereus/src/vtab/test-support/commit-stall.ts # settleMacrotasks reuses yieldToEventLoop
  - packages/quereus/test/apply-schema-yields.spec.ts # new
  - docs/schema-declarative.md
  - docs/sql-txn.md
  - docs/usage.md
  - docs/architecture.md
----

From GitHub issue #34. When a module's schema hooks do no real waiting, `apply schema` ran entirely inside one turn of the event loop, so a `Promise.race` timeout could not win and an interface froze.

## What changed

- **The yield.** One pacer per apply, created at the top of the `run` in `emitApplySchema`. It is awaited after each migration step, after each undo statement and after each seed row, and only gives up the thread once 16 ms have passed since the last yield.
- **Seed rows** now run as one `_execWithinTransaction` call per row, so the apply can yield inside a table's seed. The seed error now names the failing row instead of embedding the whole table's SQL.
- **Committed reads.** `_isConcurrentReadEligible` returns false while `_schemaMigrating` is set. That flag is held only around `runBatchedMigrationLoop`, so seeding does not disqualify a read. Such a read falls back to the serialized path, which waits for the apply.
- **`close()` mid-apply.** `_executeSingleStatement` now calls `checkOpen()`, so the next step and every undo statement are refused, and the apply rejects. This also refuses any `exec` statement queued behind the mutex when `close()` ran. Nothing `close()` itself calls reaches this method (checked by reading its callers).

## Measurements

All on this Windows machine, noisy, from a 5000-row seed and a 2000-table apply. The prior build is the compiled `dist`; the new code ran from source through the type-stripping loader, so this comparison of totals is inexact.

| Case | Prior build | This change |
| --- | --- | --- |
| 5000-row seed, timer turns during the apply | 0 | 119–138 |
| 5000-row seed, longest stall | the whole apply (1086–2878 ms) | 33 ms |
| 5000-row seed, median total, 2 passes of 7 runs | 1378, 1552 ms | 2954, 2900 ms |
| 2000-table apply, longest stall | the whole apply (56–126 ms) | 26–32 ms |
| 2000-table apply, total | 56–126 ms | 103–164 ms |

**A long apply takes about twice as long on Windows.** One `setTimeout(0)` costs about 15 ms there, against a 16 ms budget. The reporter measured about 1 ms per yield on macOS, so the cost there should be much smaller, but that was not measured here.

The ticket left the per-row parse cost as "not measured". On one build, batched and per-row execution of the same 5000 statements had medians of 1802 and 1865 ms over 9 alternating runs, about 3.5% and within the run-to-run spread.

## Tests added (`apply-schema-yields.spec.ts`)

| Test | What it verifies |
| --- | --- |
| timers run between migration steps | A timer sees a mid-plan count of created tables |
| timers run between undo statements | A timer sees a mid-unwind count of dropped tables |
| timers run between seed rows | A timer sees a mid-seed count of checked rows, and all rows land |
| a serialized statement runs after the apply | Issued mid-apply, it sees the plan's last table |
| a committed read does not see a table the failing plan undoes | Issued while the table is in the catalog, it reports the table not found |
| close() rejects the apply | The apply rejects with `Database is closed` and the not-restored line, later steps do not run, and no tables remain |
| a step failing after yields restores the catalog | The catalog fingerprint is back and no schema events are announced, inside an explicit transaction |

Each fix was disabled in turn to confirm a test depends on it: pacer never yields (all 7 fail), no pace between steps (4), between undo statements (1), between seed rows (1), no migrating check (the committed-read test), no closed check (the close test). The first version of this spec passed three tests without any yield; each of those now asserts that its timer fired mid-apply.

## Validation

- `yarn workspace @quereus/quereus test`: 10957 passing, 25 pending, 0 failing.
- `yarn test:store`: 10950 passing, 32 pending, 0 failing. It prints `[TransactionCoordinator] … out of range` savepoint warnings, which also appear in older store logs from other tickets.
- `yarn lint`: passes, including the test type-check.
- Not run: the other workspaces' test suites. `packages/quereus-store/test/isolated-store.spec.ts` uses `settleMacrotasks`, whose behaviour should be unchanged.

## Known gaps for the reviewer

- **Only tested on node on Windows.** Browsers and React Native were not run, and the slowdown in hidden browser tabs was not measured (there is a `NOTE:` on `yieldToEventLoop`).
- **Closed database with an empty journal (read from the code, not run).** If `close()` lands before any undo is journaled, for example during a module's async `beginSchemaBatch`, and the pre-apply catalog was empty, the fingerprint check passes against the cleared catalog. The apply still rejects with `Database is closed`, but without the not-restored line and with its schema events retracted. No step had landed in that case, so the report is not false. `docs/schema-declarative.md` says a migrating apply reports not restored without carving this out.
- **`close()` during seeding** rejects with the seed error, not the not-restored line, because the migration has already finished. The docs word this as applying to "a migrating apply".
- **Prepared statements queued behind the mutex at close** do not go through the new check. `close()` finalizes them. This was read from the code, not tested.
- **The backward-clock branch in the pacer has no test.** It is one condition, and a test would need to fake `Date.now`.
- **Deliberately not done:** synchronous catalog APIs are documented as unprotected rather than gated, lens deployment is not paced, and cancellation remains a separate request. The wider close defect stays in `backlog/bug-close-returns-while-statement-still-running`. No comment was posted on issue #34, since the ticket asks for one only if a human requests it. The reporter's `node:test` file was not ported.

## Usage to try

```ts
const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('timed out')), 45_000));
// The race can now be lost, but the apply keeps running after it does.
await Promise.race([db.exec('apply schema main'), timeout]);
```
