description: Batch ingestion seam (`Database.ingestExternalRowChanges`) so externally-applied row changes drive the post-write pipeline — change capture, batch-amortized row-time MV maintenance, and opt-in FK actions — inside the coordinated transaction.
files:
  - packages/quereus/src/core/database-external-changes.ts        # NEW — the batch ingestion driver
  - packages/quereus/src/core/database-internal.ts                # add ingestExternalRowChanges + option/change types to DatabaseInternal
  - packages/quereus/src/core/database.ts                         # thin public method delegating to the driver; savepoint-broadcast + flush helpers already exist
  - packages/quereus/src/runtime/emit/dml-executor.ts             # REFERENCE ONLY — the per-row pipeline order + statement-savepoint/flush pattern to mirror (runWithStatementSavepoints, processEvictions)
  - packages/quereus/src/runtime/foreign-key-actions.ts           # executeForeignKeyActionsAndLens, assertTransitiveRestrictsForParentMutation (reused as-is)
  - packages/quereus/src/core/database-materialized-views.ts      # BackingConnectionCache, maintainRowTime, flushDeferredRebuilds (reused as-is)
  - packages/quereus/src/vtab/memory/layer/manager.ts             # BackingRowChange (the change shape the seam accepts)
  - packages/quereus/src/index.ts                                 # export new types
  - packages/quereus/test/external-row-change-ingestion.spec.ts   # NEW
  - docs/materialized-views.md                                    # new § External row-change ingestion + decision matrix
  - docs/incremental-maintenance.md                               # cross-reference
----

# External row-change ingestion (implement)

## Background (condensed)

