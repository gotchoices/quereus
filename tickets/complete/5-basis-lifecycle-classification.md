description: The bookkeeping that tracks, per shared (basis) table, whether the app still uses it directly, only as a legacy derivation source, or not at all — and when it crossed those lines — so a developer can tell when an old table is safe to retire. Implemented and reviewed.
prereq:
files:
  - packages/quereus-sync/src/metadata/keys.ts                  # BASIS_LIFECYCLE 'bl:' prefix + key builder + scan bounds
  - packages/quereus-sync/src/metadata/basis-lifecycle.ts       # state enum, record, classifier, store, (de)serialize, helpers
  - packages/quereus-sync/src/metadata/index.ts                 # re-export
  - packages/quereus-sync/src/sync/events.ts                    # BasisTableLifecycleEvent + onBasisTableLifecycle + emit
  - packages/quereus-sync/src/sync/manager.ts                   # SyncManager: recordLensDeployment + getBasisTableLifecycle
  - packages/quereus-sync/src/sync/sync-manager-impl.ts         # recordLensDeployment impl, basisLifecycle store, lastBasisHash
  - packages/quereus-sync/src/index.ts                          # public exports
  - packages/quereus-store/src/common/store-module.ts           # setLensDeploymentListener + guarded notifyLensDeployment
  - packages/quereus-store/src/common/index.ts                  # export LensDeploymentListener
  - packages/quoomb-web/src/worker/quereus.worker.ts            # wire store forwarder → sync recorder
  - docs/migration.md                                           # § 2 Converge + § Current gaps marked landed
  - packages/quereus-sync/test/metadata/basis-lifecycle.spec.ts        # unit spec
  - packages/quereus-sync/test/sync/basis-lifecycle-recorder.spec.ts   # recorder spec (+ re-map-after-exit added in review)
  - packages/quereus-store/test/lens-deployment-listener.spec.ts       # store forwarder spec
----

# Complete: basis-table lifecycle classification & persistent bookkeeping (static half)

The static foundation for legacy-basis-table retirement. On each lens deploy, the
sync layer recomputes and durably stores, per basis table, a four-state
classification (`directly-mapped` / `derivation-source-only` / `unreferenced` /
`detached`) plus mapped-since / unmapped-since timestamps, and emits
`onBasisTableLifecycle` on each transition. The dynamic network signal
(`lastDirectlyMappedWriteAt`) and the eviction policy build on this in
`5.5-basis-eviction-policy` (its prereq is this ticket; the reserved fields are
carried through untouched and match its expected shape).

The implement-stage handoff is accurate; the architecture is unchanged by this
review. See commit `2741b2eb` for the full implementation diff.

## Review findings

Adversarial pass over the implement diff (`2741b2eb`) with fresh eyes before the
handoff summary. Validated build + both test suites green; verified the
implementation against the engine contracts it consumes.

