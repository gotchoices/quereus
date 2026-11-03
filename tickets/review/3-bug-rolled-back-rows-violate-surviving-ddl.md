----
description: When a transaction deletes or overwrites rows, then adds a unique index, changes a column's collation or type, or marks a column NOT NULL, and then rolls back, the rule change stays but the old rows come back and silently violate it. The schema change now also checks every state a rollback could restore and refuses (telling the user to commit first) when one of them would break the new rule.
architecture: docs/memory-table.md#ddl-and-transactions
files:
  - packages/quereus/src/vtab/module.ts                         # IssuerRowSources (replaces the bare EffectiveRowSource parameter on createIndex / alterTable)
  - packages/quereus/src/vtab/rollback-states.ts                # NEW: rolledBackRowsWouldViolate (the BUSY error), judgeRestorableStates (probe each state, rewrap CONSTRAINT/MISMATCH as BUSY), describeAlterColumn
  - packages/quereus/src/vtab/table.ts                          # VirtualTable.createIndex(rows?: IssuerRowSources), new optional savepointRowSources?() hook
  - packages/quereus/src/index.ts                               # exports
  - packages/quereus/src/core/database-internal.ts              # DatabaseInternal.getActiveSavepointDepth() (new)
  - packages/quereus/src/core/database.ts                       # its implementation
  - packages/quereus/src/vtab/memory/layer/connection.ts        # savepointRestoreLayers(): the layer each OPEN savepoint would reinstate
  - packages/quereus/src/vtab/memory/layer/manager.ts           # restorableStates, assertUniqueOverRestorableStates, validateUniqueOverRows, savepointRowSources; wired into createIndex, addUniqueConstraint, validateRekeyedUniqueStructures, validateRekeyedPrimaryKey, alterColumn; convertBaseRows throws INTERNAL
  - packages/quereus/src/vtab/memory/layer/alter-column.ts      # RestorableState, AlterColumnContext.restorableStates/ddl, planTightenNotNull and assertEveryValueConverts judge each state
  - packages/quereus/src/vtab/memory/layer/transaction.ts       # convertColumn: unconvertible own value throws INTERNAL
  - packages/quereus/src/vtab/memory/table.ts                   # MemoryTable.savepointRowSources()
  - packages/quereus/src/vtab/memory/module.ts                  # signatures
  - packages/quereus-isolation/src/isolation-module.ts          # effectiveRowsFor builds IssuerRowSources (effective + per-savepoint merges); hook-less overlay guard; BUSY routed to poison for foreign overlays; describeRowValidatingAlter
  - packages/quereus-isolation/src/overlay-rows.ts              # iterateEffectiveRows takes an entry source; collectEntriesFromRows; resolveTombstoneIndex exported
  - packages/quereus-isolation/src/alter-migration.ts           # derivePkRekey gates on effective OR committed NULLs; validateOverlayMigration refuses a NULL-key marker in a savepoint frame; the two NOTEs rewritten
  - packages/quereus-isolation/src/isolated-table.ts            # createIndex signature
  - packages/quereus-store/src/common/store-table-base.ts       # iterateCommittedEntries (committed-only scan)
  - packages/quereus-store/src/common/store-table.ts            # validateRekeyedPrimaryKey(…, savepoints, ddl, mapRow): third question over the wrapper's savepoint states
  - packages/quereus-store/src/common/store-module-index-build.ts  # RollbackState, rollbackStates, judgeRollbackStates; effectiveDdlRows takes IssuerRowSources
  - packages/quereus-store/src/common/store-module-index.ts     # createIndex (unique): committed + savepoint BUSY passes
  - packages/quereus-store/src/common/store-module-alter.ts     # alterAddConstraint (unique) and alterPrimaryKeyChange
  - packages/quereus-store/src/common/store-module-alter-column.ts  # set collate / rewrite UNIQUE re-validation, PK re-key, alterColumnSetNotNull, alterColumnSetDataType (now judges the wrapper's effective stream for MISMATCH; the NOTE is gone)
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - packages/quereus/test/vtab/alter-column-plan.spec.ts
  - packages/quereus/test/alter-column-open-transaction-layer.spec.ts
  - packages/quereus/test/logic.spec.ts                         # MEMORY_ONLY_FILES entry for 41.2.1 removed
  - packages/quereus/test/logic/41.2.4-ddl-rollback-states.sqllogic   # NEW cross-module matrix
  - packages/quereus/test/logic/41.2.1-alter-column-retype-deleted-row.sqllogic   # renamed from …-memory.sqllogic, flipped
  - packages/quereus/test/logic/10.1.2-ddl-in-transaction.sqllogic
  - packages/quereus/test/logic/41.2-alter-column.sqllogic
  - packages/quereus/test/logic/41.2.3-alter-column-set-not-null-pk-backfill.sqllogic
  - packages/quereus/test/logic/41.7.3-alter-column-retype-unique.sqllogic
  - packages/quereus/test/logic/41.7.4-alter-column-retype-semantic-memory.sqllogic
  - packages/quereus/test/logic/41.8-alter-savepoint-staged-rows.sqllogic
  - packages/quereus-isolation/test/alter-table-conformance.spec.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - packages/quereus-store/test/alter-collate-pk-rekey.spec.ts
  - packages/quereus-store/test/isolated-store.spec.ts
  - docs/memory-table.md
  - docs/module-authoring.md
  - docs/module-capabilities.md
  - docs/store.md
