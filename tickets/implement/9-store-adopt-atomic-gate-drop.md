description: After a crash, a materialized view backed by the persistent store currently rebuilds itself from scratch even when its saved-to-disk copy was perfectly fine. This makes the store remember, durably, which views had genuinely fallen out-of-date — so the rest can be trusted as-is after a crash instead of being needlessly rebuilt.
prereq: store-module-wide-coordinator
files:
  - packages/quereus-store/src/common/store-module.ts          # rehydrateCatalog trust basis; onEngineSchemaChange recompute+persist; closeAll; new computeStaleMvSet helper
  - packages/quereus-store/src/common/key-builder.ts            # add STALE_MVS_META_NAME (mirror CLEAN_SHUTDOWN_META_NAME); export
  - packages/quereus-store/src/common/index.ts                  # re-export STALE_MVS_META_NAME
  - packages/quereus-store/test/mv-rehydrate-adopt.spec.ts      # extend adopt matrix (atomic-domain crash cases)
  - docs/materialized-views.md                                  # § Cross-module atomicity gates 4–5 + caveats (lines ~108–122)
difficulty: hard
----

# Drop the MV adopt clean-shutdown gate (gate 5) for same-module backings when the provider is atomic

## Summary of the resolved design

The MV adopt-without-refill fast path (`docs/materialized-views.md` § Cross-module
atomicity) trusts a pre-existing durable backing iff five gates hold. **Gate 5**
(host attested a clean shutdown AND the MV was not stale-at-close) historically
guarded a crash-divergence window that the prereq `store-module-wide-coordinator`
has now closed for providers exposing `beginAtomicBatch` (LevelDB shared-root,
IndexedDB single-db). This ticket lets the adopt path exploit that: **when the
provider exposes the atomic capability, gate 4 alone governs same-module backings,
so a non-stale backing adopts after a crash too** — not only after a clean reopen.

Gate 5 actually conflated two windows. The atomic domain closes the
**crash-divergence** window (source+backing torn at a crash). It does **not** close
the **logical-staleness** window (an MV whose row-time maintenance was detached
mid-session by a body-relevant source schema change — `mv.derivation.stale = true`
— so later source writes never reached the backing). Adopting a stale backing is
unsound (queries read permanently-behind content). Today the *only* durable record
of staleness is the clean-shutdown marker's `staleAtClose` payload, which a crash
loses. So dropping gate 5 requires a **crash-durable** staleness signal.

**Resolution: a durable, incrementally-maintained stale-set meta entry**, written by
the store with `sync: true` whenever the stale set changes, surviving a crash. In
the atomic domain, `rehydrateCatalog` trusts `!durableStale.has(name)` per entry
**without** requiring the clean-shutdown marker. The non-atomic domain keeps today's
marker path byte-for-byte.

### Why no engine changes are needed

