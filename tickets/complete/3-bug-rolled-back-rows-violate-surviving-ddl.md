----
description: When a transaction deletes or overwrites rows, then adds a unique index, changes a column's collation or type, or marks a column NOT NULL, and then rolls back, the rule change stays but the old rows come back and silently violate it. The schema change now also checks every state a rollback could restore and refuses (telling the user to commit first) when one of them would break the new rule.
architecture: docs/memory-table.md#ddl-and-transactions
files:
  - packages/quereus/src/vtab/module.ts                         # IssuerRowSources
  - packages/quereus/src/vtab/rollback-states.ts                # rolledBackRowsWouldViolate, judgeRestorableStates, describeAlterColumn
  - packages/quereus/src/vtab/table.ts                          # VirtualTable.savepointRowSources?() hook
  - packages/quereus/src/core/database-internal.ts              # getActiveSavepointDepth()
  - packages/quereus/src/vtab/memory/layer/connection.ts        # savepointRestoreLayers()
  - packages/quereus/src/vtab/memory/layer/manager.ts           # restorableStates, assertUniqueOverRestorableStates, savepointRowSources
  - packages/quereus/src/vtab/memory/layer/alter-column.ts      # RestorableState, per-state NOT NULL / convertibility judging
  - packages/quereus-isolation/src/isolation-module.ts          # effectiveRowsFor builds the bundle; hook-less overlay guard
  - packages/quereus-isolation/src/alter-migration.ts           # derivePkRekey gate; NULL-key marker in a savepoint frame refused
  - packages/quereus-store/src/common/store-module-index-build.ts  # rollbackStates, judgeRollbackStates
  - packages/quereus-store/src/common/store-module-alter-column.ts
  - packages/quereus-store/src/common/store-table.ts            # validateRekeyedPrimaryKey third question
  - packages/quereus/test/logic/41.2.4-ddl-rollback-states.sqllogic
  - packages/quereus/test/ddl-in-transaction-validation.spec.ts
  - packages/quereus-isolation/test/isolation-layer.spec.ts
  - docs/memory-table.md
  - docs/module-authoring.md
  - docs/module-capabilities.md
  - docs/store.md
difficulty: hard
repro: verified
----

# Row-validating DDL must hold for every state a rollback can restore

## What landed

Commit `ticket(implement): bug-rolled-back-rows-violate-surviving-ddl`. A row-validating DDL inside a transaction (`create unique index`, `add constraint … unique`, `alter column … set collate` / `set data type` / `set not null`, and the legality probe of every primary-key re-key) first judges the rows the transaction can see with its existing statuses (`CONSTRAINT`, or `MISMATCH` for an unconvertible value). It then runs the same check over each state a rollback could restore: the committed rows, and the rows as they stood at each open savepoint taken before the DDL. A violation confined to a restorable state refuses with `BUSY` and a message ending "Commit the pending writes first, then retry." Released savepoints are not restorable states. A deleted row that breaks no rule does not block. Nothing is mutated on a refusal, the transaction stays usable, and `commit` followed by the same statement lands it. Outside a transaction no state differs from the effective rows, so autocommit DDL pays no second scan.

Each state is judged as the rows it will hold after the DDL's rewrite reaches it. On the memory backend the value rewrite reaches the base and every open layer, so a NULL under `set not null` with a usable DEFAULT is backfilled rather than refused, and the rewrite is forced even when the transaction itself sees no NULL. A wrapper's savepoint frame is judged as-is for the NOT NULL arm, because no rewrite of the receiving module reaches it.

The interface is `IssuerRowSources` (`{ effective, savepoints }`), which replaces the bare `EffectiveRowSource` parameter on `createIndex` / `alterTable`, so a wrapper cannot hand down the effective rows and forget the rollback states. `VirtualTable.savepointRowSources?()` is the hook a staging table implements so a wrapper can read the rows each open savepoint would restore; `MemoryTable` implements it. The shared refusal and the "probe each state, rewrap `CONSTRAINT` / `MISMATCH` as `BUSY`" helper live in `vtab/rollback-states.ts` and are used by the memory, isolation and store packages.

