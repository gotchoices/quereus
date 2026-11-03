/**
 * Table identity: the stable per-peer GENERATION every per-row sync record is filed
 * under, and the name ↔ generation mapping that resolves it.
 *
 * A table's name is not its identity. `alter table t rename to u` keeps the table
 * and changes the name; `drop table t; create table t (…)` keeps the name and
 * changes the table. Keying `cv:`/`tb:`/`cl:` by name stranded every record on a
 * rename and let a re-created table inherit the dropped incarnation's tombstones.
 * So each peer mints a random generation for a `(schema, table)` the first time it
 * files anything for that name, persists the mapping as a `tg:` record, and keys
 * the row records by the generation:
 *
 *   - a rename MOVES the mapping to the new name — the generation, and so every
 *     record, is untouched;
 *   - a drop RETIRES the generation — its records become unreachable orphans (the
 *     sibling ticket `sync-retire-dropped-table-bookkeeping` reclaims them);
 *   - a same-name re-create mints a FRESH generation and so can inherit nothing.
 *
 * The generation is LOCAL to each peer and never travels. On the wire a change is
 * addressed by the table's CURRENT name at extraction time (the record's generation
 * resolves to its name), and the receiver resolves that name to its own current
 * generation — the same name-based convergence rule replicated DDL already uses
 * (`rename_table` carries old and new names, `decideRenameTable` decides against the
 * catalog). See docs/sync.md § Table identity.
 *
 * Minting is LAZY: the record-writing stores call {@link TableIdentityStore.ensure}
 * into their own write batch, so a table that existed before sync attached, or one
 * created by replicated DDL, gets its generation with its first record. The three
 * explicit transitions (create / drop / rename) are driven by the two DDL paths —
 * local capture (`SyncManagerImpl.handleTransactionCommit`) and replicated DDL the
 * store adapter reports as executed (`change-applicator.ts`'s `commitMetadata`).
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import {
	buildAllTableGenerationScanBounds,
	buildTableGenerationKey,
	joinKeyParts,
	mintTableGeneration,
	parseTableGenerationKey,
	tableGenerationFromBytes,
	tableGenerationToBytes,
	TABLE_GENERATION_BYTES,
} from './keys.js';
import type { SchemaMigrationType } from '../sync/protocol.js';

/** The `tg:` record VALUE: the generation plus when this peer minted it. */
export interface TableGeneration {
	readonly generation: string;
	readonly mintedAt: number;
}

/**
 * What the per-row record stores need from the identity store: a read-side lookup
 * (`undefined` ⇒ nothing has ever been filed for the name, so a read finds nothing)
 * and a write-side ensure that mints into the caller's batch. {@link TableIdentityStore}
 * is the one implementation; the interface keeps the stores' constructor contract
 * narrow and lets a test wire a stub.
 */
export interface TableIdentityResolver {
	generationOf(schema: string, table: string): string | undefined;
	ensure(schema: string, table: string, batch: WriteBatch): string;
}

/**
 * Serialize a `tg:` record: 16 bytes generation + 8 bytes mintedAt (big-endian),
 * the same shape as the site identity record.
 */
export function serializeTableGeneration(record: TableGeneration): Uint8Array {
	const buffer = new Uint8Array(TABLE_GENERATION_BYTES + 8);
	buffer.set(tableGenerationToBytes(record.generation), 0);
	new DataView(buffer.buffer).setBigUint64(TABLE_GENERATION_BYTES, BigInt(record.mintedAt), false);
	return buffer;
}

/** Deserialize a `tg:` record — the inverse of {@link serializeTableGeneration}. */
export function deserializeTableGeneration(buffer: Uint8Array): TableGeneration {
	if (buffer.length !== TABLE_GENERATION_BYTES + 8) {
		throw new Error(`Invalid table generation record length: ${buffer.length}, expected ${TABLE_GENERATION_BYTES + 8}`);
	}
	const generation = tableGenerationFromBytes(buffer.slice(0, TABLE_GENERATION_BYTES));
	const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength);
	return { generation, mintedAt: Number(view.getBigUint64(TABLE_GENERATION_BYTES, false)) };
}

/**
 * The name ↔ generation map, persisted as `tg:` records and held whole in memory
 * (bounded by the table count). Every write is staged into a caller-supplied
 * `WriteBatch` so it commits atomically with the records that depend on it; the
 * in-memory maps update eagerly so later stages of the same batch resolve the new
 * state. A batch that never commits leaves the maps ahead of disk — harmless for a
 * mint (the unused generation is re-persisted by the next write) and self-healing
 * for a retire (the next write mints afresh and overwrites the stale record).
 */
export class TableIdentityStore implements TableIdentityResolver {
	/** `joinKeyParts(schema, table)` → generation. */
	private readonly byName = new Map<string, string>();
	/** generation → its current name. */
	private readonly byGeneration = new Map<string, { schema: string; table: string }>();

	constructor(private readonly kv: KVStore) {}