Quereus's post-write pipeline — (1) change capture (`_recordInsert/Update/Delete`
→ `Database.watch` post-commit dispatch + commit-time global assertions),
(2) row-time MV maintenance, (3) FK actions — lives only in the DML executor
(`runtime/emit/dml-executor.ts`). A write applied directly to module storage
(sync-inbound replication; Lamina's `RowStore`) gets none of it. The only
external seam today, `DatabaseInternal._maintainRowTimeCoveringStructures(sourceBase, change)`,
is MV-only and cold (no `BackingConnectionCache`, no deferred-rebuild set, so a
full-rebuild MV rebuilds inline per row).

This ticket adds a first-class batch seam. All maintenance machinery already
exists and takes the batch-amortization parameters — the work is exposure,
batch orchestration, and the FK/capture facets. **No new maintenance machinery.**

## Design (resolved — implement as specified)

### API

New types (export from `index.ts`; declare on `DatabaseInternal` in
`database-internal.ts`; implement as a public method on `Database` delegating to
a new `core/database-external-changes.ts` driver, mirroring how
`database-materialized-views.ts` keeps `Database` thin):

```ts
/** One externally-applied row change to report. `change` rows are FULL table
 *  rows in schema column order; `oldRow` images must be accurate before-images
 *  (they key the backing deletes and the capture log). */
export interface ExternalRowChange {
	/** Defaults to the current schema (schemaManager.getCurrentSchemaName()). */
	schemaName?: string;
	tableName: string;
	change: BackingRowChange;   // { op: 'insert'|'update'|'delete', oldRow?, newRow? }
}

export interface IngestExternalChangesOptions {
	/** Row-time covering-structure maintenance over the reported changes (default true). */
	maintainMaterializedViews?: boolean;
	/** Change capture (`_record*`): feeds Database.watch post-commit dispatch AND
	 *  commit-time global-assertion evaluation (default true). */
	captureChanges?: boolean;
	/** Parent-side FK actions for update/delete changes: transitive RESTRICT
	 *  enforcement + CASCADE / SET NULL / SET DEFAULT propagation (default FALSE —
	 *  a replication stream usually already carries the origin's cascade effects;
	 *  re-running them would double-apply). */
	applyForeignKeyActions?: boolean;
}

// on Database (and DatabaseInternal):
ingestExternalRowChanges(
	changes: readonly ExternalRowChange[],
	options?: IngestExternalChangesOptions,
): Promise<void>;
```

A flat **ordered** array (not per-source grouping): order is semantic for FK
actions and capture (origin order = parents-before-children etc.). Per-batch
memoize the `TableSchema` lookups.

### Batch algorithm

Mirror `runWithStatementSavepoints` + the DML generators' per-statement
amortization exactly; the batch is the external analogue of one statement:

1. Empty batch → return (no transaction begin, no savepoint).
2. Acquire the exec mutex (`_acquireExecMutex`) for the whole batch — FK-action
   cascades go through `_execWithinTransaction` (the already-holding-the-mutex
   variant), and the seam must serialize against concurrent statements.
3. `await db._ensureTransaction()` — runs inside the caller's active transaction
   when one exists; otherwise begins an implicit one the seam finalizes itself.
4. `_createSavepointBroadcast('__external_batch_<n>')` (module-scope counter, as
   in dml-executor's `stmtSavepointCounter`) — batch atomicity for the *derived*
   effects: all of the batch's pipeline effects apply or none.
5. Create one batch-scoped `BackingConnectionCache` (a `new Map()`) and one
   deferred-rebuild `Set<string>`.
6. For each change, in order:
   - Resolve `TableSchema` via `_findTable(tableName, schemaName)` (memoized);
     throw `QuereusError(…, StatusCode.NOTFOUND)` for an unknown table. Validate
     row arity (`row.length === columns.length`) → `MISUSE` on mismatch.
   - `tableKey = `${tableSchema.schemaName}.${tableSchema.name}`` — derived from
     the RESOLVED schema, byte-identical to the DML executor's key (maintenance
     lowercases internally; capture/watch matching gets executor parity for free).
   - `pkIndices = tableSchema.primaryKeyDefinition.map(d => d.index)`.
   - Facets in DML-executor order:
     a. **capture** (if on): `_recordInsert/_recordUpdate/_recordDelete(tableKey, …, pkIndices)`.
     b. **MV** (if on): `if (db._hasRowTimeCoveringStructures(tableKey)) await db._maintainRowTimeCoveringStructures(tableKey, change, cache, deferred)`.
     c. **FK** (if on; `op !== 'insert'` only — inserts have no parent-side actions):
        `await assertTransitiveRestrictsForParentMutation(db, tableSchema, op, oldRow, newRow)`
        then `await executeForeignKeyActionsAndLens(db, tableSchema, op, oldRow, newRow)`.
        Both with `lensRouted = false` (an external change is a physical basis
        write). The RESTRICT walk runs POST-application — exactly like
        `processEvictions`: the storage change already happened, there is no
        pre-mutation point, and the child rows it keys off still exist because
        the cascade hasn't run yet.
7. After the loop, still inside the try: `if (deferred.size > 0) await db._flushDeferredRebuilds(deferred, cache)` —
   after every change has been applied (each rebuild reads the whole batch) and
   BEFORE the savepoint release (a failed rebuild unwinds the batch). Then
   `_releaseSavepointBroadcast`.
8. On any throw: `_rollbackAndReleaseSavepointBroadcast`, then (mirroring
   `Database.exec`) `if (db._isImplicitTransaction()) await db._rollbackTransaction()`,
   release the mutex, rethrow.
9. On success: `if (db._isImplicitTransaction()) await db._commitTransaction()`
   (the batch is its own autocommit boundary, like one exec statement; watch
   dispatch fires here), release the mutex.

Holding the mutex means no statement is mid-flight, so an implicit transaction
observed at step 8/9 was necessarily started by this call — the `exec`-style
gate is exact.

### Decisions (resolved in plan; record in docs, do not re-open)

- **Facet defaults**: capture ON, MV maintenance ON, FK actions OFF (opt-in).
  Per-call options only — no registered per-source policy (every current
  consumer is a single integration layer per host; a policy registry adds
  mutable state for no consumer; revisit if multiple independent reporters
  appear).
- **Constraint stance / trust boundary**: the seam re-validates NOTHING — no
  CHECK, NOT NULL, UNIQUE, or child-side FK existence (the origin enforced
  them). Covering-UNIQUE backings are maintained **blindly** (the
  inverse-projection upsert is keyed by backing PK; an origin-unenforced UNIQUE
  collision degrades to last-writer-wins in the backing) — identical to the
  existing eviction path. Garbage in, garbage out; document explicitly.
- **Module data events are NOT a facet**: the external writer owns its module
  event emission and the `remote` flag (the sync adapter already emits
  `remote: true` itself; the seam re-emitting would double-fire sync change
  recording). Document the division of labor.
- **`notifyExternalChange` relationship**: that method stays as the coarse,
  no-transaction, whole-table watch invalidation; this seam's capture facet is
  the precise, in-transaction alternative (row-granular hits, fires at commit).
  Cross-reference both ways in jsdoc + docs.
- **Two-arg `_maintainRowTimeCoveringStructures` unchanged** — it remains the
  vtab-internal REPLACE-eviction seam (called from inside a statement, where
  this batch seam must not be used).
- **DML-replay decision matrix** (land in docs/materialized-views.md, new
  § External row-change ingestion; Lamina docs will reference it):

  | concern | DML replay (`insert or replace …` / `delete …`) | ingestion seam |
  |---|---|---|
  | pipeline facets | all, always (constraints, defaults, events, capture, MV, FK) | selected facets; no constraint re-validation |
  | per-row cost | plan + execute per statement (prepared stmts amortize partially) | no planning; maintenance batch-amortized (one connection-resolve per backing, one rebuild per full-rebuild MV per batch) |
  | inbound conflicts | engine-enforced — may reject or transform the inbound row | origin trusted verbatim |
  | FK actions | always re-run (double-applies a stream that carries origin cascade effects) | opt-in per call |
  | storage write | through the vtab — module-owned secondary indexes maintained | already applied by the caller; module index upkeep is the caller's/module's job |
  | recommended for | low-volume sync; tables with local-only constraints | bulk inbound application over origin-validated streams |

### Transaction & visibility contract (document verbatim in the new docs section)

- The call runs inside an active coordinated transaction (or its own implicit
  one); backing connections register lazily and `registerConnection` replays the
  active savepoint depth — which includes the batch savepoint — so
  commit/rollback/savepoint stay in lockstep (existing behavior, no new code).
- Residual / join-residual / full-rebuild arms re-read the source **through the
  vtab against live state**: the inbound rows must already be visible to a
  vtab read within the transaction when the seam is driven. True for both
  motivating cases: committed-KV direct writes (sync adapter) and
  connection-pending-layer writes (Lamina in-transaction apply).
- A mid-batch error unwinds the batch's **derived** effects (backing writes,
  cascade DML, capture entries — the change log is savepoint-layered) via the
  savepoint; the externally-applied storage rows are NOT unwound by Quereus.
  For RESTRICT to genuinely *protect* (not merely report), the caller must
  apply its storage writes transactionally with the seam (the Lamina case);
  with pre-committed storage the caller owns reconciliation on throw.

