/**
 * Change application logic.
 *
 * Handles the 3-phase change application pattern:
 *   1. resolveChange — CRDT conflict resolution (no writes)
 *   2. applyToStore callback — write data to store
 *   3. commitChangeMetadata — persist CRDT metadata
 */

import { compareHLC } from '../clock/hlc.js';
import { siteIdEquals, type SiteId } from '../clock/site.js';
import type { ColumnVersion } from '../metadata/column-version.js';
import type {
	ChangeSet,
	Change,
	ApplyResult,
	ApplyToStoreResult,
	DataChangeToApply,
	SchemaChangeToApply,
	SchemaMigration,
} from './protocol.js';
import type { SyncContext } from './sync-context.js';
import { persistHLCState, toError, throwIfApplyErrors } from './sync-context.js';

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

	// PHASE 1: Resolve all changes (no writes yet)
	for (const changeSet of changes) {
		ctx.hlcManager.receive(changeSet.hlc);

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

	// PHASE 2: Apply data and schema changes to the store via callback
	if (ctx.applyToStore && (dataChangesToApply.length > 0 || schemaChangesToApply.length > 0)) {
		let result: ApplyToStoreResult;
		try {
			result = await ctx.applyToStore(dataChangesToApply, schemaChangesToApply, { remote: true });
		} catch (error) {
			// Emit error state so UI can react. CRDT metadata is NOT committed,
			// allowing the same changes to be re-resolved on the next sync attempt.
			ctx.syncEvents.emitSyncStateChange({
				status: 'error',
				error: toError(error),
			});
			throw error;
		}

		// Per-change storage failures (the adapter collects rather than throws)
		// abort the apply identically to a whole-batch throw: no metadata is
		// committed, so the whole batch re-resolves and re-applies idempotently
		// on the next sync. See throwIfApplyErrors / docs/sync.md write-ordering.
		throwIfApplyErrors(ctx, result);
	}

	// PHASE 3: Commit CRDT metadata
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

	await persistHLCState(ctx);

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
 */
export async function commitChangeMetadata(
	ctx: SyncContext,
	resolvedChanges: ResolvedChange[],
): Promise<void> {
	if (resolvedChanges.length === 0) return;

	const batch = ctx.kv.batch();

	for (const resolved of resolvedChanges) {
		if (resolved.outcome !== 'applied') continue;
		const change = resolved.change;

		if (change.type === 'delete') {
			ctx.tombstones.setTombstoneBatch(batch, change.schema, change.table, change.pk, change.hlc);
			ctx.changeLog.recordDeletionBatch(batch, change.hlc, change.schema, change.table, change.pk);
		} else {
			// Delete old change log entry if exists
			if (resolved.oldColumnVersion) {
				ctx.changeLog.deleteEntryBatch(
					batch,
					resolved.oldColumnVersion.hlc,
					'column',
					change.schema,
					change.table,
					change.pk,
					change.column,
				);
			}

			ctx.columnVersions.setColumnVersionBatch(
				batch,
				change.schema,
				change.table,
				change.pk,
				change.column,
				{ hlc: change.hlc, value: change.value },
			);

			ctx.changeLog.recordColumnChangeBatch(
				batch,
				change.hlc,
				change.schema,
				change.table,
				change.pk,
				change.column,
			);
		}
	}

	await batch.write();

	// Handle column version deletions for delete operations (requires async iteration)
	for (const resolved of resolvedChanges) {
		if (resolved.outcome !== 'applied') continue;
		if (resolved.change.type === 'delete') {
			await ctx.columnVersions.deleteRowVersions(
				resolved.change.schema,
				resolved.change.table,
				resolved.change.pk,
			);
		}
	}
}
