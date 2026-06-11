description: MV backing tables do not actually reject user DML anywhere — the backing-host contract's "read-only to user DML (READONLY)" line is unenforced in memory, store, and the isolation wrapper. Decide the enforcement seam and realize it uniformly.
files:
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # buildBackingTableSchema (never sets isReadOnly)
  - packages/quereus/src/vtab/memory/layer/manager.ts               # isReadOnly guards incl. replaceBaseLayer (would throw!)
  - packages/quereus-isolation/src/isolated-table.ts                # update() writes overlay without any readonly check
  - packages/quereus-store/src/common/store-table.ts                # update() has no readonly concept
  - packages/quereus/src/vtab/backing-host.ts                       # the contract line ("must reject user DML")
----

# Backing tables should reject user DML

Found during the `store-mv-backing-host` plan research:

- `buildBackingTableSchema` never sets `TableSchema.isReadOnly`, so the
  memory module's `MemoryTableManager.isReadOnly` is `false` for every MV
  backing — `validateMutationPermissions` never fires for them. A user
  `insert into _mv_<name> …` is accepted in memory mode today. No test
  asserts the reject.
- Simply stamping `isReadOnly: true` in `buildBackingTableSchema` would BREAK
  the memory module: `replaceBaseLayer` (the host's `replaceContents`) and
  every ALTER guard check `isReadOnly` and throw READONLY — the privileged
  surface must be exempted first (the memory readonly flag currently means
  "fully immutable", not "read-only to user DML").
- Under the isolation wrapper, `IsolatedTable.update` writes the overlay with
  no readonly consultation, and the commit flush uses `trustedWrite` — so a
  wrapped backing (the `using store` deployment) also accepts user DML
  silently.
- `StoreTable.update` has no readonly concept at all.

## Expected behavior

User DML (insert/update/delete) and user DDL (ALTER/CREATE INDEX/…) against a
`_mv_<name>` backing table fail with READONLY and a message that names the
owning materialized view, in every module configuration (memory, bare store,
isolation-wrapped store), while `applyMaintenance` / `replaceContents` and the
isolation flush's `trustedWrite` path keep working. Consider whether the right
seam is the planner/builder (reject mutation plans targeting a backing table —
one engine-level check instead of three module-level ones) versus per-module
guards; the engine-level seam also covers future hosts for free.

Key tests: direct DML against `_mv_` in all three configurations; REFRESH /
maintenance / rehydrate-refill still pass; sited error message.

## Interplay: maintained-table lifecycle (`maintained-table-attachment`)

The maintained-table design (plan ticket `maintained-table-attachment`;
docs/materialized-views.md § Current limitations "First-class derivation
lifecycle") makes the derivation an *attachment* and the backing potentially
a first-class named table that outlives it. Whatever enforcement seam is
chosen here must key off **the presence of a derivation attachment / MV
record**, not the `_mv_` name pattern — so that detaching the derivation
(promotion to a plain base table) sheds READONLY structurally, and a
first-class-named maintained table is enforced identically to a hidden
`_mv_` one. This favors the engine-level (planner/builder) seam suggested
above over per-module name checks.
