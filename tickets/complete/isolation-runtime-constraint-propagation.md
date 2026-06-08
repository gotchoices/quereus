description: Closed a silent divergence in `@quereus/isolation`: a freshly-connected `IsolatedTable`'s merged-view UNIQUE pre-check read the cached underlying VirtualTable's construction-time `tableSchema` snapshot, which `IsolationModule.alterTable` never refreshed after a module-level `underlying.alterTable`. Fix re-points `underlyingState.underlyingTable.tableSchema` to the schema `alterTable` returns. Three previously-skipped memory arms (ADD/DROP UNIQUE, SET COLLATE) un-skipped and pass; added two store-backed runtime ALTER-UNIQUE regression arms.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/alter-table-conformance.spec.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## What shipped

**Production fix** (`packages/quereus-isolation/src/isolation-module.ts`, in
`IsolationModule.alterTable`, ~line 718) — after `underlying.alterTable(...)`,
refresh the cached underlying instance's schema field:

```ts
const underlyingState = this.getUnderlyingState(schemaName, tableName);
if (underlyingState) underlyingState.underlyingTable.tableSchema = updated;
```

The module-level `underlying.alterTable` rotates the underlying *manager's* schema
but not the cached *instance's* `tableSchema` field (a construction-time snapshot
for `MemoryTable`). Each `connect()` wraps that same cached instance in a fresh
`IsolatedTable`, whose constructor (and `ensureOverlay`) snapshots
`underlyingTable.tableSchema`; the merged-view UNIQUE check
(`checkMergedUniqueConstraints` / `findMergedUniqueConflict`) reads
`this.tableSchema.uniqueConstraints` / per-column `.collation`. Without the refresh,
post-alter connections kept reading the stale pre-alter constraint set — the
catalog (`table_info` / `unique_constraint_info`) was correct (reads from the
schema manager), so the divergence was silent. Mirrors the implicit instance
refresh `dropIndex` already gets (it forwards to the instance-level
`state.underlyingTable.dropIndex`, which self-refreshes).

**Tests** — un-skipped the three memory `ISOLATION_GAP_ARMS`
(`alter-table-conformance.spec.ts`) and rewrote their comment from "known gap" to
"covered regression"; added two store-backed runtime ALTER-UNIQUE arms to
`isolated-store.spec.ts` (closing the gap the implementer flagged).

## Review findings

**Scope of review:** the implement-stage diff (commit `c43bb0fa`), the full
`IsolationModule.alterTable` body and its `getUnderlyingState`/`connect`/`create`/
`dropIndex` neighbors, `IsolatedTable`'s schema-snapshot sites and merged-UNIQUE
path, the entire store-module `alterTable` switch (all eight cases) and
`StoreTable.tableSchema`/`updateSchema`, the conformance + store test harnesses, and
the isolation README + `docs/module-authoring.md`/`docs/architecture.md`.

**Correctness / SPP / type-safety — no findings.** The fix is the minimal correct
change. Verified adversarially:
- *Key consistency:* `getUnderlyingState` keys on `` `${schemaName}.${tableName}`.toLowerCase() ``,
  identical to `setUnderlyingState` at create/connect — the refresh cannot silently
  miss on identifier casing.
- *Underlying-agnostic safety:* `tableSchema` is a plain writable field on
  `VirtualTable`; both `MemoryTable` and `StoreTable` assign it directly elsewhere.
  For **store** the write is a verified no-op, not just reasoned: every one of the
  eight `store-module.alterTable` cases (addColumn, dropColumn, renameColumn,
  alterPrimaryKey, addConstraint, dropConstraint, renameConstraint, alterColumn)
  does `table.updateSchema(updatedSchema); return updatedSchema` — the same object
  the isolation fix then re-assigns. The two early `return oldSchema` no-op-alter
  guards likewise return the schema the table already holds.
- *No stale `updated`:* the value written is the `alterTable` return, the
  post-alter schema; `IsolatedTable` is reconstructed per statement and re-reads it,
  `predicateCache` is a `WeakMap` keyed on `UniqueConstraintSchema` identity (new
  constraint objects → fresh compiles), and open overlays are rebuilt against
  `updated` by `migrateOverlayForAlter` — so no broader invalidation is needed.

**Coverage — gap found and closed (minor, fixed in this pass).** The implementer
exercised the runtime ALTER-UNIQUE path only against the **memory** underlying and
left the store path "reasoned, not tested." Added two store-backed arms to
`isolated-store.spec.ts` → `ALTER TABLE overlay migration`:
- runtime `ADD CONSTRAINT … UNIQUE` then duplicate INSERT → rejected with a UNIQUE
  error;
- runtime `DROP CONSTRAINT … UNIQUE` then once-duplicate INSERT → accepted
  (count == 2).
These prove the store no-op empirically through a real connection. Other paths
(cross-connection overlay migration, poison, autocommit pre-check) were already
covered and are unaffected.

**Docs — checked, accurate, no change.** The isolation `README.md` ALTER section
documents issuer/foreign-overlay atomicity + poison (a separate concern, untouched);
`docs/module-authoring.md` documents the module-level `alterTable` contract and a
*different* tracked gap (`store-pk-collate-module-capability` for PK-column
collation). This fix is a wrapper-only snapshot bug — it changes no module
capability and was never documented as a gap (only the test-file comment, which the
implementer correctly updated). Nothing stale.

**Trivial observation (no change made):** `dropIndex` guards its analogous refresh
with `if (!updatedSchema) return;` whereas the alter fix guards only
`if (underlyingState)`, not `updated`. `alterTable`'s return type is the
non-optional `TableSchema`, so a nullish `updated` would violate the contract
upstream; the asymmetry is cosmetic and not worth churning the 3-line fix.

**Major findings → new tickets:** none. No `fix`/`plan`/`backlog` tickets filed.

## Validation

- `yarn workspace @quereus/isolation typecheck` — clean (EXIT 0).
- `yarn workspace @quereus/isolation test` — **126 passing** (EXIT 0); the three
  un-skipped arms green.
- `yarn workspace @quereus/store test` — **366 passing / 1 pending** (EXIT 0),
  including the two new runtime ALTER-UNIQUE arms (was 364). The `Error: boom` /
  rehydrate-skip lines are deliberate error-path logging inside passing tests.
- Lint not applicable: only `packages/quereus` has an eslint script, and this change
  touches only `@quereus/isolation` (one source file) and `@quereus/store` (test
  only). The implementer's full-suite `yarn test` (5367 passing / 9 pending) on the
  identical source already covers cross-package integration; the source file is
  unchanged by this review pass (test-only additions).

## Pre-existing failures

None encountered; no `.pre-existing-error.md` written. The pending tests are
unrelated pre-existing skips.