difficulty: hard
repro: verified
----

# Row-validating DDL must hold for every state a rollback can restore

## What landed

The decided rule from the fix ticket, implemented on all three legs. A row-validating DDL inside a transaction (`create unique index`, `add constraint … unique`, `alter column … set collate` / `set data type` / `set not null`, and the legality probe of every primary-key re-key) first judges the rows the transaction can see, with its existing statuses (`CONSTRAINT`, or `MISMATCH` for an unconvertible value). It then runs the same check, on its own, over each state a rollback could restore: the committed rows and the rows as they stood at each open savepoint taken before the DDL. A violation confined to a restorable state refuses with `BUSY` and a message of this shape, which tests match with `/commit the pending writes first/i`:

```
Cannot create unique index ix on table t: rows this transaction has deleted or overwritten would violate it if the transaction rolled back. Commit the pending writes first, then retry.
```

Released savepoints are not restorable states. A deleted row that breaks no rule does not block. Nothing is mutated on a refusal, the transaction stays usable, and `commit` followed by the same statement lands it. Outside a transaction no state differs from the effective rows, so autocommit DDL pays no second scan.

Each state is judged as the rows it will hold after the DDL's rewrite reaches it. On the memory backend the value rewrite reaches the base and every open layer, so a NULL under a `set not null` with a usable DEFAULT is backfilled rather than refused (and the rewrite is now forced even when the transaction itself sees no NULL). A wrapper's savepoint frame is judged as-is for the NOT NULL arm, because no rewrite of the receiving module reaches it.

### The interface

`IssuerRowSources` (`vtab/module.ts`) replaces the bare `EffectiveRowSource` parameter on `VirtualTableModule.createIndex` / `alterTable`, `VirtualTable.createIndex`, and the memory manager's four DDL entry points. It is a bundle, `{ effective, savepoints }`, so a wrapper cannot hand down the effective rows and forget the rollback states. `VirtualTable.savepointRowSources?()` is the new optional hook a staging table implements so a wrapper can read the rows each open savepoint would restore; `MemoryTable` implements it. The shared refusal (`rolledBackRowsWouldViolate`) and the "probe each state, rewrap as BUSY" helper (`judgeRestorableStates`) live in the new `vtab/rollback-states.ts` and are exported, so the memory, isolation and store packages share one wording.

### Memory backend

