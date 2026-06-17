<!--
RESUME HISTORY (context for the reviewer): this ticket spanned several
interrupted implement runs that each hit the 10-min idle timeout. The work
itself landed across two runner "timed out" commits:
  - 2d9951d1 — full implementation + the 14-test spec
  - ca95b6ae — docs/migration.md + docs/sync.md + the store-adapter-seam test fix
The final implement run only re-verified gates (sync typecheck + 275 tests green)
and wrote this handoff. No implementation change is uncommitted for this ticket.
-->
description: A long-offline peer can reconnect and send edits for a table the receiver has since deleted; the sync engine now lets an operator choose to drop or durably keep those edits, and always reports them so a straggler's writes are never silently lost.
prereq:
files:
  - packages/quereus-sync/src/sync/change-applicator.ts        # detection + diversion + telemetry in apply flow
  - packages/quereus-sync/src/metadata/quarantine.ts           # QuarantineStore (put/list/pruneOlderThan)
  - packages/quereus-sync/src/metadata/keys.ts                 # qt: prefix + key/scan-bounds builders
  - packages/quereus-sync/src/sync/protocol.ts                 # UnknownTableDisposition, SyncConfig field, ApplyResult.unknownTable, DEFAULT_SYNC_CONFIG
  - packages/quereus-sync/src/sync/events.ts                   # UnknownTableEvent + onUnknownTable
  - packages/quereus-sync/src/sync/sync-context.ts             # isTableInBasis / recordUnknownTable on the ctx surface
  - packages/quereus-sync/src/sync/sync-manager-impl.ts        # oracle, stats counter, pruneQuarantine, ctx wiring
  - packages/quereus-sync/src/sync/manager.ts                  # SyncManager interface additions
  - packages/quereus-sync/src/sync/store-adapter.ts            # defensive "Table not found" throw kept as net
  - packages/quereus-sync/test/sync/unknown-table-disposition.spec.ts  # NEW — 14 tests, the primary coverage
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts # oracle patched so the absent-store throw still fires
  - docs/migration.md                                          # § 4 Contract — Unknown-table disposition
  - docs/sync.md                                               # § Unknown-Table Disposition, config, events, ApplyResult
difficulty: hard
----

# Review: Unknown-table disposition + telemetry

## What the feature does (one paragraph)

After a legacy basis table retires everywhere, a long-offline **straggler** can
reconnect and send changes for a table the receiver no longer has. Previously the
store adapter resolved the table to `undefined` and threw `Table not found for
external write`, which aborted the whole batch — a **poison batch** that
re-resolved forever and taught the straggler nothing (silent write loss). This
ticket replaces that with **structural out-of-basis detection at Phase 1 of
`applyChanges`** plus a **configured disposition** (`ignore` | `quarantine`,
default `quarantine`) and **always-on telemetry** (`onUnknownTable` event,
`getUnknownTableStats()` counter, `ApplyResult.unknownTable`). Diverted changes
never reach resolution / store apply / CRDT metadata, so the change log stays
clean for a table the receiver does not have.

## Implementation map (where to look)

- **Detection + diversion**: `change-applicator.ts`
  - `computeBatchTableDelta()` — net `create_table`/`drop_table` sets over the whole batch.
  - In `applyChanges`'s Phase 1 loop: self-origin echo skip runs FIRST, then
    `known = (isTableInBasis || batchCreated.has) && !batchDropped.has`; unknown
    changes are diverted into `unknownByTable` and `continue` (never resolved).
  - Quarantine `put` is folded into the **`commitMetadata` callback of `admitGroup`**
    (lines ~225-233) — durable inside the admission unit, before `watermarkHLC`
    advances. `ignore` writes nothing.
  - Telemetry (`recordUnknownTable` + `emitUnknownTable`) fires AFTER successful
    admission, per `(schema,table)` group, regardless of disposition.
- **Durable store**: `quarantine.ts` — `QuarantineStore.put/list/pruneOlderThan`,
  raw `Change` serialized verbatim + `receivedAt`. HLC-in-key ⇒ idempotent re-apply.
- **Keys**: `keys.ts` — `qt:{schema}.{table}:{hlc}:{type}:{pk}[:{column}]`,
  `buildQuarantineKey` / `buildQuarantineScanBounds`.
- **Oracle + stats + GC**: `sync-manager-impl.ts` — `isTableInBasis` over the
  existing `getTableSchema` callback; `recordUnknownTable` / `getUnknownTableStats`
  in-memory counter; `pruneQuarantine()` sibling of `pruneTombstones()`.

## Validation state (what I personally re-ran this session)

- `yarn workspace @quereus/sync run typecheck` → **clean (exit 0)**.
- `yarn workspace @quereus/sync run test` → **275 passing, 0 failing**, including
  the 14-test `unknown-table-disposition.spec.ts`.
- `yarn build` + `packages/quereus` lint were **green in the immediately prior
  implement run** on this exact committed code (no quereus-sync code changed since).
  I did **not** re-run the full monorepo build/lint this session — see the
  working-tree caveat below for why I deliberately left it to the reviewer.