## Edge cases & interactions

- Empty batch: no-op — no transaction, no savepoint, no mutex churn beyond acquire/release (or early-return before acquiring).
- Unknown table / unknown schema: NOTFOUND error before any effect; row-arity mismatch: MISUSE; batch savepoint never partially applied (error on change k unwinds changes 1..k-1's derived effects).
- Mid-batch RESTRICT violation (FK facet): earlier changes' backing deltas, capture entries, and cascade effects all roll back with the savepoint; error propagates; implicit transaction (if seam-started) rolls back; an explicit caller transaction is left open with the savepoint unwound (caller decides).
- FK cascade DML issued by the seam re-enters the full DML pipeline (nested statement savepoints inside the batch savepoint; the cascaded child writes get their own capture + MV maintenance + transitive actions) — assert this in tests, not just the direct child delete.
- `pragma foreign_keys = off` with `applyForeignKeyActions: true`: both FK helpers early-return — no error, no action.
- `update` change whose PK moved (`oldRow` PK ≠ `newRow` PK): capture records one update (executor parity); inverse-projection deletes the old backing key and upserts the new.
- Same row changed twice in one batch: processed in order; each change's `oldRow` must be the true before-image of *that* change (i.e. the first change's `newRow`) — document as part of the accuracy contract.
- Multi-table interleaved batch: per-change dispatch on `tableKey`; the shared cache/deferred set span tables (they are keyed by backing/MV, not source).
- Full-rebuild MV reading the batched table: dirtied per change, rebuilt ONCE at the flush — O(body), not O(rows × body); MV-over-MV consumers converge via the existing flush worklist.
- Covering-UNIQUE collision in inbound data: blind last-writer-wins in the backing (trust boundary; see Decisions).
- Capture + global assertions: with capture on, inbound changes participate in commit-time assertion evaluation — intended (delegated invariant maintenance), but name it in docs; capture off opts out of both watch and assertions.
- Concurrent statements: serialized via the exec mutex. **Do not call from within statement execution or vtab callbacks** (deadlock on the mutex); the two-arg eviction seam covers that context. Document on the method jsdoc.
- Explicit-transaction rollback after a successful seam call discards everything (backing pending layers, change log) — lockstep.
- Watch dispatch timing: implicit (seam-started) transaction → handlers fire at the seam's own commit; explicit → at the caller's commit.
- A change reported against an MV backing table (`_mv_x`) directly: not special-cased and not supported — document as out of contract (the cascade machinery happens to treat it as a source, but the backing is engine-owned).
- Batch containing only-insert changes with FK facet on: facet is a per-change no-op (no parent-side actions on insert); child-side FK existence is deliberately NOT checked (trust boundary).

