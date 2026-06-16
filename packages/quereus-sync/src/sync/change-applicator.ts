/**
 * Change application logic.
 *
 * Handles the 3-phase change application pattern:
 *   1. resolveChange — CRDT conflict resolution (no writes)
 *   2. applyToStore callback — write data to store
 *   3. commitChangeMetadata — persist CRDT metadata
 */

import type { WriteBatch } from '@quereus/store';
import { compareHLC, maxHLC } from '../clock/hlc.js';
import { siteIdEquals, type SiteId } from '../clock/site.js';
import type { ColumnVersion } from '../metadata/column-version.js';
import type { Tombstone } from '../metadata/tombstones.js';
import type {
	ChangeSet,
	Change,
	ColumnChange,
	RowDeletion,
	ApplyResult,
	DataChangeToApply,
	SchemaChangeToApply,
	SchemaMigration,
} from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { admitGroup } from './admission.js';

/**
 * Result of resolving a single change (without writing metadata).
 * Separates resolution from commit for correct write order.
 */
export interface ResolvedChange {
	outcome: 'applied' | 'skipped' | 'conflict';
	change: Change;
	dataChange?: DataChangeToApply;
	/** For column changes: the old version to clean up in the change log. */
	oldColumnVersion?: ColumnVersion;
	/** For delete changes: the prior tombstone whose stale delete entry to clean up in the change log. */
	oldTombstone?: Tombstone;
}

/**
 * Apply change sets from a remote peer.
 *
 * Three-phase process:
 *   1. Resolve all changes (no writes)
 *   2. Apply data to store via callback
 *   3. Commit CRDT metadata
 */
export async function applyChanges(
	ctx: SyncContext,
	changes: ChangeSet[],
): Promise<ApplyResult> {
	let applied = 0;
	let skipped = 0;
	let conflicts = 0;

	const dataChangesToApply: DataChangeToApply[] = [];
	const schemaChangesToApply: SchemaChangeToApply[] = [];
	const appliedChanges: Array<{ change: Change; siteId: SiteId }> = [];
	const resolvedDataChanges: ResolvedChange[] = [];
	const pendingSchemaMigrations: Array<{
		migration: SchemaMigration;
		schemaVersion: number;
	}> = [];

	// PHASE 1: Resolve all changes (no writes yet). The clock watermark is merged
	// once after a successful admission (see admitGroup below), not per changeset —
	// resolution reads stored versions via compareHLC, never the live clock.
	for (const changeSet of changes) {
		// Process schema migrations first (DDL before DML)
		for (const migration of changeSet.schemaMigrations) {
			const schemaVersion = migration.schemaVersion ??
				(await ctx.schemaMigrations.getCurrentVersion(migration.schema, migration.table)) + 1;

			const existingMigration = await ctx.schemaMigrations.getMigration(
				migration.schema,
				migration.table,
				schemaVersion,
			);

			if (existingMigration) {
				if (compareHLC(migration.hlc, existingMigration.hlc) <= 0) {
					skipped++;
					continue;
				}
			}

			schemaChangesToApply.push({
				type: migration.type,
				schema: migration.schema,
				table: migration.table,
				ddl: migration.ddl,
			});
			pendingSchemaMigrations.push({ migration, schemaVersion });
			applied++;
		}

		// Resolve data changes
		for (const change of changeSet.changes) {
			const resolved = await resolveChange(ctx, change);
			if (resolved.outcome === 'applied') {
				applied++;
				appliedChanges.push({ change, siteId: changeSet.siteId });
				resolvedDataChanges.push(resolved);
				if (resolved.dataChange) {
					dataChangesToApply.push(resolved.dataChange);
				}
			} else if (resolved.outcome === 'skipped') {
				skipped++;
			} else if (resolved.outcome === 'conflict') {
				conflicts++;
			}
		}
	}

	// Admit the whole resolved batch as one all-or-nothing unit: data first (PHASE
	// 2), then CRDT metadata (PHASE 3), then the merged clock watermark — aborting
	// with no metadata committed on any data-apply failure. The batch is admitted
	// once (not per ChangeSet): the single per-peer lastSyncHLC watermark cannot
	// express a partial commit, so selective commit is intentionally not done.
	await admitGroup(ctx, {
		dataChanges: dataChangesToApply,
		schemaChanges: schemaChangesToApply,
		applyOptions: { remote: true },
		commitMetadata: async () => {
			await commitChangeMetadata(ctx, resolvedDataChanges);

			// Commit schema migration metadata
			for (const { migration, schemaVersion } of pendingSchemaMigrations) {
				await ctx.schemaMigrations.recordMigration(migration.schema, migration.table, {
					type: migration.type,
					ddl: migration.ddl,
					hlc: migration.hlc,
					schemaVersion,
				});
			}
		},
		// Merging the batch max once is equivalent to receiving each changeset's
		// HLC (receive is a monotonic max-merge); on a mid-batch abort the clock
		// does not advance and the batch re-resolves next sync.
		watermarkHLC: maxHLC(changes.map(cs => cs.hlc)),
	});

	// Emit remote change events
	if (appliedChanges.length > 0) {
		const changesBySite = new Map<string, Change[]>();
		for (const { change, siteId } of appliedChanges) {
			const siteKey = Array.from(siteId).join(',');
			const siteChanges = changesBySite.get(siteKey);
			if (siteChanges) {
				siteChanges.push(change);
			} else {
				changesBySite.set(siteKey, [change]);
			}
		}

		const appliedAt = ctx.hlcManager.now();
		for (const [siteKey, siteChanges] of changesBySite) {
			const siteIdBytes = new Uint8Array(siteKey.split(',').map(Number));
			ctx.syncEvents.emitRemoteChange({
				siteId: siteIdBytes,
				transactionId: crypto.randomUUID(),
				changes: siteChanges,
				appliedAt,
			});
		}
	}

	return {
		applied,
		skipped,
		conflicts,
		transactions: changes.length,
	};
}