`MemoryTableConnection.savepointRestoreLayers()` walks the savepoint stack (not the layer chain) and returns the layer each open savepoint would reinstate. `MemoryTableManager.restorableStates()` turns that into the judged list (base plus those layers; or base plus the wrapper's `savepoints` when supplied), read after `ensureSchemaChangeSafety` so lazy markers are already re-pointed. One probe (`validateUniqueOverRows`) serves both the effective pass and the per-state pass. The two swallow branches in `convertBaseRows` and `TransactionLayer.convertColumn` now throw `INTERNAL` (the pending-change image remap in `convertColumn` still keeps a raw image; it holds historical images no restorable state carries, so it was left alone).

### Isolation wrapper

`effectiveRowsFor` builds the bundle: the live overlay merge as `effective`, and the same merge over each overlay savepoint frame as `savepoints`. A `BUSY` from `validateOverlayMigration` on a foreign overlay now poisons it like `CONSTRAINT` / `MISMATCH` do, instead of aborting the issuer's ALTER after the underlying has mutated. If the configured overlay module lacks the hook and the issuer has staged changes under open savepoints, a row-validating DDL is refused with the same `BUSY` (this needed a small `DatabaseInternal.getActiveSavepointDepth()` accessor).

Two second-order holes surfaced while tracing the `set not null` backfill of a key column and are closed here:

- The wrapper's key-move gate (`derivePkRekey`) mirrored the underlying's old backfill decision (NULL visible in the effective rows). The underlying now also backfills a committed NULL a rollback would restore, which moves that row's key out from under the overlay's deletion marker. The gate now asks both streams (`underlyingBackfills`), so the marker is re-keyed and the delete still lands at commit. The test that pinned "metadata-only, marker untouched" flipped accordingly.
- A deletion marker at the NULL key sitting in a savepoint frame would, after `rollback to` that frame, delete nothing at flush and resurrect the row. `validateOverlayMigration` now refuses that shape (`assertNoMarkerAtNullKeyInSavepointFrames`). The two NOTEs in `alter-migration.ts` that cited this ticket were rewritten to say the refusals close the hole.

### Store, behind the wrapper

`rollbackStates(table, rows)` yields the committed rows (via the new `iterateCommittedEntries`) plus the wrapper's savepoint states, each tagged with whether the store's rewrite reaches it; `judgeRollbackStates` runs a probe over them. Wired into `createIndex` (unique), `alterAddConstraint` (unique), the `set collate` / value-rewrite UNIQUE re-validation, `alterColumnSetNotNull`, `alterColumnSetDataType` (which also gained the effective-stream `MISMATCH` pass it was missing), and `StoreTable.validateRekeyedPrimaryKey`, which gained a third question over the wrapper's savepoint states. The memory and store legs now agree behind the wrapper, so `41.2.1` left `MEMORY_ONLY_FILES`.

Unwrapped, `rollbackStates` returns nothing by design: the bare module's buffered deletes and savepoints are the coordinator's op log, left to `bug-bare-store-ddl-ignores-buffered-rollback-states` (which this ticket's helper is shaped to be extended by).

## Not in the ticket's list, done anyway

- `validateRekeyedPrimaryKey` on both backends now also runs its legality probe over `rows.savepoints` (rewrapped as `BUSY`). Rule 3's chain walk is untouched. Without this, `committed ('A'); begin; insert ('a'); savepoint s; delete ('a'); alter column k set collate nocase` was accepted behind the wrapper and `rollback to s` restored 'A' and 'a' under a NOCASE key. Pinned by the new isolation test "raises BUSY when only a savepoint frame holds the colliding pair".
- `describeAlterColumn` is shared from `rollback-states.ts` rather than duplicated in the memory and store packages.

## Known gaps and things a reviewer should probe

- The hook-less overlay guard in `effectiveRowsFor` is not exercised by any test: no test injects an overlay module without `savepointRowSources`, and the only custom overlays in the suite are the concurrency-mode stubs. Reading the code is the only verification it has.
- Behind the wrapper, the underlying memory manager's `restorableStates` ignores its own savepoint markers when `rows` is supplied (they are all lazy and re-pointed at the base). That relies on the underlying never holding its own open work under isolation, which is the wrapper's invariant, not something asserted here.
- The per-state scans are plain re-scans. `set collate` over a table with several UNIQUE structures under a deep savepoint stack scans once per structure per state (the NOTE on `effectiveRowsFor` says where to memoize if it ever shows up).
- The memory-leg run of every core spec without `--bail` terminated without printing a summary (the log stops mid-dots); the project's own runner (`yarn test`, which bails) and the no-bail store leg both completed clean. I did not find the cause.

## Tests

Flipped from acceptance to the `BUSY` refusal, each followed by a usable-transaction check and the committed retry where the old test had a follow-up:

- `ddl-in-transaction-validation.spec.ts`: "sees a pending DELETE" (create unique index), "sees a pending DELETE" (set collate), the deleted-row `set data type` and `set not null` acceptances, and "accepts when a pending UPDATE clears the only committed NULL" (case D).
- `41.2.1-alter-column-retype-deleted-row.sqllogic` (renamed, now cross-module), `41.7.3` § 8, `41.7.4` § 8b, `10.1.2` § 6.
- `alter-table-conformance.spec.ts` "same-class SET DATA TYPE … row the transaction deleted"; `alter-collate-pk-rekey.spec.ts` the two deleted-unique-index-collider tests (one now asserts the index and scan agree after the committed retry, the other that rollback restores the pair under BINARY).
- `isolation-layer.spec.ts` "leaves a marker at its NULL key when the tightening is metadata-only" became "re-keys a marker … because the committed NULL is backfilled".

Kept their original purpose by staging the colliding rows inside the transaction, so no committed state holds the pair: `isolation-layer.spec.ts` "ADD CONSTRAINT UNIQUE over a primary-key member ignores in-transaction deletion markers" and "create unique index … fully tombstoned table commits empty", `41.8` t11, and `isolated-store.spec.ts` "accepted CREATE UNIQUE INDEX rebuilds the overlay …" (seed changed so the deleted row is not a duplicate).

New, one per behaviour:

- `41.2.4-ddl-rollback-states.sqllogic` (cross-module): cases A, B, C, D, D with DEFAULT (backfilled), E, F (legal), H (released savepoint, legal).
- `ddl-in-transaction-validation.spec.ts`: case A, case H, case E, case F, "backfills a committed NULL a rollback would restore from the DEFAULT instead of refusing", "backfills a NULL held only in a savepoint frame, because the rewrite reaches every open layer", plus the refusal-then-commit-then-retry shapes inside each flipped test.
- `alter-column-plan.spec.ts` (lowest layer, no database): a restorable-state NULL with no DEFAULT refuses `BUSY`; with a DEFAULT and a reachable state it forces the backfill; with a DEFAULT and an unreachable state (a wrapper frame) it refuses; an unconvertible value only in a restorable state refuses `BUSY` with the `MISMATCH` as cause.
- `isolation-layer.spec.ts`: "ADD CONSTRAINT UNIQUE refuses (BUSY) when the deleted committed rows would collide on rollback"; "SET NOT NULL … DEFAULT refuses (BUSY) while a savepoint frame holds a staged NULL the backfill cannot reach"; "CREATE UNIQUE INDEX refuses (BUSY) when rollback to a savepoint would restore a staged duplicate" (case A over `using isolated`); "refuses (BUSY) a key-member backfill while a savepoint frame holds a marker at the NULL key"; "raises BUSY when only a savepoint frame holds the colliding pair" (PK collate). Every isolation refusal also asserts the message names the user's table, not `_overlay_…`.

## Validation run

- `yarn build`: clean (Vite chunk-size warnings only).
- `yarn lint`, `yarn typecheck`: clean across every workspace.
- `yarn test` (every workspace, project runner): all green, 0 failing. The core package alone: 10903 passing, 25 pending.
- `yarn test:store` (core logic suite on LevelDB behind the wrapper): 368 passing, 7 pending, 0 failing, run without bail.
- No pre-existing failures were found; every failure encountered was a test pinning the old acceptance and is listed above.

## Docs

`docs/memory-table.md` rule 1 rewritten to the decided rule and the "Rule 1 assumes the transaction commits" paragraph replaced; the `SET DATA TYPE` and `SET NOT NULL` paragraphs updated for the restorable-state refusals and the forced backfill. `docs/module-authoring.md` § "When the pending rows live outside your module" rewritten around `IssuerRowSources` (the stale "Not covered: a PRIMARY KEY collision …" paragraph removed, since the effective pass has covered it since the PK re-key work). `docs/module-capabilities.md` non-transactional tier gained the refusal sentence. `docs/store.md` pre-commit validation paragraph gained the wrapped-leg passes and the bare-module deferral.
