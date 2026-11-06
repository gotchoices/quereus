# Runtime DML Execution

> **Stability: Internal** — see [Stability Tiers](stability.md#tiers).

What the DML executor (`runtime/emit/dml-executor.ts`) does around each row of an `INSERT`,
`UPDATE` or `DELETE`: statement-level atomicity and its savepoint modes, the read/write
separation that avoids the physical Halloween hazard, the per-row post-write pipeline, and
batched parent-side RESTRICT. The flat OLD/NEW row these sections refer to is defined in
[Mutation Operations](runtime.md#mutation-operations-always-present-oldnew-model). A satellite of
[Quereus Runtime](runtime.md).

## Statement-Level Atomicity

Unless a violation resolves to FAIL, a multi-row `INSERT`/`UPDATE`/`DELETE` is
atomic at the statement level: either all of its row effects apply or none do,
mirroring SQLite's implicit-savepoint-per-statement semantics. In autocommit this is masked because
`_finalizeImplicitTransaction` rolls back the whole implicit transaction on
error; inside an explicit `begin … rollback` the guarantee comes from a
statement-scope savepoint instead.

All three DML generators route through one shared higher-order async generator,
`runWithStatementSavepoints` (`runtime/emit/dml-executor.ts`), which owns the
savepoint lifecycle and calls back a per-row `processRow` closure for the
operation-specific body. It runs in one of three modes (`DmlSavepointMode`):

- **`statement`** (ABORT default / IGNORE / REPLACE / ROLLBACK): a single
  statement-scope savepoint (`__stmt_atomic_N`) is opened before the row loop,
  released after it completes, and rolled-back-and-released on **any** throw
  escaping the loop — whether from the source iterator (a `ConstraintCheckNode`
  above the executor raising NOT NULL / CHECK / parent-side FK RESTRICT before a
  row is yielded) or from `processRow` (a vtab-returned constraint, or the
  runtime RESTRICT pre-check). This is what reverts rows 1..N-1 when row N fails.
- **`row`** (`or fail`): deliberately *skips* the statement wrap (FAIL keeps prior
  rows) and instead opens a per-row savepoint (`__or_fail_N`), released on success
  and rolled back on throw, so only the failing row's partial work (including a
  row-time MV backing write that landed before a later maintenance throw) is
  undone.
- **`statementAndRow`** (no `or` clause, and the table declares `on conflict fail`
  on any constraint): opens both, because another constraint on the table may
  resolve to ABORT and which action applies is only known when a row fails. A
  `FailConflictError` keeps the earlier rows: the per-row savepoint has undone the
  failing row, and the statement savepoint is released rather than rolled back. Any
  other error rolls the statement savepoint back. A NOT NULL or CHECK violation
  raised by the source iterator arrives with no per-row savepoint open, but that row
  has written nothing. A statement with an `or` clause overrides the declared action,
  so it uses one of the other two modes.

An UPDATE or DELETE on a module without per-scan snapshot isolation drains its source
before writing (see the read/write separation section below), so in
`statementAndRow` mode an error during that drain is held back: the rows read before
it are applied first, then it is raised from the loop. Every failure therefore takes
effect at its own row's position, as it does when streaming, and the rows a declared
FAIL keeps exist on every module.

A row undone by a FAIL must leave nothing for later checks to find. The source queues
a row's deferred checks as the row is pulled, before its savepoint opens, so in
`statementAndRow` mode `RowScopedDeferredChecks` sets them aside and queues them once
the savepoint is open; otherwise COMMIT would evaluate a check for a row that was never
written. A row adds its keys to the batched RESTRICT probe only after it completes, so
the probe does not report children of a parent key the row failed to move.

At the **end-of-statement boundary** — after the row loop completes and **before**
any statement savepoint releases — the generator drains its
per-statement *deferred full-rebuild set* via `Database._flushDeferredRebuilds`.
Only the full-rebuild materialized-view arm is deferred there (the bounded-delta
arms apply per row inside `processRow`); each source row that touched a
full-rebuild MV marked it dirty, and the flush rebuilds each such MV exactly once.
Inside the statement savepoint, a failed rebuild rolls the whole statement back, and
a statement that aborts mid-loop never reaches the flush (so a dirtied-then-aborted
MV leaves its backing untouched). FAIL mode still runs the flush after the loop, but
having no statement savepoint, a flush failure there does not unwind the
already-applied rows — consistent with FAIL's keep-prior-rows semantics. When a FAIL
stops the loop, `row` and `statementAndRow` both run the flush before raising the
error, so an MV does not lag the surviving rows. `statementAndRow` still has its
statement savepoint at that point, so a flush failure there rolls the whole statement
back and supersedes the FAIL. See `docs/incremental-maintenance.md` § end-of-statement
flush.

The savepoint helpers used are always the broadcast variants
(`_createSavepointBroadcast` / `_releaseSavepointBroadcast` /
`_rollbackAndReleaseSavepointBroadcast`) so per-connection savepoint stacks stay
in lockstep with the `TransactionManager`'s stack. This covers the row-time MV
backing connection, which registers lazily on the first maintenance call:
`Database.registerConnection` replays the active savepoint depth (already including
the statement savepoint) onto it, so the backing write participates in the same
rollback/release.

## DML executor: read/write phase separation (physical Halloween)

A predicate `DELETE`/`UPDATE` reads its target table (the source scan) and writes
it (the per-row `vtab.update()`). Streaming those two phases on one live cursor —
pull a source row, apply its mutation inline, pull the next — is the classic
**physical Halloween hazard**: the write mutates the very structure the scan
cursor is still walking. A backing store whose scan cursor caches a path into a
shared b-tree has that path invalidated by the first write and the next
`cursor.next()` throws (e.g. `Path is invalid due to mutation of the tree`).

Whether streaming is safe is a **module property**, so it is gated on a module
capability flag, `VirtualTableModule.scanSnapshotIsolation` (default **false**):

- **Snapshot-isolated (`true`)** — a `query()` iterator sees a stable snapshot
  even if `update()` mutates the same table mid-scan. The memory module qualifies
  (it captures an immutable layer at `query()` entry and writes a fresh child
  layer), so `runUpdate`/`runDelete` **stream** the source, paying no buffering
  cost. This is the common path.
- **Not snapshot-isolated (default)** — `runUpdate`/`runDelete` fully **drain**
  the source match set into an array (`drainBeforeWriting`), closing the scan cursor,
  **before** applying any write. The read phase now precedes the write phase in
  full, matching SQLite's "figure out which rows to change, then change them". The
  drain runs on the row loop's first pull, inside the statement savepoint, because
  reading a row queues its deferred checks and those must roll back with the statement.

The false default is correctness-first: any durable / third-party store is correct
out of the box (it buffers) and opts into streaming only once it can prove per-scan
snapshot isolation. Buffering costs O(match-set) memory for such a store (a
`DELETE big WHERE rare` matching millions materializes them all) — the accepted
price of correctness, since such a store cannot safely stream-delete anyway. The
drain feeds the same `runWithStatementSavepoints` loop, so savepoint / FAIL-mode /
RETURNING semantics are unchanged (RETURNING still streams per row after the
drain). An FK cascade issues its own child `DELETE`/`UPDATE` through a fresh
executor call, which makes its own drain-or-stream decision from the *child*
module's flag.

**Boundary — INSERT-source Halloween is out of scope here.** An
`INSERT … SELECT` reading the same table it inserts into is a *different* Halloween
shape (the insert node, `runInsert`), not addressed by this read/write split; it
relies on the memory savepoint snapshot plus the existing CTE/Halloween machinery.

## Per-row post-write pipeline and internal evictions

After each successful `vtab.update()`, the executor's `processRow` body runs one
**post-write pipeline** for the row: change-tracking (`_recordInsert` /
`_recordUpdate` / `_recordDelete`, consumed by `Database.watch` / change-scope and
the `DeltaExecutor`), row-time materialized-view backing maintenance
(`maintainRowTimeStructures`), foreign-key `ON DELETE` / `ON UPDATE` actions
(`executeForeignKeyActions`), and — for modules without native event support — a
data-change auto-event. This pipeline has exactly one home; substrates do not drive
any of it themselves.

**Raw flows down, stored flows back up.** Coercion to the declared logical type
happens *inside* `vtab.update()` (`coerceRowToSchema` in the memory manager and the
store table; the overlay's own coercion in the isolation layer), so the row the
executor hands **down** still carries the statement's un-converted input — a `json`
column's `'{"a":2}'` is TEXT there, an `integer`-affinity column's `'7'` still a
string — while a subsequent `select` reads back the coerced one. Every post-write
consumer must therefore see the **stored** row, reported as `UpdateResult.row`: the
executor recovers it via `storedRowOrRaw` and feeds it to change-tracking, row-time
MV maintenance, the FK cascade, the changed-column comparison, the auto-event, and
the row yielded downstream to `RETURNING` (`withStoredNewSection` swaps the NEW half
of the flat OLD/NEW row). Nothing is coerced *before* the write, so the row is
coerced exactly once and non-idempotent parses are never re-entered.

`UpdateResult.row` carries two signals, and all four arms read the first. Its
**presence** means a row really was written or removed; every arm short-circuits and
returns nothing downstream when it is absent, which is how a key-not-found
UPDATE/DELETE and a module-resolved IGNORE conflict are reported. Its **contents**
are the stored row, read only by INSERT/UPDATE: `storedRowOrRaw` falls back to the
raw row when the reported row's width is not the table's column count, covering a
minimal test/sample module that echoes its input (raw *is* stored for one that never
coerces). DELETE reads only the presence — its OLD image comes from the source scan
and is already a stored row, and the isolation layer returns a synthetic PK-only
placeholder there. See `bug-dml-downstream-uses-uncoerced-row`.

A REPLACE conflict resolved inside `vtab.update()` can delete rows the executor
never asked it to touch. Two channels on the `ok` `UpdateResult` report them so the
pipeline still runs uniformly (`internal-eviction-reporting`):

- **`replacedRow`** — the row displaced at the *same PK* by a PK-collision REPLACE,
  modeled as an update-in-place of that PK slot (FK fired as a delete of the old
  image).
- **`evictedRows`** — rows at *other PKs* removed because REPLACE resolved a non-PK
  UNIQUE conflict for this same call. The executor runs the **full delete pipeline**
  for each (a shared `processEvictions` helper: `_recordDelete` +
  `maintainRowTimeStructures({op:'delete'})` + `executeForeignKeyActions('delete')` +
  a delete auto-event), fired **before** the writing row's own bookkeeping so the
  evict-then-write order the substrate journaled is preserved. This is what makes a
  secondary-UNIQUE REPLACE eviction fire FK cascades, change subscriptions, events,
  and covering-MV backing maintenance — uniformly across the memory, store, and
  isolation substrates, none of which re-drive the pipeline themselves.

The two channels co-occur: a PK-collision REPLACE does not exempt the write from the
table's other UNIQUE constraints. Each substrate still checks every secondary UNIQUE
under its own action (statement OR > constraint default > ABORT) — so
`insert or replace` into `(id pk, v unique)` can displace the row at its PK
(`replacedRow`) *and* evict another row holding the same `v` (`evictedRows`), while a
PK-level `on conflict replace` with a plain `unique` column fails with the UNIQUE error,
as in SQLite.

`processEvictions` enforces FK `RESTRICT` / `NO ACTION` for the eviction's would-be
delete alongside the FK *actions* (`CASCADE` / `SET NULL` / `SET DEFAULT`). The substrate
has already physically removed the evicted row inside `vtab.update()`, so there is no
pre-mutation point at which to block; instead the helper runs the transitive RESTRICT scan
(`assertTransitiveRestrictsForParentMutation`) **post-eviction** — the child rows the scan
keys off remain, so `select 1 from child where fk = ?` still answers correctly — and throws
on a violation. `runWithStatementSavepoints` then rolls back the statement-scope savepoint
(`__stmt_atomic_N`, opened before the row loop), unwinding both the substrate's eviction and
the writing row. (Evictions only occur under REPLACE resolution, which an `or fail`
statement never has, so the statement savepoint is always open, and the RESTRICT error is
never a `FailConflictError`.) The surfaced error is the
`FOREIGN KEY constraint failed: DELETE on '<parent>' violates RESTRICT from '<child>'`
form — not the plan-time `CHECK constraint failed: _fk_...` form — since the plan-time
parent-side FK check is absent for internal evictions. Enforced on the key-based memory,
direct-store, and isolation-wrapped substrates. Rowid-chained backends (lamina) are out of
scope: the transitive recursion reads children at call time and, post-eviction, the parent
value is gone, so a deeper cascade may not resolve — mirroring the documented SET-DEFAULT
recursion gap.

**Internal statement cache.** The per-row FK/DDL enforcement statements — the RESTRICT
existence probe (`assertNoRestrictedChildrenForParentMutation` and its lens dual), the
transitive cascade pre-walk child scan, the cascade DML (`executeSingleFKAction`'s and
`issueLensFkAction`'s `DELETE`/`UPDATE`), and the drop-referencing check
(`SchemaManager.assertNoReferencingChildrenForDrop`) — run through a per-`Database` LRU pool
of compiled statements keyed by exact SQL text (`InternalStatementCache`) rather than a fresh
`prepare`/`finalize` per affected row (the engine has no plan cache, so each fresh prepare
pays a full parse + plan + emit). Each fixed shape compiles once and rebinds; a bulk cascade
over N parents runs a couple of compiles, not 2N. Correctness rides existing `Statement`
behavior: the compiled statement subscribes to schema-change notifications and lazily
recompiles across intervening DDL, and a cascade re-entering with the same SQL text while
that statement is mid-iteration falls back to a fresh one-shot statement (the busy-guard)
rather than sharing a live cursor. Internal probes are prepared type-agnostically, so a
loose-affinity FK column binding an integer key on one row and a text key on another under
one SQL shape is neither rejected nor served a first-use-frozen plan. Deliberately internal —
not a public statement-cache feature. The batched RESTRICT flush is a handful of compiles per
statement, not per row, so it stays on the plain `prepare` path.

## Batched RESTRICT

Parent-side RESTRICT enforcement normally costs **two** probes per mutated parent row per
inbound FK: the plan-time synthesized `NOT EXISTS(select 1 from child where fk = OLD.pk)`
constraint (compiled once, evaluated per row by `ConstraintCheckNode`) and the runtime
transitive pre-walk (`assertTransitiveRestrictsForParentMutation` inside
`processDeleteRow` / `processUpdateRow`). On a high-latency store each probe is a storage
round-trip, so a bulk parent DELETE costs O(rows × FKs) round-trips even when nothing
references the deleted keys.

For statement shapes where it is provably equivalent, both per-row probes are replaced by
**one chunked probe per inbound FK at the end-of-statement boundary**. The shared
batchability gate, `getBatchableRestrictFks` (`planner/building/foreign-key-builder.ts`),
is consulted by both the plan builders (`buildDeleteStmt` / `buildUpdateStmt` skip the
per-row `NOT EXISTS` checks) and the DML executor (`runDelete` / `runUpdate` skip the
per-row pre-walk), so the two sides cannot disagree. A DELETE/UPDATE batches iff it is
not lens-routed, its effective conflict resolution is default/ABORT or ROLLBACK, and
**every** inbound FK is a non-self-referential `restrict` for the op:

- **FAIL / IGNORE / REPLACE** have per-row keep/skip semantics a statement-end check
  cannot honor (`or fail` keeps prior rows; the gate excludes it, so the flush always
  runs under the statement-scope savepoint). The gate reads only the statement's `or`
  clause, so a table that declares `on conflict fail` still batches: its `statementAndRow`
  mode has the statement savepoint, and the flush also runs when a declared FAIL stops the
  row loop, so the rows that FAIL would keep cannot skip the probe. A violation found there
  is an ABORT, which undoes those rows.
- **Any cascading / set-null / set-default inbound FK** forces the per-row transitive
  pre-walk, which must interleave with cascade execution (a cascade could delete a
  RESTRICT child's rows mid-statement).
- **A self-referential FK**'s check outcome depends on which rows of the same table the
  statement has already deleted, so it stays per-row.

The gate takes the `Database`, not a bare `SchemaManager`, because it answers two questions
that must not be split across callers: it reports "not batchable" whenever `pragma
foreign_keys` is off (nothing is enforced on either route, so the executor builds no batch),
and it **raises** on an inbound FK whose child column count does not match the parent key it
references (see [Constraints § 7.6 FOREIGN KEY](sql-constraints.md#76-foreign-key-constraint)) — the
batch is that FK's only enforcement on this route, so skipping it would leave the key
unenforced here alone. The executor calls the gate on every DELETE/UPDATE and has no other
pragma check in front of it.

During the row loop the executor accumulates each affected row's OLD referenced-key tuple
into per-execution, per-FK state (`createParentRestrictBatch` /
`accumulateParentRestrictKeys`, `runtime/foreign-key-actions.ts`) — deduplicated on an
injective serialization, skipping tuples containing NULL (MATCH SIMPLE) and UPDATE rows
that change no referenced column. "Change" means the value the column will actually
**store** differs, not that the UPDATE text differs: both rows arrive in stored form (the DML
emitters convert NEW to the declared column types before the pre-checks run), so rewriting a
key as an equivalent-but-differently-spelled value (`1` as the text `'1'`, a JSON object with
reordered keys) is not a change. Value identity is widened only by the key's own collation —
the one resolved over the child and parent column ([Constraints § 7.6 FOREIGN
KEY](sql-constraints.md#76-foreign-key-constraint), *Collation*): under a NOCASE key a
case-only re-key is not a change, since every child that matched the old key still matches.
The same test (`referencedKeyValueChanged`) backs the per-row pre-walk, the cascade actions,
the lens pre-check and the plan-time `NOT EXISTS` skip in `runtime/row-constraints.ts`, so
every enforcement site agrees. The state is per execution (never on the emit
closure), so a re-run prepared statement starts empty. `flushParentRestrictBatch` fires in
`runWithStatementSavepoints` after the row loop, **before** the deferred-maintenance flush
(fail fast — skip wasted MV work) and before the statement savepoint releases, probing
each FK's child table in ~500-key chunks (`fkcol in (?, …)`, or OR-of-conjunctions for a
composite FK — plain SQL `=`/`IN` against the child column, plus an explicit `collate` when
the key's collation differs from the child column's own, since a bound parameter carries
none — so the probe compares exactly as the per-row `NOT EXISTS` does). A hit throws the same
`FOREIGN KEY constraint failed: DELETE on '<parent>' violates RESTRICT from '<child>'`
error and the statement savepoint unwinds every row — the same final state and error class
as a per-row abort. The REPLACE-eviction path (`processEvictions`) always stays per-row.

The one observable divergence: a consumer streaming `RETURNING` rows sees **all** rows
yielded before the violation aborts the statement, instead of only the rows preceding the
violating one — transient output before an error that voids the statement either way.
