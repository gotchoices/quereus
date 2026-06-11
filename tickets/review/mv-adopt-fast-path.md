description: Review the durable-backing adopt fast path — at rehydrate, a store-hosted `_mv_` backing is trusted (no body refill) when all five gates pass, anchored by a single-use clean-shutdown catalog marker; any failed gate keeps the drop+refill.
files:
  - packages/quereus/src/schema/manager.ts                          # ImportCatalogOptions; importCatalog/importDDL threading; adopt arm + tryAdoptPreExistingBacking
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # adoptMaterializedView (registration tail, backing re-stamp, rollback rules)
  - packages/quereus/src/index.ts                                   # ImportCatalogOptions export
  - packages/quereus-store/src/common/key-builder.ts                # \x00meta\x00 prefix; buildMetaCatalogKey; CLEAN_SHUTDOWN_META_NAME; 'meta' classify kind
  - packages/quereus-store/src/common/store-module.ts               # closeAll marker write; consumeCleanShutdownMarker; phase-3 trust threading; loadAllDDL meta filter
  - packages/quereus-store/src/common/index.ts                      # new key-builder exports
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts          # NEW: 13-test reopen matrix (sentinel-divergence oracle)
  - docs/materialized-views.md                                      # § Cross-module atomicity: realized adopt semantics (replaces "future fast path")
  - docs/schema.md                                                  # importCatalog options bullet; rehydrate-phasing marker/adopt notes
  - docs/module-authoring.md                                        # durable-host adopt guidance (ordinary table entry + attested trustBackings)
----

# Adopt-without-refill at rehydrate — implementation summary

Implements the third step after `store-backing-host`: `SchemaManager.importMaterializedView`'s
same-module pre-existing-backing arm is upgraded from unconditional drop+refill to
gate-checked adopt. Create and refresh never adopt; only catalog import does.

## What landed

**Engine** (`packages/quereus`):

- `ImportCatalogOptions { trustBackings?, adoptedBackings? }` threaded
  `importCatalog` → `importDDL` → `importMaterializedView`. Both default off;
  existing callers unchanged.
- `tryAdoptPreExistingBacking` (manager.ts): gates 2 (shape via
  `backingShapeMatches`/`deriveBackingShape`), arity pre-check, 4 (every source
  same-module; every `_mv_`-prefixed source in `adoptedBackings`). Gate 1
  (same module) and 5 (`trustBackings`) checked by the caller; gate 3
  (bodyHash) is automatic by construction (catalog persists DDL, import
  re-parses and recomputes the same canonical-definition hash — asserted in
  comments, no runtime check possible).
- `adoptMaterializedView` (materialized-view-helpers.ts): re-stamps the
  registered backing schema with the body-derived `buildBackingTableSchema`
  result (phase-1 DDL round-trip loses ScalarType fidelity; shapes verified
  identical; `estimatedRows` carried over), builds the MV record with the exact
  `materializeView` formula, `linkCoveredUniqueConstraints` →
  `addMaterializedView` → `registerMaterializedView`; on registration failure
  unlink + remove + rethrow but **leave the backing registered** as a plain
  table (durable rows preserved for a retry).
- **Behavioral nuance a reviewer should scrutinize**: under `trustBackings`, a
  body that cannot PLAN now propagates out of the adopt arm *without dropping
  the backing* (per-entry error, backing preserved). This is load-bearing for
  the MV-over-MV fixpoint: a dependent that sorts before its upstream fails to
  plan in round 1, and dropping there would destroy the rows round 2 adopts.
  (Caught live: the multi-round test failed against a stale build that still
  had catch→false→drop.) The UNtrusted path keeps the old behavior
  (drop, then `materializeView` raises the real diagnostic).

**Store** (`packages/quereus-store`):

- Reserved `\x00meta\x00` catalog prefix; `buildMetaCatalogKey`,
  `CLEAN_SHUTDOWN_META_NAME`, `classifyCatalogKey` → `'meta'` kind.
