description: Review the new bookkeeping that tracks, per shared (basis) table, whether the app still uses it directly, only as a legacy derivation source, or not at all — and when it crossed those lines — so a developer can tell when an old table is safe to retire.
prereq:
files:
  - packages/quereus-sync/src/metadata/keys.ts                  # BASIS_LIFECYCLE 'bl:' prefix + key builder + scan bounds
  - packages/quereus-sync/src/metadata/basis-lifecycle.ts       # NEW: state enum, record, classifier, store, (de)serialize, helpers
  - packages/quereus-sync/src/metadata/index.ts                 # re-export
  - packages/quereus-sync/src/sync/events.ts                    # BasisTableLifecycleEvent + onBasisTableLifecycle + emit
  - packages/quereus-sync/src/sync/manager.ts                   # SyncManager: recordLensDeployment + getBasisTableLifecycle
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # recordLensDeployment impl, basisLifecycle store, lastBasisHash
  - packages/quereus-sync/src/index.ts                          # public exports
  - packages/quereus-store/src/common/store-module.ts           # setLensDeploymentListener + guarded notifyLensDeployment
  - packages/quereus-store/src/common/index.ts                  # export LensDeploymentListener
  - packages/quoomb-web/src/worker/quereus.worker.ts            # wire store forwarder → sync recorder
  - docs/migration.md                                           # § 2 Converge + § Current gaps marked landed
  - packages/quereus-sync/test/metadata/basis-lifecycle.spec.ts        # NEW unit spec
  - packages/quereus-sync/test/sync/basis-lifecycle-recorder.spec.ts   # NEW recorder spec
  - packages/quereus-store/test/lens-deployment-listener.spec.ts       # NEW store forwarder spec
----

# Review: basis-table lifecycle classification & persistent bookkeeping (static half)

The static foundation for legacy-basis-table retirement. On each lens deploy, the
sync layer recomputes and durably stores, per basis table, a four-state
classification + mapped-since / unmapped-since timestamps, and emits an event on
each transition. The dynamic network signal and the eviction policy build on this
in `5.5-basis-eviction-policy` (its prereq is this ticket).

## What was built

**Data + plumbing**
- `notifyLensDeployment` fires on every registered module after a logical
  `apply schema`. `StoreModule` (the basis-backing host) now implements it: a new
  `setLensDeploymentListener(fn)` binds a host callback, and the hook forwards to
  it **wrapped in try/catch** — advisory bookkeeping must never abort a deploy.
  This deliberately **inverts** the engine's "a throwing notification aborts apply
  schema" contract; documented at the call site.
- `@quereus/store` stays free of a `@quereus/sync` dependency — the listener is a
  plain `(db, logicalSchemaName, snapshot) => void | Promise<void>`. The
  **worker** (`quereus.worker.ts`, depends on both) wires
  `StoreModule.setLensDeploymentListener(...)` → `SyncManager.recordLensDeployment`.
- `IsolationModule.notifyLensDeployment` already forwards to its underlying
  module — verified unchanged; an isolation-wrapped StoreModule still reaches the
  listener.

**Classification (`SyncManagerImpl.recordLensDeployment`)**
- Per logical schema, the directly-mapped set = union of every table snapshot's
  `relationBacking` keys **plus** `surrogateMemberKeys` (deferred surrogate
  members count as referenced).
- Basis enumerated via `db.schemaManager.getSchema(snapshot.basisSchemaName)` →
  `getAllTables()`: membership + union of `derivation.sourceTables`.
- Per basis-relation key, `mappedBy` OR-folds this schema's contribution (add when
  mapped now, remove when not) so a table stays `directly-mapped` until the *last*
  mapper drops it. Aggregate state: `mappedBy.length>0` → directly-mapped; else
  `derivationSource` → derivation-source-only; else `inBasis` → unreferenced; else
  → detached.
- `mappedSince` stamped on entry into directly-mapped (clearing `unmappedSince`);
  `unmappedSince` on exit. Records persisted in one KV batch per deploy (`bl:`
  prefix). `onBasisTableLifecycle` emitted **after** the batch is durable, only on
  an actual state change of an already-tracked table.