## Tests (new `packages/quereus/test/external-row-change-ingestion.spec.ts`, mocha)

Simulate "externally-applied" writes by calling `vtab.update()` directly on the
table instance (bypasses the DML executor exactly as an external storage write
does), or — for arms that never re-read the source (inverse-projection, capture,
FK) — by synthesizing changes alone.

- Inverse-projection covering MV over `t`: seam insert/update/delete changes converge the backing (`select from mv`); a multi-row batch converges; PK-move update handled.
- Full-rebuild MV: apply N rows via direct `vtab.update()`, one seam batch → MV reflects all N (single flush; correctness asserted via final state).
- Watch: `db.watch` subscription fires post-commit with row-granular hits when capture on; does not fire with `captureChanges: false`.
- FK CASCADE: parent-delete change with facet on deletes children (and a grandchild via the nested cascade); facet off/default leaves children untouched.
- FK RESTRICT: parent-delete change orphaning a child throws; an earlier change in the same batch has its backing delta rolled back; no watch event fires.
- Implicit transaction: seam with no active transaction commits at batch end; a throwing batch leaves no transaction open and no derived effects.
- Explicit transaction: seam inside `begin`; `rollback` discards backing delta + capture.
- Unknown table → NOTFOUND, zero effects.
- `pragma foreign_keys = off` + facet on → no actions, no error.
- Empty batch → no-op (and does not begin a transaction: `getAutocommit()` stays true).

Run `yarn test` (and lint in packages/quereus) before handoff; `yarn test:store` only if a store-path concern emerges.

## Docs

- `docs/materialized-views.md`: new § **External row-change ingestion** adjacent to § Synchronous, transactional, per-statement — API, facet semantics + defaults, transaction & visibility contract, key format, trust boundary, batch-boundary semantics (savepoint + flush placement), the decision matrix above, and the `notifyExternalChange` cross-reference. Update the § Synchronous… sentence that names the two-arg seam as the only external surface.
- `docs/incremental-maintenance.md`: short cross-reference from the maintenance-driver discussion.
- `database-internal.ts` jsdoc on the new method: full contract incl. the do-not-call-from-within-a-statement rule.

## TODO

- Add `ExternalRowChange` + `IngestExternalChangesOptions` types and the `ingestExternalRowChanges` declaration to `database-internal.ts`; export types from `index.ts`
- New `core/database-external-changes.ts` driver implementing the batch algorithm above (per-batch TableSchema memo, cache + deferred set, savepoint lifecycle, facet dispatch, flush, implicit-txn finalization)
- Thin `Database.ingestExternalRowChanges` method wiring the driver (exec mutex around the batch)
- Tests per the list above
- Docs per the list above
- `yarn build`, `yarn test`, lint clean
