/**
 * Re-file a table's per-row sync bookkeeping after its primary key is REDEFINED.
 *
 * Every `cv:` / `tb:` / `cl:` record is keyed by the row's pk IDENTITY under the key
 * columns in force when it was written, and carries the raw pk VALUES in its value
 * (docs/sync.md § Row identity vs. address). `alter table t alter primary key (…)`
 * changes which columns make the key: the engine re-keys the TABLE in place and emits
 * one `alter`/`table` event, with no per-row event, so without this pass every
 * existing record is unreachable from the next write on (a lookup by the new key finds
 * nothing) and every fact extracted from it ships addressed by a key the receiver no
 * longer uses.
 *
 * The pass runs with the POST-change schema in force, at both places a key change
 * becomes known: the local commit capture (`SyncManagerImpl.handleTransactionCommit`,
 * staged into the transaction's own batch ahead of its data records, which the engine
 * already re-keyed) and the replicated apply (`change-applicator.ts`, Phase 3, from the
 * executed-DDL list, before the batch's own metadata is filed) — so in both the batch's
 * own records overwrite re-filed ones, never the reverse. The pass re-files exactly the
 * TRANSITION the statement made, old key → new key, and reads neither from the catalog:
 * the retired key's column names come from the engine's event locally (`oldKeyColumns`)
 * and from the pre-DDL schema on the replicated path (the capture runs after the catalog
 * has swapped, so nothing else still names it), and the new key's from the statement's
 * own `alter primary key (…)` list. The catalog's CURRENT key is not the target: a
 * later key change can already have moved it on by the time an earlier change's capture
 * runs (the commit chain lags the engine), and a pass that re-filed to the catalog's
 * key would leave the later change's own pass looking for records under a key nothing
 * is filed under — and dropping every one.
 *
 * Two variants, differing in where a row's NEW key is read from:
 *
 * - **From the table** ({@link rekeyTableBookkeeping}), on a peer with an engine: one
 *   scan projects each row's old key → old identity (under the retired key's keying,
 *   derivable from the current columns because ALTER PRIMARY KEY adds and drops none)
 *   and its new key. A `cv:` row group the table no longer holds is dropped, entries
 *   included: its row was deleted, and that delete filed the tombstone that protects it.
 * - **From the records themselves** ({@link rekeyRelayBookkeeping}), on a relay — a peer
 *   with sync records but no catalog and no table. Every cell record holds its column
 *   name and value, so a row's new key is read from its own cells, using the column list
 *   in the statement; the old identity is the record's key, so the relay never needs to
 *   know the old key. Identities on a relay are raw. A row group with no cell for a key
 *   column cannot be moved and STAYS where it is, counted and warned about rather than
 *   deleted: a missing cell is not a deleted row, and the relay may hold the only copy
 *   (a key built on a column added after the rows were written is
 *   `bug-sync-key-on-column-without-cells-through-relay`).
 *
 * In both, each `cv:` row group is re-filed under the new identity with the new pk in
 * its value, and its `cl:` entries move with it — each old entry's key is rebuilt from
 * the record's own filing position, so no change-log scan is needed. A re-filed record
 * KEEPS that position (`metadata/filing-position.ts`): a key redefinition changes where
 * a fact is addressed, not when it reached this replica, so a peer that had already read
 * past it is not sent it again and one that had not still finds it. A record moving in never
 * overwrites a newer record at its target ({@link CellContest}): a relay's rows are not
 * checked for uniqueness, so two old groups can land on one new identity, and a
 * duplicate apply of the same key change can be running alongside.
 *
 * **Tombstones.** A deleted row cannot be read back; its new key comes from
 * `Tombstone.priorRow` when present and of the table's column layout — the catalog's
 * on an engine peer, the `alter primary key` migration's own `columns` list on a relay
 * (a column added or dropped since the delete shifts the layout, and a wrong projection
 * is worse than none). Otherwise the tombstone and its entry are dropped: those rows
 * lose delete-wins protection against a stale write from a peer, the honest cost of a
 * key redefinition. A tombstone whose NEW identity belongs to a live row that was a
 * different row under the old key is dropped too — that key is taken — and two
 * tombstones that collide keep the newer.
 *
 * The old identity is always read straight from the record's key, never recomputed;
 * the new identity is `encodePkIdentity` under the table's current keying.
 *
 * What this does not cover (docs/sync.md § Tombstones): a change already on the wire,
 * or recorded by a peer that has not yet applied the key change, carries pk values
 * under the old definition — the concurrent-DDL-versus-data race; see the NOTE at the
 * pk-projection site in `store-adapter.ts`'s `mergeColumnUpdates`.
 */

