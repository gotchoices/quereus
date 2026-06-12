description: Resumed streaming-snapshot apply wipes completed-table CRDT metadata. Make the up-front metadata clear in applySnapshotStream resume-aware — preserve tables listed as completed in the persisted checkpoint instead of blanket-clearing everything.
files:
  - packages/quereus-sync/src/sync/snapshot-stream.ts        # applySnapshotStream up-front clear; getSnapshotCheckpoint
  - packages/quereus-sync/src/metadata/keys.ts               # parseTombstoneKey / parseChangeLogKey (already exist)
  - packages/quereus-sync/test/sync/store-adapter-seam.spec.ts  # add resume-preservation test alongside existing stream tests
difficulty: medium
----

# Resumed snapshot stream wipes completed-table metadata

## Problem (confirmed)

`applySnapshotStream` (`snapshot-stream.ts`) clears **all** CRDT metadata
(column-versions, tombstones, change-log) in one batch at the very top of every
apply, before processing any chunk:

```ts
// Clear existing metadata before applying
const clearBatch = ctx.kv.batch();
for await (const entry of ctx.kv.iterate(buildAllColumnVersionsScanBounds())) { clearBatch.delete(entry.key); }
for await (const entry of ctx.kv.iterate(buildAllTombstonesScanBounds()))    { clearBatch.delete(entry.key); }
for await (const entry of ctx.kv.iterate(buildAllChangeLogScanBounds()))     { clearBatch.delete(entry.key); }
await clearBatch.write();
```

The sender, on resume, **skips** already-completed tables
(`resumeSnapshotStream` → `streamSnapshotChunks` with
`completedTables = new Set(checkpoint.completedTables)`) and never re-emits
their `table-start` / `column-versions` / `table-end` chunks. So a resumed apply
clears the completed tables' metadata and never rewrites it → completed tables
look empty to subsequent delta sync (`getChangesSince`), even though their row
data may still be in the store. CRDT-state loss / metadata-data divergence.

Reproduced: seed a `cv:` column version for `main.tableA`, persist a checkpoint
listing `main.tableA` completed, then drive `applySnapshotStream` with a resumed
stream that omits tableA (header + tableB + footer). Before the fix, tableA's
column version is gone (`getColumnVersion` returns `undefined`); after, it
survives and tableB is applied.

## Chosen fix (validated locally — all 184 quereus-sync tests pass with it)

Make the up-front clear **resume-aware** by consulting the persisted checkpoint.
The receiver already saves a checkpoint under `sc:{snapshotId}` during apply
(`saveSnapshotCheckpoint`) and only deletes it on a successful `footer`
(`clearSnapshotCheckpoint`). On resume that checkpoint is still present and lists
exactly the tables the sender will skip — so look it up by the `snapshotId` from
the header chunk and preserve those tables through the clear.

This was preferred over the alternatives in the fix ticket because it keeps
full-replacement semantics for non-resumed applies (local-only tables absent
from the snapshot are still cleared) and needs no public API change
(`applySnapshotStream(chunks, onProgress)` is unchanged — the coordinator
service / websocket wiring is untouched). Per-table lazy clearing was rejected
because the change-log is HLC-keyed (not table-prefixed), so clearing it
per-`table-start` would require a full change-log scan per table (quadratic);
the single filtered up-front pass below is O(metadata) like today.

### 1. New helper `clearExistingMetadata(ctx, preserveTables)`

Replaces the inline blanket clear. Filters each scan by parsed `schema.table`;
with an empty `preserveTables` it deletes everything (identical to today's
fresh-apply behaviour). Place it just above `applySnapshotStream`:

```ts
async function clearExistingMetadata(
	ctx: SyncContext,
	preserveTables: ReadonlySet<string>,
): Promise<void> {
	const clearBatch = ctx.kv.batch();

	for await (const entry of ctx.kv.iterate(buildAllColumnVersionsScanBounds())) {
		const parsed = parseColumnVersionKey(entry.key);
		if (parsed && preserveTables.has(`${parsed.schema}.${parsed.table}`)) continue;
		clearBatch.delete(entry.key);
	}
	for await (const entry of ctx.kv.iterate(buildAllTombstonesScanBounds())) {
		const parsed = parseTombstoneKey(entry.key);
		if (parsed && preserveTables.has(`${parsed.schema}.${parsed.table}`)) continue;
		clearBatch.delete(entry.key);
	}
	for await (const entry of ctx.kv.iterate(buildAllChangeLogScanBounds())) {
		const parsed = parseChangeLogKey(entry.key);
		if (parsed && preserveTables.has(`${parsed.schema}.${parsed.table}`)) continue;
		clearBatch.delete(entry.key);
	}

	await clearBatch.write();
}
```

