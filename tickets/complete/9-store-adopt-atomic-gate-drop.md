description: After a crash, a materialized view backed by the persistent store no longer rebuilds itself from scratch when its on-disk copy was actually fine — the store durably remembers which views genuinely fell out of date, so the rest are trusted as-is on a crash-restart instead of being needlessly rebuilt.
files:
  - packages/quereus-store/src/common/key-builder.ts          # STALE_MVS_META_NAME constant + doc
  - packages/quereus-store/src/common/index.ts                # re-export STALE_MVS_META_NAME
  - packages/quereus-store/src/common/store-module.ts         # computeStaleMvSet; durable stale-set read/write; atomicProvider gate; closeAll/listener/rehydrate tail
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts    # atomic-capable test provider + new tests (671 total)
  - docs/materialized-views.md                                # § Cross-module atomicity gate 5 + caveats
----

# Completed — drop the MV adopt clean-shutdown gate (gate 5) when the provider is atomic

## Summary

The MV adopt-without-refill fast path previously trusted a pre-existing durable backing
only under five gates; **gate 5** (clean shutdown AND not stale-at-close) guarded a
crash-divergence window that the module-wide `beginAtomicBatch` coordinator (prereq
`store-module-wide-coordinator`) has since closed. This change lets the adopt path exploit
that for **atomic providers** (LevelDB shared-root, IndexedDB single-db): gate 5 is dropped
for same-module backings (gate 4 alone governs), so a non-stale backing adopts **after a
crash** — with logical staleness excluded instead by a new **crash-durable stale-MV set**
(`\x00meta\x00stale_mvs`). Non-atomic providers are unchanged: the clean-shutdown marker
remains the trust basis.

The mechanism, soundness argument, and durability-ordering discipline are documented in
`docs/materialized-views.md` § Cross-module atomicity and were verified during review (see
below). The implementer's handoff is accurate.

## Review findings

### What was checked
- **Implement diff** (`274faef2`) read first with fresh eyes — key-builder constant,
  index re-export, store-module mechanism, doc rewrite, 11 new tests.
- **Soundness of dropping gate 5** — the load-bearing argument, traced end-to-end:
  - *Listener ordering invariant.* The engine MV manager subscribes in its constructor
    (`MaterializedViewManager`, wired at `Database` construction) **before** the store's
    lazy subscription; `SchemaChangeNotifier` dispatches over a `Set` (insertion order), so
    the store's recompute always observes the already-flipped `derivation.stale`. **Holds.**
  - *Name-format consistency.* MV catalog keys are built lowercased
    (`buildMaterializedViewCatalogKey`), so `parseMaterializedViewCatalogKey` and
    `computeStaleMvSet` agree on lowercased qualified `schema.mv` — no case-mismatch
    adopt-of-stale. **Holds.**
  - *Every staleness SET has an observed event.* The listener path
    (`table_modified`/`table_removed` on a source) and `markMaterializedViewStale` (which
    always `emitBackingInvalidation` → synthetic `table_modified`) both fire an event the
    store observes; the only event-less transition (rename-restore CLEAR) is handled
    conservatively (over-naming → sound refill, corrected at next clean close). **Holds.**
  - *WAL durability ordering.* The source DDL is enqueued (non-`sync`) before the stale-set
    `sync:true` write on the same `persistQueue`; a WAL-ordered backend flushes both or
    neither → sound either way. Same discipline + backend caveat as the marker-consume
    delete. **Holds** (documented caveat for sync-less backends).
- **Conservative parse** — absent → marker fallback; unparseable/wrong-shape → refill-all. **Correct.**
- **`classifyCatalogKey`** — the new `\x00meta\x00stale_mvs` key classifies as `'meta'` by
  the existing prefix match (no classifier change) and is skipped by the DDL phases. **Correct.**
- **Atomic path unchanged** — the gate (`atomicProvider`) is `true` for atomic providers, so
  all write/read sites behave exactly as the implement diff intended for them.
- **Lint / tests** — see below.

### Finding (minor — fixed inline)
**The durable stale-set was written unconditionally (even by non-atomic providers) but only
read/trusted by atomic ones.** The implementer flagged the wasted per-staleness-change fsync
on non-atomic stores and asked for confirmation. Scrutiny surfaced a *latent soundness
vector* beyond the I/O cost: a **persistent** non-atomic provider — whose commits can tear a
source from its backing on a crash — could leave a torn-but-`"not-stale"` set on disk that a
later **atomic** reopen would trust → an unsound adopt. Unreachable for shipped providers
(persistent ⟹ atomic; the only non-atomic provider, memory, isn't persistent), but it made
the read's trust depend on an undocumented "capability is stable per physical store"
assumption, and a custom persistent-non-atomic provider would be a footgun.

**Fix:** gated the durable-set **write** on the same `beginAtomicBatch` capability as the
read (new cached `StoreModule.atomicProvider`), at all three sites — the incremental
listener/rehydrate-tail write (`persistStaleMvSetIfChanged`), and the `closeAll` write. The
rehydrate **read** is now skipped for non-atomic providers too (no pointless catalog get).
Result: only an atomic-capable session ever authors the set, so the read's trust no longer
rests on any external invariant — the cross-capability hole is structurally impossible — and
the wasted fsync on non-atomic stores is gone. The clean-shutdown marker (the non-atomic
trust basis) is untouched.

**Test changes:** renamed the `downgrade/parity` test to assert a non-atomic provider writes
the set *nowhere* (`durableStaleValue → undefined`) while the marker still governs (behavior
unchanged); added a **true-downgrade** test (atomic clean-close writes the set, then a
non-atomic provider reopens the **same byte-map** and must ignore the on-disk set, falling
back to the marker) — proving the read is gated, not just the write. Doc § updated with the
write-gating rationale.

### Findings filed as new tickets
None. The one finding was minor and fixed inline.

### Gaps accepted (documented, not blocking)
- **No real power-loss crash-injection test.** The atomic branch is covered by an in-memory
  atomic-capable test provider (method-presence) plus the real IDB/LevelDB suites passing;
  the durability-ordering soundness rests on the WAL + `sync:true` argument, not an
  fsync-crash test (impractical in a unit test). Acceptable — matches the existing marker's
  own test posture.
- **`yarn test:store` / `test:full` not run** — LevelDB-backed *engine-logic* path; slow and
  not agent-runnable within the idle budget, and the ticket explicitly defers it. The change
  is isolated to `@quereus/store`; the real atomic providers pass end-to-end. Worth a CI pass.
- **rename-restore test** asserts soundness via durable-set over-naming + content correctness
  + clean-close correction, without planting a sentinel to prove the refill *ran* (the
  `select *` reshape makes sentinel-shape fiddly). Acceptable; a sentinel variant is optional.
- **Atomic-batch fold** (folding the stale-set write into one `batch()` with the source DDL —
  the fully-portable hardening that removes the WAL-ordering dependency) is intentionally out
  of scope; documented as future work in the doc caveat.

### Validation
- `yarn workspace @quereus/store test` — **671 passing** (+1 net vs implement: renamed 1,
  added the true-downgrade test).
- `tsc -p tsconfig.json` and `tsc -p tsconfig.test.json` (store src + test) — **clean**.
- `yarn workspace @quereus/plugin-leveldb test` — **30 passing**;
  `yarn workspace @quereus/plugin-indexeddb test` — **73 passing** (real atomic providers,
  no regression; the gate is `true` for them so their path is byte-identical).