### Checked — engine-contract fidelity (no issues)
- **Key alignment.** `relationBacking` keys (`lens.ts:216`) and
  `derivation.sourceTables` (`derivation.ts:52-53`) are both lowercased
  `schema.table`, matching the recorder's basis enumeration key
  `${table.schemaName}.${table.name}`.toLowerCase()`. The real-`Database`
  end-to-end recorder test confirms the produced snapshot + basis enumeration
  agree for an ordinary name-match lens.
- **Fire contract + isolation forward.** `notifyLensDeployment`'s engine
  fire-once-per-successful-deploy contract (`module.ts:417+`,
  `schema-declarative.ts:notifyLensDeploymentAll`) and the
  `IsolationModule.notifyLensDeployment` straight-delegate
  (`isolation-module.ts:463`, with its own unit + real-apply tests) are present
  and unchanged — an isolation-wrapped StoreModule still reaches the listener.
- **Guard inversion.** The store forwarder's try/catch deliberately inverts the
  engine's "a throwing notification aborts apply schema" contract; proven by the
  real-`apply schema` store test (`lens-deployment-listener.spec.ts`) that a
  throwing/rejecting listener does not abort the deploy.

### Checked — classification correctness (no issues)
- **Multi-schema OR-fold.** `mapped.add/delete(logical)` per universe key never
  clobbers another schema's contribution (a non-mapping schema's deploy is a
  no-op `delete`), so a table stays `directly-mapped` until the *last* mapper
  drops it. Covered by the two-schema test.
- **Event/write coherence.** A state change always forces a write
  (`basisLifecycleRecordChanged` compares `state`), so the event gate
  (`prior.state !== state`) can never emit a transition that wasn't durably
  persisted first. Events are emitted only after `batch.write()`.
- **KV-key consistency.** `buildBasisLifecycleKey` / `getAll` / `put` lowercase
  uniformly and agree with the recorder's universe keys (basis membership,
  derivation sources, directly-mapped, and stored keys are all lowercased).
- **Surrogate folding, restart durability, missing-basis defensiveness,
  idempotent re-apply, empty/detach-all deploy** — all covered by existing
  recorder tests and re-verified by reading the code paths.

### Found & fixed inline (minor)
- **Re-map-after-exit path was untested** despite the ticket flagging it as
  high-value reviewer focus. The `isMapped && !wasMapped` re-entry branch resets
  `mappedSince` and clears `unmappedSince`, but no test exercised re-mapping a
  table *after* it had left `directly-mapped`. Added
  `re-mapping after an exit resets mappedSince and clears unmappedSince` to
  `basis-lifecycle-recorder.spec.ts`: map → flip away (derivation-source-only,
  `unmappedSince` stamped) → re-map, asserting `directly-mapped`, `mappedBy`
  restored, `unmappedSince` cleared, `mappedSince` re-stamped (≥ original, to
  avoid ms-resolution flake), and a `derivation-source-only → directly-mapped`
  event fired. Sync suite: **330 → 331 passing.**

### Observed — accepted, no action (documented, not findings)
- **`basisLifecycleRecordChanged` ignores the `schema`/`table` display fields.**
  A pure display-case upgrade (e.g. a record first stored lowercased via the
  missing-basis `splitRelKey` fallback, later resolvable to original case) would
  not, by itself, rewrite the record. Harmless in practice: any such case upgrade
  rides along with an `inBasis` (or other tracked-field) transition that forces a
  write, and the emitted *event* always carries the freshly-computed display
  regardless of the gate. Left as-is.
- **Detached records accumulate unbounded.** Detached tables stay in KV and are
  re-classified every deploy (the universe includes `stored.keys()`). Deleting
  them after retirement is `5.5-basis-eviction-policy`'s job — a deliberate
  design boundary, not a leak in the static half.
- **Worker wire-through (gap #1) is build-verified only.** The store forwarder
  and the sync recorder are each unit-tested; the worker binds the listener on
  the *same* `StoreModule` instance it registers (`quereus.worker.ts:603,662` —
  no isolation wrapper in quoomb-web), so the seam is a one-line type-checked
  pass-through between two tested ends. The risk is low enough that a
  worker-harness integration test is not warranted; left as a documented
  limitation rather than a follow-up ticket.

### Not done (no findings)
- **Lint:** the only `lint` script is in `@quereus/quereus`, which this change
  does not touch; the sync/store sources and tests type-check under their package
  builds (`yarn workspace @quereus/{store,sync} run build` clean) and the worker
  wiring type-checks under `@quereus/quoomb-web` build. No lint pass applies.
- **No major findings → no new fix/plan tickets filed.** The one parked item
  (in-SQL `quereus_basis_lifecycle()` TVF) was already split to
  `tickets/backlog/sync-basis-lifecycle-sql-tvf.md` during implement; that split
  is appropriate and left in place.

## Validation
```
yarn workspace @quereus/sync run test     # 331 passing (was 330; +1 re-map test)
yarn workspace @quereus/store run test    # 643 passing
yarn workspace @quereus/store run build   # clean
yarn workspace @quereus/sync run build    # clean
yarn workspace @quereus/quoomb-web build  # clean (worker wiring type-checks)
```

## End
