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
 *   - a drop RETIRES the generation — its `cv:`/`tb:` records are deleted with the
 *     drop, and its `cl:` entries with the next `repairChangeLog` sweep;
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
 *
 * The in-memory index is updated the moment a transition is STAGED, not when its
 * batch commits, so later stages of the same batch resolve the new state (`drop t;
 * create t; insert into t` files the rows under the fresh generation). The price is
 * that a batch which never commits — abandoned by a throw mid-staging, or refused by
 * the store — leaves the index ahead of disk, and nothing re-persists a mapping the
 * index already holds. So every site that stages transitions and then fails to
 * commit them re-reads the index with {@link TableIdentityStore.load}, through
 * {@link withIdentityRecovery}: `admitGroup`'s metadata commit, the streaming
 * snapshot apply, the stores' standalone writers ({@link writeIdentityBatch}), and
 * the local commit capture's own catch.
 */

import type { KVStore, WriteBatch } from '@quereus/store';
import {
	buildAllTableGenerationScanBounds,
	buildTableColumnVersionScanBounds,
	buildTableGenerationKey,
	buildTombstoneScanBounds,
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
	/** Re-read the mapping from disk — the recovery after a batch that staged a transition failed to commit. */
	load(): Promise<void>;
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
 * state, and a batch that fails to commit must be followed by {@link load} (see the
 * file header) or the maps stay ahead of disk.
 */
export class TableIdentityStore implements TableIdentityResolver {
	/** `joinKeyParts(schema, table)` → generation. */
	private readonly byName = new Map<string, string>();
	/** generation → its current name. */
	private readonly byGeneration = new Map<string, { schema: string; table: string }>();

	constructor(private readonly kv: KVStore) {}

	/**
	 * (Re)load every `tg:` record, replacing whatever the maps hold. Called once by
	 * `SyncManagerImpl.create` before any store is used, and again by any site whose
	 * batch staged a transition and then failed to commit.
	 */
	async load(): Promise<void> {
		this.byName.clear();
		this.byGeneration.clear();
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
	 * generation. Every scan skips what such a generation still has on disk: its
	 * `cl:` entries until the next repair sweep, and its `cv:`/`tb:` records while
	 * the retiring batch has not committed.
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
		// NOTE: a `tg:` record can outlive its table when the drop ran while sync was
		// detached (the drop's migration is lost the same way), and a later same-name
		// create then inherits the dropped incarnation's generation here. If DDL while
		// detached ever becomes supported, reconcile `tg:` against the catalog in `load`.
		const existing = this.generationOf(schema, table);
		if (existing !== undefined) return existing;

		const generation = mintTableGeneration();
		batch.put(buildTableGenerationKey(schema, table), serializeTableGeneration({ generation, mintedAt: Date.now() }));
		this.index(schema, table, generation);
		return generation;
	}

	/**
	 * Retire the generation `(schema, table)` resolves to: the name forgets it and
	 * the deletion of its `cv:`/`tb:` records is staged into `batch`, so they go
	 * with the drop that orphaned them. No-op for a name that never filed anything.
	 *
	 * The `cl:` entries stay: the change log is HLC-first, so finding one generation's
	 * entries takes a full scan, which `repairChangeLog` already runs and which removes
	 * them because a retired generation resolves to no name.
	 *
	 * The name forgets the generation BEFORE the first await, so nothing that runs
	 * during the scan can resolve the name to it and file a new record under it. A
	 * failed scan is the same recovery as a failed commit ({@link withIdentityRecovery}).
	 *
	 * The `tg:` delete is staged AFTER the scan, and only if the name is still free. A
	 * commit during the scan can give the name a new generation (a local `create table
	 * t`, a rename onto it), and this batch commits later: deleting the key then would
	 * erase that mapping and strand the new table's records at the next open.
	 */
	async retire(schema: string, table: string, batch: WriteBatch): Promise<void> {
		const generation = this.generationOf(schema, table);
		if (generation === undefined) return;

		this.byName.delete(joinKeyParts(schema, table));
		this.byGeneration.delete(generation);
		await this.stageRecordDeletions(generation, batch);
		if (this.generationOf(schema, table) === undefined) batch.delete(buildTableGenerationKey(schema, table));
	}

	/**
	 * NOTE: one delete per record in one batch, so the drop holds the table's whole
	 * record count in memory until the commit. If that shows up on very large tables,
	 * commit the `tg:` removal first and purge in chunks; the purge needs no atomicity
	 * with it, only a way to resume after a crash.
	 *
	 * NOTE: an inbound batch already staged under this generation can commit after this
	 * scan (the commit chain does not exclude the apply path), leaving records nothing
	 * purges. They are inert, since every scan skips a nameless generation. If they ever
	 * accumulate, sweep `cv:`/`tb:` for nameless generations alongside `repairChangeLog`.
	 */
	private async stageRecordDeletions(generation: string, batch: WriteBatch): Promise<void> {
		for (const bounds of [buildTableColumnVersionScanBounds(generation), buildTombstoneScanBounds(generation)]) {
			for await (const entry of this.kv.iterate(bounds)) batch.delete(entry.key);
		}
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

		// NOTE: on a catalog peer the engine (local) or `decideRenameTable` (replicated)
		// already refused a rename onto an existing table, so an occupant here is a
		// stale `tg:` record of a table dropped while sync was detached (see `ensure`).
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

/**
 * Run `body` — anything that stages identity transitions or lazy mints into batches
 * — and re-read the identity index from disk if it throws, so the index never stays
 * ahead of what committed (see the file header). The error is rethrown unchanged.
 */
export async function withIdentityRecovery<T>(tables: TableIdentityResolver, body: () => Promise<T>): Promise<T> {
	try {
		return await body();
	} catch (error) {
		await tables.load();
		throw error;
	}
}

/**
 * Stage one standalone write through `stage` and commit it under
 * {@link withIdentityRecovery} — `stage` may mint a generation into the batch. For
 * the record stores' non-batch writers.
 */
export function writeIdentityBatch(
	kv: KVStore,
	tables: TableIdentityResolver,
	stage: (batch: WriteBatch) => void,
): Promise<void> {
	return withIdentityRecovery(tables, async () => {
		const batch = kv.batch();
		stage(batch);
		await batch.write();
	});
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
export async function applySchemaChangeTransitions(
	identity: TableIdentityStore,
	changes: ReadonlyArray<TableLifecycleChange>,
	batch: WriteBatch,
): Promise<void> {
	for (const change of changes) {
		switch (change.type) {
			case 'create_table':
				identity.ensure(change.schema, change.table, batch);
				break;
			case 'drop_table':
				await identity.retire(change.schema, change.table, batch);
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