import { quoteIdentifier, type Database, type Row, type SqlValue } from '@quereus/quereus';
import type { WriteBatch } from '@quereus/store';
import { compareHLC } from '../clock/hlc.js';
import type { FiledAt } from '../metadata/filing-position.js';
import { deserializeColumnVersion, type ColumnVersion } from '../metadata/column-version.js';
import { deserializeTombstone, type Tombstone } from '../metadata/tombstones.js';
import {
	buildTableColumnVersionScanBounds,
	buildTombstoneScanBounds,
	encodePkIdentity,
	joinKeyParts,
	parseColumnVersionKey,
	parseTombstoneKey,
	type PkKeying,
} from '../metadata/keys.js';
import type { SyncContext } from './sync-context.js';
import type { StagedTransactionMetadata } from './staged-transaction-metadata.js';

/** What one pass did to a table's bookkeeping — the fields of `PrimaryKeyRekeyedEvent`. */
export interface RekeyCounts {
	cellsRekeyed: number;
	rowsRekeyed: number;
	rowsDropped: number;
	rowsStranded: number;
	tombstonesRekeyed: number;
	tombstonesDropped: number;
}

/** The schema facts one pass needs, resolved once per table. */
interface RekeyPlan {
	readonly generation: string;
	/** The table's column layout — the shape of every row image — when this peer knows it. */
	readonly columns: readonly string[] | undefined;
	readonly newKeyColumns: readonly string[];
	/** Position of each new key column in a row image (`Tombstone.priorRow`); absent with `columns`. */
	readonly newKeyIndices: readonly number[] | undefined;
	readonly newKeying: PkKeying;
	/**
	 * Where a row's new key is read from, which decides what a row group WITHOUT one means.
	 * Read from the table, a group with none belongs to a row the table no longer holds,
	 * and is dropped; read from the group's own cells (a relay, which has no table), it is
	 * a row whose key column has no cell here, and it stays where it is.
	 */
	readonly newKeySource: 'table' | 'cells';
}

/** What the table variant's scan needs beyond the plan: the engine, and the retired key to match records by. */
interface TableScan {
	readonly db: Database;
	readonly oldKeyColumns: readonly string[];
	readonly oldKeying: PkKeying;
}

/** The table's live rows, indexed both ways by identity. */
interface LiveRows {
	/** old identity → the row's new pk */
	readonly newPkByOld: Map<string, SqlValue[]>;
	/** new identity → old identity (a tombstone colliding with a live row is spotted here) */
	readonly oldByNew: Map<string, string>;
}

interface CellRecord {
	readonly key: Uint8Array;
	readonly column: string;
	readonly cv: ColumnVersion;
}

/** One row's cell records — contiguous under the generation, so one scan yields them together. */
interface RowGroup {
	readonly identity: string;
	readonly cells: readonly CellRecord[];
}

/**
 * Stage the re-filing of `(schema, table)`'s bookkeeping into `batch`, where
 * `oldKeyColumns` is the key the records are filed under and `newKeyColumns` the key
 * the statement installed, which they must move to. Each row's new key is read from the
 * TABLE. Returns what was done, or `undefined` when the pass could not run here —
 * nothing was ever filed for the name, or this peer has no engine / schema to read the
 * table through, which is logged (a peer with no schema oracle at all runs
 * {@link rekeyRelayBookkeeping} instead). `staged` (local capture only) learns every
 * re-filed record so a later event of the same transaction reads it instead of
 * committed storage.
 */
