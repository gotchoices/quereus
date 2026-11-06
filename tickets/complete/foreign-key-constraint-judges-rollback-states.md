description: Adding a FOREIGN KEY inside a transaction now also checks every state a rollback could restore, pairing the child table's rows and the parent table's rows at the same rollback point, and refuses as retryable when one would leave a child row with no parent.
prereq: check-constraint-judges-rollback-states
architecture: docs/module-authoring-transactions.md#ddl-inside-an-open-transaction
files:
  - packages/quereus/src/schema/constraint-builder.ts  # validateAddedForeignKeyOverExistingRows, foreignKeyOrphanScan, scanForOrphans, foreignKeyRollbackPoints, rowsAtSavepoint, restorableStatesOf
  - packages/quereus/src/vtab/rollback-states.ts  # describeAddForeignKey; refusal message reworded
  - packages/quereus/src/vtab/memory/layer/manager.ts  # addForeignKeyConstraint
  - packages/quereus-store/src/common/store-module-alter.ts  # alterAddConstraint foreignKey arm
  - packages/quereus/src/vtab/module.ts  # restorableRowStates doc
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # NOTE tripwire (review)
  - packages/quereus/src/runtime/emit/add-constraint.ts  # comment references (review)
  - packages/quereus/test/logic/41.2.4-ddl-rollback-states.sqllogic  # cases N–S
  - packages/quereus-store/test/bare-ddl-rollback-states.spec.ts  # bare-store FK case (review)
  - docs/module-authoring-transactions.md
  - docs/memory-table.md
  - docs/store.md
  - docs/design-isolation-challenges.md
  - docs/determinism.md
  - docs/mv-constraints.md
----

# A new FOREIGN KEY must hold in every state a rollback could restore

## What landed

On the bundled backends DDL survives `rollback` / `rollback to savepoint`, but the rows do not. The FK existing-row scan read only the rows the transaction could see. So a committed orphan the transaction had deleted came back under the surviving constraint, and so did a committed child row whose only parent was a row the transaction inserted.

`validateAddedForeignKeyOverExistingRows` (`schema/constraint-builder.ts`) is now the entry point for both module FK arms: memory `addForeignKeyConstraint` and store `alterAddConstraint`. Both still skip it when `restoring` is set. It works in this order:

- It runs the effective scan first. An orphan the transaction can see fails with `CONSTRAINT`.
- It then re-runs the same orphan SQL once per rollback point: the whole-transaction rollback, plus each open savepoint depth. At each point both the child's rows and the parent's rows are replaced, through `Statement._rowSourceOverrides`, by the rows that point would restore (`foreignKeyRollbackPoints`).
- An orphan that appears only at a rollback point fails with `BUSY`: "rolling back this transaction would leave rows that break it. Commit the pending writes first, then retry."

Special cases:

- A self-referencing FK uses one override, shared by both reads.
- An absent parent needs no override.
- A table that reports no states keeps its current rows.

The table states are looked up through the catalog's module, so under the isolation layer the wrapper answers. `validateForeignKeyOverExistingRows` is now effective-only. Its one caller is the materialized-view derivation.

The refusal text in `rolledBackRowsWouldViolate` changed and is shared by every rollback-state refusal. The old text ("rows this transaction has deleted or overwritten…") was false for the parent-side case.

Known deviation, accepted: on the `add column … references` path the refusal names `add foreign key` / `add constraint <name> foreign key`, not `add column <name>`. The module arm cannot tell the two statements apart, and the UNIQUE arms already behave this way. The docs say so.

## Review findings

Read the implement diff (`ticket(implement): foreign-key-constraint-judges-rollback-states`) before the handoff.

**Correctness, checked by reading and by running code:**

- **Savepoint pairing.** Each table's per-depth array can be lined up with the other's because the database replays its savepoint stack onto a connection that joins late (`MemoryTableConnection.savepointRestoreLayersByDepth`). The isolation layer pads its array to the active depth. A short array is read as "restores the committed rows", consistent with `VirtualTable.savepointRowSources`.
- **Probes run against the memory backend from a scratch script (not committed):**
  - staged child, then a savepoint, then child and parent both deleted → lands;
  - parent before the savepoint, child after → lands;
  - parent inserted after `s1`, committed child deleted after `s2` → `BUSY`;
  - savepoint released after a parent insert, with a committed orphan → `BUSY`;
  - `add column … default 5 references p` with the parent inserted after a savepoint → `BUSY`, and the column is reverted;
  - named constraint → the message names it.

  All behaved correctly.
