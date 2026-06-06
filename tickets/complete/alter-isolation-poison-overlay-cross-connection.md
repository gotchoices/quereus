description: Hybrid cross-connection ALTER semantics in IsolationModule — issuer-own un-backfillable overlay aborts atomically; a foreign un-backfillable overlay is poisoned (its owning connection errors on next merged read/write/commit) while the issuer's ALTER applies and migratable peers carry forward. Reviewed + two poison-clearing holes fixed inline.
files: packages/quereus-isolation/src/isolation-module.ts, packages/quereus-isolation/src/isolated-table.ts, packages/quereus-isolation/src/index.ts, packages/quereus-isolation/test/isolation-layer.spec.ts, packages/quereus-isolation/README.md, docs/design-isolation-layer.md
----

## What shipped

`IsolationModule.alterTable` now has an **isolation-faithful hybrid (B)** blast radius:

- **Issuer's own overlay un-backfillable → reject the ALTER atomically.** Validated before the
  irreversible `underlying.alterTable`, so underlying + catalog + every overlay stay untouched.
- **A foreign connection's overlay un-backfillable → apply the ALTER, poison that overlay.** The
  shared underlying + catalog change regardless; the foreign overlay is left in its pre-alter
  layout and marked `poison`. Its owning connection raises `CONSTRAINT` on its next merged
  read / write / commit-flush; a `committed.<table>` (readCommitted) read still works. Rollback
  discards the overlay (and the poison).
- **Foreign migratable overlays** carry forward unchanged. **INTERNAL failures** (e.g. missing
  tombstone column) on a foreign overlay **rethrow** loud rather than poison.

Implementation: `ConnectionOverlayState.poison?: { message }`; `alterTable` partitions issuer-own
vs foreign and runs three tiers (validate-own-first / mutate / per-foreign migrate-or-poison);
`IsolatedTable.assertOverlayUsable()` guards `update`, the merged branch of `query`, and
`flushAndClearOverlay`. README + `docs/design-isolation-layer.md` updated.

## Review findings

Reviewed the full implement diff (`fb6ccfbf`) with fresh eyes against every aspect angle, read all
six touched files plus the engine's real ALTER emit path, and ran build + typecheck + the package
test suite.

### Verified correct (no change)
- **Production wiring (the implementer's top flagged unknown).** `packages/quereus/src/runtime/emit/
  alter-table.ts` passes `rctx.db` — the *issuing* connection — to `module.alterTable` for every
  ALTER variant (addColumn/dropColumn/rename/alterColumn). So the `ownKey` partition matches the
  issuer in production exactly as the white-box tests assume. The main "is this reachable in the real
  engine" concern is closed.
- **Poison reaches every data-op chokepoint, none missed.** All reads route through `query()` (guarded
  on the merged branch; fast path provably never serves a poisoned overlay since poison ⇒
  `hasChanges === true`); all writes hit `update()` (guarded first); commit/onConnectionCommit hit
  `flushAndClearOverlay` (guarded). Synchronous throw from `query()` matches the pre-existing
  "underlying does not support query" throw — consistent, not a regression.
- **Atomic-abort path unchanged** for the issuer; tier-2 validation precedes the irreversible
  underlying mutation. Pre-existing residual non-atomic INTERNAL-rethrow accepted (matches companion
  ticket).
- **`renameTable`** carries the poison field along (re-keys the same state object in place) — verified,
  as the handoff claimed.
- **Poison only ever arises on the addColumn NOT NULL backfill path** (the sole `CONSTRAINT` source in
  `validateOverlayMigration`); `buildAlterPoisonMessage`'s `<column>` fallback is dead-but-defensive.

### Bugs found and fixed inline (minor — small, localized, well-tested)
Two **poison-clearing holes**: paths that rebuild an overlay create a fresh `ConnectionOverlayState`
with no `poison`, so they silently un-poison a connection that must still roll back AND copy
layout-mismatched pre-alter rows — exactly the base/overlay divergence this subsystem exists to
prevent. Both reachable once a connection has been poisoned by a peer's ALTER:

1. **A poisoned connection's *own* later ALTER.** The original partition checked `key === ownKey`
   *before* the `state.poison` skip, so a poisoned own overlay became `ownEntry` and was migrated.
   Fix: check `state.poison` **first**, skipping own-or-foreign poisoned overlays uniformly
   (`isolation-module.ts` alterTable partition).
2. **`DROP INDEX` on the table.** `dropIndex`'s post-drop rebuild loop migrated *every* overlay,
   including poisoned ones. Fix: `continue` past poisoned overlays in that loop.

Both fixes leave the poisoned overlay untouched (poison preserved); the owning connection still
recovers only by rolling back. Added two regression tests (`isolation-layer.spec.ts`) — both **fail
without the fix** with the exact "poison silently cleared" assertion (`expected undefined not to be
undefined`) and pass with it. Updated the design-doc "Poison lifecycle" note to document that both
rebuild paths now skip poisoned overlays (and that `renameTable` is safe as-is).

### Noted, out of scope (not fixed)
- **No end-to-end two-connection SQL repro.** Tests remain white-box (direct `iso.alterTable` over a
  shared module). Given the production wiring is now verified, the residual risk is low; a real
  `BEGIN; INSERT` on dbB + cross-connection SQL `ALTER` on dbA test would be stronger but is hard to
  make deterministic and was not prescribed. Left as a nice-to-have, not a blocker.
- **CHECK constraints on an ADD COLUMN are not evaluated against staged overlay rows** during
  migration/validation (only NOT NULL is). Pre-existing — `validateOverlayMigration` /
  `computeAddColumnValue` never checked CHECK, and this ticket did not change that. A foreign staged
  row violating a new column's CHECK would migrate without poison. Out of scope here; flag for a
  future ticket if CHECK-on-ADD-COLUMN under isolation becomes a requirement.
- **`IsolatedTable.alterSchema`** (the instance hook, distinct from the engine's `module.alterTable`
  ALTER path) clears the overlay unconditionally, discarding staged rows + any poison. Not reached by
  the cross-connection ALTER path; pre-existing discard-on-alterSchema behavior, unchanged.
- **Editor-only lint:** the LSP flags the pre-existing unused `_exhaustive` exhaustiveness sentinel in
  `translateOverlayRow` (unchanged code). The build tsconfig enables neither `noUnusedLocals` nor
  `noUnusedParameters`, so `tsc` build + typecheck are clean. Not introduced here.

### Validation (re-run after the fixes)
- `yarn workspace @quereus/isolation run typecheck` — clean (exit 0).
- `yarn workspace @quereus/isolation run build` — exit 0.
- `yarn workspace @quereus/isolation test` — **108 passing** (106 from implement + 2 new regressions),
  0 failing. No `packages/quereus-isolation` lint script exists (only `packages/quereus` has one).
- `yarn test:store` not run (slow / not agent-runnable; poison lives in the per-connection overlay
  layer, underlying-agnostic, so the memory-backed run is representative). A human/CI should still run
  the store suite before release.