`parseTombstoneKey` and `parseChangeLogKey` already exist in
`metadata/keys.ts` — add them to the existing import block in
`snapshot-stream.ts` (next to `parseColumnVersionKey` / `parseSchemaMigrationKey`).

### 2. Drive the clear from the `header` chunk, not before the loop

Remove the inline clear block (the `// Clear existing metadata before applying`
section) from before the chunk loop. Move it into `case 'header'` so the
`snapshotId` is known; seed the local resume counters from the checkpoint so
mid-stream checkpoint saves stay monotonic (don't drop tables A,B when only C is
re-streamed) and progress reporting against the header's full `tableCount` is
accurate. Convert the case to a block (it now declares a `const`):

```ts
case 'header': {
	snapshotId = chunk.snapshotId;
	snapshotHLC = chunk.hlc;
	totalTables = chunk.tableCount;

	// On a resumed transfer the sender skips tables it already streamed and
	// never re-emits their metadata. Look up the persisted checkpoint (saved
	// under this snapshotId during the prior pass) and preserve those completed
	// tables through the up-front clear; otherwise their column-version /
	// change-log state would be wiped and never rewritten.
	const checkpoint = snapshotId ? await getSnapshotCheckpoint(ctx, snapshotId) : undefined;
	if (checkpoint) {
		completedTables.push(...checkpoint.completedTables);
		tablesProcessed = checkpoint.completedTables.length;
		entriesProcessed = checkpoint.entriesProcessed;
	}
	await clearExistingMetadata(ctx, new Set(completedTables));
	break;
}
```

`getSnapshotCheckpoint` is a hoisted function declaration in the same file, so
calling it before its definition is fine.

## Invariants to keep

- **`sync-apply-per-change-errors-ignored` invariant**: an apply failure must
  still abort before the footer emits `status: 'synced'` and must retain the
  checkpoint. This change touches only the clear path (header) — the footer /
  `flushDataToStore` / `throwIfApplyErrors` path is unchanged. The existing
  `store-adapter-seam.spec.ts` test "applySnapshotStream: an unresolvable table
  throws and never emits status synced" must still pass (it sends a fresh
  snapshotId with no prior checkpoint → preserve set empty → clears all → same
  behaviour as today).
- **Fresh full apply** still replaces all local state: no checkpoint → empty
  preserve set → blanket clear, exactly as before.

## TODO

- [ ] Add `parseTombstoneKey`, `parseChangeLogKey` to the keys import in
      `snapshot-stream.ts`.
- [ ] Add the `clearExistingMetadata(ctx, preserveTables)` helper above
      `applySnapshotStream`.
- [ ] Remove the inline up-front clear block; move the clear into `case 'header'`
      with checkpoint lookup + counter seeding as shown.
- [ ] Add a regression test (alongside the snapshot-stream tests in
      `packages/quereus-sync/test/sync/store-adapter-seam.spec.ts`, or
      `sync-manager.spec.ts`): seed a `cv:` column version for `main.tableA`,
      persist a checkpoint (key `sc:{snapshotId}`, value mirroring
      `saveSnapshotCheckpoint`'s serialization — `hlc.wallTime` as string,
      `siteId`/`hlc.siteId` as number arrays, `completedTables: ['main.tableA']`)
      via `kv.put`, then `applySnapshotStream` a resumed stream that omits tableA
      and sends only tableB. Assert tableA's column version survives **and**
      tableB's is applied. (This is exactly the validated repro.)
- [ ] Optionally also assert the survival via the public surface
      (`getChangesSince` relays tableA's change) for the metadata/data-divergence
      angle.
- [ ] `yarn build` then `yarn test` (full workspace) green. Lint
      `packages/quereus` is unaffected, but run it if convenient.