## Test coverage (the floor — treat as a starting point, not a ceiling)

`unknown-table-disposition.spec.ts` covers, with a fake `applyToStore`/oracle harness:

- quarantine default: divert + don't-apply + telemeter; **no CRDT metadata** for
  the unknown table (`getChangesSince`/columnVersions/tombstones stay empty);
  deletes AND column changes held verbatim; **idempotent re-apply** (one entry/HLC).
- `ignore`: drops changes, still telemeters (event + `ignored` counter, no `qt:` entry).
- detection edges: in-batch `create_table` + DML applies normally (nothing
  quarantined); in-batch `drop_table` diverts; **self-origin echo skip first**
  (self-change never quarantined); **mixed batch** (known applies, unknown
  diverted); absent-oracle inert (treated as known).
- GC: prune past a 1ms horizon; no prune within a 60s horizon.
- telemetry detail: `latestHLC` is the max among diverted; one event per distinct table.

### Gaps a reviewer should probe (tests I would add / scrutinize)

- **End-to-end against the real store adapter.** The spec uses a fake
  `applyToStore`. There is no test of detection + quarantine against the *production*
  `createStoreAdapter` over an actual store table (two real `SyncManagerImpl`
  peers, one retiring a table the other still writes). Worth an integration test —
  the unit harness proves the control flow, not the real-store seam interaction.
- **Crash-safety claim is asserted indirectly.** The "durable before watermark"
  ordering is verified only via the idempotent-re-apply test (re-apply ⇒ one entry
  per HLC). There is no test that actually interrupts between data-apply and
  quarantine-write. The ordering is correct by construction (quarantine `put` is
  inside the `commitMetadata` batch that lands before `watermarkHLC`), but a
  fault-injection test would harden it.
- **`UnknownTableEvent.siteId` is the first changeset's siteId for the table**, not
  per-change. If two different stragglers reference the same retired table in one
  `applyChanges` call, the group keeps only the *first* changeset's `siteId` while
  accumulating both sites' changes. Matches the ticket's "from the changeset"
  spec, but the reviewer should confirm that's the intended attribution.
- **create+drop of the same table in one batch.** `computeBatchTableDelta` puts it
  in both sets; `known = (... || created) && !dropped` ⇒ `dropped` wins ⇒ diverted.
  Untested; rare, but confirm the desired semantics.
- **`pruneQuarantine()` is caller-driven, not auto-scheduled** — exactly mirroring
  the pre-existing `pruneTombstones()` (no internal maintenance loop calls either).
  This is parity with the existing pattern, not a regression, but note that nothing
  in the engine invokes either prune on a timer; an operator/host must call them.
- **`receivedAt` uses `Date.now()` at apply time** for GC, same wall-clock basis as
  tombstone `createdAt`. GC precision is therefore subject to the same clock-skew
  caveats; bounded by the horizon.

## Explicitly out of scope (deferred / by design)

- **`store-and-forward` disposition** (durably hold AND re-offer to peers that still
  have the table) — needs outbound `getChangesSince` integration; parked in
  `tickets/backlog/sync-unknown-table-store-and-forward.md`. The disposition type is
  `'ignore' | 'quarantine'` until that lands.
- **Snapshot paths** (`applySnapshot` / `applySnapshotStream`) — bootstrap a whole
  basis, not a straggler delta; an unknown table there still hits the adapter's
  defensive throw. Documented in `docs/migration.md`.
- **Absent `getTableSchema`** — detection inert (treated as known), adapter throw is
  the documented fallback. Tested.

## Working-tree caveat (important — do not attribute these to this ticket)

At handoff the working tree contains **unrelated in-flight changes from the
concurrent cross-table-apply-ordering work**, which I left untouched per the "never
sanitize the working tree" rule:

- `M packages/quereus/src/runtime/emit/materialized-view-helpers.ts`
- `M packages/quereus/src/schema/manager.ts`
- `M docs/sync.md` (an *uncommitted* hunk about cross-table FK-actions ordering,
  separate from this ticket's already-committed § Unknown-Table Disposition)
- `D tickets/backlog/sync-cross-table-apply-ordering.md`
- `?? tickets/plan/`

None of these are part of unknown-table disposition. The reviewer should scope the
review to the committed `packages/quereus-sync/**` diff (commits `2d9951d1` and
`ca95b6ae`) plus the migration/sync doc sections on unknown-table disposition. If a
full `yarn build` / `quereus lint` is run and fails, check whether the cause is in
those unrelated `packages/quereus` files before charging it to this ticket.

## Suggested review focus order

1. `change-applicator.ts` Phase-1 diversion + the `commitMetadata`-fold ordering
   (the load-bearing correctness/crash-safety claim).
2. `quarantine.ts` key idempotency + serialization round-trip fidelity.
3. The no-CRDT-pollution invariant (does any diverted change reach `commitChangeMetadata`?).
4. The two integration gaps above (real-store e2e, fault injection) — decide
   whether to fix inline (minor) or spawn a fix/backlog ticket (major).
