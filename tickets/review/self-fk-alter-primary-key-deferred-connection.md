description: Review the fix for the memory-table `ALTER PRIMARY KEY` stale-connection leak that tripped `DeferredConstraintQueue.findConnection` ("multiple candidate connections") at commit for self-referential FK tables. Fix adds a `removeConnectionsForTable` cleanup inside `rebuildMemoryTable` after the manager swap, mirroring the drop-table path.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                  # rebuildMemoryTable — fix site (after catalog swap, in the try block)
  - packages/quereus/src/core/database.ts                             # removeConnectionsForTable (~1633) — the reused cleanup helper
  - packages/quereus/src/schema/manager.ts                            # dropTable (~951) — the precedent this mirrors
  - packages/quereus/test/declarative-equivalence.spec.ts             # new sibling regression test (~2272) + existing non-PK self-FK case (~2216)
  - packages/quereus/src/runtime/deferred-constraint-queue.ts         # findConnection (~158) — the throw site (symptom)
----

## What was implemented

Single-line fix plus a regression test. Root cause and analysis are exactly as
laid out in the implement ticket (confirmed accurate during implementation).

### Source change — `rebuildMemoryTable` (alter-table.ts)

After the manager swap and catalog `removeTable`/`addTable` (inside the existing
`try` block), added:

```ts
rctx.db.removeConnectionsForTable(schemaName, tableName);
```

with a comment explaining why (the swapped-out manager is orphaned; any
`VirtualTableConnection` still bound to it is stale and would coexist with a
fresh connection registered on the next DML, leaving two candidates under the
same `schema.table` name → `findConnection` throws at the next commit when a
deferred self-FK — which carries no `connectionId` — resolves by name).

**Placement decision:** memory-only, inside `rebuildMemoryTable` (the minimal
change), per the ticket's "pick one and note the choice." The non-memory
`rebuildViaShadowTable` path already cleans up via a real `drop table`
(`schema/manager.ts` dropTable → `removeConnectionsForTable`), so it needs no
change. I did **not** hoist the call into the shared `rebuildTableWithNewShape`
parent (the ticket noted that would be a defensible alternative but a harmless
no-op for the shadow path); the targeted placement keeps the fix adjacent to the
exact swap that creates the orphan.

### Test change — `declarative-equivalence.spec.ts`

Added a sibling to the existing non-PK self-FK case:
`REGRESSION: a self-referential FK over a renamed PK column (→ ALTER PRIMARY KEY)
commits with the deferred self-FK enforced`. This is the ticket's exact repro:
seed `node(code PK, parent_code)` with a self-FK, `apply` a declarative rename of
the **PK** column `code → ucode` (→ `ALTER PRIMARY KEY`), then `insert into node
values (3, 2)` which must commit, and assert an orphan `insert ... (4, 999)` is
still rejected at commit by the deferred self-FK.

The pre-existing non-PK case (~line 2216) was left as-is — its comment documents
that it uses a UNIQUE referenced column to isolate FK-churn reconciliation from
this PK-rebuild bug; that case still serves its original purpose. The new test
covers the PK path the old case deliberately avoided.

## Validation performed

- **Negative control (the important one):** temporarily neutralized the fix
  line and ran the new test — it fails with the exact production symptom
  `QuereusError: Deferred constraint execution found multiple candidate
  connections for table main.node`, thrown from `DeferredConstraintQueue.
  findConnection` via `commitTransaction → runDeferredRowConstraints`. Restored
  the fix → test passes. So the test genuinely guards the regression, not just
  the happy path.
- Full memory-vtab suite: `yarn workspace @quereus/quereus test` → **4863
  passing, 9 pending** (includes the new test and the alter-pk sqllogic /
  shadow-ddl specs).

## Known gaps / what the reviewer should scrutinize

- **`yarn test:store` not run.** The ticket flagged a spot-check of the store
  module's own `alterPrimaryKey` (`store-module.ts`, different connection model)
  as "if convenient." I did not run it — `test:store` is the slow LevelDB path.
  The store path is not believed affected (it has its own re-key implementation
  and does not go through `rebuildMemoryTable`), but this is an unverified claim.
  A reviewer with time should run `yarn test:store` or at least eyeball
  `store-module.ts`'s alterPrimaryKey to confirm it doesn't leave an analogous
  stale connection.
- **Pre-existing lint diagnostic (not mine):** `rebuildViaShadowTable` in
  alter-table.ts has an unused `schema` parameter (TS6133 at ~line 1106). It is
  in a function this change does not touch and predates this ticket — flagged
  here only so the reviewer doesn't attribute it to the fix. Out of scope.
- The fix relies on `removeConnectionsForTable` correctly bypassing the
  implicit-transaction deferral (it does — same code drop-table depends on).
  Worth a glance that the swap genuinely discards the old manager's pending
  layer with no rollback need; analysis says yes (the orphaned manager is
  dropped from `module.tables` and unreferenced), but it's the one place a
  subtle leak could hide.