/**
 * Resolve CRDT conflicts for a single change WITHOUT writing metadata.
 *
 * Phase 1 of the 3-phase apply pattern.
 */
export async function resolveChange(
	ctx: SyncContext,
	change: Change,
): Promise<ResolvedChange> {
	// Skip changes that originated from ourselves (echo prevention)
	if (siteIdEquals(change.hlc.siteId, ctx.getSiteId())) {
		return { outcome: 'skipped', change };
	}

	if (change.type === 'delete') {
		const existingTombstone = await ctx.tombstones.getTombstone(
			change.schema,
			change.table,
			change.pk,
		);

		if (existingTombstone && compareHLC(change.hlc, existingTombstone.hlc) <= 0) {
			return { outcome: 'skipped', change };
		}

		return {
			outcome: 'applied',
			change,
			oldTombstone: existingTombstone ?? undefined,
			dataChange: {
				type: 'delete',
				schema: change.schema,
				table: change.table,
				pk: change.pk,
			},
		};
	} else {
		// Column change: single getColumnVersion read, then decide via resolver or HLC
		const localVersion = await ctx.columnVersions.getColumnVersion(
			change.schema,
			change.table,
			change.pk,
			change.column,
		);

		if (localVersion) {
			const remoteWins = ctx.config.conflictResolver
				? ctx.config.conflictResolver({
					schema: change.schema,
					table: change.table,
					pk: change.pk,
					column: change.column,
					localValue: localVersion.value,
					localHlc: localVersion.hlc,
					remoteValue: change.value,
					remoteHlc: change.hlc,
				}) === 'remote'
				: compareHLC(change.hlc, localVersion.hlc) > 0;

			if (!remoteWins) {
				ctx.syncEvents.emitConflictResolved({
					schema: change.schema,
					table: change.table,
					pk: change.pk,
					column: change.column,
					localValue: localVersion.value,
					remoteValue: change.value,
					winner: 'local',
					winningHLC: localVersion.hlc,
				});
				return { outcome: 'conflict', change };
			}
		}

		// Remote wins or no local version — check tombstone blocking
		const isBlocked = await ctx.tombstones.isDeletedAndBlocking(
			change.schema,
			change.table,
			change.pk,
			change.hlc,
			ctx.config.allowResurrection,
		);

		if (isBlocked) {
			return { outcome: 'skipped', change };
		}

		if (localVersion) {
			ctx.syncEvents.emitConflictResolved({
				schema: change.schema,
				table: change.table,
				pk: change.pk,
				column: change.column,
				localValue: localVersion.value,
				remoteValue: change.value,
				winner: 'remote',
				winningHLC: change.hlc,
			});
		}

		return {
			outcome: 'applied',
			change,
			oldColumnVersion: localVersion ?? undefined,
			dataChange: {
				type: 'update',
				schema: change.schema,
				table: change.table,
				pk: change.pk,
				columns: { [change.column]: change.value },
			},
		};
	}
}

/**
 * Commit CRDT metadata for resolved changes.
 *
 * Phase 3 of the 3-phase apply pattern: called AFTER data is written to store.
 *
 * In-batch repeats of one key are collapsed to the max-HLC winner before any write.
 * Two versions of the same key can land in a single `applyChanges` batch (e.g.
 * concurrent deletes of the same pk relayed together), and Phase 1 resolved BOTH
 * against the same pre-batch prior version — neither saw the other. Writing both would
 * leave two change-log entries for one key, re-attributing the older entry to the later
 * HLC and breaking {@link SyncManagerImpl}'s `collectChangesSince` LOAD-BEARING
 * INVARIANT (survivor's log HLC == its current version's HLC). So only the winner's
 * metadata + change-log entry are written; losers are never written and the single
 * pre-batch prior entry is deleted once. Mirrors the local write-path dedup in
 * `recordDataEvent` / `recordColumnVersions`, keeping the delete and column paths
 * symmetric.
 */
