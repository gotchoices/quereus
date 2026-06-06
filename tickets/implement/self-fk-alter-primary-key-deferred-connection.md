description: Memory-table `ALTER PRIMARY KEY` rebuild orphans its old manager but leaves the stale VirtualTableConnection registered, so the next DML registers a second connection under the same `schema.table` name — tripping `DeferredConstraintQueue.findConnection` ("multiple candidate connections") at the following commit. Fix: remove the table's stale connections during the memory rebuild swap, matching what `drop table` already does on the non-memory path.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                  # rebuildMemoryTable (~line 956-1033) — the swap site that orphans the old manager
  - packages/quereus/src/core/database.ts                             # removeConnectionsForTable (~line 1634); getAllConnections / registerConnection
  - packages/quereus/src/runtime/utils.ts                             # getVTableConnection (~line 73) — reuse-by-name + stale-manager skip
  - packages/quereus/src/runtime/deferred-constraint-queue.ts         # findConnection (~line 160) — the throw site (symptom, not cause)
  - packages/quereus/src/schema/manager.ts                            # dropTable (~line 951) — the existing removeConnectionsForTable precedent
  - packages/quereus/test/declarative-equivalence.spec.ts             # self-FK churn case currently sidesteps via a non-PK UNIQUE ref column
effort: medium
----

## Root cause (confirmed)

`ALTER PRIMARY KEY` on a memory table falls through the native re-key attempt
(`module.alterTable({type:'alterPrimaryKey'})` throws `UNSUPPORTED`) into
`rebuildTableWithNewShape` → **`rebuildMemoryTable`** in
`packages/quereus/src/runtime/emit/alter-table.ts`.

That function builds a fresh shadow `MemoryTable` manager, copies rows into it,
then **swaps it in under the original `schema.table` key**:

```
module.tables.delete(oldKey);
module.tables.delete(shadowKey);
shadowMgr.renameTable(tableName);
module.tables.set(oldKey, shadowMgr);   // old manager is now orphaned
schema.removeTable(tableName);
schema.addTable(shadowMgr.tableSchema);
```

It never calls `removeConnectionsForTable`. So any `VirtualTableConnection`
registered during an earlier DML in the session (e.g. the seed
`insert into node values (1,null),(2,1)`) stays in `db.activeConnections`,
still bound to the **orphaned old manager**.

On the next `insert into node`, `getVTableConnection` would normally reuse that
connection by name — but it is stale (its `memoryConnection.tableManager` no
longer matches the live shadow manager), so the write path ends up registering a
**second** connection against the live manager. Now two connections share the
`main.node` name.

At the following commit, `TransactionManager.runDeferredRowConstraints` →
`DeferredConstraintQueue.runDeferredRows` → `findConnection` is invoked for the
deferred **self-FK** entry, which carries **no `connectionId`**. The name-match
branch finds two candidates, neither `isCovering`, and throws:

```
Deferred constraint execution found multiple candidate connections for table main.node
```

This is why only the *self-referential* FK case fires: a non-self FK's deferred
entry resolves a different table, and a non-FK `ALTER PRIMARY KEY` simply never
enqueues a deferred row that re-enters `findConnection`. The duplicate stale
connection is left behind regardless of self-FK — it is just only *observed*
when a deferred self-FK fires.

The non-memory (`rebuildViaShadowTable`) path does **not** have the bug because
it issues a real `drop table` on the original, and `schema/manager.ts` dropTable
already calls `db.removeConnectionsForTable(...)`.

## Reproduction (verified failing on HEAD)

```sql
pragma foreign_keys = true;
declare schema main {
  table node { code INTEGER PRIMARY KEY, parent_code INTEGER null,
               constraint fk foreign key (parent_code) references node(code) }
}
apply schema main;
insert into node values (1, null), (2, 1);

declare schema main {
  table node { ucode INTEGER PRIMARY KEY with tags ("quereus.previous_name" = 'code'),
               parent_code INTEGER null,
               constraint fk foreign key (parent_code) references node(ucode) }
}
apply schema main;

insert into node values (3, 2);   -- throws at commit on HEAD
```

