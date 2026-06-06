description: Review the fix for a stale source-table read mid-transaction after an in-transaction `alter table … add column` when a materialized view over that source exists. A source connection detached from its MemoryTableManager's `connections` map (autocommit collapse) but still in the Database registry kept a stale pre-alter `readLayer`; `ensureSchemaChangeSafety` only re-pointed map connections. The fix adds `repointRegisteredConnections()` to re-point every registered (incl. detached) source connection at the new base layer.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, docs/materialized-views.md
----

## What changed

### 1. `MemoryTableManager.ensureSchemaChangeSafety` (manager.ts) — the fix
After the existing `this.connections.values()` re-point loop, added a call to a
new private helper `repointRegisteredConnections()`, plus the helper itself, and the
import `import { MemoryVirtualTableConnection } from '../connection.js';`.

The helper iterates `this.db.getConnectionsForTable(qualifiedName)`, unwraps each
`MemoryVirtualTableConnection` → `getMemoryConnection()`, and for connections backed
by **this** manager with `pendingTransactionLayer === null` and a `readLayer` not
already the base, re-points `readLayer` to `this.baseLayer`. This closes the gap for a
connection that is **detached** from the manager's `connections` map (removed by
`disconnect()` after an autocommit layer collapse) but still **registered** in the
Database registry — exactly the connection `MemoryTable.ensureConnection` reuses for a
later scan. The unwrap pattern mirrors `getBackingConnection` in
`core/database-materialized-views.ts`.

### 2. `MemoryTable.ensureConnection` (table.ts) — comment correction only
The justification "Schema changes can't happen during a transaction
(ensureSchemaChangeSafety throws on active transactions), so staleness is not a concern
here" was **false** (in-transaction `alter add column` works and is the whole bug).
Rewrote the comment to state that an in-transaction schema change re-points every
registered connection (incl. the detached one reused here) via
`ensureSchemaChangeSafety`, so reuse observes the current base. **No behavioral change**
to this method — staleness is resolved upstream.

### 3. Regression test — `51-materialized-views.sqllogic` §11
A join-MV `select * from itx_ord o join itx_cust c on …` (the sharpest reproducer).
After an autocommit source scan leaves a detached-but-registered source connection,
inside one explicit transaction it runs `alter table itx_ord add column extra text
default 'x'`, then asserts **both**:
  - (b) the same-transaction direct `select * from itx_ord` returns the new column with
    its backfilled default; and
  - (a) `refresh materialized view itxv` rebuilds the backing so the post-commit
    `select * from itxv` shows every value under the right label (no misalignment).
Plus a post-commit row-time insert carrying the new column.

### 4. `docs/materialized-views.md` — one-paragraph note
Under § Schema-change staleness, documents that an in-transaction source schema change
re-points all registered source connections (incl. detached ones) so a same-transaction
read and the refresh scan observe the new column shape.

## Validation performed

- **Regression guard proven**: with `repointRegisteredConnections()` commented out, §11
  FAILS at the first in-transaction `select * from itx_ord` — actual
  `{"id":10,"customer_id":1,"amt":100}` vs expected `…,"extra":"x"` (the stale 3-column
  shape, exactly the bug). With the fix restored it passes.
- `yarn workspace @quereus/quereus run typecheck` — clean.
- Full `logic.spec.ts` — **223 passing**.
- Full `yarn test` (memory) — **4905 passing, 9 pending, 0 failing**.
- `eslint` on both changed source files — clean.

## Review focus / use cases to probe

- **Soundness of the `pendingTransactionLayer === null` guard.** The helper never
  re-points a connection holding an uncommitted pending layer, so no in-flight write is
  discarded. Note the *pre-existing* `this.connections.values()` loop re-points
  `readLayer` to base with **no** pending guard at all (it only leaves
  `pendingTransactionLayer` untouched); the new helper is strictly **more** conservative.
  Worth confirming the reviewer agrees the guard is sufficient and consistent.
- **Eager-swap savepoint edge** (flagged honestly): a connection with
  `pendingTransactionLayer === null` whose `readLayer` is a savepoint *snapshot* holding
  uncommitted writes would be re-pointed to base by this helper — but the existing map
  loop already does the same for map connections, and reaching this requires a detached
  connection that did a savepoint eager-swap *and then* an in-transaction ALTER. This is
  pre-existing behavior (and `isLayerInUse` already ignores detached connections), not a
  new hazard introduced here. Probe if you want to be thorough; not expected to be
  reachable through normal SQL.
- **Explicitly out of scope (do NOT widen here):** `begin; insert into <source>; alter
  table <source> add column; …` — a write *then* an in-transaction schema change on the
  **same** connection, which holds an uncommitted pending layer built on the old schema.
  This is a distinct, pre-existing concern independent of materialized views; the
  `pendingTransactionLayer === null` guard deliberately leaves it untouched. If the
  reviewer judges it worth fixing, file a **separate** fix/ ticket — it needs its own
  pending-layer schema-migration design.
- **Coverage floor**: §11 covers the single-source-row join-MV case. Not exercised:
  multi-row sources under the same in-transaction alter+refresh, `drop column` /
  `rename column` in-transaction with an MV present (the same `ensureSchemaChangeSafety`
  path, so the fix should cover them, but only `add column` is asserted), and the store
  module path (`yarn test:store` was not run — memory-only validation).