export async function commitChangeMetadata(
	ctx: SyncContext,
	resolvedChanges: ResolvedChange[],
): Promise<void> {
	if (resolvedChanges.length === 0) return;

	// Collapse in-batch repeats per key, keeping the max-HLC change. Deletes key by
	// (schema, table, pk); columns by (schema, table, pk, column) — distinct change-log
	// entry types that never collide.
	const deleteWinners = new Map<string, ResolvedChange>();
	const columnWinners = new Map<string, ResolvedChange>();
	for (const resolved of resolvedChanges) {
		if (resolved.outcome !== 'applied') continue;
		const change = resolved.change;
		if (change.type === 'delete') {
			keepMaxHLC(deleteWinners, deleteKey(change), resolved);
		} else {
			keepMaxHLC(columnWinners, columnKey(change), resolved);
		}
	}

	const batch = ctx.kv.batch();
	for (const resolved of deleteWinners.values()) {
		const change = resolved.change;
		if (change.type !== 'delete') continue; // homogeneous map; narrows the union
		commitDeleteMetadata(ctx, batch, change, resolved.oldTombstone);
	}
	for (const resolved of columnWinners.values()) {
		const change = resolved.change;
		if (change.type !== 'column') continue; // homogeneous map; narrows the union
		commitColumnMetadata(ctx, batch, change, resolved.oldColumnVersion);
	}
	await batch.write();

	// Column-version cleanup for deletes requires async iteration — once per winning
	// delete (losers were never written, so there is nothing of theirs to clean).
	for (const resolved of deleteWinners.values()) {
		const change = resolved.change;
		if (change.type !== 'delete') continue;
		await ctx.columnVersions.deleteRowVersions(change.schema, change.table, change.pk);
	}
}

/** Stable per-pk key for collapsing repeated delete entries within one batch. */
function deleteKey(change: RowDeletion): string {
	return JSON.stringify([change.schema, change.table, change.pk]);
}

/** Stable per-(pk, column) key for collapsing repeated column entries within one batch. */
function columnKey(change: ColumnChange): string {
	return JSON.stringify([change.schema, change.table, change.pk, change.column]);
}

/** Keep the max-HLC resolved change per key, collapsing in-batch repeats to one winner. */
function keepMaxHLC(
	winners: Map<string, ResolvedChange>,
	key: string,
	resolved: ResolvedChange,
): void {
	const prev = winners.get(key);
	if (!prev || compareHLC(resolved.change.hlc, prev.change.hlc) > 0) {
		winners.set(key, resolved);
	}
}

/** Write a winning delete's tombstone + change-log entry, deleting any prior delete entry. */
function commitDeleteMetadata(
	ctx: SyncContext,
	batch: WriteBatch,
	change: RowDeletion,
	oldTombstone: Tombstone | undefined,
): void {
	// Dedupe: a newer tombstone overwrites the prior one, leaving its delete change-log
	// entry stale — remove it so at most one survives per pk (mirrors the column dedup
	// and the write path in recordDataEvent).
	if (oldTombstone) {
		ctx.changeLog.deleteEntryBatch(batch, oldTombstone.hlc, 'delete', change.schema, change.table, change.pk);
	}
	ctx.tombstones.setTombstoneBatch(batch, change.schema, change.table, change.pk, change.hlc);
	ctx.changeLog.recordDeletionBatch(batch, change.hlc, change.schema, change.table, change.pk);
}

/** Write a winning column's version + change-log entry, deleting any prior column entry. */
function commitColumnMetadata(
	ctx: SyncContext,
	batch: WriteBatch,
	change: ColumnChange,
	oldColumnVersion: ColumnVersion | undefined,
): void {
	// Delete the prior (pk, column) change-log entry if one exists.
	if (oldColumnVersion) {
		ctx.changeLog.deleteEntryBatch(batch, oldColumnVersion.hlc, 'column', change.schema, change.table, change.pk, change.column);
	}
	ctx.columnVersions.setColumnVersionBatch(
		batch,
		change.schema,
		change.table,
		change.pk,
		change.column,
		{ hlc: change.hlc, value: change.value },
	);
	ctx.changeLog.recordColumnChangeBatch(batch, change.hlc, change.schema, change.table, change.pk, change.column);
}