- **Override plumbing.** `buildTableSource` turns an overridden table into a literal scan, so no access path or index seek can bypass it. A subquery inherits the overrides through the context spread. Test O confirms the parent override is taken.
- **Bare store.** `alterAddConstraint` does not flush the coordinator's op log before the FK scan, so the buffered states are real and judging them is correct. On the `add column` path the store's `alterAddColumn` flushes first, so nothing is left to judge. That is correct too.
- **Isolation.** FK is not forwarded to the overlay (`forwardAddConstraintToOverlay`), so no second validation runs. `describeRowValidatingAlter` returning undefined for FK is correct, because the FK arm ignores `rows` and reads through the catalog.
- **Latching.** The parent's hook is called from inside the child's schema-change latch. The memory and store hooks take no latch. Self-reference does not fetch the parent states.

**Tests:**

- Cases N–S in `41.2.4-ddl-rollback-states.sqllogic` each pin a distinct branch: child-side, parent-side, false-refusal guard, savepoint-only, self-reference, and CONSTRAINT-before-BUSY ordering. All kept; none restates the implementation.
- Added one bare-store case to `bare-ddl-rollback-states.spec.ts`: a parent row the transaction inserted, rescuing a committed child row → `BUSY`. Until now nothing exercised the store's own `restorableRowStates` being read for a *parent* table from inside the child's `alterTable` (the gap the handoff flagged). I confirmed it fails with the parent-state fetch patched out of the built file, and passes with it. The child side of the bare store reads the same hook the existing CHECK cases already cover, so I added no case for it.

**Docs (fixed inline):**

- Stale references to `validateForeignKeyOverExistingRows` as the ALTER entry point, now naming `validateAddedForeignKeyOverExistingRows`: `docs/design-isolation-challenges.md`, `docs/determinism.md`, and three comments in `runtime/emit/add-constraint.ts`.
- `docs/mv-constraints.md` said the materialized-view scans are "the same validators ALTER uses". It now says the ALTER paths add a pass over rollback states.
- The `restorableRowStates` doc in `vtab/module.ts` claimed a module without the hook is fine whenever its DDL rolls back with its data. That does not hold when its table is an FK *parent*: the parent's rows can roll back under a child FK that survives. The doc now says so.

**Tripwires (`NOTE:`, no ticket):**

- A parent whose module has no `restorableRowStates` hook is read as unchanged by any rollback. Every bundled module has the hook. Parked at `foreignKeyRollbackPoints` (`schema/constraint-builder.ts`).
- The materialized-view attach validation judges no rollback state, for CHECK or FK. Whether an attach inside a transaction survives a rollback that restores pre-attach rows is unverified. Parked at `validateDeclaredConstraintsOverContents` (`runtime/emit/materialized-view-helpers.ts`).

**Considered and left as is:**

- `apply schema` adding a fresh FK inside an open transaction now refuses `BUSY`, which `executeMigrationStep` flattens to `ERROR` like every failed step. That site already carries a `NOTE:` about flattening inner codes, so no new action.
- The `add column … references` refusal text (see the deviation above). Fixing it needs a new `SchemaChangeInfo` field for message text alone, and the UNIQUE arms share the behaviour. Not worth a ticket.
- The store's `bufferedRestorableRowStates` builds a new stream per savepoint, so the pair de-duplication never merges store states. This costs at most one extra scan per open savepoint and does not affect correctness.
- `constraint-builder.ts` is 925 lines (`wc -l`). It is cohesive (constraint builders plus existing-row validators), so I did not split it.

**Type safety, error handling, resource cleanup:** no `any`. Each scan statement is finalized in `finally`. `judgeRestorableStates` rewraps only `CONSTRAINT` / `MISMATCH` and lets faults propagate. No issues found.

**Validation:** `yarn build`, `yarn lint` (quereus exit 0), `yarn typecheck` (exit 0), and `yarn test` all green (`@quereus/quereus` 11093 passing / 26 pending; no failures in any workspace). I did not re-run `yarn test:store`: since the implement-stage run, the source changes are comments only, plus one store spec that I ran directly.
