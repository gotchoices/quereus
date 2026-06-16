description: Make the store backing host's `replaceContents` (create-fill / full-rebuild refresh) publish ONLY genuine deltas against the committed contents when the backing opts into sync replication (`quereus.sync.replicate = true`), so cold derived rows reach never-upgrading old peers at deploy/refresh without storming the change log on a value-identical re-fill.
files:
  - packages/quereus-store/src/common/backing-host.ts            # replaceContents (the change); applyReplaceAll (the reference diff); replicates / toDataChangeEvent (reuse)
  - packages/quereus-store/test/backing-host.spec.ts             # replicate describe block: setup(replicate) / resolveHost / events / shape helpers
  - docs/migration.md                                            # § Synced vs. local derived tables (table row), § Current gaps (last bullet)
  - packages/quereus/src/schema/reserved-tags.ts                 # SYNC_REPLICATE_TAG doc comment ("create-fill/refresh stays event-free")
difficulty: medium
----

# Publish create-fill / refresh deltas on a replicate-opted-in store backing

## Background

The landed prereq (`sync-derivation-changelog-optin`) gave a store backing carrying
the reserved tag `quereus.sync.replicate = true` a change-log voice for its
**row-time maintenance** writes: `applyMaintenance` queues one local
`DataChangeEvent` per realized `BackingRowChange`, with value-identical-upsert
suppression closing the echo loop. It **deliberately left `replaceContents`
event-free** — the bulk create-fill / full-rebuild path — because that path
published nothing and so could not storm, but also because it had no
delta/suppression story.

The consequence (the gap this ticket closes): a derived row whose source is filled
at deploy and then **never edited again** is never published, so a
never-upgrading old peer (which stores the new basis table opaquely) never
receives it. Active data self-heals via row-time maintenance; **cold/static rows
do not**.

## Decision (settled — do not re-open)

**Publish, but only genuine deltas.** `replaceContents` on a replicate-opted-in
backing diffs the incoming `rows` against the **committed** contents and queues a
`DataChangeEvent` for each real insert / update / delete — and **nothing** for a
key whose value is byte-faithful-identical. This restores suppression for the bulk
path: N upgraded peers that each independently re-derive the same fill compute
identical bytes (replicable determinism), so the second-and-later re-fills diff to
**zero deltas and emit zero events**. Only the first peer to author a given cold
row publishes it; LWW settles the rare concurrent first-fills harmlessly. The
general principle this realizes: *sync changes fire only on actual deltas.*

