description: Fixed a stale source-table read mid-transaction after an in-transaction `alter table … add column` when a materialized view over that source exists. A source connection detached from its MemoryTableManager's `connections` map (autocommit collapse) but still registered in the Database kept a stale pre-alter `readLayer`; `ensureSchemaChangeSafety` only re-pointed map connections. The fix adds `repointRegisteredConnections()` to re-point every registered (incl. detached) source connection at the new base layer.
files: packages/quereus/src/vtab/memory/layer/manager.ts, packages/quereus/src/vtab/memory/table.ts, packages/quereus/test/logic/51-materialized-views.sqllogic, docs/materialized-views.md
----

## Summary

`MemoryTableManager.ensureSchemaChangeSafety` re-points connections' `readLayer` to the
current base layer so an in-transaction schema change (e.g. `alter table … add column`,
which is permitted inside an explicit transaction) is observed by subsequent reads. It
formerly iterated only `this.connections` (the manager's own map). A connection can be
**detached** from that map (removed by `disconnect()` after an autocommit layer collapse)
while remaining **registered** in the Database connection registry — and
`MemoryTable.ensureConnection` reuses exactly such a connection for a later scan. The
detached connection kept a stale pre-alter `readLayer` carrying the old column shape, so a
same-transaction source read missed the new column and a `refresh materialized view`
refilled the backing with misaligned values.

The fix adds a private `repointRegisteredConnections()` helper, called at the end of
`ensureSchemaChangeSafety`, that walks `db.getConnectionsForTable(qualifiedName)`, unwraps
each `MemoryVirtualTableConnection → getMemoryConnection()`, and re-points to
`this.baseLayer` every connection backed by **this** manager that carries no uncommitted
pending layer (`pendingTransactionLayer === null`). The unwrap pattern mirrors
`getBackingConnection` in `core/database-materialized-views.ts`.

The stale `MemoryTable.ensureConnection` comment (which falsely claimed schema changes
can't happen during a transaction) was corrected — no behavioral change there; staleness
is resolved upstream. A §11 regression test and a docs note under § Schema-change
staleness were added.

## Review findings

### What was checked
- Re-read the implement diff (commit `c848493d`) with fresh eyes: the `manager.ts` helper +
  call site, the `table.ts` comment correction, the §11 test, and the docs note.
- **Soundness of why the upstream fix is necessary.** Traced `explicitTransaction`
  propagation: `begin` broadcasts to every registered connection (commit/rollback comments
  confirm DB-level broadcasts hit all connections), so the reused detached connection has
  `explicitTransaction === true` at reuse time → the *existing* `readLayer` reset in
  `ensureConnection` (table.ts:107-109) is **skipped** → the upstream re-point in
  `ensureSchemaChangeSafety` is genuinely required. Confirmed.
- **In-place base-layer invariant.** `addColumn` mutates `this.baseLayer` in place via
  `updateSchema` (not a replace), so re-pointing `readLayer` to the `baseLayer` *object*
  *before* the mutation is correct — the connection observes post-mutation schema through
  the same reference, and the `catch` path restores the schema on that same object (no
  half-state).
- **Generality.** Verified every schema op (`addColumn`, `dropColumn`, `renameColumn`,
  `alterColumn`, `createIndex`, `dropIndex`, `dropConstraint`, `renameConstraint`,
  `addConstraint`) routes through `ensureSchemaChangeSafety`, so the fix covers all of them
  even though the test asserts only `add column`.
- **Guard soundness.** The `pendingTransactionLayer === null` guard never discards an
  in-flight write; the helper is strictly *more* conservative than the pre-existing
  `connections`-map loop (which re-points with no pending guard at all).
- **Dependencies.** `getConnectionsForTable`, `MemoryVirtualTableConnection.getMemoryConnection`,
  `tableManager` all exist and behave as assumed; the `mc.tableManager !== this` guard
  correctly rejects a same-simple-name connection from another schema.
- **Docs** read for accuracy against the new reality (Schema-change staleness section).

### What was found / done
- **Correctness — no issues.** The fix is sound, minimal, and well-targeted. No major
  findings; no new tickets filed.
- **Regression guard independently verified (not just trusted).** Temporarily commented
  out `this.repointRegisteredConnections()` → §11 fails at the first in-transaction
  `select * from itx_ord` with the stale 3-column shape (`{id,customer_id,amt}` vs expected
  `…,extra:"x"`), exactly the reported bug; restored → passes. Working tree confirmed clean
  after restore.
- **Minor — DRY (noted, not fixed):** the unwrap idiom (`instanceof
  MemoryVirtualTableConnection` → `getMemoryConnection()` → `tableManager === manager`) now
  appears in three sites (`getBackingConnection`, `ensureConnection`,
  `repointRegisteredConnections`) across two files/classes. Extracting a shared helper is
  borderline and would cross class/module boundaries; left as-is, flagged for future
  consolidation.
- **Minor — coverage floor (noted, not expanded):** only `add column` is asserted.
  `drop`/`rename`/`alter column` in-transaction with an MV, multi-row sources, and the
  store-module path (`test:store`) are not independently exercised. They traverse the
  *same* `ensureSchemaChangeSafety` → `repointRegisteredConnections` line, so the fix
  covers them; a dedicated drop-column-with-MV test was deliberately *not* added to avoid
  entangling the regression with stale-MV "drop and recreate" diagnostic behavior (a
  separate concern). Documented rather than risk a finicky test.
- **Pre-existing, out of scope (noted):** the `connections`-map loop
  (manager.ts:2290-2294) re-points `readLayer` to base with no pending/savepoint-snapshot
  guard — a latent concern for a map connection mid eager-swap savepoint holding
  uncommitted writes in its snapshot under an in-transaction ALTER. The new helper is more
  conservative and does **not** worsen this. Also out of scope (per the implement ticket):
  `begin; insert into <source>; alter table <source> add column` on the *same* connection
  (holds an uncommitted pending layer on the old schema) — distinct pending-layer
  schema-migration concern; the `pendingTransactionLayer === null` guard intentionally
  leaves it untouched. Neither warrants a ticket at this time.

### Validation
- `yarn workspace @quereus/quereus run typecheck` — clean.
- `eslint` on both changed source files — clean.
- `logic.spec.ts` — 223 passing.
- Full memory suite (`test-runner.mjs`) — **4905 passing, 9 pending, 0 failing**.
- `test:store` not run (memory-only validation, as in implement) — store path covered only
  by code-path generality, not asserted.
