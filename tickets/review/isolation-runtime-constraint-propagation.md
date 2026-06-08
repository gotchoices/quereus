description: Fix + regression coverage for `@quereus/isolation` enforcing UNIQUE against a PRE-alter schema after a runtime `alterTable`. `IsolationModule.alterTable` now refreshes the cached underlying VirtualTable instance's `tableSchema` snapshot from the schema `underlying.alterTable` returns, so every freshly-connected `IsolatedTable`'s merged-view UNIQUE pre-check sees the post-alter constraint set / collation. The three previously-skipped `ISOLATION_GAP_ARMS` (ADD UNIQUE / DROP UNIQUE / SET COLLATE) are un-skipped and pass.
prereq:
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/test/alter-table-conformance.spec.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-store/test/isolated-store.spec.ts
----

## What changed

**Production fix** — `packages/quereus-isolation/src/isolation-module.ts`, in
`IsolationModule.alterTable`, immediately after the `underlying.alterTable(...)`
call (now ~line 718):

```ts
const updated = await this.underlying.alterTable(db, schemaName, tableName, change);

// Refresh the cached underlying VirtualTable instance's tableSchema snapshot.
const underlyingState = this.getUnderlyingState(schemaName, tableName);
if (underlyingState) underlyingState.underlyingTable.tableSchema = updated;
```

That is the entire behavioral change — 9 lines (6 comment, 3 code). No other
source file is touched.

**Test changes** — `packages/quereus-isolation/test/alter-table-conformance.spec.ts`:
- Un-skipped the `ISOLATION_GAP_ARMS` loop (`it.skip(` → `it(`, line ~313).
- Rewrote the comment block above `ISOLATION_GAP_ARMS` (the constant name was kept)
  to document these arms as *covered regression* rather than a parked gap; dropped
  the stale "Kept SKIPPED … remove `.skip` once that lands" note.

## Root cause (recap, for the reviewer)

`IsolationModule` connects to the underlying module once and caches the resulting
`VirtualTable` in `underlyingTables`. Each `connect()` wraps that *same cached
instance* in a fresh `IsolatedTable`, whose constructor snapshots
`underlyingTable.tableSchema` (`isolated-table.ts:68`). For the memory underlying,
`MemoryTable.tableSchema` is itself a construction-time copy of
`manager.tableSchema`, not a live getter. `IsolationModule.alterTable` forwarded to
the **module-level** `underlying.alterTable` (rotates the *manager's* schema) and
returned the new `TableSchema`, but never wrote it back onto the cached instance's
field — so post-alter `IsolatedTable`s kept reading the stale pre-alter
`uniqueConstraints` / per-column `.collation` in `checkMergedUniqueConstraints` /
`findMergedUniqueConflict`. The catalog (`table_info` / `unique_constraint_info`)
was correct because it reads from the schema manager, which is why the divergence
was silent.

Contrast `dropIndex`, which calls the **instance-level**
`state.underlyingTable.dropIndex(...)`; the MemoryTable's own `dropIndex` already
does `this.tableSchema = this.manager.tableSchema`. ALTER had no such instance
refresh — this fix supplies it explicitly at the module layer.

## Validation done (this is the floor, not the ceiling)

- `yarn workspace @quereus/isolation typecheck` — clean (EXIT 0).
- `yarn workspace @quereus/isolation test` — **126 passing** (was 123 + 3 skipped).
- Targeted spec-reporter run of the three arms — all green:
  - ADD UNIQUE → duplicate rejected with `StatusCode.CONSTRAINT` (no more INTERNAL
    "invariant violation" at flush).
  - DROP UNIQUE → once-duplicate insert now accepted.
  - SET COLLATE (non-PK UNIQUE) → NOCASE collision rejected with `CONSTRAINT`.
- `yarn test` (all workspaces, memory-backed) — green, **5367 passing / 9 pending**
  in the main quereus suite plus all sibling suites green (EXIT 0). The
  "Error: boom" / "[Sync] Error handling …" lines in the log are deliberate
  error-path logging inside passing tests, not failures.
- Acceptance-called-out store baseline
  (`packages/quereus-store/test/isolated-store.spec.ts` →
  `cross-layer UNIQUE / PK conflict detection`) — **17 passing**. This is the
  CREATE-declared-UNIQUE path and is unaffected by the fix, confirming no regression.

## Reviewer focus / known gaps

- **Coverage gap (documented, out of scope here):** the runtime ALTER-UNIQUE path
  is exercised only against the **memory** underlying (via `ISOLATION_GAP_ARMS`)
  plus the store **CREATE-declared** baseline. There is no store-backed *runtime*
  ALTER-UNIQUE arm. `StoreTable` already refreshes its own instance `tableSchema`
  on alter (store-table.ts:170/190), so the write is idempotent for it and the fix
  is expected to be a no-op there — but that expectation is reasoned, **not tested**
  under `yarn test:store`. A store-backed runtime ALTER-UNIQUE arm is a sensible
  follow-up; flag if the reviewer wants it filed now.
- **Scope of the write:** `underlyingState.underlyingTable.tableSchema` is a plain
  writable field on `VirtualTable`; both `MemoryTable` and `StoreTable` assign it
  directly elsewhere, so the assignment is safe. Worth a sanity check that no other
  underlying module treats `tableSchema` as derived/read-only such that an external
  write would desync it — if one does, it would already be broken by the existing
  `dropIndex` instance-refresh path, but confirm.
- **Why no broader invalidation is needed (verify the reasoning holds):**
  `IsolatedTable` is reconstructed per statement (so it re-reads the refreshed
  snapshot every time); `predicateCache` is a `WeakMap` keyed on
  `UniqueConstraintSchema` identity (new constraint objects → fresh compiles);
  open-transaction overlays are already rebuilt against `updated` by
  `migrateOverlayForAlter`. The fix only closes the autocommit pre-check's
  dependency on the cached underlying snapshot.

## Pre-existing failures

None encountered. The 9 pending tests in the main quereus suite and 1 pending in
the sync suite are pre-existing skips unrelated to this change; no
`.pre-existing-error.md` was written.