export async function rekeyTableBookkeeping(
	ctx: SyncContext,
	schema: string,
	table: string,
	oldKeyColumns: readonly string[],
	newKeyColumns: readonly string[],
	batch: WriteBatch,
	staged?: StagedTransactionMetadata,
): Promise<RekeyCounts | undefined> {
	const planned = planTableRekey(ctx, schema, table, oldKeyColumns, newKeyColumns);
	if (!planned) return undefined;
	const { plan, scan } = planned;
	const live = await scanLiveRows(schema, table, scan, plan);
	return refileRecords(ctx, schema, table, plan, live, scanRowGroups(ctx, plan.generation), batch, staged);
}

/**
 * The relay variant of {@link rekeyTableBookkeeping}: a peer with no catalog and no
 * table re-files `(schema, table)`'s records from the records themselves, reading each
 * row's new key from its own cells and a deleted row's from its tombstone's before-image
 * laid out as `columns` (the statement's `alter primary key` migration carries it; absent,
 * every tombstone is dropped). Returns `undefined` when nothing was ever filed for the
 * name.
 */
export async function rekeyRelayBookkeeping(
	ctx: SyncContext,
	schema: string,
	table: string,
	newKeyColumns: readonly string[],
	columns: readonly string[] | undefined,
	batch: WriteBatch,
): Promise<RekeyCounts | undefined> {
	const plan = planRelayRekey(ctx, schema, table, newKeyColumns, columns);
	if (!plan) return undefined;
	// ONE scan, held in memory, so the row maps and the move act on the SAME records. Two
	// pushes of one key change can apply at once (nothing serializes applies on a
	// manager), and a second scan straddling the first pass's write saw some groups
	// already moved and some not — and dropped every moved one as a row the first scan had
	// not listed.
	// NOTE: holds every cell record of the table for the length of the pass, where the
	// table variant holds one entry per row. Bounded by the table's bookkeeping; if a key
	// change on a very large relay table ever shows up as a memory spike here, take one KV
	// snapshot and stream it twice instead.
	const groups = await collectRowGroups(ctx, plan.generation);
	return refileRecords(ctx, schema, table, plan, liveRowsFromCells(groups, plan), groups, batch, undefined);
}

/**
 * Log a pass's cost when it had one, and emit the per-table event either way. A dropped
 * row group is not a cost: it belonged to a row the table no longer holds, whose own
 * delete filed the tombstone that protects it. A dropped tombstone and a stranded row
 * group are.
 */
export function reportRekeyOutcome(ctx: SyncContext, schema: string, table: string, counts: RekeyCounts): void {
	const costs: string[] = [];
	if (counts.tombstonesDropped > 0) {
		costs.push(
			`dropped ${counts.tombstonesDropped} tombstone(s) whose new key could not be determined — those deletions `
				+ `no longer protect against a stale write from a peer`,
		);
	}
	if (counts.rowsStranded > 0) {
		costs.push(
			`left ${counts.rowsStranded} row(s) under the old key because a key column has no cell here — unreachable `
				+ `under the new key, so a device that takes a snapshot will not receive them, but not deleted`,
		);
	}
	if (costs.length > 0) {
		console.warn(
			`[Sync] ${schema}.${table}: primary key changed — re-filed ${counts.cellsRekeyed} cell version(s) of `
				+ `${counts.rowsRekeyed} row(s) and ${counts.tombstonesRekeyed} tombstone(s); ${costs.join('; ')}`,
		);
	}
	ctx.syncEvents.emitPrimaryKeyRekeyed({ schema, table, ...counts });
}

