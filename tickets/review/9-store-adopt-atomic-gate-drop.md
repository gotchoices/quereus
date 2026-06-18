description: After a crash, a materialized view backed by the persistent store no longer rebuilds itself from scratch when its on-disk copy was actually fine — the store now durably remembers exactly which views had genuinely fallen out of date, so the rest are trusted as-is on a crash-restart instead of being needlessly rebuilt.
files:
  - packages/quereus-store/src/common/key-builder.ts          # STALE_MVS_META_NAME constant + doc; buildMetaCatalogKey comment
  - packages/quereus-store/src/common/index.ts                # re-export STALE_MVS_META_NAME
  - packages/quereus-store/src/common/store-module.ts         # computeStaleMvSet; persist/read/write stale-set; rehydrate trust basis; closeAll; onEngineSchemaChange split
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts    # atomic-capable test provider + 11 new tests
  - docs/materialized-views.md                                # § Cross-module atomicity gate 5 + caveats (rewritten)
difficulty: hard
----

# Review handoff — drop the MV adopt clean-shutdown gate (gate 5) when the provider is atomic

## What landed

The MV adopt-without-refill fast path (`docs/materialized-views.md` § Cross-module
atomicity) trusted a pre-existing durable backing iff five gates held. **Gate 5**
(clean shutdown AND not stale-at-close) historically guarded a crash-divergence
window. The prereq `store-module-wide-coordinator` closed that window for providers
exposing `beginAtomicBatch` (LevelDB shared-root, IndexedDB single-db). This change
lets the adopt path exploit that:

- **Atomic provider** (`typeof provider.beginAtomicBatch === 'function'`): gate 5 is
  **dropped** for same-module backings — gate 4 alone governs — so a **non-stale
  backing adopts after a crash** (not only after a clean reopen). Logical staleness is
  excluded instead by a new **crash-durable stale-MV set** (`!durableStale.has(name)`).
- **Non-atomic provider**: unchanged, **byte-for-byte** — the clean-shutdown marker
  remains the trust basis.

### Mechanism

A new reserved meta entry `\x00meta\x00stale_mvs` (`STALE_MVS_META_NAME`), classified
`'meta'` by the existing `classifyCatalogKey` (no classifier change). Its value is a
JSON array of lowercased qualified `schema.mv` names currently stale. Unlike the
single-use clean-shutdown marker it is **persistent current-truth**:

- **Written** (`sync: true` point-write, riding `persistQueue`) on every staleness
  change, recomputed in `onEngineSchemaChange` after dispatch — and at clean close
  (`closeAll`, plain put alongside the marker). Compare-write guarded by an in-memory
  `lastPersistedStaleMvs` so an unrelated `table_modified` costs no fsync.
- **Read** (never deleted) at `rehydrateCatalog`; conservative parse mirrors the
  marker (absent → fall back to marker path; unparseable → refill all).
- The single recompute source is `computeStaleMvSet()` (extracted from the old inline
  `closeAll` computation; reused by the listener, `closeAll`, and the rehydrate tail).

The store needs **no engine changes**: `derivation.stale` is in-memory runtime state
the engine's own listener sets; the engine subscribes first (Database constructor),
the store lazily later, and listeners dispatch in insertion order, so the store's
recompute always observes post-transition flags.

### Soundness (the load-bearing argument — verify this in review)

The unsound case to prevent: a source's content-significant DDL durable on disk while
the stale-set entry recording the resulting staleness is **not** → reopen adopts a
behind MV. The source DDL is persisted eagerly (non-`sync`) before the
`table_modified` event; the stale-set write is enqueued in the event handler **after**
(same `persistQueue`), with `sync: true`. On a WAL-ordered backend the `sync` flushes
the earlier source-DDL put too, so a crash before the sync loses **both** (→ old
source + old stale-set → sound adopt) and a crash after has **both** (→ refill). Same
discipline + same backend caveat as the existing marker-consume `sync` delete.
**Deliberately NOT folded into an atomic batch** — that fully-portable hardening is
documented as out-of-scope future work.

## How to validate / use cases

`yarn workspace @quereus/store test` (670 passing; +11 new in
`mv-rehydrate-adopt.spec.ts`). The 11 new tests (1 in the top describe, 10 in
`describe('atomic-commit domain (gate 5 dropped …)')`):

