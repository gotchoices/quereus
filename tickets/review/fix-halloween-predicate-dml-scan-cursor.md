description: A DELETE or UPDATE with a matching WHERE clause used to crash on storage backends whose scan cursor breaks when the table changes underneath it; the engine now finishes reading which rows to change before it starts changing them, gated by a per-module capability flag so in-memory tables keep their fast streaming path.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts          # moduleHasScanSnapshotIsolation + drainSourceRows helpers; gating in runUpdate/runDelete; runWithStatementSavepoints rows param type widened
  - packages/quereus/src/vtab/module.ts                         # new VirtualTableModule.scanSnapshotIsolation flag (default false)
  - packages/quereus/src/vtab/memory/module.ts                  # MemoryTableModule declares scanSnapshotIsolation = true
  - packages/quereus/test/vtab/test-fragile-cursor-module.ts    # reproduction module (unchanged; pre-existing)
  - packages/quereus/test/vtab/fragile-cursor-halloween.spec.ts # regression spec: un-skipped, +FK-cascade case, +memory-flag assertion
  - docs/runtime.md                                             # new "DML executor: read/write phase separation (physical Halloween)" subsection
difficulty: medium
----

# Review: predicate DELETE/UPDATE no longer invalidates its own scan cursor

## What the change does (plain terms)

A `DELETE FROM t WHERE <pred>` / `UPDATE t SET ... WHERE <pred>` that matches rows
used to interleave read and write on one live cursor: pull a source row from the
scan over `t`, apply the mutation inline (which mutates `t`), pull the next row
from the same cursor. On a backing store whose scan cursor caches a path into a
shared b-tree, the first write invalidates that path and the next `cursor.next()`
throws `Path is invalid due to mutation of the tree`. The memory vtab masks this
(it snapshots reads onto an immutable layer), which is why it was never caught.

The fix separates the read phase from the write phase — but only where needed:

- New module capability flag `VirtualTableModule.scanSnapshotIsolation` (default
  **false**). `true` = a `query()` iterator sees a stable snapshot even if
  `update()` mutates the same table mid-scan.
- `runUpdate`/`runDelete` (`dml-executor.ts`): if the target module's flag is not
  `true`, fully **drain** the source scan into an array (`drainSourceRows`) before
  entering the savepoint/mutation loop, closing the cursor before the first write.
  If `true`, **stream** exactly as before.
- `MemoryTableModule` declares `scanSnapshotIsolation = true` → keeps streaming,
  zero perf change, existing behavior unchanged.

The false default is correctness-first: every durable / third-party store (store,
isolation overlay, leveldb/indexeddb plugins) is correct out of the box (it
buffers) and opts into streaming only after it can prove per-scan snapshot
isolation.

## Why this is safe / semantically better

- Draining reads before writes is exactly SQLite's model ("figure out which rows
  to change, then change them"). For UPDATE the flatRows already carry OLD+NEW
  (the SET projection ran upstream as each row was pulled), so draining evaluates
  all SET values against the pre-mutation snapshot — strictly more correct than
  streaming, never less.
- `drainSourceRows` feeds the SAME `runWithStatementSavepoints` loop. Its
  `rows` param type was widened from `AsyncIterable<Row>` to
  `AsyncIterable<Row> | Iterable<Row>` (a `for await ... of` consumes either).
  Savepoint / FAIL-mode / RETURNING logic is untouched — RETURNING still streams
  per row after the drain.
- FK cascade: a cascade issues its own child DELETE/UPDATE through a fresh
  executor call, which makes its own drain-or-stream decision from the *child*
  module's flag. No cross-interaction.

## How to validate (use cases)

Regression spec: `test/vtab/fragile-cursor-halloween.spec.ts` (was `describe.skip`,
now live). Run just it:

```
cd packages/quereus
node --import ./register.mjs ../../node_modules/mocha/bin/mocha.js \
  "test/vtab/fragile-cursor-halloween.spec.ts" --colors
```