`mv.derivation.stale` is in-memory runtime state set/cleared inside the engine's own
`SchemaChangeNotifier` listener (`database-materialized-views.ts:493` —
`subscribeToSchemaChanges`). The store is a **second** listener on the same notifier
(`store-module.ts:2411` `ensureSchemaSubscription` → `onEngineSchemaChange`).
Listeners dispatch in **insertion order** (`SchemaChangeNotifier` uses a `Set`;
`notifyChange` iterates it — `change-events.ts`). The engine's MV manager subscribes
in the `Database` constructor; the store subscribes lazily on its first
`create`/`connect`/`rehydrate` — so **the engine listener always runs first** and the
store's recompute observes the already-updated flags. Therefore the store can simply
recompute `getAllMaintainedTables().filter(mv => mv.derivation.stale)` (the *exact*
computation `closeAll` already does at `store-module.ts:2603`) on each observed
event. The synthetic backing-invalidation event (`emitBackingInvalidation`, a nested
`table_modified` on the MV's own backing, `database-materialized-views.ts:669`) gives
redundant coverage of MV-over-MV cascade staleness and fires *after* the flag flips —
so cascade-staled dependents are caught too.

**Every staleness SET transition is bracketed by an event the store observes**
(source `table_modified`/`table_removed`; the synthetic backing-invalidation
`table_modified`). **Every CLEAR transition fires an event too** — `refresh`
(`materialized_view_refreshed`), recreate/re-attach (`materialized_view_added` /
`_modified`) — **except** the rename-restore path
(`restoreUnaffectedMaterializedViews` / `restoreMaterializedViewLive`,
`materialized-view-helpers.ts:2736`), which deliberately fires no event. That one
gap is handled conservatively (see Edge cases) — it causes a wasteful-but-**sound**
refill, never an unsound adopt.

### Durability ordering (soundness argument — do NOT fold into an atomic batch)

The unsound case to prevent: source's *content-significant* schema change is durable
on disk while the stale-set entry that records the resulting staleness is **not** →
reopen adopts an MV that is actually behind. We need: *stale-set durable no-later-than
the source DDL that caused it.*

The store persists the source DDL eagerly inside `module.alterTable`
(`saveTableDDL`, a non-`sync` `put`) **before** the `table_modified` event fires
(staleness is only known after). The stale-set write happens in the event handler,
**after**, with `sync: true`. On a WAL-ordered backend (LevelDB) the `sync` on the
stale-set flushes everything queued before it (including the source DDL), so a crash
before that `sync` loses **both** (→ reopen sees old source + old stale-set → adopt,
sound) and a crash after has **both** (→ refill, sound). This is the **same
sync-point-write durability discipline** the existing clean-shutdown marker-consume
delete uses (`store-module.ts:2307`, `{ sync: true }`), and it carries the **same
documented backend caveat** (a backend without a durability knob no-ops the hint; an
IndexedDB-style per-tx-durability backend has the marker's identical best-effort
ordering caveat). **Mirror the marker exactly: a `sync: true` point-write, not an
atomic-batch fold.** Folding the stale-set into a single `catalogStore.batch()` with
the source DDL is the fully-portable hardening but requires deferring/reworking
`alterTable`'s eager persist across every alter kind — out of scope here; note it in
the doc caveat as the future step, exactly as the marker caveat already notes its own
subsuming fix.

## Architecture / data shapes

New reserved meta entry, classified `'meta'` by the existing `classifyCatalogKey`
(any `\x00meta\x00*` key → skipped by every rehydrate DDL phase — **no classifier
change**):

```
key:   buildMetaCatalogKey(STALE_MVS_META_NAME)   // "\x00meta\x00stale_mvs"
value: JSON array of lowercased qualified `schema.mv` names currently stale
       e.g. []  or  ["main.mv","main.mv2"]
```

`STALE_MVS_META_NAME = 'stale_mvs'` in `key-builder.ts`, modeled on
`CLEAN_SHUTDOWN_META_NAME`, exported from `common/index.ts`.

Unlike the marker, the stale-set entry is **persistent current-truth**, NOT
single-use: `rehydrateCatalog` **reads** it (never deletes it); the session
overwrites it as staleness changes; a crash leaves the last synced value intact.

### Recompute helper (extract the closeAll computation)

```ts
// store-module.ts — reused by onEngineSchemaChange, closeAll, and rehydrate tail.
private computeStaleMvSet(): string[] {
  return this.subscribedDb
    ? this.subscribedDb.schemaManager.getAllMaintainedTables()
        .filter(mv => mv.derivation.stale)
        .map(mv => `${mv.schemaName}.${mv.name}`.toLowerCase())
    : [];
}
```

`closeAll`'s existing `staleAtClose` computation (`store-module.ts:2603`) becomes a
call to this helper (preserve its existing comment about no-subscribed-db ⇒ empty,
and memory-backed MVs being harmless).

### Incremental compare-write (in `onEngineSchemaChange`)

After the existing `switch`, recompute the set and **compare-write only on change**
(avoid an fsync per unrelated tag-swap `table_modified`). Track the last-written set
in an in-memory field (e.g. `private lastPersistedStaleMvs: string | undefined`
holding the JSON string). When the recomputed JSON differs, enqueue on
`persistQueue` a `catalogStore.put(buildMetaCatalogKey(STALE_MVS_META_NAME),
encode(json), { sync: true })`. Enqueuing on `persistQueue` keeps it serialized
behind the event's own source-DDL compare-write, so the `sync` lands after the source
DDL is queued (the ordering the soundness argument relies on). Reset
`lastPersistedStaleMvs = undefined` wherever a fresh DB is subscribed so a reopened
module re-establishes the baseline.

### `closeAll` (final authoritative write)

Keep writing the clean-shutdown marker exactly as today. **Additionally** write the
durable stale-set from `computeStaleMvSet()` (same array used for the marker
payload). This both (a) corrects any rename-restore drift at a clean close and (b)
guarantees the entry exists even in a session with no staleness events.

### `rehydrateCatalog` (read side — capability-aware trust basis)

Capability check = method presence, matching the coordinator's own gate:
`const atomic = typeof this.provider.beginAtomicBatch === 'function';`

```
read durableStale  = parse(stale-set meta entry)   // ReadonlySet<string>, or ABSENT
consume marker     = consumeCleanShutdownMarker()   // unchanged; still single-use delete

if (atomic && durableStaleEntryPresent):
    // gate 4 alone governs — marker NOT required (crash → still adopt non-stale)
    trustBackings = !durableStale.has(entry.name)        // per entry, for ALL entries
else:
    // today's behavior, byte-for-byte (also the upgrade path: capability gained but
    // no stale-set entry yet → fall back to the marker the prior clean close wrote)
    trustBackings = markerTrusted && !staleAtClose.has(entry.name)
```

Always consume (delete) the marker for single-use hygiene even in the atomic branch;
its *trust bit* is simply ignored there. The conservative-parse discipline of the
stale-set read mirrors `consumeCleanShutdownMarker`: an absent entry → fall to the
marker path; a present-but-unparseable/wrong-shape entry → treat as "everything
stale" (refill all) — refill is always safe.

After phase 3 completes, recompute the durable stale-set from the now-current flags
and compare-write it (refilled MVs cleared `stale`; adopted MVs were never stale) so
the entry reflects post-rehydrate truth.

## Edge cases & interactions (write these as tests)

- **Atomic-domain crash, non-stale backing** — simulate a crash (persistent provider,
  skip `closeAll`, à la `mv-rehydrate-adopt.spec.ts`) over a provider whose
  `beginAtomicBatch` is a function. A non-stale same-module backing **adopts** (planted
  sentinel survives) with **no clean-shutdown marker present** — gate 4 alone governs.
- **Atomic-domain crash, stale-at-close MV** — an MV staled mid-session (body-relevant
  source ALTER) then crashed: the **durable stale-set** (not the lost marker) drives
  exclusion → it **refills** (sentinel scrubbed). Proves the logical-staleness window
  stays sound under the dropped gate.
- **Residual shape-stable-but-content-stale case (the hole this pass identified)** —
  a source `set collate` / type change on a column used only in a `where`/`group by`
  (not projected): gate 2 (`backingShapeMatches`) passes, but the engine's
  `tryRecompileMaterializedViewLive` fails (content not provably stable) → MV staled.
  After a crash in the atomic domain it must **refill** because the durable stale-set
  names it. (Confirm the chosen source change actually stales the MV in this store —
  pin it with an assertion on `derivation.stale`, mirroring the existing stale-at-close
  test at `mv-rehydrate-adopt.spec.ts:494`.)
- **Non-atomic / minimal provider (no `beginAtomicBatch`)** — full fallback parity:
  the marker gate governs exactly as today (existing adopt suite must stay green
  unchanged). The in-memory provider used by the adopt spec has no `beginAtomicBatch`,
  so add an *atomic-capable* persistent test provider (expose a `beginAtomicBatch`
  method — it need not truly be atomic for these logical tests; the capability check is
  method presence) to exercise the new branch, OR run the relevant cases against the
  real LevelDB provider.
- **Capability appears between sessions (upgrade)** — session 1 (no capability) closes
  cleanly writing only the marker; session 2 (capability) rehydrates with **no
  stale-set entry present** → falls back to the marker path → adopts non-stale / refills
  per the marker. No crash, no unsound adopt.
- **Capability disappears between sessions (downgrade)** — session 1 (capability) wrote
  both marker and stale-set; session 2 (no capability) uses the marker path and ignores
  the (harmless, `'meta'`-classified) stale-set entry.
- **Stale-then-refreshed in the same session** — an MV staled then `refresh`ed
  (`materialized_view_refreshed` fires) → recompute clears it from the durable set, so
  a later crash adopts the now-healthy backing (durable set must NOT still name it).
- **Rename-restore no-event clear (accepted conservatism)** — a rename that stales an
  MV then provably-restores it via `restoreUnaffectedMaterializedViews` fires no clear
  event; if a crash hits before any other schema event, the MV is in the durable set →
  **wasteful refill on reopen, but sound**. Document; the next clean close (or any
  subsequent staleness event) recomputes it away. Add a test asserting the refill is
  *sound* (correct content), not that it's skipped.
- **MV-over-MV cascade** — an upstream that refills must force dependents to refill (the
  existing `adoptedBackings` ledger composes this through fixpoint rounds; the durable
  stale-set must not bypass it). A cascade-staled dependent (via
  `emitBackingInvalidation`) appears in `getAllMaintainedTables().filter(stale)`, so the
  recompute records it. Test a 2-level chain: source ALTER stales the upstream; both
  upstream and dependent must refill after an atomic-domain crash.
- **Memory-backed MV in the stale-set** — harmless: it has no phase-1 durable backing,
  so it always refills; withholding trust is a no-op (parity with the existing
  `closeAll` note).
- **Listener ordering invariant** — add a guard/test asserting the engine MV manager
  subscribes before the store (so the recompute sees post-transition flags). If feasible,
  assert on `getChangeNotifier().getListenerCount()` ordering or via an integration test
  that a source ALTER's stale flag is visible in the persisted stale-set entry.
- **`buildCatalogEntry`/DDL parity unaffected** — the stale-set is a meta entry, not
  DDL: adopt-vs-refill must still leave byte-identical catalog DDL (the existing
  `afterAdopt deep.equal afterRefill` test must stay green; the new meta entry is
  excluded from those snapshots or asserted separately).

## Acceptance

- `provider.beginAtomicBatch` present ⇒ MV adopt succeeds across a simulated crash
  (no marker) for a non-stale same-module backing; gate 4 alone governs.
- Capability present ⇒ a stale-at-close MV still refills across a simulated crash,
  driven by the durable stale-set (not the lost marker).
- No capability ⇒ marker gate governs exactly as today (full parity).
- The residual shape-stable-but-content-stale case refills after a crash in the
  atomic domain (regression test for the specific hole identified above).
- `docs/materialized-views.md` gate 5 + caveats updated: gate 5 becomes a runtime
  `beginAtomicBatch`-presence check; the durable stale-set mechanism documented; the
  `sync`-point-write durability caveat documented (mirroring the marker caveat,
  noting the atomic-batch fold as the future portable hardening); the "subsuming fix
  tracked under plan ticket `store-adopt-atomic-gate-drop`" notes (lines ~116, ~122)
  resolved (the work landed).
- `yarn test` green (default, memory-backed). The new atomic-domain branch is covered
  via an atomic-capable test provider (method-presence) and/or LevelDB. Run
  `yarn workspace @quereus/quereus-store test` for the store suite and
  `yarn workspace @quereus/quereus run lint` for the typecheck. (`yarn test:store` /
  `test:full` exercise the LevelDB path but are slow — run only if diagnosing a
  store-specific failure; document any deferral.)

## TODO

- key-builder.ts: add + export `STALE_MVS_META_NAME = 'stale_mvs'` (doc-comment it like
  `CLEAN_SHUTDOWN_META_NAME`); re-export from `common/index.ts`.
- store-module.ts: extract `computeStaleMvSet()`; refactor `closeAll`'s `staleAtClose`
  to use it; add `lastPersistedStaleMvs` field + reset on (re)subscribe.
- store-module.ts: in `onEngineSchemaChange`, after the switch, recompute + compare-write
  the stale-set with `sync: true` via `persistQueue` (only on change).
- store-module.ts: `closeAll` — additionally write the durable stale-set (keep the
  marker write unchanged).
- store-module.ts: `rehydrateCatalog` — add the `atomic = typeof
  provider.beginAtomicBatch === 'function'` check; read + conservative-parse the
  stale-set entry; choose the trust basis (atomic+entry-present → `!durableStale`;
  else marker path); still consume the marker; recompute the stale-set at the
  phase-3 tail.
- mv-rehydrate-adopt.spec.ts: add an atomic-capable persistent test provider; cover
  every Edge-cases bullet above.
- docs/materialized-views.md: update gates 4–5 + both caveat bullets; resolve the
  two "tracked under plan ticket" references.
- Run the store test suite + lint; record any LevelDB-path deferral.