- **non-atomic downgrade/parity** — durable stale-set present but IGNORED without
  `beginAtomicBatch`; the marker governs (no marker after a crash → refill).
- **atomic crash, non-stale backing adopts with NO marker** — the headline new
  behavior; gate 4 alone governs; sentinel survives + live maintenance armed.
- **atomic crash, stale-at-close MV refills** — driven by the durable stale-set, not
  the lost marker; the logical-staleness window stays sound under the dropped gate.
- **residual content-stale hole** — a value-semantics ALTER (`set collate`) on a
  column read only in `where` (gate 2 `backingShapeMatches` passes) still stales the
  MV → must refill after a crash. Pins `derivation.stale === true` on the trigger.
- **upgrade** — capability present but no stale-set entry yet → marker fallback adopts.
- **stale-then-refreshed adopts** — `refresh` cleared the MV from the durable set.
- **MV-over-MV cascade** — a stale upstream + cascade-staled dependent both refill.
- **listener ordering invariant** — a source ALTER's stale flag is visible in the
  persisted durable stale-set (end-to-end proof the engine listener runs first).
- **memory-backed MV in the durable set** — harmless (always refills).
- **rename-restore conservatism** — a no-event clear leaves the durable set
  over-naming a now-live MV → a crash yields a sound (wasteful) refill; the next clean
  close corrects the drift.
- **atomic catalog fixed point** — two clean adopt+close cycles converge to identical
  catalog bytes (incl. the new meta entries).

Real atomic providers exercised end-to-end (no regressions):
`yarn workspace @quereus/plugin-indexeddb test` (73) and
`@quereus/plugin-leveldb test` (30). Store `typecheck` clean; engine `lint` clean.

## Known gaps / where a reviewer should push (tests are a floor)

- **No real power-loss crash-injection test.** The atomic branch is covered by an
  in-memory atomic-capable test provider (method-presence) plus the real IDB/LevelDB
  suites passing. The durability-ordering soundness rests on the WAL + `sync:true`
  argument above, **not** on an fsync-crash test (hard in a unit test). Consider
  whether a LevelDB-real adopt-across-crash test is worth adding (would require
  killing/replaying the WAL out of band). The in-memory provider's `beginAtomicBatch`
  is faithful-but-not-truly-crash-atomic by construction.
- **`yarn test:store` / `test:full` (LevelDB-backed engine logic) NOT run** — slow;
  ticket says defer unless diagnosing a store-specific failure. Deferred. Worth a CI
  pass to confirm the LevelDB engine-logic path under the new meta entry.
- **rename-restore test** asserts soundness via durable-set over-naming + content
  correctness + clean-close correction, but does **not** plant a sentinel to prove the
  refill *ran* (the `select *` reshape makes sentinel-shape fiddly). Reviewer may want
  a sentinel-based variant.
- **Atomic-batch fold** (the fully-portable hardening that removes the WAL-ordering
  dependency) is intentionally out of scope; documented as future work in the doc
  caveat. Confirm that deferral is acceptable.
- **Non-atomic providers now also write the stale-set entry at close** (and
  incrementally). It's ignored on read there, but it does add one catalog entry +
  per-staleness-change fsync on non-atomic stores. Confirm that's acceptable (the
  existing non-atomic fixed-point test stays green because both adopt and refill
  sessions close with `[]`).

## Acceptance status

- [x] atomic provider ⇒ non-stale same-module backing adopts across a simulated crash
      (no marker); gate 4 alone governs.
- [x] atomic provider ⇒ stale-at-close MV refills across a crash via the durable set.
- [x] no capability ⇒ marker gate governs exactly as today (parity).
- [x] residual shape-stable-but-content-stale case refills after a crash (regression).
- [x] `docs/materialized-views.md` gate 5 → runtime `beginAtomicBatch`-presence check;
      durable stale-set documented; `sync`-point-write caveat documented (atomic-batch
      fold noted as future); both "tracked under plan ticket" references resolved.
- [x] `yarn workspace @quereus/quereus-store test` green; engine `lint` green.
- [ ] `yarn test:store` / `test:full` — deferred (slow), see gaps.