8 cases, all passing after the fix (5–6 of them threw `Path is invalid due to
mutation of the tree` against HEAD before it):
- PK-prefix predicate DELETE (composite PK)
- non-PK-column predicate DELETE (single PK)
- predicate UPDATE
- delete-then-reinsert children in one transaction
- zero-match DELETE control (was the lone passing case pre-fix)
- DELETE ... RETURNING (yields deleted rows AND clears them)
- **FK cascade delete** — parent predicate DELETE matching multiple rows whose
  ON DELETE CASCADE fires a child DELETE per parent; both tables fragile, so
  streaming either scan would throw. Exercises drain on parent + each child scan.
- **memory-flag assertion** — `MemoryTableModule.scanSnapshotIsolation === true`,
  fragile module's is falsy. This is the pin that memory keeps streaming (no
  buffering regression) while the fragile stand-in buffers.

Full suite: `yarn test` → all green (quereus core 6432 passing / 9 pending;
store 675; sync/isolation/web/etc. all pass). `yarn workspace @quereus/quereus
lint` → clean.

## Known gaps / honest flags for the reviewer

1. **Store / isolation / plugins left at default (buffered), NOT audited to prove
   snapshot isolation.** This is the conservative-correct choice the ticket
   endorsed, but it means predicate DELETE/UPDATE against the store now buffers
   the match set instead of streaming. All store *unit* tests
   (`packages/quereus-store`) pass. However **`yarn test:store` (the LevelDB-backed
   re-run of quereus logic tests) was NOT run in this ticket** — no store code
   changed, and buffering is strictly-safer than streaming, but the LevelDB path
   wasn't exercised here. Worth a run during review or before release. A future
   optimization could set `scanSnapshotIsolation = true` on store IF someone
   proves its scan is isolated from same-statement writes (it uses a
   pending-over-committed overlay; plausibly qualifies, but unverified).

2. **Memory-cost tripwire (recorded in code).** A `// NOTE:` sits at the buffering
   site in `runUpdate` (`dml-executor.ts`): a non-snapshot-isolated
   `UPDATE big SET ... WHERE rare` matching millions now materializes the whole
   match set. Accepted cost of correctness (such a store cannot safely stream-delete
   anyway); memory tables are unaffected (they stream). Not a ticket — it is
   conditional and lives at the site.

3. **The memory "streaming-preserved" assertion is a flag-value pin, not a
   behavioral observation.** Directly observing that memory does *not* buffer is
   hard (buffered vs streamed both produce correct rows and memory tolerates
   mutation-during-scan either way). The test asserts the gating input instead. A
   reviewer wanting a stronger guarantee could add an instrumentation hook, but
   the flag is the honest correctness boundary.

4. **`drainSourceRows` has no separate abort poll** — it relies on the source
   scan-leaf's own cancellation checkpoint (every DELETE/UPDATE source is a table
   scan, which polls the signal). The per-row `throwIfAborted` inside
   `runWithStatementSavepoints` still runs during the write phase over the buffer.
   Fine as-is; noted in case a future scan-less DELETE/UPDATE source appears.

5. **INSERT-source Halloween (`INSERT ... SELECT` from the same target) is out of
   scope** — different node (`runInsert`), covered today by the memory savepoint
   snapshot + existing CTE/Halloween machinery. The boundary is documented in
   `docs/runtime.md`. Flag if a durable-store `INSERT ... SELECT self` case turns
   up; it is a separate ticket.

## Review findings

- Tripwire parked: memory-cost `// NOTE:` at the buffering site in `runUpdate`
  (`dml-executor.ts`) — non-snapshot-isolated predicate UPDATE/DELETE materializes
  the full match set. Conditional, so it is a code comment, not a ticket.
- Deferral parked: store/isolation/plugins intentionally left buffered (flag
  default false); `yarn test:store` (LevelDB path) not run this ticket — see gap #1.
