description: Review the hybrid cross-connection ALTER semantics in IsolationModule — issuer-own un-backfillable overlay still aborts atomically; a foreign un-backfillable overlay is poisoned (its owning connection errors on next merged read/write/commit) while the issuer's ALTER applies and migratable peers carry forward.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/src/index.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-isolation/README.md, docs/design-isolation-layer.md
----

## What shipped

Changed the blast radius of `IsolationModule.alterTable` from "any connection's un-backfillable
overlay aborts the issuer's ALTER" to **isolation-faithful hybrid (B)**:

- **Issuer's own overlay un-backfillable → reject the ALTER (atomic, unchanged).** Validated
  BEFORE the irreversible `underlying.alterTable`, so underlying + catalog + every overlay stay
  untouched.
- **A foreign connection's overlay un-backfillable → apply the ALTER, poison that overlay.** The
  shared underlying + catalog change regardless; the foreign overlay is left in its pre-alter
  layout and marked `poison`. Its owning connection raises `CONSTRAINT` on its next merged
  read / write / commit of that table; a `committed.<table>` (readCommitted) read still works.
  Rollback discards the overlay (and the poison).
- **Foreign migratable overlays** are carried forward exactly as before.
- **INTERNAL failures** (e.g. missing tombstone column) on a foreign overlay **rethrow** (loud
  layer-bug signal), not poison.

### Implementation map

- `ConnectionOverlayState` gained `poison?: { message: string }` (isolation-module.ts).
- `IsolationModule.alterTable` restructured into three tiers: partition issuer-own vs foreign
  (skip already-poisoned foreign); validate issuer-own first (abort path unchanged); mutate
  underlying; migrate issuer-own; then per-foreign `validateOverlayMigration` → poison on
  `StatusCode.CONSTRAINT` / rethrow on anything else / else migrate. `buildAlterPoisonMessage`
  names schema.table + column.
- `IsolatedTable.assertOverlayUsable()` added and called from `update` (before staging), the
  **merged** branch of `query` (NOT the fast path — readCommitted / no-overlay / no-changes stay
  safe), and `flushAndClearOverlay` (commit / `onConnectionCommit`). Throws
  `QuereusError(message, StatusCode.CONSTRAINT)`.
- `ConnectionOverlayState` is now exported from the package index (for the tests).
- README "Atomic ALTER" note + `docs/design-isolation-layer.md` (replaced the stale "DDL bypasses
  the overlay" line with an overlay-migration + poison subsection).

## Validation performed

- `yarn workspace @quereus/isolation run typecheck` — clean.
- `yarn workspace @quereus/isolation run build` — exit 0.
- `yarn workspace @quereus/isolation test` — **106 passing** (100 prior + 6 new), 0 failing.

### New tests (white-box; two/three `Database` instances over one shared `IsolationModule`)

The tests inject overlays directly (`setConnectionOverlay`, following `setupStagedOverlay`) and
drive ALTER through `iso.alterTable(dbA, 'main', 't', change)`. The `change` mirrors the real
engine's `ADD COLUMN c INTEGER NOT NULL DEFAULT (new.x)` — a non-foldable `new.x` DEFAULT expr
PLUS a matching `backfillEvaluator: row => row[1]` (see "Gotcha" below). Cases:

- Foreign overlay poisoned, issuer (clean) succeeds; A's read shows the backfilled new column.
- Poison observed at merged read / write / commit-flush for B; a readCommitted reader for B still
  returns underlying rows without throwing.
- Issuer's own un-backfillable overlay aborts atomically (live `getSchema()` column count
  unchanged; A's overlay intact, not poisoned).
- Issuer-own AND a foreign both un-backfillable → abort first, no foreign overlay poisoned.
- Mixed: B poisoned, C migrated (C's staged row survives with `c` backfilled from `x`).
- Second ALTER skips an already-poisoned overlay; both succeed; B's poison message unchanged.
- Full rollback clears poison; rollback to a post-overlay savepoint leaves poison set.

## Reviewer notes / known gaps (treat tests as a floor)

- **Tests are white-box, not end-to-end SQL.** They never run two real concurrent transactions
  (`BEGIN; INSERT …` on dbB, then a cross-connection SQL `ALTER` on dbA) through the engine. The
  module-level behavior and the poison guard are exercised directly; the IsolatedConnection →
  `onConnectionCommit/Rollback/RollbackToSavepoint` wiring is assumed correct (covered by the
  existing savepoint suite). A real two-connection SQL repro would be stronger but is harder to
  make deterministic and is not what the ticket prescribed. Worth a skeptical look at whether the
  engine's real ALTER path reaches `iso.alterTable` with the issuer's `db` such that the
  `ownKey` partition matches in production (the white-box test passes the issuer db explicitly).
- **Gotcha that bit the first test run:** the underlying `MemoryTableManager.addColumn` rejects a
  NOT NULL column on a *non-empty* table unless the columnDef carries a DEFAULT *expression*
  (`hasDefaultExpr`). A bare `{type:'notNull'}` columnDef (no default) fails there before the
  isolation layer's poison logic is reached. The committed baseline row makes the table non-empty,
  so the test change must include the `new.x` DEFAULT expr. Confirm this matches how the engine
  actually constructs `change.columnDef` for `ADD COLUMN … NOT NULL DEFAULT (new.x)`.
- **`query` throws synchronously** in the merged branch (at `.query()` call time, not first
  `.next()`), consistent with the existing fast-path return structure. If any caller expects a
  lazy/iteration-time throw, revisit.
- **Residual non-atomic path (accepted):** an INTERNAL rethrow on a foreign overlay happens
  *after* the underlying is mutated — a layer-bug path, matching the companion ticket's accepted
  "residual unreachable INTERNAL throw" stance.
- **DROP / RENAME of a table while an overlay is poisoned** is out of scope; existing
  `destroy` / `renameTable` overlay handling is unchanged (renameTable re-keys the poisoned state,
  carrying the poison along; destroy does not touch connectionOverlays — both pre-existing). No
  test trips it.
- **Editor-only lint:** the LSP flags two pre-existing unused symbols in *unchanged* code
  (`translateOverlayRow`'s `_exhaustive`, `checkMergedPKConflict`'s `tombstoneIndex` param). The
  build tsconfig does not enable `noUnusedLocals`/`noUnusedParameters`, so `tsc` build + typecheck
  are clean — these are not introduced by this change and not build failures.
- **`yarn test:store` deferred** (slow / not agent-runnable). The change is underlying-agnostic
  (poison lives in the per-connection overlay layer, not the base), so the memory-backed run is
  representative; a human/CI should still run the store suite before release.
