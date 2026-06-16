description: Review the change that makes a replicate-opted-in store backing's `replaceContents` (create-fill / full-rebuild refresh) publish ONLY genuine deltas against the committed contents — so cold/static derived rows reach never-upgrading old peers at deploy, while a value-identical re-fill emits nothing (storm suppression). Store-host-only change plus doc edits; memory host and engine interface untouched.
files:
  - packages/quereus-store/src/common/backing-host.ts            # replaceContents (bifurcated); module header § Events
  - packages/quereus-store/test/backing-host.spec.ts             # new replaceContents emit tests + DESC/NOCASE replaceContents describe block
  - docs/migration.md                                            # § Synced vs. local derived tables table row; § Current gaps last bullet
  - packages/quereus/src/runtime/emit/materialized-view-helpers.ts  # the create-fill / refresh callers (context only — unchanged)
difficulty: medium
----

# Review: publish create-fill / refresh deltas on a replicate-opted-in store backing

## What changed

`StoreBackingHost.replaceContents` (`packages/quereus-store/src/common/backing-host.ts`)
was bifurcated. Previously it was event-free on every path; now:

- **Non-replicating backing (default, common case):** unchanged. Streams the
  committed contents, deletes every key not in the incoming `rows`, puts all
  entries, resets stats. Byte-for-byte the prior behavior, zero added cost — no
  old-value deserialization, no delta list, no events. This is the early-return
  arm gated on `!this.replicates`.
- **Replicating backing (`quereus.sync.replicate = true`):** after committing any
  open coordinator transaction (the existing DDL-commit posture) and building the
  duplicate-checked `entries` set, it snapshots the **committed** before-image
  (`store.iterate(buildFullScanBounds())` — no pending state to merge once the
  coordinator is committed), diffs the incoming rows against it, writes the
  minimal batch, then queues one `DataChangeEvent` per genuine delta:
  - new key → `insert`
  - existing key, value byte-different (`!rowsValueIdentical`) → `update` (re-keys)
  - existing key, byte-identical → **skipped** (no put, no event — suppression)
  - old key absent from the fill → `delete` (tombstone)

  Emit order mirrors `applyReplaceAll`: inserts/updates in `rows` order, deletes
  after in old-key (ascending PK) order. Events are queued **after** `batch.write()`
  (durable-then-publish). Because the coordinator is not in a transaction at that
  point, `queueEvent` emits immediately into the `StoreEventEmitter`; when the
  engine drives the fill mid-transaction (create-fill runs under
  `db._ensureTransaction()` — see `materialized-view-helpers.ts:486`), the emitter
  is batching, so the deltas flush as one grouped change-set at engine commit.

The `entries` map now also carries the deserialized `row` (`{ key, value, row }`)
so the event `newRow` is available without re-deserializing.

This realizes the settled decision: **sync changes fire only on actual deltas.**
N upgraded peers that each re-derive the same fill compute identical bytes
(replicable determinism), so second-and-later re-fills diff to zero deltas; only
the first author of a given cold row publishes it; LWW settles rare concurrent
first-fills.

### Docs / comments

- `backing-host.ts` module header § "Events: off by default, opt-in per table" —
  the old "create-fill / refresh stays event-free regardless … would storm" line
  is replaced with the minimal-keyed-diff description. The `replaceContents`
  docstring gained a "Replication seam" paragraph.
- `docs/migration.md` § "Synced vs. local derived tables" table row — now states
  create-fill / refresh publishes genuine deltas (value-identical re-fills suppress).
- `docs/migration.md` § "Current gaps" last bullet — the `sync-derivation-fill-publication`
  gap is removed / marked implemented (folded into the change-logging-opt-in note).
- `packages/quereus/src/schema/reserved-tags.ts` — **intentionally NOT edited.**
  Its only event-free assertion is "the memory host stays event-free", which is
  still true (the memory host is event-free on every path). It never claimed
  create-fill/refresh was event-free, so there was nothing to update there.

## Scope guardrails (verify these held)

- **Memory host untouched.** No edits under `packages/quereus/src/vtab/memory/**`
  or the engine `vtab/backing-host.ts` interface. The memory host stays event-free
  on every path. This was a `quereus-store`-only code change + doc edits.
