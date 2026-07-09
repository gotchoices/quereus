description: The older whole-database snapshot API can bring deleted rows back to life, because it throws away deletion records and never sends them to the replica being rebuilt. Fix: carry deletion records (tombstones) in the snapshot and restore them on apply, mirroring the streaming path that was already fixed.
files:
  - packages/quereus-sync/src/sync/protocol.ts        # add SnapshotTombstone type + Snapshot.tombstones field
  - packages/quereus-sync/src/sync/snapshot.ts         # getSnapshot collects tombstones; applySnapshot restores them
  - packages/quereus-sync/src/sync/snapshot-stream.ts  # reference model (global tombstone pass, setTombstoneBatch consumer)
  - packages/quereus-sync/src/metadata/tombstones.ts   # setTombstoneBatch / deserializeTombstone / Tombstone
  - packages/quereus-sync/src/metadata/keys.ts         # buildAllTombstonesScanBounds / parseTombstoneKey
  - packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts  # add non-streaming describe block mirroring the streaming one
difficulty: medium
----

## Problem

Quereus-sync bootstraps a fresh replica two ways. The **streaming** path
(`getSnapshotStream` / `applySnapshotStream`) was fixed to carry **tombstones**
(records of the form "row R was deleted at HLC h", which suppress a later-arriving
*older* write for R so a deleted row is not resurrected). The older **non-streaming**
path (`getSnapshot` → in-memory `Snapshot` → `applySnapshot`) was **not** fixed and
has the identical defect:

- `getSnapshot` (`snapshot.ts:36-112`) collects only column-versions + schema
  migrations. `Snapshot` / `TableSnapshot` (`protocol.ts:175-191`) have **no
  tombstone field**, so tombstones cannot travel.
- `applySnapshot`'s `commitMetadata` (`snapshot.ts:194-196`) **deletes** the
  receiver's existing tombstones during its metadata clear and never restores any.

Net: after `applySnapshot` bootstrap the receiver has no record R was deleted. A
straggler older write for R is applied as if R were merely absent → **R resurrects,
replicas permanently disagree**. `getSnapshot`/`applySnapshot` are a public,
README-documented API (`packages/quereus-sync/README.md:109-110`) — reachable, not
dormant.

## Fix design (mirror the streaming path)

The streaming producer at `snapshot-stream.ts:201-246` and consumer at
`snapshot-stream.ts:510-528` are the reference. Key constraint they solve, which
this fix must also solve: a **fully-deleted row** (all columns deleted) has a
tombstone but **no live column-versions**, so its `(schema, table)` may be absent
from any column-version-derived table set. The streaming fix uses a **GLOBAL**
tombstone pass (`buildAllTombstonesScanBounds()`) for exactly this reason —
**do the same here**; do NOT key tombstone collection off `TableSnapshot`
entries.

### Interface change — `protocol.ts`

Add a global tombstone collection to `Snapshot` (a flat, table-independent array
so tombstone-only tables travel). New type + field:

```ts
/**
 * A tombstone (deletion record) carried in a non-streaming snapshot. A GLOBAL
 * collection on `Snapshot` (not nested under `TableSnapshot`) so a fully-deleted
 * row — a tombstone with no live column-versions, hence no `TableSnapshot` — still
 * travels. Mirrors the streaming `SnapshotTombstoneChunk` entry shape.
 */
export interface SnapshotTombstone {
  readonly schema: string;
  readonly table: string;
  readonly pk: SqlValue[];
  readonly hlc: HLC;
  readonly createdAt: number;
  /** Last-known row image before deletion; absent on snapshot-reconstructed tombstones. */
  readonly priorRow?: Row;
}
```

Add to `Snapshot`:

```ts
export interface Snapshot {
  readonly siteId: SiteId;
  readonly hlc: HLC;
  readonly tables: TableSnapshot[];
  readonly schemaMigrations: SchemaMigration[];
  readonly tombstones: SnapshotTombstone[];   // NEW
}
```

`Row` is already imported in `protocol.ts`. Every `Snapshot` literal in the tree
must set `tombstones` — only `getSnapshot` builds one (below); grep for other
constructors and add `tombstones: []` where a snapshot is synthesized in tests /
fixtures if the compiler flags them.

### Producer — `getSnapshot` (`snapshot.ts`)

After the schema-migrations loop, add a global tombstone pass before the return.
Needs new imports: `parseTombstoneKey` (from `../metadata/keys.js`) and
`deserializeTombstone` (from `../metadata/tombstones.js`). `buildAllTombstonesScanBounds`
is already imported.

