/**
 * Shared context for sync operations.
 *
 * Extracted modules (snapshot-stream, change-applicator, snapshot) receive
 * this context instead of accessing SyncManagerImpl internals directly.
 */

import type { KVStore } from '@quereus/store';
import type { HLCManager, HLC } from '../clock/hlc.js';
import type { SiteId } from '../clock/site.js';
import type { ColumnVersionStore } from '../metadata/column-version.js';
import type { TombstoneStore } from '../metadata/tombstones.js';
import type { ChangeLogStore } from '../metadata/change-log.js';
import type { SchemaMigrationStore } from '../metadata/schema-migration.js';
import type { QuarantineStore } from '../metadata/quarantine.js';
import type { BasisLifecycleStore } from '../metadata/basis-lifecycle.js';
import type { SyncConfig, ApplyToStoreCallback, ApplyToStoreResult, UnknownTableDisposition } from './protocol.js';
import type { SyncEventEmitterImpl } from './events.js';
import { SYNC_KEY_PREFIX } from '../metadata/keys.js';

/**
 * Context shared across sync sub-modules.
 *
 * SyncManagerImpl implements this interface; extracted functions
 * accept it as their first parameter.
 */
export interface SyncContext {
	readonly kv: KVStore;
	readonly config: SyncConfig;
	readonly hlcManager: HLCManager;
	readonly columnVersions: ColumnVersionStore;
	readonly tombstones: TombstoneStore;
	readonly changeLog: ChangeLogStore;
	readonly schemaMigrations: SchemaMigrationStore;
	readonly quarantine: QuarantineStore;
	readonly basisLifecycle: BasisLifecycleStore;
	readonly syncEvents: SyncEventEmitterImpl;
	readonly applyToStore?: ApplyToStoreCallback;

	getSiteId(): SiteId;
	getCurrentHLC(): HLC;

	/**
	 * Whether `(schema, table)` is in the local basis. Backed by the
	 * `getTableSchema` oracle; when no oracle was provided detection is inert and
	 * this returns `true` for every table (the store adapter's defensive throw
	 * remains the fallback for genuinely-retired tables).
	 */
	isTableInBasis(schema: string, table: string): boolean;

	/**
	 * Record cumulative unknown-table disposition stats (surfaced via
	 * `SyncManager.getUnknownTableStats`). Telemetry-only; called once per
	 * diverted `(schema, table)` group after successful admission.
	 */
	recordUnknownTable(
		disposition: UnknownTableDisposition,
		schema: string,
		table: string,
		changeCount: number,
	): void;
}

/**
 * Persist HLC state to the KV store (standalone put).
 */
export async function persistHLCState(ctx: SyncContext): Promise<void> {
	const state = ctx.hlcManager.getState();
	const buffer = new Uint8Array(10);
	const view = new DataView(buffer.buffer);
	view.setBigUint64(0, state.wallTime, false);
	view.setUint16(8, state.counter, false);
	await ctx.kv.put(SYNC_KEY_PREFIX.HLC_STATE, buffer);
}

/**
 * Normalize an unknown caught value into an Error instance.
 */
export function toError(error: unknown): Error {
	return error instanceof Error ? error : new Error(String(error));
}

/**
 * Abort the apply if the store reported any per-change errors.
 *
 * The store adapter continues applying other tables when one fails, collecting
 * each failure in `result.errors` rather than throwing — so the maximal set of
 * resolvable rows reaches committed storage. The *consumer* must still treat
 * any non-empty `errors` exactly like the whole-batch throw path: emit an error
 * sync-state event and throw BEFORE committing any CRDT metadata, so the whole
 * batch re-resolves and re-applies idempotently on the next sync attempt.
 *
 * This upholds the write-ordering invariant (docs/sync.md § Transactional
 * Integrity): CRDT metadata must not be committed when the corresponding data
 * write did not land — for per-change failures, not just whole-batch throws.
 *
 * No-op when `result.errors` is empty.
 */
export function throwIfApplyErrors(ctx: SyncContext, result: ApplyToStoreResult): void {
	if (result.errors.length === 0) return;

	const detail = result.errors
		.map(({ change, error }) => `${change.schema}.${change.table} (${change.type}): ${error.message}`)
		.join('; ');
	const error = new Error(
		`apply-to-store failed for ${result.errors.length} change(s): ${detail}`,
		{ cause: result.errors[0].error },
	);

	ctx.syncEvents.emitSyncStateChange({ status: 'error', error });
	throw error;
}

/**
 * Write HLC state into an existing WriteBatch.
 */
export function persistHLCStateBatch(
	ctx: SyncContext,
	batch: import('@quereus/store').WriteBatch,
): void {
	const state = ctx.hlcManager.getState();
	const buffer = new Uint8Array(10);
	const view = new DataView(buffer.buffer);
	view.setBigUint64(0, state.wallTime, false);
	view.setUint16(8, state.counter, false);
	batch.put(SYNC_KEY_PREFIX.HLC_STATE, buffer);
}