function planTableRekey(
	ctx: SyncContext,
	schema: string,
	table: string,
	oldKeyColumns: readonly string[],
	newKeyColumns: readonly string[],
): { plan: RekeyPlan; scan: TableScan } | undefined {
	const generation = ctx.tableIdentity.generationOf(schema, table);
	if (generation === undefined) return undefined; // nothing was ever filed for the name

	const columns = ctx.getTableColumnNames(schema, table);
	const oldKeying = ctx.getPkKeyingOf(schema, table, oldKeyColumns);
	const newKeying = ctx.getPkKeyingOf(schema, table, newKeyColumns);
	if (!ctx.db || !columns || !oldKeying || !newKeying) {
		console.warn(
			`[Sync] ${schema}.${table}: primary key changed but its sync bookkeeping cannot be re-filed on this peer `
				+ `(no engine or table schema here) — the conflict history of its existing rows is unreachable from now on`,
		);
		return undefined;
	}
	// The statement may spell a key column in any case; the plan carries the catalog's
	// spelling. Every name resolves: the keyings above did not.
	const newKeyIndices = keyIndicesIn(columns, newKeyColumns)!;
	const canonical = (name: string): string => columns[keyIndicesIn(columns, [name])![0]];
	return {
		plan: {
			generation,
			columns,
			newKeyColumns: newKeyIndices.map(i => columns[i]),
			newKeyIndices,
			newKeying,
			newKeySource: 'table',
		},
		scan: { db: ctx.db, oldKeyColumns: oldKeyColumns.map(canonical), oldKeying },
	};
}

function planRelayRekey(
	ctx: SyncContext,
	schema: string,
	table: string,
	newKeyColumns: readonly string[],
	columns: readonly string[] | undefined,
): RekeyPlan | undefined {
	const generation = ctx.tableIdentity.generationOf(schema, table);
	if (generation === undefined) return undefined; // nothing was ever filed for the name
	return {
		generation,
		columns,
		newKeyColumns,
		newKeyIndices: columns === undefined ? undefined : keyIndicesIn(columns, newKeyColumns),
		// Raw on a relay (no schema can exist here) — the same keying every record writer resolves.
		newKeying: ctx.getPkKeying(schema, table),
		newKeySource: 'cells',
	};
}

/**
 * Position of each of `keyColumns` in `columns`, matched case-insensitively (a statement
 * can spell a column differently from the catalog or the cells), or `undefined` when a
 * key column is not in the layout.
 */
function keyIndicesIn(columns: readonly string[], keyColumns: readonly string[]): number[] | undefined {
	const position = new Map(columns.map((name, i): [string, number] => [name.toLowerCase(), i]));
	const indices: number[] = [];
	for (const name of keyColumns) {
		const index = position.get(name.toLowerCase());
		if (index === undefined) return undefined;
		indices.push(index);
	}
	return indices;
}

/**
 * One scan of the table, projecting each row's old and new key. The key columns are
 * selected under positional aliases (`k0…`) so the projection never depends on how the
 * engine spells a `select *` column. A committed read: the key change this pass follows
 * has committed, and the scan must neither join nor wait on a statement the host may be
 * running — the replicated path is host-driven, and the local path runs on the commit
 * chain, which Phase 3 drains from inside the host's apply call.
 *
 * NOTE: holds one entry per live row (its new pk values and two identity strings) for
 * the length of the pass — bounded by the table, like the engine's own re-key. If a
 * key change on a very large table ever shows up as a memory spike here, stream the
 * table in pk order instead and probe each row's `cv:` group directly.
 *
 * NOTE: reads the table as it is NOW, not as the key change left it: a transaction
 * committed after the key change but before this capture ran has already changed the
 * rows. A row deleted in between is dropped here and re-protected by that delete's own
 * tombstone; a key column edited in between is re-filed under the edited value, where
 * that update's own records then land — both converge. The local capture resolving
 * keying from the current catalog rather than the catalog at commit time is a wider,
 * pre-existing gap of the capture (its DML records are filed the same way); if a key
 * change ever has to be safe against a concurrent write on the same peer, carry the
 * table's schema on the commit batch and derive every keying from that.
 */