Connection-state trace from a throwaway probe:

```
after first insert:        [ memory-main.node-0 :: main.node ]
after apply (alter pk):    [ memory-main.node-0 :: main.node ]   <-- stale, still bound to old mgr
after insert(3,2) [fail]:  [ memory-main.node-0, memory-main.node-1 ]  <-- duplicate
```

## Fix (verified)

In `rebuildMemoryTable`, immediately after the manager swap (after
`module.tables.set(oldKey, shadowMgr)` and the catalog `removeTable`/`addTable`),
drop the table's now-stale connections:

```ts
// The old manager is now orphaned. Any active VirtualTableConnection bound to
// it (e.g. from a prior insert in this session) is stale and must not be reused
// against the rebuilt table — a reused-stale + fresh connection pair leaves two
// candidates registered for the same table name, which trips
// DeferredConstraintQueue.findConnection at the next commit.
rctx.db.removeConnectionsForTable(schemaName, tableName);
```

With this change the probe shows `[]` connections after the apply and a single
fresh connection after `insert(3,2)`, which then succeeds; the deferred self-FK
enforces normally (valid self-reference accepted, orphan rejected).

`removeConnectionsForTable` only deletes the map entries (the orphaned memory
manager and its pending layer are discarded with the old manager — no rollback
needed), and it intentionally bypasses the implicit-transaction deferral, exactly
as the `drop table` path relies on.

### Validation already run with the candidate patch in place
- The repro above: passes (insert succeeds, single connection).
- `declarative-equivalence.spec.ts`, `alter-add-constraint.spec.ts`,
  `alter-drop-rename-constraint.spec.ts`: 83 passing.
- `runtime/shadow-ddl.spec.ts` + full `logic.spec.ts` (includes
  `logic/41.1-alter-pk.sqllogic`): 230 passing.

## Notes / scope for the implementer

- Keep the fix inside `rebuildMemoryTable`. Do **not** try to "harden"
  `findConnection` to pick among duplicates — the duplicate registration is the
  actual defect; masking it there hides future stale-connection leaks.
- Consider whether the same stale-connection cleanup belongs at the end of
  `rebuildTableWithNewShape` (covers both memory and shadow paths uniformly)
  rather than only inside `rebuildMemoryTable`. The shadow path already cleans up
  via `drop table`, so a call there would be a harmless no-op — placing it in the
  shared parent is defensible if you prefer one cleanup site; placing it in
  `rebuildMemoryTable` is the minimal change. Pick one and note the choice.
- The `test/declarative-equivalence.spec.ts` self-FK churn case currently uses a
  **non-PK UNIQUE** referenced column specifically to dodge this bug. Once fixed,
  consider switching it (or adding a sibling case) to reference the **PK** column
  so the regression is guarded by that harness.

## TODO

- [ ] Add `rctx.db.removeConnectionsForTable(schemaName, tableName)` after the
      manager swap in `rebuildMemoryTable` (`packages/quereus/src/runtime/emit/alter-table.ts`).
      Decide memory-only vs. shared `rebuildTableWithNewShape` placement per the note above.
- [ ] Add a regression test for the exact repro (self-FK table, declarative
      `apply` that renames the PK column → `ALTER PRIMARY KEY`, then an insert
      that must commit with the deferred self-FK enforced). A focused
      `.spec.ts` is fine; or extend `declarative-equivalence.spec.ts` per the
      note. Also assert an orphan insert (`insert into node values (4, 999)`)
      is still rejected at commit.
- [ ] Run `yarn workspace @quereus/quereus test` (memory vtab) and confirm green.
- [ ] Spot-check `yarn test:store` for the alter-pk logic path if convenient
      (the store module has its own `alterPrimaryKey` in `store-module.ts` and a
      different connection model; not believed affected, but worth a glance).
