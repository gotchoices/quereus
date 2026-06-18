description: When a deleted table comes back, the sync edits that were being held for it are now automatically replayed into it instead of sitting unused until they expire.
prereq:
files:
  - packages/quereus-sync/src/metadata/quarantine.ts          # QuarantineStore.delete(batch, change) — symmetric with put
  - packages/quereus-sync/src/sync/change-applicator.ts       # drainHeldChanges + drainTableGroup + extracted emitRemoteChanges
  - packages/quereus-sync/src/sync/sync-context.ts            # SyncContext.getTableColumnNames
  - packages/quereus-sync/src/sync/sync-manager-impl.ts       # getTableColumnNames impl + drainHeldChanges delegate
  - packages/quereus-sync/src/sync/manager.ts                 # SyncManager.drainHeldChanges
  - packages/quereus-sync/src/sync/events.ts                  # HeldChangesDrainedEvent + on/emitHeldChangesDrained
  - packages/quereus-sync/src/index.ts                        # export HeldChangesDrainedEvent
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts   # drain describe block + harness + crash test
  - packages/quereus-sync-client/test/sync-client.spec.ts     # MockSyncManager.drainHeldChanges (+ 3 pre-existing stubs)
  - docs/migration.md                                         # § 4 Contract — Revival / drain paragraph
  - docs/sync.md                                              # § Unknown-Table Disposition — Revival / drain subsection (review)
----

# Drain held out-of-basis changes when their table reappears

## Summary

When a retired table reappears in the local basis (re-created app-side, or a
`create_table` arrives inbound), its held changes (`quarantine` + forwardable
`store-and-forward`) are replayed into the now-present table via the host-driven
`SyncManager.drainHeldChanges(schema?, table?)` — a sibling of `pruneTombstones` /
`pruneQuarantine` / `evictExpiredBasisTables`. Each held change resolves against the
reappeared table exactly like a fresh inbound change (LWW / tombstone-blocking /
`allowResurrection`) and is cleared from the hold on resolution whether or not it
applied; only entries for still-absent tables stay held. The library adds no timer
and never drains inline. A no-op returning 0 on a relay-only / no-oracle peer.

Core implementation in `change-applicator.ts` (`drainHeldChanges` → `drainTableGroup`),
gated on a new `SyncContext.getTableColumnNames` accessor; `emitRemoteChanges` extracted
and shared with `applyChanges`; `QuarantineStore.delete` added (symmetric with `put`);
`HeldChangesDrainedEvent` + `onHeldChangesDrained` added. See `docs/sync.md` §
Unknown-Table Disposition → Revival / drain and `docs/migration.md` § 4 Contract.

## Review findings

**Scope of review:** read the full implement diff (`108b8004`) with fresh eyes —
`change-applicator.ts`, `quarantine.ts`, `keys.ts`, `admission.ts`, `events.ts`,
`manager.ts`, `sync-context.ts`, `sync-manager-impl.ts`, `index.ts`, both spec files,
and both docs. Aspect angles checked: correctness, DRY, resource cleanup, error
handling, type safety, convergence/CRDT semantics, ordering, idempotency, docs.

### Correctness / semantics — verified sound
- **All-skipped drain still clears the hold.** `admitGroup` always runs `commitMetadata`
  (and `applyDataToStore` is a no-op on empty data), so a group where every held change
  loses LWW / is tombstone-blocked / drift-dropped still deletes its held entries.
- **No store↔metadata divergence on multi-version collapse.** Quarantine keys sort
  HLC-ascending within a table (`buildQuarantineKey`: table prefix → HLC → type → pk),
  so `list()` returns ascending HLC; the stub store applies in that order and ends on
  the max-HLC value, matching `commitChangeMetadata`'s `keepMaxHLC` winner.
- **`QuarantineStore.delete` is key-symmetric with `put`** (same `buildQuarantineKey`
  inputs), confirmed by the idempotent-re-drain test (second sweep finds 0).
- **Deleting non-applied held entries is convergence-safe.** An LWW-lost / tombstone-
  blocked / drift-dropped held change is causally dominated by the surviving local
  value or tombstone, which relays via the normal change log — so dropping the held
  copy loses no convergence (holds for forwardable entries too).
- **Crash-mid-drain is idempotent by construction** (data-first → metadata+hold-clear
  second; a data-apply throw aborts before `commitMetadata`, leaving entries held;
  re-resolution of an already-committed change is a no-op, so no double-apply).

### Minor — fixed in this pass
- **Doc completeness (fixed).** The implementer updated `docs/migration.md` but not
  `docs/sync.md`, the canonical sync-mechanics doc, whose Unknown-Table Disposition
  section described `quarantine` / `ignore` / `store-and-forward` + the relay but never
  the revival/drain path or `drainHeldChanges` / `onHeldChangesDrained`. Added a
  "Revival / drain" subsection mirroring the store-and-forward relay section.
- **Untested crash path (fixed).** Crash-mid-drain idempotency was reasoned, not tested.
  Added a `failApply` throw hook to the test harness (default off → zero impact on the
  405 existing tests) and a test asserting a thrown drain apply leaves the entry held +
  fires no drained event + writes nothing, and a later drain succeeds without
  double-apply. Suite now **406 passing**.

### Major — filed as backlog follow-ups (not defects)
- **`tickets/backlog/sync-drain-integration-test.md`** — the drain is exercised only at
  CRDT-metadata + in-memory-stub-store level, never end-to-end through `createStoreAdapter`.
  An e2e test (mirroring `store-and-forward-relay-e2e.spec.ts`) would harden the
  delete-of-absent-pk no-op, MV maintenance / `Database.watch` capture, and
  forwardable→drain→relay-stops claims. The unit suite is a correct floor.
- **`tickets/backlog/sync-drain-host-wiring.md`** — no production caller invokes
  `drainHeldChanges`; hosts that already call the sibling prune/evict sweeps do not yet
  call it, so in the real app held changes still wait for horizon GC. Out of scope for
  the library ticket by design (cadence is host policy), but realizing the feature's
  end-user value requires this wiring.

### Confirmed acceptable (raised by the handoff)
- **`onHeldChangesDrained.applied` counts each resolved-applied held change** even when
  several collapse to one surviving cell — this mirrors `applyChanges`' `applied`
  counter exactly, and `applied + skipped === drained` always holds. Consistent; fine.

### Deferred (per ticket design — not a finding)
- Inline drain on an inbound `create_table` (drain the instant the DDL lands). The
  host-driven sweep already covers correctness/timeliness; an optimization only.

### Side fix carried from implement (noted, accepted)
- `MockSyncManager` in `sync-client.spec.ts` was missing `recordLensDeployment` /
  `getBasisTableLifecycle` / `evictExpiredBasisTables` at HEAD (left by the
  basis-lifecycle ticket), breaking `@quereus/sync-client` `tsc`. The implementer added
  the three stubs while editing the mock. Re-verified: sync-client typecheck clean,
  49 passing.

## Validation
- `yarn workspace @quereus/sync typecheck` → clean.
- `yarn workspace @quereus/sync test` → **406 passing** (was 405; +1 crash test).
- `yarn workspace @quereus/sync-client typecheck` → clean; `test` → **49 passing**.
- (`[Sync] ... Error` console lines during the run are other suites' error-path tests
  in `sync-manager.spec.ts` — `failingKv` injection — not failures.)