```ts
const tombstones: SnapshotTombstone[] = [];
for await (const entry of ctx.kv.iterate(buildAllTombstonesScanBounds())) {
  const parsed = parseTombstoneKey(entry.key);
  if (!parsed) continue;
  const ts = deserializeTombstone(entry.value);
  tombstones.push({
    schema: parsed.schema,
    table: parsed.table,
    pk: parsed.pk,
    hlc: ts.hlc,
    createdAt: ts.createdAt,
    ...(ts.priorRow !== undefined ? { priorRow: ts.priorRow } : {}),
  });
}
// ...return { siteId, hlc, tables, schemaMigrations, tombstones };
```

### Consumer — `applySnapshot` (`snapshot.ts`)

Inside `commitMetadata`, the `clearBatch` already deletes existing tombstones
(lines 194-196) — leave that. In the `applyBatch` section (after the
column-version / change-log rewrites, alongside the schema-migration replay),
re-write the snapshot's tombstones:

```ts
for (const ts of snapshot.tombstones) {
  ctx.tombstones.setTombstoneBatch(applyBatch, ts.schema, ts.table, ts.pk, ts.hlc, ts.priorRow);
}
```

Match the streaming consumer's caveat (`snapshot-stream.ts:517-520`):
`setTombstoneBatch` stamps `createdAt = Date.now()` internally and ignores the
sender's `createdAt`, so the bootstrapped tombstone's TTL horizon re-bases to
bootstrap time. That is the accepted phase-1 behavior — do not try to preserve
the original `createdAt`; just carry it in the wire type for parity (the
streaming chunk carries it too).

### Cleanup

Remove/adjust the now-stale `NOTE:` in `applySnapshot` (`snapshot.ts:125-128`)
that says this path still omits tombstones and points at this ticket slug — the
defect is fixed once this lands.

## Test — mirror the streaming spec

Add a new `describe` block to
`packages/quereus-sync/test/sync/snapshot-tombstones-and-drift.spec.ts` (the file
whose header already documents the tombstone-survival property). Mirror the
existing streaming test `'a deleted row stays deleted after snapshot bootstrap;
a stale older write is tombstone-blocked'` (lines 33-86) but through the
**non-streaming** API:

- Sender: `insert` R then `delete` R (fully-deleted-row case — tombstone, no live
  column-versions).
- `const snap = await sender.manager.getSnapshot();`
- Assert `snap.tombstones.length > 0` (the global pass carried it — this is the
  fully-deleted-row assertion that would fail with a per-table collection).
- `await receiver.manager.applySnapshot(snap);`
- Assert `receiver.manager.tombstones.getTombstone('main','orders',['r1'])` is
  defined after bootstrap.
- Deliver a stale foreign-site write for R with HLC strictly older than the
  tombstone's `hlc` via `receiver.manager.applyChanges([cs])` (copy the ChangeSet
  construction from the streaming test).
- Assert R does NOT resurrect (`select count(*) ... where id='r1'` → 0) and the
  tombstone is still present.

The receiver bootstraps fresh (no pre-created `orders`), so the snapshot's own
`create_table` migration installs the table — same fresh-replica flow the
streaming test uses. `makePeer` / `localWrite` / `collect` come from
`./_peer-harness.js`.

## TODO

- [ ] `protocol.ts`: add `SnapshotTombstone` interface; add `tombstones: SnapshotTombstone[]` to `Snapshot`.
- [ ] Fix any other `Snapshot` literals the compiler flags (add `tombstones: []`).
- [ ] `snapshot.ts` `getSnapshot`: add imports (`parseTombstoneKey`, `deserializeTombstone`); add global tombstone pass; include `tombstones` in the returned object.
- [ ] `snapshot.ts` `applySnapshot` `commitMetadata`: re-write `snapshot.tombstones` into `applyBatch` via `ctx.tombstones.setTombstoneBatch`.
- [ ] `snapshot.ts`: remove the stale `NOTE:` referencing this ticket at lines ~125-128.
- [ ] Add the non-streaming describe block to `snapshot-tombstones-and-drift.spec.ts`.
- [ ] `yarn workspace @quereus/quereus-sync test` (or `yarn test` from root) — green, incl. new + existing streaming tests.
- [ ] `yarn lint` — clean (no `any`, unused imports, etc.).
