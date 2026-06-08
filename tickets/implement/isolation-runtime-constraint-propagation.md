description: After a runtime `alterTable` that changes UNIQUE constraints or a UNIQUE column's collation, `@quereus/isolation` keeps enforcing UNIQUE against the PRE-alter schema. Root cause: `IsolationModule` caches one long-lived underlying table instance whose `tableSchema` is a construction-time snapshot, and `alterTable` forwards to the module-level `underlying.alterTable` (which rotates the *manager's* schema) without refreshing that snapshot — so every freshly-connected `IsolatedTable` copies the stale UNIQUE set into its merged-view conflict check. Fix validated: refresh the cached instance's `tableSchema` from the schema `underlying.alterTable` returns.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/alter-table-conformance.spec.ts, packages/quereus-isolation/src/isolated-table.ts
----

## Root cause (confirmed)

`IsolationModule` connects to the underlying module exactly once (at `create`,
or the first `connect` if pre-existing) and caches the resulting `VirtualTable`
in `underlyingTables` (`UnderlyingTableState.underlyingTable`). Every subsequent
`IsolationModule.connect()` reuses that cached instance and wraps it in a fresh
`IsolatedTable`, whose constructor snapshots the schema:

```
// isolated-table.ts:68
this.tableSchema = underlyingTable.tableSchema;
```

For the default memory underlying, `MemoryTable.tableSchema` is itself a
**construction-time snapshot** of `manager.tableSchema` (table.ts:56), not a live
getter. `IsolationModule.alterTable` (isolation-module.ts:650) forwards to the
**module-level** `underlying.alterTable`, which mutates the *manager* and returns
the new `TableSchema` — but the cached `MemoryTable` instance's `tableSchema`
field is never updated. (Contrast `IsolationModule.dropIndex`, which calls the
**instance-level** `state.underlyingTable.dropIndex(...)`; the MemoryTable's own
`dropIndex` refreshes `this.tableSchema = this.manager.tableSchema`, so index DDL
already propagates. ALTER has no such instance-level refresh.)

Net effect: after a runtime UNIQUE add/drop or a UNIQUE-column collation change,
`IsolatedTable.checkMergedUniqueConstraints` / `findMergedUniqueConflict` read
`this.tableSchema.uniqueConstraints` (and per-column `.collation`) from the stale
pre-alter snapshot. The catalog (what `table_info` / `unique_constraint_info`
report) is correct because that comes from the schema manager, not the vtab
instance — which is exactly why the divergence is silent.

Per-arm manifestation (all reproduced — see below):
- **ADD UNIQUE** — pre-check has no knowledge of the new constraint, so the
  duplicate is staged into the overlay and only caught at the commit flush by the
  underlying, where `assertFlushWriteOk` converts it to `StatusCode.INTERNAL`
  (code 2) "isolation-layer invariant violation" instead of `CONSTRAINT` (19).
- **DROP UNIQUE** — pre-check still sees the dropped constraint and rejects the
  (now legal) duplicate with the isolation layer's own message
  `UNIQUE constraint failed: t (email)` (from `checkMergedUniqueConstraints`,
  isolation-table.ts ~1270).
- **SET COLLATE** on a non-PK UNIQUE column — `findMergedUniqueConflict` compares
  under the stale BINARY collation, misses the NOCASE collision, and it surfaces
  as INTERNAL at flush (same path as ADD).

## Reproduction (done)

Un-skipping the three `ISOLATION_GAP_ARMS` cells and running:

```
node --import ./packages/quereus-isolation/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-isolation/test/alter-table-conformance.spec.ts" \
  --grep "isolation-runtime-constraint-propagation" --reporter spec
```

yields exactly the ticket's symptoms: ADD → `expected 2 to equal 19`, DROP →
`ConstraintError: UNIQUE constraint failed: t (email)`, COLLATE →
`expected 2 to equal 19`.

## Fix (validated)

In `IsolationModule.alterTable`, after the underlying alter returns the new
schema, refresh the cached underlying instance's snapshot so every later
`connect()` wraps the post-alter schema:

```ts
const updated = await this.underlying.alterTable(db, schemaName, tableName, change);

// The cached underlying VirtualTable's `tableSchema` is a construction-time
// snapshot (e.g. MemoryTable.tableSchema); module-level alterTable rotates the
// underlying manager's schema but not this instance's field. Refresh it so a
// freshly-connected IsolatedTable's merged-view UNIQUE check (which reads
// this.tableSchema.uniqueConstraints / per-column collation) sees the post-alter
// constraint set. Mirrors the implicit instance refresh dropIndex already gets.
const underlyingState = this.getUnderlyingState(schemaName, tableName);
if (underlyingState) underlyingState.underlyingTable.tableSchema = updated;
```

Placement: immediately after the existing `const updated = await this.underlying.alterTable(...)`
line (isolation-module.ts:716), before the issuer-overlay migration. `VirtualTable.tableSchema`
is a plain writable field; both `MemoryTable` and `StoreTable` (store-table.ts:170/190)
assign it directly, so the write is safe and is idempotent for a store underlying that
already refreshes its own instance.

With this one change the full `@quereus/isolation` suite passes (126 tests),
including the three un-skipped gap arms.

### Why this is sufficient (no broader invalidation needed)
- `IsolatedTable` is constructed fresh per statement (even inside an open txn),
  so it always re-reads `state.underlyingTable.tableSchema` — fixing the source
  snapshot propagates everywhere.
- `predicateCache` is a `WeakMap` keyed on `UniqueConstraintSchema` identity; new
  constraint objects after ALTER get fresh compiles automatically.
- Open-transaction overlays are already rebuilt against `updated` by
  `migrateOverlayForAlter` (their schemas rotate); this fix only closes the
  missing underlying-instance refresh that the autocommit pre-check depends on.

## Acceptance

- Remove `.skip` from the `ISOLATION_GAP_ARMS` loop in
  `packages/quereus-isolation/test/alter-table-conformance.spec.ts:314`
  (change `it.skip(` back to `it(`), and drop the now-stale "Kept SKIPPED … remove
  `.skip` once that lands" note in the comment block above `ISOLATION_GAP_ARMS`
  (lines ~216-235) so the harness documents these as covered, not parked.
- All three arms pass: ADD UNIQUE → duplicate rejected with `StatusCode.CONSTRAINT`;
  DROP UNIQUE → duplicate accepted; SET COLLATE → NOCASE-collision rejected with
  `CONSTRAINT`. No `INTERNAL` "invariant violation" for a genuine user duplicate.
- `yarn test` stays green across workspaces — in particular the
  `cross-layer UNIQUE / PK conflict detection` suite in
  `packages/quereus-store/test/isolated-store.spec.ts` (CREATE-declared UNIQUE
  baseline) and the existing isolation suite.

## TODO

- Apply the `tableSchema` refresh in `IsolationModule.alterTable`
  (isolation-module.ts, right after the `underlying.alterTable` call).
- Un-skip the `ISOLATION_GAP_ARMS` loop and prune the stale "known gap" comment in
  `alter-table-conformance.spec.ts`.
- Run the isolation suite: `yarn workspace @quereus/isolation test` (expect 126 passing).
- Run `yarn test` (all workspaces) to confirm the store baseline and engine tests
  remain green; stream with `2>&1 | tee /tmp/test.log; tail -n 80 /tmp/test.log`.
- Hand off to review with a note that the store/runtime ALTER-UNIQUE path is only
  exercised here via memory + the store CREATE-declared baseline; a store-backed
  *runtime* ALTER-UNIQUE arm under `yarn test:store` is a possible follow-up but is
  out of scope for the acceptance.
