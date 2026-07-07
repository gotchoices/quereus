description: A DELETE or UPDATE with a WHERE clause that actually matches rows crashes on storage backends whose scan cursor breaks when the table is changed underneath it; the engine must finish reading which rows to change before it starts changing them.
files:
  - packages/quereus/src/runtime/emit/dml-executor.ts        # runDelete (L918), runUpdate (L770), runWithStatementSavepoints (L423) — the interleaved read/write loop
  - packages/quereus/src/vtab/module.ts                       # VirtualTableModule capability flags (concurrencyMode L82) — add scan-snapshot flag here
  - packages/quereus/src/vtab/memory/module.ts                # MemoryTableModule — declares the new flag true (keeps streaming)
  - packages/quereus/test/vtab/test-fragile-cursor-module.ts  # reproduction module (already written) — mutation-intolerant scan cursor
  - packages/quereus/test/vtab/fragile-cursor-halloween.spec.ts # regression spec (already written, currently describe.skip) — un-skip
  - docs/runtime.md                                           # DML executor / statement-savepoint section — document the read/write phase separation
difficulty: medium
----

# Fix: predicate DELETE/UPDATE invalidates its own scan cursor (physical Halloween)

## Symptom

A `DELETE FROM t WHERE <predicate>` (or `UPDATE ... WHERE <predicate>`) that **matches
one or more rows** throws:

```
QuereusError: Error during query on table '<t>': Path is invalid due to mutation of the tree
```

against a backing store whose scan cursor caches a path into the tree and is invalidated
when the tree is mutated (reported against an `@optimystic/db-core` strand). A predicate
matching **zero** rows succeeds; pure INSERT never fails. The memory vtab never reproduces
it. This is the classic **Halloween problem**: the statement mutates the same structure its
own scan cursor is still walking.

## Root cause (confirmed)

`runDelete` (`dml-executor.ts:918`) and `runUpdate` (`:770`) hand the source scan straight
to `runWithStatementSavepoints` (`:423`), whose core loop is:

```ts
for await (const flatRow of rows) {      // rows === the source scan over target table t
    rowToYield = await processRow(flatRow); // processRow → vtab.update({operation:'delete'|'update'})
    ...
}
```

The executor pulls one row from the scan cursor, applies the DELETE/UPDATE **inline** (which
mutates `t`), then pulls the next row from the *same* still-open cursor. The read phase and
the write phase are interleaved on one live cursor.

Why memory masks it: `MemoryTableModule` snapshots reads onto an immutable layer — "SELECT
iterates an immutable layer while INSERT writes a fresh child BTree"
(`src/vtab/memory/layer/connection.ts:36-42`), so the scan cursor is frozen at open and never
sees the mutation. Stores without per-scan snapshot isolation (a plain shared b-tree cursor)
have their cached path invalidated the instant the first matching row is deleted, and the
next `cursor.next()` throws.

Confirmed by a purpose-built reproduction (`test-fragile-cursor-module.ts`): a vtab that bumps
a generation counter on every write and throws the exact message if an in-flight scan observes
the change. Against HEAD the regression spec fails 5/6 — PK-prefix DELETE, non-PK-column
DELETE, predicate UPDATE, delete-then-reinsert-in-one-transaction, and DELETE ... RETURNING —
with only the zero-match control passing. The failure stack is exactly
`scan.ts → filter.ts → delete.ts → runWithStatementSavepoints → runDelete`.

Scope note: the ticket named DELETE only; the repro proves **UPDATE has the identical hazard**
(it runs the same interleaved loop). Both must be fixed. INSERT ... SELECT reading the same
target is a *separate* Halloween shape (different node, `runInsert`) — out of scope here (see
Edge cases).

## Correction

Separate the read phase from the write phase: fully drain the source match set **before**
applying any mutation, so the scan cursor is closed before the first write.

**Recommended — capability-gated eager materialization.** Unconditional buffering would add an
O(match-set) memory spike to *every* predicate DELETE/UPDATE, including the memory vtab that
does not need it (a `DELETE FROM big WHERE rare` matching millions would newly materialize them
all). So gate on a module capability, mirroring the existing `concurrencyMode` flag:

- Add a module flag to `VirtualTableModule`, e.g.
  `readonly scanSnapshotIsolation?: boolean` — "a `query()` iterator sees a stable snapshot
  even if `update()` mutates the same table mid-scan." **Default (unset) = false = not
  snapshot-isolated.**
- In `runDelete`/`runUpdate`, when the target module's flag is **not** true, materialize the
  source into an array before entering the savepoint/mutation loop; when true, stream exactly
  as today.
- `MemoryTableModule` declares `scanSnapshotIsolation = true` → keeps streaming, zero perf
  regression, existing tests unaffected.