- **Default path is byte-identical.** The entire diff/deserialize/emit is gated on
  `this.replicates`; a non-replicating backing keeps its streaming put-all batch.
- **Duplicate-key detection stays first**, before any write or event, in both
  paths — so a rejected fill leaves the committed contents untorn and (replicating)
  queues nothing.

## Test coverage added (the floor, not the ceiling)

In `packages/quereus-store/test/backing-host.spec.ts`:

New `replaceContents` cases inside the existing `quereus.sync.replicate`
change-log opt-in describe block (run against **both** registration flavors —
`IsolationModule(StoreModule)` and bare `StoreModule`):
- **fresh-fill on an empty backing** → one `insert` per row (the headline migration
  case: a cold derived row filled at deploy reaches old peers).
- **identical re-fill** → zero events (storm-suppression contract).
- **partial diff** → only changed/new/removed publish; identical paired rows nothing;
  asserts exact event order (update, insert, delete).
- **refresh to empty (`rows = []`)** → one `delete` per old row in PK order
  (inverse cold path), backing ends empty.
- **non-replicating backing** → zero events AND the storage swap still happened
  (default-path regression guard).
- **duplicate PK** → throws before any event, committed contents untorn.

New `backing-host quereus.sync.replicate replaceContents: DESC / NOCASE leading PK`
describe block:
- **collation-equal / byte-different fill row** (`'A'` vs stored `'a'` under a
  NOCASE+DESC PK) → resolves to a single `update` that re-keys the stored bytes,
  NOT insert+delete; byte-identical paired rows skip.
- **re-fill of exact committed bytes** → zero events.

All 622 store tests pass (20 match `replaceContents`). Full `yarn build` (exit 0,
includes store `tsc`) and `yarn test` across all workspaces green (6330 engine +
622 store + 260 sync + others; the lone `failing`-grep hit is the `failingKv`
fault-injection fixture, not a failure). No `.pre-existing-error.md` needed.

## Known gaps / suggested adversarial angles for the reviewer

- **Grouped-flush-at-engine-commit is not directly asserted by the new tests.**
  They call `host.replaceContents(...)` directly (no engine transaction wraps
  them), so the coordinator-not-in-txn → immediate-emit path is what's exercised;
  the `StoreEventEmitter.startBatch`/`flushBatch` grouping (which makes a real
  engine-driven create-fill surface as ONE change-set) is pre-existing machinery
  that these tests don't drive end-to-end. An integration test that runs
  `create materialized view … using store with tags ("quereus.sync.replicate" = true)`
  over a **pre-populated** source (so the create-fill emits inserts) and asserts a
  single grouped change-set at the engine commit would close this. Consider adding
  one at the engine layer, or confirm the existing maintenance-path grouping
  coverage is sufficient.
- **"Open coordinator transaction at entry" in replicate mode is only partially
  covered.** There is a non-emit test that `replaceContents` commits an open
  coordinator txn first, but no replicate-mode variant verifying that (a) a
  prior `applyMaintenance` row pending in that txn is part of the committed
  before-image the diff sees, and (b) the prior txn's queued events fire on that
  top-of-method commit separately from the fill's deltas (no double-counting).
  Worth adding.
- **Refresh caller at `materialized-view-helpers.ts:1387`** (the second
  `replaceContents` call site) was not separately traced; both call sites pass the
  same `onDuplicateKey` factory and run under the engine transaction, but a
  reviewer may want to confirm the refresh path's transaction posture matches the
  create-fill path's.
- **Large-fill memory:** the replicating path holds `oldByKey` (all old rows
  deserialized) in memory, identical to the already-shipped `applyReplaceAll` arm.
  Acceptable per the decision; non-replicating path keeps its streaming iterate.

## How to run

```
node --import ./packages/quereus-store/register.mjs node_modules/mocha/bin/mocha.js \
  "packages/quereus-store/test/backing-host.spec.ts" --reporter spec --grep "replaceContents"
# full package:
yarn workspace @quereus/store test
# regression sweep:
yarn build && yarn test
```