- Reserved fields `lastDirectlyMappedWriteAt` / `evictPolicy`
  (`'never'|'immediate'|number`) are carried through untouched — they match
  `5.5-basis-eviction-policy`'s expected shape exactly.

## How to validate / use cases

**Run the tests:**
```
yarn workspace @quereus/sync run test     # 330 passing (incl. 2 new specs, 22 new cases)
yarn workspace @quereus/store run test    # 643 passing (incl. 1 new spec, 6 new cases)
```
Full `yarn build` is clean; full `yarn test` is green across all 12 workspaces.

**Key scenarios covered (recorder spec):** first deploy → directly-mapped +
`mappedSince`; directly-mapped wins over derivation-source; flip → derivation-
source-only (`unmappedSince` + event, `mappedSince` preserved) → detach →
detached; two schemas stay directly-mapped until the last flips; empty deploy
clears `mappedBy`; idempotent re-apply emits nothing & preserves timestamps;
surrogate members treated as referenced; restart re-reads persisted records;
missing basis schema doesn't throw; **one real `Database` name-match deploy
end-to-end**. Store spec: guarded forward swallows sync/async throws and does
**not** abort a real `apply schema`.

## Honest gaps / things to scrutinize

1. **Worker wire-through is build-verified only, not runtime-tested.** The store
   forwarder and the sync recorder are each unit-tested in isolation, and the
   `quereus.worker.ts` wiring type-checks under `yarn build`, but there is **no
   runtime test** exercising the full notify → StoreModule → recorder chain inside
   the actual worker (quoomb-web has no harness for it). The real-`Database`
   recorder test proves the snapshot + basis enumeration are real; the store spec
   proves the guard; the seam between them in the worker is unproven at runtime.
2. **Deviation from the ticket's universe formula (intentional).** The ticket
   specified the reclassification universe as
   `basisMembership ∪ derivationSources ∪ {stored}`. I additionally fold in this
   schema's `directlyMapped` set, so every relation the lens maps is tracked even
   in the defensive case where the basis schema can't be resolved (a no-op
   normally, since a mapped relation is a real basis member). Confirm this is the
   desired robustness. A failing test first surfaced this gap.
3. **`getBasisTableLifecycle()` is async** (`Promise<BasisTableLifecycleRecord[]>`)
   — the ticket showed a sync signature, but the records are KV-durable so the read
   must be async. Same for `recordLensDeployment` (already async).
4. **Basis-drift warning is in-memory only.** `lastBasisHash` is a per-process
   `Map`, so the drift warning won't fire on the first deploy after a restart even
   if the hash changed out-of-band. The ticket called drift detection "not
   required here"; this is advisory logging. There is **no dedicated test** for the
   warning (it is only incidentally triggered by the flip test using `h`→`h2`).
5. **Memory-backed basis assumption.** Classification only runs when the store
   module is the basis host (only it has the forwarder). A purely memory-backed
   basis records nothing — by design (sync-with-persistence implies the store
   module). Tests call `recordLensDeployment` directly to exercise the recorder.
6. **Original-case fidelity.** `mappedBy` stores lowercased logical schema names;
   only basis schema/table case is preserved (from enumeration, with a
   lowercased-key-split fallback for detached/derivation-only keys).
7. **No SQL TVF.** In-SQL introspection (`quereus_basis_lifecycle()`) was parked
   to `tickets/backlog/sync-basis-lifecycle-sql-tvf.md` per the ticket; the method
   + event are the contract.

## Suggested reviewer focus

- The `mappedBy` OR/remove logic and `unmappedSince`/`mappedSince` stamping across
  the multi-schema and re-entry (re-map after exit) paths — the retirement hint
  depends on these being exactly right.
- The `basisLifecycleRecordChanged` gate vs. event emission: confirm an idempotent
  re-apply truly writes nothing and emits nothing (asserted, but high-value).
- Whether the directly-mapped-in-universe deviation (gap 2) is acceptable.
- Whether the unverified worker wiring (gap 1) warrants a follow-up integration
  test ticket.
