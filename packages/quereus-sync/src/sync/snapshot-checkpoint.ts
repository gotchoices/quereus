/**
 * Saved positions of interrupted streaming snapshot applies.
 *
 * A record exists from the moment an apply clears local metadata until its footer
 * finishes, so "a checkpoint exists" also answers "is this replica's data partial?".
 */

import { bytesEqual } from '@quereus/store';
import { buildAllSnapshotCheckpointScanBounds, buildSnapshotCheckpointKey } from '../metadata/keys.js';
import type { SnapshotCheckpoint } from './manager.js';
import type { SyncContext } from './sync-context.js';

// NOTE: the AT-REST encoding below (wallTime as a decimal string, siteId as a
// number array) is deliberately NOT the wire encoding. The wire form is
// `SerializedSnapshotCheckpoint` in `wire.ts` (both binary fields as base64),
// used by the `resume_snapshot` message. Two encodings for one type is a wart,
// but unifying them is a stored-format migration: existing `sc:` records would
// have to be read under both shapes. If checkpoint storage is ever reworked for
// another reason, fold it onto the wire codec then.

/** Decode one checkpoint record's at-rest bytes. */
function decodeCheckpoint(bytes: Uint8Array): SnapshotCheckpoint {
	const obj = JSON.parse(new TextDecoder().decode(bytes));

	return {
		...obj,
		hlc: {
			wallTime: BigInt(obj.hlc.wallTime),
			counter: obj.hlc.counter,
			siteId: new Uint8Array(obj.hlc.siteId),
			opSeq: obj.hlc.opSeq ?? 0,
		},
		siteId: new Uint8Array(obj.siteId),
	};
}

/**
 * Retrieve a saved checkpoint for an in-progress snapshot.
 */
export async function getSnapshotCheckpoint(
	ctx: SyncContext,
	snapshotId: string,
): Promise<SnapshotCheckpoint | undefined> {
	const data = await ctx.kv.get(buildSnapshotCheckpointKey(snapshotId));
	if (!data) return undefined;
	return decodeCheckpoint(data);
}

/**
 * List every saved snapshot checkpoint — the discovery path for a caller that
 * has forgotten (or never held) the `snapshotId` of an interrupted transfer.
 * See {@link import('./manager.js').SyncManager.listSnapshotCheckpoints}.
 */
export async function listSnapshotCheckpoints(ctx: SyncContext): Promise<SnapshotCheckpoint[]> {
	const checkpoints: SnapshotCheckpoint[] = [];
	for await (const entry of ctx.kv.iterate(buildAllSnapshotCheckpointScanBounds())) {
		checkpoints.push(decodeCheckpoint(entry.value));
	}
	return checkpoints;
}

/**
 * Save a checkpoint during a streaming snapshot apply.
 */
export async function saveSnapshotCheckpoint(
	ctx: SyncContext,
	checkpoint: SnapshotCheckpoint,
): Promise<void> {
	const json = JSON.stringify({
		...checkpoint,
		hlc: {
			wallTime: checkpoint.hlc.wallTime.toString(),
			counter: checkpoint.hlc.counter,
			siteId: Array.from(checkpoint.hlc.siteId),
			opSeq: checkpoint.hlc.opSeq,
		},
		siteId: Array.from(checkpoint.siteId),
	});
	await ctx.kv.put(buildSnapshotCheckpointKey(checkpoint.snapshotId), new TextEncoder().encode(json));
}

/**
 * Delete every saved checkpoint EXCEPT `keepSnapshotId`'s.
 *
 * Called once per apply, right after `clearExistingMetadata`: at that instant
 * every other transfer's resume position became unusable (see the call site).
 * At most one checkpoint therefore exists at a time, so `listSnapshotCheckpoints`
 * cannot accumulate records and cannot report a complete replica as partial.
 */
export async function clearOtherSnapshotCheckpoints(
	ctx: SyncContext,
	keepSnapshotId: string,
): Promise<void> {
	const keep = buildSnapshotCheckpointKey(keepSnapshotId);
	const clearBatch = ctx.kv.batch();
	let staleCount = 0;

	for await (const entry of ctx.kv.iterate(buildAllSnapshotCheckpointScanBounds())) {
		if (bytesEqual(entry.key, keep)) continue;
		clearBatch.delete(entry.key);
		staleCount++;
	}

	if (staleCount > 0) await clearBatch.write();
}

/**
 * Clear a checkpoint — after its snapshot completes successfully, or when a
 * caller abandons a transfer it will not resume.
 */
export async function clearSnapshotCheckpoint(
	ctx: SyncContext,
	snapshotId: string,
): Promise<void> {
	await ctx.kv.delete(buildSnapshotCheckpointKey(snapshotId));
}