- `closeAll` writes the marker after unsubscribe + `persistQueue` drain + table
  disconnects, immediately before `provider.closeAll`.
- `rehydrateCatalog` consumes the marker FIRST (read + immediate delete —
  single-use), threads `{ trustBackings, adoptedBackings }` into every phase-3
  `importCatalog` call with one shared set across fixpoint rounds; meta entries
  are skipped in classification (defensive — the marker is already gone by the
  scan) and filtered from `loadAllDDL`.

## How to validate

From repo root: `yarn build`, `yarn lint`, `yarn test`, `yarn test:store` — all
run and green at handoff (engine 5775 passing/9 pending; store package 511
passing incl. the 13 new; store-mode logic run 5771 passing/13 pending).

The new spec (`mv-rehydrate-adopt.spec.ts`) uses a persistence-faking provider
(byte maps survive `StoreModule.closeAll`; skipping `closeAll` = simulated
crash) and a **sentinel-divergence oracle**: a row planted directly into the
backing's KV store between sessions. Sentinel served through the MV ⇒ adopt
(body provably not re-run); sentinel scrubbed ⇒ refill. Matrix:

- adopt happy path (marker consumed; maintenance live post-adopt; plain view
  alongside so all three phases run with the meta key present)
- marker single-use (2nd rehydrate w/o close ⇒ refill; clean close re-arms)
- no marker / simulated crash ⇒ refill
- source shape change (`select *` widens after `alter table add column`) ⇒
  gate-2 refill matching the new shape
- memory source recreated pre-rehydrate ⇒ gate-4 refill from fresh source
- MV-over-MV: both adopt across two fixpoint rounds (dependent sorts first —
  the discriminator: dependent keeps ITS sentinel and does NOT inherit the
  upstream's); refilled upstream forces dependent refill (ledger gate); memory
  upstream forces store dependent refill (module gate)
- adopt → registration failure (hand-edited body, `where random() is not
  null`: shape-identical so gates pass, non-determinism rejects at
  registration) ⇒ per-entry error, backing remains a plain table, sentinel
  bytes preserved
- catalog fixed point: bytes after an adopt session == after a refill session
- engine arm without `rehydrateCatalog`: no options ⇒ refill even when all
  other gates pass (gate-5 default); with `trustBackings` ⇒ adopt; trust does
  NOT bypass the other-module CONSTRAINT arm (squatting memory `_mv_mv`
  untouched)

## Known gaps / honest notes

- **Live-instance re-stamp is host-reconciled.** Adopt re-registers the stamped
  schema in the schema manager only; the connected `StoreTable`'s cached schema
  updates via `rehydrateCatalog`'s existing end-of-run reconciliation loop. A
  host calling `importCatalog({trustBackings})` directly must reconcile its own
  connected instances (documented in module-authoring.md). Shapes are
  gate-verified identical, so reads behave the same either way — the re-stamp
  is fidelity-only.
- **Sentinel probe is provider-level, in-memory.** The crash-window simulation
  plants bytes in an `InMemoryKVStore`-backed provider; no LevelDB-on-disk
  crash test exists (out of agent scope — would need process-kill tooling).
- **Gate 4's `_mv_` detection is name-convention.** A user table legitimately
  named `_mv_x` used as a source requires ledger membership it can never have ⇒
  permanent refill for that MV (conservative, correct, slightly pessimal).
- **Trusted vs untrusted error-path asymmetry** (intentional, see above): a
  genuinely unbuildable MV under trust leaves its backing registered as a plain
  table; untrusted drops it first. Both record the same per-entry error.
- **`estimatedRows` carry-over** on the re-stamp diverges microscopically from
  refill (which finalizes at 0 until stats refresh); chosen because the adopted
  rows make the prior estimate truthful (ticket: "don't reset stats on adopt").
- The marker is written by every `closeAll`, including for never-rehydrated or
  empty catalogs (harmless; consumed-or-ignored on next open).
