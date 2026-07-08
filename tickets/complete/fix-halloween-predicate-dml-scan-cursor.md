description: A DELETE or UPDATE with a matching WHERE clause used to crash on storage backends whose scan cursor breaks when the table changes underneath it; the engine now finishes reading which rows to change before it starts changing them, gated by a per-module capability flag so in-memory tables keep their fast streaming path.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts          # scanSnapshotIsolation gating + drainSourceRows + resolveDmlSourceRows (review fix); runUpdate/runDelete
  - packages/quereus/src/vtab/module.ts                         # VirtualTableModule.scanSnapshotIsolation flag (default false)
  - packages/quereus/src/vtab/memory/module.ts                  # MemoryTableModule declares scanSnapshotIsolation = true
  - packages/quereus/test/vtab/test-fragile-cursor-module.ts    # reproduction module (pre-existing)
  - packages/quereus/test/vtab/fragile-cursor-halloween.spec.ts # regression spec: un-skipped, +FK-cascade case, +memory-flag assertion
  - docs/runtime.md                                             # "DML executor: read/write phase separation (physical Halloween)" subsection
----

# Complete: predicate DELETE/UPDATE no longer invalidates its own scan cursor

## What shipped

A `DELETE FROM t WHERE <pred>` / `UPDATE t SET ... WHERE <pred>` that matches rows
used to interleave read and write on one live cursor. On a backing store whose
scan cursor caches a path into a shared b-tree, the first inline write invalidated
that path and the next `cursor.next()` threw `Path is invalid due to mutation of
the tree`. The memory vtab masked it (reads snapshot onto an immutable layer).

Fix separates read phase from write phase, gated per module:

- New `VirtualTableModule.scanSnapshotIsolation` flag (default **false**).
- `runUpdate`/`runDelete` (`dml-executor.ts`): if the target module's flag is not
  `true`, fully **drain** the source scan into an array before entering the
  savepoint/mutation loop (cursor closed before the first write); if `true`,
  **stream** exactly as before.
- `MemoryTableModule` declares `scanSnapshotIsolation = true` → keeps streaming,
  zero perf change.

False default is correctness-first: durable / third-party stores buffer (safe out
of the box) and opt into streaming only after proving per-scan snapshot isolation.

## Review findings

### Checked

- **Read/write phase split correctness** — draining evaluates all UPDATE SET
  values against the pre-mutation snapshot (SET projection runs upstream as each
  source row is pulled); matches SQLite's "figure out which rows, then change
  them." Strictly ≥ correct vs streaming. OK.
- **Type widening** of `runWithStatementSavepoints` `rows` param to
  `AsyncIterable<Row> | Iterable<Row>` — `for await ... of` consumes either;
  savepoint / FAIL-mode / RETURNING logic untouched. Only other caller
  (`runInsert`) still streams. OK.
- **FK cascade** — child DELETE/UPDATE runs through a fresh executor call that
  makes its own drain-or-stream decision from the *child* module's flag. Covered
  by the new FK-cascade spec case (both tables fragile). OK.
- **Memory flag claim** — `scanSnapshotIsolation = true` preserves the exact
  pre-existing streaming behavior memory already had and that the full suite
  exercises; no behavioral change. OK.
- **No other in-repo module relied on streaming for correctness** — draining a
  DELETE/UPDATE match set is always semantically safe (only a perf/memory cost);
  full quereus suite (6432 passing) confirms every DML path still works with the
  drain default. OK.
- **docs/runtime.md** — new subsection read in full; accurately describes the
  flag, the drain, the buffering cost, FK-cascade behavior, and the INSERT-source
  out-of-scope boundary. Matches the code. OK.
- **Lint + tests** — `yarn workspace @quereus/quereus lint` clean (eslint +
  test-file type-check); `yarn test` → 6432 passing / 9 pending, exit 0.

### Found + fixed inline (minor)

- **Resource-cleanup regression: target vtab leaked if the source drain throws.**
  `getVTable()` connects the target write vtab; `disconnectVTable()` runs only in
  `runWithStatementSavepoints`'s `finally`. The implement diff consumed the drain
  (`await drainSourceRows(rows)`) *outside* that try/finally, so a scan I/O error
  — or an abort mid-drain, the very cancellation path the implementer's gap #4
  leans on — would skip the target vtab's `disconnect()`. The old streaming code
  consumed the source *inside* the try, so disconnect always ran. Narrow (only
  non-snapshot-isolated targets, only on scan/abort error), but a genuine leak for
  durable stores whose `disconnect()` releases a connection/handle.
  **Fix:** extracted `resolveDmlSourceRows(ctx, vtab, tableSchema, rows)` (DRY,
  used by both `runUpdate` and `runDelete`); it disconnects the target vtab on a
  drain failure before re-throwing, matching the streaming path. Strictly-additive
  cleanup on the error path — no correctness change. Lint + full suite re-run green.

### Tripwires / deferrals parked (not tickets)

- **Memory-cost `// NOTE:` at the buffering site in `runUpdate`** (carried over
  from implement) — a non-snapshot-isolated `UPDATE big SET ... WHERE rare`
  matching millions materializes the whole match set. Conditional, lives at the
  site. Reviewed and left in place.
- **No direct regression test for the cleanup fix.** Triggering a *drain-time*
  throw needs new scaffolding: the fragile fixture's `query()` only throws *after*
  a write (never during a pure drain), its `disconnect()` is a no-op with no
  counter, and any disconnect assertion would be muddied by the source scan's own
  separate connect/disconnect lifecycle. The fix is strictly-additive error-path
  cleanup, so I deferred the test rather than bolt on a scan-throwing module +
  disconnect instrumentation. If a future change makes drain-time failure common,
  add a throw-on-scan fixture with a disconnect counter and assert target-vtab
  disconnect on drain error.
- **`yarn test:store` (LevelDB path) not run** — carried over from implement
  gap #1. The store is non-snapshot-isolated and now takes the *same* drain path
  the fragile module exercises (which passes); buffering is strictly less
  demanding than streaming (cursor closed before writes), so the store is
  logically safer, not riskier. Deferred per AGENTS.md (test:store is a
  release-prep / store-diagnosis suite, slower; wall-clock risks the agent idle
  budget). Worth a run before release.

### Not filed as tickets — reasons

- **No major findings** → no new fix/plan/backlog tickets. The one defect found
  (vtab leak on drain error) was minor and fixed inline.
- **INSERT-source Halloween** (`INSERT ... SELECT` from the same target) remains
  out of scope — different node (`runInsert`), documented boundary in
  `docs/runtime.md`, covered today by memory savepoint snapshot + existing
  CTE/Halloween machinery. Not a regression from this change; no ticket unless a
  durable-store `INSERT ... SELECT self` case surfaces.

## Validate

Regression spec (8 cases, all passing; 5–6 threw `Path is invalid due to mutation
of the tree` against HEAD before the fix):

```
cd packages/quereus && yarn test    # runs the whole suite incl. fragile-cursor-halloween.spec.ts
```

Full suite: 6432 passing / 9 pending. Lint: clean.