Three legs: the memory manager judges its base plus the layer each open savepoint would reinstate; the isolation wrapper builds the bundle from its overlay (live merge as `effective`, the merge over each overlay savepoint frame as `savepoints`) and refuses with the same `BUSY` when the configured overlay module lacks the hook and savepoints are open; the store behind the wrapper judges its committed rows plus the wrapper's frames. Unwrapped, the bare store judges no rollback state by design; that is `bug-bare-store-ddl-ignores-buffered-rollback-states` (in `implement/`, prereq on this ticket). Two second-order holes in the wrapper's key-member `set not null` backfill were closed alongside (the re-key gate now mirrors the committed-NULL backfill; a deletion marker at the NULL key in a savepoint frame is refused).

## Review findings

**Read first:** the implement commit's full diff across all 45 files, before the handoff summary. Then every source file the change touches and the four docs.

**Checked by reading.** The refusal ordering in the isolation `alterTable`: an underlying `BUSY` after the issuer's marker drops reinserts the markers and rethrows, so no overlay mutation survives a refusal. `hasChanges` is only ever set true, so an overlay emptied by a later delete still feeds its frames. Savepoints taken before the overlay existed are replayed onto the pre-registered overlay connection, so their frames exist and equal the committed state. `restorableStates` returns nothing for autocommit DDL and the store's `rollbackStates` returns nothing unwrapped, so no extra scan lands on the common path. `judgeRestorableStates` rewraps only `CONSTRAINT` / `MISMATCH`; any other failure propagates as a fault. The two swallow branches that now throw `INTERNAL` are unreachable after the pre-pass, as claimed. Type safety: the bundle type makes both halves mandatory; no `any` introduced. Resource cleanup and error paths: every refusal is throw-only before mutation on all three legs.

**Checked by running.** `yarn build`, `yarn lint`, `yarn typecheck`: clean. `yarn test`: every workspace green (core 10903 passing, 25 pending). `yarn test:store` (core logic suite on LevelDB behind the wrapper, no bail): 10896 passing, 32 pending, 0 failing. The implementer's note that a no-bail memory run stopped without a summary did not reproduce. Ad-hoc probes against the built packages, on both the memory leg and the wrapper leg, for savepoint shapes the tests do not pin: an inner savepoint rolled back to while the outer frame still holds the pair (refused); a released inner savepoint with the outer frame holding the pair (refused, then accepted once the outer is released, and the rolled-back table enforces the index); a savepoint predating the staged pair with the inner one released (accepted, and `rollback to` the outer restores the committed state); the same frame-only shape for `set collate`, `set data type`, and `add constraint … unique` (all refused); a DEFAULT backfill of a NULL only in a frame followed by `rollback to` that frame (restores the DEFAULT, column enforces NOT NULL). All as designed.

**Minor, fixed in this pass.**
- `describeRowValidatingAlter` in `isolation-module.ts` re-spelled the `alter column` statement that `describeAlterColumn` already builds; it now gates on the row-validating arms and delegates.
- `docs/memory-table.md` cited `tickets/backlog/feat-ddl-transaction-capability.md` twice, a path that no longer exists, and one of those paragraphs still said no capability flag distinguishes transactional DDL from the degrading kind although `getCapabilities().ddlTransactionality` does. Both now cite the flag's section in `module-capabilities.md`; the second also names the live follow-up `feat-transactional-ddl-native-backends`.

**Test added (one, for a contract left unverified).** The implementer listed the hook-less overlay guard as unexercised. `isolation-layer.spec.ts` now ends with a describe block that injects an overlay module whose staging table has no `savepointRowSources`, and pins: a unique index under an open savepoint refuses `BUSY` naming the user's table, a non-unique index under the same savepoint is accepted, and the unique index is accepted once the savepoint is released. No duplicate exists in any state, so the guard is the only possible source of the refusal.

**Tests cut: none.** Each new test pins one behaviour at the lowest layer that reproduces it; the plan-level tests build contexts by hand without mocking a module the repository owns, and the sqllogic matrix is cross-module. None restates the implementation.

**Tripwires.** One added: `MemoryTableManager.restorableStates` carries a `NOTE:` that, with a wrapper's bundle supplied, the manager's own savepoint markers are not judged (under the wrapper they are all lazy and re-pointed at the base), and what to merge in if a wrapper ever lets the underlying hold its own open work. The per-structure, per-state rescan cost is already parked by the existing `NOTE:` on `IsolationModule.effectiveRowsFor` and the one in `derivePkRekey`; nothing new to add there.

**Major findings / tickets filed: none.** The one deliberate deferral (bare store's buffered rollback states) already has its ticket in `implement/`. No accepted-tradeoff `NOTE:` at any touched site had its revisit condition tripped.

**Pre-existing failures: none** encountered.