The **false default is deliberately correctness-first**: any third-party / durable store works
correctly out of the box (it buffers) and opts into streaming only after it can prove per-scan
snapshot isolation. `@optimystic/db-core` needs no change on their side.

Implementation shape (illustrative — implementer refines): the cleanest seam is to drain in
`runDelete`/`runUpdate` and pass the buffered array where `rows` is passed today
(`for await ... of` consumes a sync array fine), leaving `runWithStatementSavepoints`'
savepoint/FAIL-mode logic untouched. Reads are side-effect-free, so draining before the
statement savepoint opens is safe.

**Fallback if the flag surface is judged too heavy:** unconditional buffering in
`runDelete`/`runUpdate` (drop the flag). Simpler, always correct, but imposes the memory cost
above on the memory backend. Prefer the gated version; record the memory-cost tripwire either
way.

## Edge cases & interactions

- **UPDATE parity.** Fix `runUpdate` too, not just `runDelete` — the repro's UPDATE case fails
  identically. Same drain-before-mutate treatment.
- **FAIL-mode per-row savepoints** (`__or_fail_*`) and the **statement savepoint**
  (`__stmt_atomic_*`): buffering changes only *when the source is read*, not the order writes
  are applied or how savepoints wrap them. Rows still process in source order over the buffered
  array. Verify OR FAIL / ON CONFLICT paths still behave (partial-failure unwind unchanged).
- **RETURNING** still streams per row after the drain — the DELETE ... RETURNING case must both
  yield the deleted rows and clear them (covered in the spec).
- **Large match set** on a non-snapshot module: the accepted cost of correctness (that module
  cannot safely stream-delete anyway). Leave a `// NOTE:` at the buffering site. Memory keeps
  streaming, so the common path is unaffected.
- **FK cascade / nested DML**: a cascade issues its own DELETE/UPDATE against the child table
  through a fresh executor call, which makes its own buffering decision from the child module's
  flag. No cross-interaction, but add a cascade-delete case to be sure.
- **In-tree module audit**: with the false default, `quereus-store`, `quereus-isolation`
  overlay, and the leveldb/indexeddb plugins are all correct without change (they buffer).
  Only set the flag `true` where per-scan snapshot isolation is actually guaranteed — memory
  for sure; audit the store/isolation path and set it only if provably safe (else leave it
  buffering, which is what `yarn test:store` already exercises safely today).
- **INSERT ... SELECT from the same target** (insert-side Halloween): out of scope. Different
  node (`runInsert`), and the memory savepoint snapshot + existing CTE-Halloween machinery
  cover today's tested paths. If addressed later it is a separate ticket; note the boundary in
  `docs/runtime.md`.
- **Zero-match DELETE/UPDATE**: no writes, so no cursor invalidation regardless — the control
  case; keep it green.

## Tests

The reproduction module and spec already exist and encode the acceptance criteria:

- `test/vtab/test-fragile-cursor-module.ts` — mutation-intolerant scan-cursor vtab.
- `test/vtab/fragile-cursor-halloween.spec.ts` — currently `describe.skip`; **un-skip it**.
  Cases: PK-prefix predicate DELETE (composite PK), non-PK-column predicate DELETE,
  predicate UPDATE, delete-then-reinsert children in one transaction, DELETE ... RETURNING,
  and the zero-match control. All six must pass after the fix.

Add during implementation:
- A **FK cascade** delete case (parent delete cascading to fragile-cursor children).
- A memory-vtab assertion that the streaming path is preserved (i.e. `scanSnapshotIsolation`
  is honored — memory does not buffer). A plan/behavior check or a targeted unit test on the
  gating predicate is enough.

## TODO

- Add `scanSnapshotIsolation?: boolean` (or better name) to `VirtualTableModule` in
  `src/vtab/module.ts` with a doc comment; default-false semantics via a helper like
  `getModuleConcurrencyMode`'s pattern.
- Gate eager materialization in `runDelete` and `runUpdate` (`dml-executor.ts`) on the flag;
  drain the source to an array when not snapshot-isolated, stream otherwise. Add the memory-cost
  `// NOTE:` at the buffering site.
- Declare `scanSnapshotIsolation = true` on `MemoryTableModule`.
- Audit `quereus-store` / `quereus-isolation` / plugins; set the flag only where snapshot
  isolation is provable, else leave default (buffered).
- Un-skip `fragile-cursor-halloween.spec.ts`; add the FK-cascade case and the memory
  streaming-preserved assertion.
- Update `docs/runtime.md` DML/savepoint section: read phase now fully precedes the write phase
  for non-snapshot-isolated targets; note the INSERT-source Halloween boundary.
- Run `yarn workspace @quereus/quereus lint` and `yarn test` (and note `yarn test:store` if the
  store audit changes anything). All green.
