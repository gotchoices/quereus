description: Fixed the memory-table `ALTER PRIMARY KEY` stale-connection leak that tripped `DeferredConstraintQueue.findConnection` ("multiple candidate connections") at commit on self-referential FK tables. `rebuildMemoryTable` now calls `removeConnectionsForTable` after the manager swap, mirroring the drop-table path. Reviewed and accepted with one minor inline comment fix.
files:
  - packages/quereus/src/runtime/emit/alter-table.ts                  # rebuildMemoryTable (~1027-1036) — fix: removeConnectionsForTable after swap
  - packages/quereus/src/core/database.ts                             # removeConnectionsForTable (~1634) — reused cleanup helper (bypasses implicit-txn deferral)
  - packages/quereus/src/runtime/deferred-constraint-queue.ts         # findConnection (~160) — the throw site (symptom); enqueue connectionId from rctx.activeConnection
  - packages/quereus/src/runtime/emit/constraint-check.ts             # ~341 — deferred FK entry takes connectionId = rctx.activeConnection?.connectionId (undefined here → name-match branch)
  - packages/quereus/src/schema/manager.ts                            # dropTable — precedent this mirrors
  - packages/quereus/test/declarative-equivalence.spec.ts             # new REGRESSION sibling (~2272) + clarified comment on the non-PK case (~2216)
----

## Summary

A single-line engine fix plus a regression test. On a memory table, renaming the
PK column emits `ALTER PRIMARY KEY`, which falls through to `rebuildMemoryTable`
(native re-key throws `UNSUPPORTED`). That function builds a fresh shadow manager,
copies rows, and swaps it under the original `schema.table` key — orphaning the
old manager while leaving its `VirtualTableConnection` registered in
`db.activeConnections`. The next DML registers a *second* connection under the
same name, and at the following commit the deferred self-FK entry (which carries
no `connectionId`, so it resolves by name) finds two candidates and throws
`Deferred constraint execution found multiple candidate connections for table
main.node`. The fix adds, immediately after the swap (inside the existing `try`):

```ts
rctx.db.removeConnectionsForTable(schemaName, tableName);
```

mirroring what `drop table` already does on the non-memory path. The orphaned
manager and its pending layer are discarded with the old manager, so no rollback
is needed; the call intentionally bypasses implicit-transaction deferral, exactly
as drop-table relies on.

## Review findings

### Diff read with fresh eyes — root cause confirmed
Independently traced the symptom from `commitTransaction → runDeferredRowConstraints
→ DeferredConstraintQueue.runDeferredRows → findConnection` (deferred-constraint-queue.ts:160).
Confirmed the "multiple candidate connections" throw only fires in the *no-`preferredId`*
branch (line 177), which means the offending deferred entry must carry **no**
`connectionId`. Verified at the enqueue site (constraint-check.ts:341): the entry's
`connectionId` is `rctx.activeConnection?.connectionId`, so the self-FK insert's
deferred child-check is enqueued with `undefined` here, consistent with the
name-match path being the one that throws. Fix placement (after the catalog
swap, inside the `try`) is correct and adjacent to the exact swap that creates
the orphan.

### Correctness / edge cases — checked
- **`removeConnectionsForTable` semantics**: matches on `conn.tableName === schema.table`
  (lowercased) and deletes map entries only; does not touch the live manager. Correct
  target — the fresh post-rebuild connection is registered under the new manager on the
  *next* DML, after this cleanup runs, so it is not collateral. ✓
- **Theoretical dangling-`preferredId` (non-blocking)**: if a deferred entry *did*
  carry a `connectionId` pointing at the removed connection (i.e. a DML that set
  `rctx.activeConnection`, then an `ALTER PRIMARY KEY`, then commit, all inside one
  explicit transaction with the entry undrained), `findConnection(preferredId)`
  would throw "could not find connectionId" instead. This risk is **not introduced
  by this fix** — it is identical to what the long-standing drop-table cleanup does —
  and it is bounded in practice: `rebuildMemoryTable` runs only after
  `ensureSchemaChangeSafety` consolidates transaction layers to base and refuses the
  rebuild while older transaction versions are in use, so the table cannot carry an
  in-flight uncommitted layer across the rebuild. Noted, not actioned.
- **Failure path**: the `catch` deletes the shadow key, which has already been
  renamed away on the success path — harmless. The cleanup line is the last
  statement in the `try`, so a throw from it cannot leave a half-swapped catalog
  (swap + catalog update already completed). ✓

### Placement / DRY
Implementer chose memory-only placement over hoisting into the shared
`rebuildTableWithNewShape` parent, and documented the choice. Accepted: the shadow
path (`rebuildViaShadowTable`) already cleans up via a real `drop table`, so hoisting
would be a harmless no-op there but is a defensible style preference, not a defect.
The targeted placement keeps the fix next to the orphan-creating swap.

### Tests
- New `REGRESSION` sibling reproduces the exact ticket scenario: seed
  `node(code PK, parent_code)` with a self-FK, declaratively rename the **PK**
  column `code → ucode` (→ `ALTER PRIMARY KEY`), insert a valid self-reference
  `(3, 2)` that must commit, and assert an orphan `(4, 999)` is still rejected at
  commit by the deferred self-FK. Covers happy path + error path. The implementer's
  negative-control (neutralize the fix → exact production symptom reappears) makes
  this a genuine regression guard, not just a happy-path test. ✓
- **Minor fix applied (this pass)**: the pre-existing non-PK self-FK case
  (declarative-equivalence.spec.ts:2216) had a comment describing the PK-rename bug
  in present tense ("trips a separate engine issue … see the review handoff") as if
  unresolved. Updated it to note the bug is now fixed and that the PK path is covered
  by the sibling REGRESSION case, so the comment no longer implies a live defect.

### Docs
Checked `docs/schema.md`, `docs/runtime.md`, and the alter-table source/doc comments.
This is an internal correctness fix with no user-visible behavior change (the
operation simply now succeeds where it previously threw an internal error), and no
doc describes the connection-registry invariant of the rebuild swap. No doc update
warranted. Stated explicitly rather than silently.

### Lint + tests (must-pass gate)
- `yarn lint` (packages/quereus) → exit 0, clean.
- Full suite `node test-runner.mjs` → **4863 passing, 9 pending**, exit 0.
- Targeted `--grep "self-referential FK"` → 2 passing (both self-FK cases), re-run
  green after the comment edit.

### Deferred / not done (carried from implement, accepted)
- **`yarn test:store` not run** — the store module has its own `alterPrimaryKey`
  (`packages/quereus-store/src/common/store-module.ts`, ~812) with an independent
  re-key (`rekeyRows`) and connection model; it does **not** route through
  `rebuildMemoryTable`, so it is not affected by this fix. Eyeballed the store
  `alterPrimaryKey` — it updates schema in place and rebuilds indexes, no
  manager-swap that would orphan a connection. The slow LevelDB `test:store` path
  was not run (agent-time tradeoff); no change touches store code, so this is not a
  review blocker.
- **Pre-existing unused `schema` param in `rebuildViaShadowTable`** (TS6133-class):
  in a function this change does not touch; eslint did not flag it (exit 0). Out of
  scope, left as-is.

**Disposition:** No major findings — no new ticket filed. One minor finding (stale
test comment) fixed inline. Fix is correct, well-placed, mirrors an established
precedent, and is guarded by a regression test with a verified negative control.