	/** Load every `tg:` record. Called once by `SyncManagerImpl.create` before any store is used. */
	async load(): Promise<void> {
		for await (const entry of this.kv.iterate(buildAllTableGenerationScanBounds())) {
			const parsed = parseTableGenerationKey(entry.key);
			if (!parsed) {
				console.warn('[Sync] Unparseable table generation key — skipped; the table will mint a fresh generation on its next write');
				continue;
			}
			this.index(parsed.schema, parsed.table, deserializeTableGeneration(entry.value).generation);
		}
	}

	/** The generation `(schema, table)` currently resolves to, or `undefined` when nothing was ever filed for it. */
	generationOf(schema: string, table: string): string | undefined {
		return this.byName.get(joinKeyParts(schema, table));
	}

	/**
	 * The name a generation currently carries, or `undefined` for a retired
	 * generation — whose records are leftovers every scan skips.
	 */
	nameOf(generation: string): { schema: string; table: string } | undefined {
		return this.byGeneration.get(generation);
	}

	/**
	 * The generation for `(schema, table)`, minting and staging a `tg:` record into
	 * `batch` when the name has none. Idempotent: a name that already resolves keeps
	 * its generation (a re-delivered `create_table`, or a create that follows data
	 * filed under the name, inherits nothing it should not — the name's records ARE
	 * that table's).
	 */
	ensure(schema: string, table: string, batch: WriteBatch): string {
		const existing = this.generationOf(schema, table);
		if (existing !== undefined) return existing;

		const generation = mintTableGeneration();
		batch.put(buildTableGenerationKey(schema, table), serializeTableGeneration({ generation, mintedAt: Date.now() }));
		this.index(schema, table, generation);
		return generation;
	}

	/**
	 * Retire the generation `(schema, table)` resolves to: the name forgets it and
	 * its records become unreachable. No-op for a name that never filed anything.
	 * The records themselves are left in place — reclaiming them is the sibling
	 * ticket `sync-retire-dropped-table-bookkeeping`.
	 */
	retire(schema: string, table: string, batch: WriteBatch): void {
		const generation = this.generationOf(schema, table);
		if (generation === undefined) return;

		batch.delete(buildTableGenerationKey(schema, table));
		this.byName.delete(joinKeyParts(schema, table));
		this.byGeneration.delete(generation);
	}

	/**
	 * A rename: `(schema, from)`'s generation now answers to `(schema, to)`. Records
	 * are untouched. A `from` that never filed anything has nothing to move (the new
	 * name mints lazily on its first write). A `to` that already resolves is a
	 * collision — the same yes/yes row `decideRenameTable` refuses — and throws rather
	 * than silently merging two tables' histories.
	 */
	move(schema: string, from: string, to: string, batch: WriteBatch): void {
		const generation = this.generationOf(schema, from);
		if (generation === undefined) return;

		const occupant = this.generationOf(schema, to);
		if (occupant !== undefined) {
			throw new Error(
				`Cannot move sync bookkeeping of ${schema}.${from} to ${schema}.${to}: `
					+ `that name already has its own generation (${occupant})`,
			);
		}

		batch.delete(buildTableGenerationKey(schema, from));
		batch.put(buildTableGenerationKey(schema, to), serializeTableGeneration({ generation, mintedAt: Date.now() }));
		this.byName.delete(joinKeyParts(schema, from));
		this.index(schema, to, generation);
	}

	private index(schema: string, table: string, generation: string): void {
		this.byName.set(joinKeyParts(schema, table), generation);
		this.byGeneration.set(generation, { schema, table });
	}
}

/** The subset of a schema change the identity transitions read. */
export interface TableLifecycleChange {
	readonly type: SchemaMigrationType;
	readonly schema: string;
	readonly table: string;
	readonly fromTable?: string;
}

/**
 * Apply the identity transitions of schema changes that EXECUTED, in the order they
 * ran: `create_table` ensures, `drop_table` retires, `rename_table` moves. Every
 * other migration type leaves identity alone (an index or column alteration changes
 * the table, not which table it is). Shared by the replicated-DDL path (the store
 * adapter's executed list) and the snapshot receivers; the local-DDL path maps
 * engine events to the same three calls in `SyncManagerImpl`.
 *
 * Order matters and is the caller's: `drop t; create t` must retire before it
 * ensures, or the re-create keeps the dropped incarnation's generation.
 */
export function applySchemaChangeTransitions(
	identity: TableIdentityStore,
	changes: ReadonlyArray<TableLifecycleChange>,
	batch: WriteBatch,
): void {
	for (const change of changes) {
		switch (change.type) {
			case 'create_table':
				identity.ensure(change.schema, change.table, batch);
				break;
			case 'drop_table':
				identity.retire(change.schema, change.table, batch);
				break;
			case 'rename_table':
				// No `fromTable` (an omitting peer) is undecidable for the catalog too —
				// `decideRenameTable` converges without applying — so there is nothing to move.
				if (change.fromTable !== undefined) identity.move(change.schema, change.fromTable, change.table, batch);
				break;
			default:
				break;
		}
	}
}
