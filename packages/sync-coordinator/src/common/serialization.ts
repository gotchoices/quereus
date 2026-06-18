/**
 * Shared serialization for JSON transport.
 *
 * Used by both the WebSocket handler and the HTTP routes
 * for consistent wire format.
 *
 * Uint8Array values (blobs) are encoded as `{ __bin: "<base64>" }` so they
 * survive JSON round-trips. See encodeSqlValue / decodeSqlValue in @quereus/sync.
 */

import {
	siteIdFromBase64,
	siteIdToBase64,
	deserializeHLC,
	serializeHLC,
	encodeSqlValue,
	decodeSqlValue,
	type ChangeSet,
	type ColumnChange,
	type RowDeletion,
	type SnapshotChunk,
} from '@quereus/sync';

/**
 * Serialize a ChangeSet for JSON transport.
 * Converts binary fields (siteId, HLCs) and SqlValue blobs to base64 strings.
 */
export function serializeChangeSet(cs: ChangeSet): object {
	return {
		siteId: siteIdToBase64(cs.siteId),
		transactionId: cs.transactionId,
		hlc: Buffer.from(serializeHLC(cs.hlc)).toString('base64'),
		changes: cs.changes.map(c => {
			const base = {
				type: c.type,
				schema: c.schema,
				table: c.table,
				pk: c.pk.map(v => encodeSqlValue(v)),
				hlc: Buffer.from(serializeHLC(c.hlc)).toString('base64'),
			};
			if (c.type === 'column') {
				const cc = c as ColumnChange;
				return {
					...base,
					column: cc.column,
					value: encodeSqlValue(cc.value),
					// Carry the per-cell before-image (value + HLC) present-only: write both
					// together gated on priorHlc, never a phantom key. priorHlc reuses the same
					// base64-binary HLC encoding as `hlc`; priorValue rides encodeSqlValue.
					...(cc.priorHlc !== undefined
						? {
								priorValue: encodeSqlValue(cc.priorValue ?? null),
								priorHlc: Buffer.from(serializeHLC(cc.priorHlc)).toString('base64'),
							}
						: {}),
				};
			}
			const rd = c as RowDeletion;
			return {
				...base,
				// Carry the row before-image present-only. An empty array is present:
				// [].map(...) is still [] and [] !== undefined, so the conditional spread
				// preserves the empty-present vs absent boundary.
				...(rd.priorRow !== undefined
					? { priorRow: rd.priorRow.map(v => encodeSqlValue(v)) }
					: {}),
			};
		}),
		schemaMigrations: cs.schemaMigrations.map(m => ({
			...m,
			hlc: Buffer.from(serializeHLC(m.hlc)).toString('base64'),
		})),
	};
}

/**
 * Serialize a SnapshotChunk for JSON transport.
 * Converts binary fields (siteId, HLCs) and SqlValue blobs to base64 strings.
 */
export function serializeSnapshotChunk(chunk: SnapshotChunk): object {
	switch (chunk.type) {
		case 'header':
			return {
				type: chunk.type,
				siteId: siteIdToBase64(chunk.siteId),
				hlc: Buffer.from(serializeHLC(chunk.hlc)).toString('base64'),
				tableCount: chunk.tableCount,
				migrationCount: chunk.migrationCount,
				snapshotId: chunk.snapshotId,
			};
		case 'column-versions':
			return {
				type: chunk.type,
				schema: chunk.schema,
				table: chunk.table,
				entries: chunk.entries.map(([key, hlc, value]) => [
					key,
					Buffer.from(serializeHLC(hlc)).toString('base64'),
					encodeSqlValue(value),
				]),
			};
		case 'schema-migration':
			return {
				type: chunk.type,
				migration: {
					...chunk.migration,
					hlc: Buffer.from(serializeHLC(chunk.migration.hlc)).toString('base64'),
				},
			};
		// table-start, table-end, footer have no binary fields
		default:
			return chunk;
	}
}

/**
 * Deserialize a SnapshotChunk from JSON transport format.
 * Converts base64 strings back to binary fields (SiteId, HLC) and decodes SqlValue blobs.
 */
export function deserializeSnapshotChunk(obj: unknown): SnapshotChunk {
	const chunk = obj as Record<string, unknown>;
	switch (chunk.type) {
		case 'header':
			return {
				type: 'header',
				siteId: siteIdFromBase64(chunk.siteId as string),
				hlc: deserializeHLC(Buffer.from(chunk.hlc as string, 'base64')),
				tableCount: chunk.tableCount as number,
				migrationCount: chunk.migrationCount as number,
				snapshotId: chunk.snapshotId as string,
			};
		case 'column-versions':
			return {
				type: 'column-versions',
				schema: chunk.schema as string,
				table: chunk.table as string,
				entries: (chunk.entries as unknown[][]).map(([key, hlc, value]) => [
					key as string,
					deserializeHLC(Buffer.from(hlc as string, 'base64')),
					decodeSqlValue(value),
				]),
			} as SnapshotChunk;
		case 'schema-migration': {
			const migration = chunk.migration as Record<string, unknown>;
			return {
				type: 'schema-migration',
				migration: {
					...migration,
					hlc: deserializeHLC(Buffer.from(migration.hlc as string, 'base64')),
				},
			} as SnapshotChunk;
		}
		// table-start, table-end, footer have no binary fields
		default:
			return chunk as unknown as SnapshotChunk;
	}
}

/**
 * Deserialize a ChangeSet from JSON transport format.
 * Converts base64 strings back to binary fields and decodes SqlValue blobs.
 */
export function deserializeChangeSet(cs: unknown): ChangeSet {
	const obj = cs as Record<string, unknown>;
	return {
		siteId: siteIdFromBase64(obj.siteId as string),
		transactionId: obj.transactionId as string,
		hlc: deserializeHLC(Buffer.from(obj.hlc as string, 'base64')),
		changes: (obj.changes as Record<string, unknown>[]).map(c => {
			const base = {
				type: c.type,
				schema: c.schema,
				table: c.table,
				pk: (c.pk as unknown[]).map(v => decodeSqlValue(v)),
				hlc: deserializeHLC(Buffer.from(c.hlc as string, 'base64')),
			};
			if (c.type === 'column') {
				return {
					...base,
					column: c.column,
					value: decodeSqlValue(c.value),
					// Mirror serialize: attach the before-image only when the serialized
					// object carries it, so absent stays absent (not a phantom undefined).
					...(c.priorHlc !== undefined
						? {
								priorValue: decodeSqlValue(c.priorValue),
								priorHlc: deserializeHLC(Buffer.from(c.priorHlc as string, 'base64')),
							}
						: {}),
				};
			}
			return {
				...base,
				...(c.priorRow !== undefined
					? { priorRow: (c.priorRow as unknown[]).map(v => decodeSqlValue(v)) }
					: {}),
			};
		}),
		schemaMigrations: ((obj.schemaMigrations as Record<string, unknown>[]) || []).map(m => ({
			...m,
			hlc: deserializeHLC(Buffer.from(m.hlc as string, 'base64')),
		})),
	} as ChangeSet;
}