This is the store host's decision only. The **memory host stays event-free** on
every path (reserved-tags.ts: "behaviorally store-only … the memory host stays
event-free") — do not touch `packages/quereus/src/vtab/memory/**` or the engine
`vtab/backing-host.ts` interface; this is purely a `quereus-store` change plus doc
edits.

## How it works — the seam already exists

`applyReplaceAll` (same file, the `replace-all` maintenance arm) is the exact
reference: it snapshots the old contents into an `oldByKey` map, walks the new
`rows`, and emits `insert` / `update(if !rowsValueIdentical)` / `delete` against
that snapshot. `replaceContents` must do the **same diff**, with three differences
that follow from its DDL-commit nature:

1. **Before-image source.** `replaceContents` commits any open coordinator
   transaction FIRST, then writes a direct `store.batch()` (not coordinator ops).
   After that top-of-method commit, `store.iterate(buildFullScanBounds())` yields
   exactly the **committed** contents — which is the before-image the diff must
   compare against. (No `iterateEffectiveEntries` here: there is no pending state
   to merge once the coordinator is committed.)

2. **Emission seam.** Reuse the existing `this.replicates` getter and
   `this.toDataChangeEvent(schema, change)` mapper, then `this.coordinator.queueEvent(event)`
   per delta. Because the coordinator is **not in a transaction** at that point
   (committed at the top, or never began), `queueEvent` emits **immediately** to
   the `StoreEventEmitter`. When the engine is mid-transaction (create-fill runs
   under `db._ensureTransaction()`; refresh likewise), the store emitter is
   batching, so these immediate emits land in its batch and flush as **one grouped
   change-set at the engine commit** — the same place `applyMaintenance`'s events
   end up. Queue events **after** `batch.write()` succeeds (durable-then-publish).

3. **Default path must stay byte-identical.** Gate the entire diff/deserialize/emit
   on `this.replicates`. A non-replicating backing must keep the current behavior
   exactly: iterate committed contents, `batch.delete` every key not in `entries`,
   `batch.put` all `entries`, `resetStats`. No old-value deserialization, no delta
   list — zero added cost for the overwhelmingly common local-derivation case.

The duplicate-key detection (build `entries`, throw `onDuplicateKey()` on a
collision) stays **first, before any write or event**, in both paths — preserving
the "untorn committed contents on duplicate" guarantee, now also "no events on a
rejected fill."

Recommended replicating-path shape (mirror `applyReplaceAll`'s emit order so the
test ordering is stable — inserts/updates in `rows` order, deletes after in
old-key order):

```
// after committing any open coordinator txn and building `entries` (dup-checked):
const store = await this.table.openDataStore();
if (!this.replicates) { /* unchanged direct-batch path */ return after resetStats; }

// replicating: snapshot committed before-image, diff, emit
const oldByKey = new Map<string, { key: Uint8Array; row: Row }>();
for await (const e of store.iterate(buildFullScanBounds()))
  oldByKey.set(bytesToHex(e.key), { key: e.key, row: deserializeRow(e.value) });

const batch = store.batch();
const deltas: BackingRowChange[] = [];
for (const { key, value, row } of entries.values()) {       // rows order
  const existing = oldByKey.get(bytesToHex(key));
  if (!existing) { batch.put(key, value); deltas.push({ op: 'insert', newRow: row }); }
  else if (!rowsValueIdentical(existing.row, row)) { batch.put(key, value); deltas.push({ op: 'update', oldRow: existing.row, newRow: row }); }
  // else: byte-identical → no put needed, no delta (suppression)
}
for (const { key, row } of oldByKey.values())                // old-key order
  if (!entries.has(bytesToHex(key))) { batch.delete(key); deltas.push({ op: 'delete', oldRow: row }); }
await batch.write();
const schema = this.table.getSchema();
for (const d of deltas) this.coordinator.queueEvent(this.toDataChangeEvent(schema, d));
await this.table.resetStats(rows.length);
```

Note `entries` must now also carry the deserialized `row` (for the event's
`newRow`), not just `{key, value}`. Skipping the `put` for a byte-identical key is
a storage-write reduction that matches `applyReplaceAll` and is non-observable
(the bytes already present are identical); the non-replicating path keeps its
existing put-all behavior untouched.

## Edge cases & interactions

- **Fresh fill on empty backing (the headline migration case)** — every row is an
  `insert`; all cold rows publish at deploy so a never-upgrading old peer receives
  them. Expected: one event per row, all `insert`.
- **Re-fill identical to committed (refresh of unchanged data)** — zero deltas,
  zero events. This is the storm-suppression contract; assert `events` is empty.
- **Partial change** — a mix of identical / changed / new / removed rows publishes
  exactly the changed/new/removed; identical paired rows publish nothing.
- **Refresh to empty (`rows = []`) over populated contents** — every old row
  becomes a `delete` (tombstones publish). Confirms the inverse cold path.
- **Non-replicating backing (regression guard)** — zero events AND the storage
  writes are byte-for-byte the prior `replaceContents` (existing
  `replaceContents` tests must still pass unchanged).
- **Duplicate PK among `rows`** — `onDuplicateKey()` throws before any
  `batch.write()` / `queueEvent`; committed contents untorn, zero events. Assert in
  replicating mode too.
- **NOCASE / DESC leading PK (collation key identity)** — keys compare by ENCODED
  data-key bytes (folds per-column key collation), exactly as `applyReplaceAll`: a
  case-only key match with byte-different value resolves to an `update` that
  re-keys the stored bytes, NOT an insert+delete. Reuse the existing DESC/NOCASE
  describe block's setup to cover this.
- **Open coordinator transaction at entry** — committed first (DDL-commit posture,
  unchanged). Any events queued by a prior `applyMaintenance` in that txn fire on
  that commit; the fill's deltas are then emitted separately. Verify no
  double-counting and that a prior-pending row is part of the committed
  before-image the diff sees.
- **Change-set grouping (cross-subsystem)** — verify a synced create-fill /
  refresh surfaces its deltas as a single grouped transaction at the engine
  commit (store emitter batch → flush), not N ungrouped emits. If the existing
  replicate spec's harness commits the engine transaction around the fill, the
  collected `events` already reflect the grouped flush; assert count + shapes.
- **Large fill memory** — the replicating path holds `oldByKey` (all old rows
  deserialized) in memory for the diff, same as `applyReplaceAll`. Acceptable and
  identical to the already-shipped maintenance arm; non-replicating path keeps its
  streaming iterate (no map).

## Docs to update (same ticket)

- `packages/quereus-store/src/common/backing-host.ts` module header § "Events:
  off by default, opt-in per table": the line "Create-fill / refresh
  (`replaceContents`) stays event-free regardless — it has no suppression, so
  publishing it would storm the change log." is now false. Replace with: a
  replicate-opted-in `replaceContents` publishes the **minimal keyed diff against
  the committed contents**, so a value-identical re-fill emits nothing (the same
  suppression the point-op and `replace-all` arms have); a non-replicating backing
  stays event-free and byte-identical.
- `docs/migration.md` § "Synced vs. local derived tables" table — the
  "maintenance writes recorded in the sync change log" row currently ends
  "create-fill/refresh stays event-free." Update to state create-fill/refresh now
  publishes genuine deltas against committed contents (value-identical re-fills
  suppress).
- `docs/migration.md` § "Current gaps" last bullet — remove "Create-fill /
  full-rebuild publication remains a gap — tracked as
  `sync-derivation-fill-publication`." (mark implemented, like the sibling
  change-logging opt-in note above it).