async function scanLiveRows(schema: string, table: string, scan: TableScan, plan: RekeyPlan): Promise<LiveRows> {
	const selected = [...new Set([...scan.oldKeyColumns, ...plan.newKeyColumns])];
	const alias = new Map(selected.map((name, i): [string, string] => [name, `k${i}`]));
	const sql = `select ${selected.map((name, i) => `${quoteIdentifier(name)} as k${i}`).join(', ')} `
		+ `from ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
	const valueOf = (row: Record<string, SqlValue>, name: string): SqlValue => row[alias.get(name)!];

	const newPkByOld = new Map<string, SqlValue[]>();
	const oldByNew = new Map<string, string>();
	for await (const row of scan.db.eval(sql, undefined, { readConcurrency: 'committed' })) {
		const oldIdentity = encodePkIdentity(scan.oldKeyColumns.map(name => valueOf(row, name)), scan.oldKeying);
		const newPk = plan.newKeyColumns.map(name => valueOf(row, name));
		newPkByOld.set(oldIdentity, newPk);
		oldByNew.set(encodePkIdentity(newPk, plan.newKeying), oldIdentity);
	}
	return { newPkByOld, oldByNew };
}

/** The relay's counterpart of the table scan: each row's new key read from its own cells. */
function liveRowsFromCells(groups: readonly RowGroup[], plan: RekeyPlan): LiveRows {
	const newPkByOld = new Map<string, SqlValue[]>();
	const oldByNew = new Map<string, string>();
	for (const group of groups) {
		const newPk = projectKeyFromCells(group, plan);
		if (newPk === undefined) continue;
		newPkByOld.set(group.identity, newPk);
		oldByNew.set(encodePkIdentity(newPk, plan.newKeying), group.identity);
	}
	return { newPkByOld, oldByNew };
}

/** A row's new key from its cells, or `undefined` when a key column has no cell. Names match case-insensitively. */
function projectKeyFromCells(group: RowGroup, plan: RekeyPlan): SqlValue[] | undefined {
	const valueByColumn = new Map(group.cells.map((cell): [string, SqlValue] => [cell.column.toLowerCase(), cell.cv.value]));
	const newPk: SqlValue[] = [];
	for (const name of plan.newKeyColumns) {
		const value = valueByColumn.get(name.toLowerCase());
		if (value === undefined) return undefined;
		newPk.push(value);
	}
	return newPk;
}

/** Walk the generation's `cv:` records row group by row group (one row's cells are contiguous). */
async function* scanRowGroups(ctx: SyncContext, generation: string): AsyncIterable<RowGroup> {
	let identity: string | undefined;
	let cells: CellRecord[] = [];
	for await (const entry of ctx.kv.iterate(buildTableColumnVersionScanBounds(generation))) {
		const parsed = parseColumnVersionKey(entry.key);
		if (!parsed) continue;
		if (parsed.identity !== identity) {
			if (identity !== undefined) yield { identity, cells };
			identity = parsed.identity;
			cells = [];
		}
		cells.push({ key: entry.key, column: parsed.column, cv: deserializeColumnVersion(entry.value) });
	}
	if (identity !== undefined) yield { identity, cells };
}

async function collectRowGroups(ctx: SyncContext, generation: string): Promise<RowGroup[]> {
	const groups: RowGroup[] = [];
	for await (const group of scanRowGroups(ctx, generation)) groups.push(group);
	return groups;
}

/** Re-file every row group and tombstone of the table, then write the records that won their place. */
async function refileRecords(
	ctx: SyncContext,
	schema: string,
	table: string,
	plan: RekeyPlan,
	live: LiveRows,
	groups: Iterable<RowGroup> | AsyncIterable<RowGroup>,
	batch: WriteBatch,
	staged: StagedTransactionMetadata | undefined,
): Promise<RekeyCounts> {
	const counts: RekeyCounts = {
		cellsRekeyed: 0, rowsRekeyed: 0, rowsDropped: 0, rowsStranded: 0, tombstonesRekeyed: 0, tombstonesDropped: 0,
	};
	// Every put is deferred past every delete: under a key SWAP (row 1's new identity is
	// row 2's old one) a group's re-filed records would otherwise be deleted again by
	// the next group's removal of its own old records.
	const cells = new CellContest(ctx, plan.generation, batch);
	const tombstonePuts: Array<() => void> = [];
	for await (const group of groups) {
		refileRowGroup(ctx, schema, table, plan, live, group, batch, cells, counts, staged);
	}
	await rekeyTombstones(ctx, schema, table, plan, live, batch, tombstonePuts, counts, staged);
	counts.cellsRekeyed = cells.settle();
	for (const put of tombstonePuts) put();
	return counts;
}

function refileRowGroup(
	ctx: SyncContext,
	schema: string,
	table: string,
	plan: RekeyPlan,
	live: LiveRows,
	group: RowGroup,
	batch: WriteBatch,
	cells: CellContest,
	counts: RekeyCounts,
	staged: StagedTransactionMetadata | undefined,
): void {
	const newPk = live.newPkByOld.get(group.identity);
	if (newPk === undefined) {
		if (plan.newKeySource === 'cells') {
			// A key column with no cell here: the new key cannot be read, and the records
			// stay where they are rather than being deleted — a missing cell is not a
			// deleted row, and this peer may hold the only copy.
			counts.rowsStranded++;
			return;
		}
		// The table no longer holds the row — deleted since these records were written
		// (by the very batch whose DDL triggered this pass, whose delete cleanup would
		// have removed them a step later) — so nothing can address them now.
		for (const { key, column, cv } of group.cells) {
			batch.delete(key);
			ctx.changeLog.deleteEntryByIdentityBatch(batch, cv, 'column', plan.generation, group.identity, column);
		}
		counts.rowsDropped++;
		return;
	}

	const newIdentity = encodePkIdentity(newPk, plan.newKeying);
	if (newIdentity === group.identity) {
		// The same identity under both keys: nothing moves, but each cell holds its place
		// against any older one moving in.
		for (const { column, cv } of group.cells) cells.keep(newIdentity, column, cv);
		return;
	}

	for (const { key, column, cv } of group.cells) {
		batch.delete(key);
		ctx.changeLog.deleteEntryByIdentityBatch(batch, cv, 'column', plan.generation, group.identity, column);
		// Everything but the retired pk travels: the version's HLC, value, before-image,
		// and the position it is filed at.
		const { pk: _retiredPk, ...version } = cv;
		cells.move(newIdentity, column, cv, () => {
			// Through the name-keyed writers, so the new identity is derived exactly as any
			// other write derives it (there is deliberately no caller-supplied-identity writer).
			ctx.columnVersions.setColumnVersionBatch(batch, schema, table, newPk, column, version);
			ctx.changeLog.recordColumnChangeBatch(batch, version, schema, table, newPk, column);
			staged?.noteColumnVersion(schema, table, newPk, column, version);
		});
	}
	counts.rowsRekeyed++;
}

/**
 * Which record ends up in each cell slot `(new identity, column)` once the pass has run:
 * the one already filed there that does not move, or the newest of those moving in. The
 * table variant never contests a slot (the table holds one row per new key), but a
 * relay's rows are not checked for uniqueness, so two old groups can land on one new
 * identity, and a duplicate apply of the same key change can be running alongside this
 * one and have moved a group already. A record moving in never overwrites a newer one,
 * and the loser's change-log entry goes with it, so the log keeps exactly one entry per
 * surviving record (the LOAD-BEARING INVARIANT of `collectChangesSince`).
 */
class CellContest {
	private readonly slots = new Map<string, { filed: FiledAt; put?: () => void }>();

	constructor(
		private readonly ctx: SyncContext,
		private readonly generation: string,
		private readonly batch: WriteBatch,
	) {}

	/** A record already filed at `identity` that stays there. */
	keep(identity: string, column: string, filed: FiledAt): void {
		this.contest(identity, column, { filed });
	}

	/** A record moving to `identity`, written by `put` if it wins its slot. Its old record is already deleted. */
	move(identity: string, column: string, filed: FiledAt, put: () => void): void {
		this.contest(identity, column, { filed, put });
	}

	private contest(identity: string, column: string, candidate: { filed: FiledAt; put?: () => void }): void {
		const slot = joinKeyParts(identity, column);
		const incumbent = this.slots.get(slot);
		if (incumbent === undefined) {
			this.slots.set(slot, candidate);
			return;
		}
		// The newer wins; between equals — the same fact, met twice — the one that stays,
		// which costs no write.
		const order = compareHLC(candidate.filed.hlc, incumbent.filed.hlc);
		const candidateWins = order > 0 || (order === 0 && candidate.put === undefined && incumbent.put !== undefined);
		const loser = candidateWins ? incumbent : candidate;
		if (loser.put === undefined) {
			// A stayer that lost: the winner's put overwrites its record, but not its entry.
			this.ctx.changeLog.deleteEntryByIdentityBatch(this.batch, loser.filed, 'column', this.generation, identity, column);
		}
		if (candidateWins) this.slots.set(slot, candidate);
	}

	/** Write every winning record that moved; returns how many did. */
	settle(): number {
		let moved = 0;
		for (const { put } of this.slots.values()) {
			if (put === undefined) continue;
			put();
			moved++;
		}
		return moved;
	}
}

async function rekeyTombstones(
	ctx: SyncContext,
	schema: string,
	table: string,
	plan: RekeyPlan,
	live: LiveRows,
	batch: WriteBatch,
	puts: Array<() => void>,
	counts: RekeyCounts,
	staged: StagedTransactionMetadata | undefined,
): Promise<void> {
	// The new key need not separate rows the old one did, so two tombstones can land on
	// one new identity; the newer wins, as between any two deletes of one row.
	const winners = new Map<string, { tombstone: Tombstone; newPk: SqlValue[] }>();

	for await (const entry of ctx.kv.iterate(buildTombstoneScanBounds(plan.generation))) {
		const parsed = parseTombstoneKey(entry.key);
		if (!parsed) continue;
		const tombstone = deserializeTombstone(entry.value);
		const newPk = projectKeyFromImage(tombstone.priorRow, plan);
		const newIdentity = newPk === undefined ? undefined : encodePkIdentity(newPk, plan.newKeying);
		if (newIdentity === parsed.identity) continue; // the same identity under both keys: nothing moves

		// From here on the old record goes, whatever becomes of the tombstone.
		batch.delete(entry.key);
		ctx.changeLog.deleteEntryByIdentityBatch(batch, tombstone, 'delete', plan.generation, parsed.identity);

		const liveOwner = newIdentity === undefined ? undefined : live.oldByNew.get(newIdentity);
		if (newPk === undefined || newIdentity === undefined || (liveOwner !== undefined && liveOwner !== parsed.identity)) {
			// No usable before-image, or the new key now belongs to a live row that was a
			// different row under the old key: that key is taken.
			counts.tombstonesDropped++;
			continue;
		}
		const incumbent = winners.get(newIdentity);
		if (incumbent !== undefined && compareHLC(incumbent.tombstone.hlc, tombstone.hlc) >= 0) {
			counts.tombstonesDropped++;
			continue;
		}
		if (incumbent !== undefined) counts.tombstonesDropped++;
		winners.set(newIdentity, { tombstone, newPk });
	}

	for (const { tombstone, newPk } of winners.values()) {
		puts.push(() => {
			// `createdAt` carried over: a re-filed tombstone keeps its original TTL clock,
			// and (as `tombstone` carries it) the position it was filed at.
			ctx.tombstones.setTombstoneBatch(batch, schema, table, newPk, tombstone, tombstone.priorRow, tombstone.createdAt);
			ctx.changeLog.recordDeletionBatch(batch, tombstone, schema, table, newPk);
			staged?.noteTombstone(schema, table, newPk, tombstone);
		});
		counts.tombstonesRekeyed++;
	}
}

/**
 * The new key of a deleted row from its before-image, or `undefined` when the image is
 * absent, this peer does not know the table's layout, or the image is of another layout.
 */
function projectKeyFromImage(priorRow: Row | undefined, plan: RekeyPlan): SqlValue[] | undefined {
	if (!priorRow || plan.columns === undefined || plan.newKeyIndices === undefined) return undefined;
	if (priorRow.length !== plan.columns.length) return undefined;
	return plan.newKeyIndices.map(i => priorRow[i]);
}