- `packages/quereus/src/schema/reserved-tags.ts` — the `SYNC_REPLICATE_TAG` doc
  block / the `reserved-tags` table comment if either asserts "create-fill/refresh
  stays event-free"; update to match.

## TODO

- [ ] Carry the deserialized `row` in the `entries` map so the event `newRow` is available.
- [ ] Bifurcate `replaceContents`: keep the current streaming direct-batch path verbatim for the non-replicating case; add the committed-contents diff + `queueEvent` path for the replicating case (after `batch.write()`, before/after `resetStats`).
- [ ] Reuse `this.replicates`, `this.toDataChangeEvent`, `rowsValueIdentical`, `buildFullScanBounds`, `bytesToHex`, `deserializeRow` — no new imports beyond what the file already pulls.
- [ ] Add store specs in `backing-host.spec.ts` replicate block: fresh-fill→all inserts; identical re-fill→zero events; partial diff; refresh-to-empty→all deletes; non-replicating→zero events + storage unchanged; duplicate-key→throws, zero events, untorn; NOCASE/DESC key collation case-only rewrite→update.
- [ ] Update the four doc/comment sites above.
- [ ] `yarn workspace @quereus/quereus-store test 2>&1 | tee /tmp/store-test.log; tail -n 60 /tmp/store-test.log` (the spec lives here); then `yarn build` and `yarn test` for the engine to confirm no regression in the create-fill/refresh callers. Stream output (`tee`), never silent-redirect.
- [ ] If lint touched: `yarn workspace @quereus/quereus lint` only if engine files changed; the store package has no lint script (AGENTS.md).
