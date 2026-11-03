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
 * Per record under the table's generation:
 *
 * - **Cell versions.** A live row's new key is read from the TABLE: one scan projects
 *   each row's old key → old identity (under the retired key's keying, derivable from
 *   the current columns because ALTER PRIMARY KEY adds and drops none) and its new key.
 *   Each `cv:` row group is re-filed under the new identity with the new pk in its
 *   value, and its `cl:` entries move with it — each old entry's key is rebuilt from
 *   the record's own `hlc`, so no change-log scan is needed. A group whose row the
 *   table no longer holds is dropped, entries included.
 * - **Tombstones.** A deleted row cannot be read back; its new key comes from
 *   `Tombstone.priorRow` when present and still the current column count (a column
 *   added or dropped since the delete shifts the layout, and a wrong projection is
 *   worse than none). Otherwise the tombstone and its entry are dropped: those rows
 *   lose delete-wins protection against a stale write from a peer, the honest cost of
 *   a key redefinition. A tombstone whose NEW identity belongs to a live row that was
 *   a different row under the old key is dropped too — the catalog says that key
 *   exists — and two tombstones that collide keep the newer.
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
import { deserializeColumnVersion, type ColumnVersion } from '../metadata/column-version.js';
import { deserializeTombstone, type Tombstone } from '../metadata/tombstones.js';
import {
	buildTableColumnVersionScanBounds,
	buildTombstoneScanBounds,
	encodePkIdentity,
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
	tombstonesRekeyed: number;
	tombstonesDropped: number;
}

/** The schema facts one pass needs, resolved once per table. */
interface RekeyPlan {
	readonly db: Database;
	readonly generation: string;
	readonly columns: readonly string[];
	readonly oldKeyColumns: readonly string[];
	readonly newKeyColumns: readonly string[];
	/** Position of each new key column in a row image (`Tombstone.priorRow`). */
	readonly newKeyIndices: readonly number[];
	readonly oldKeying: PkKeying;
	readonly newKeying: PkKeying;
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

/**
 * Stage the re-filing of `(schema, table)`'s bookkeeping into `batch`, where
 * `oldKeyColumns` is the key the records are filed under and `newKeyColumns` the key
 * the statement installed, which they must move to. Returns what was done, or
 * `undefined` when the pass could not run here — nothing was ever filed for the name,
 * or this peer has no engine / schema to read the table through (a relay-only
 * deployment), which is logged. `staged` (local capture only) learns every re-filed
 * record so a later event of the same transaction reads it instead of committed storage.
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
	const plan = planRekey(ctx, schema, table, oldKeyColumns, newKeyColumns);
	if (!plan) return undefined;
	const live = await scanLiveRows(schema, table, plan);

	const counts: RekeyCounts = { cellsRekeyed: 0, rowsRekeyed: 0, rowsDropped: 0, tombstonesRekeyed: 0, tombstonesDropped: 0 };
	// Every put is deferred past every delete: under a key SWAP (row 1's new identity is
	// row 2's old one) a group's re-filed records would otherwise be deleted again by
	// the next group's removal of its own old records.
	const puts: Array<() => void> = [];
	await rekeyCellVersions(ctx, schema, table, plan, live, batch, puts, counts, staged);
	await rekeyTombstones(ctx, schema, table, plan, live, batch, puts, counts, staged);
	for (const put of puts) put();
	return counts;
}

/**
 * Log a pass's cost when it had one, and emit the per-table event either way. Only a
 * dropped tombstone is a cost: a dropped row group belonged to a row the table no
 * longer holds, whose own delete filed the tombstone that protects it.
 */
export function reportRekeyOutcome(ctx: SyncContext, schema: string, table: string, counts: RekeyCounts): void {
	if (counts.tombstonesDropped > 0) {
		console.warn(
			`[Sync] ${schema}.${table}: primary key changed — re-filed ${counts.cellsRekeyed} cell version(s) of `
				+ `${counts.rowsRekeyed} row(s) and ${counts.tombstonesRekeyed} tombstone(s); dropped `
				+ `${counts.tombstonesDropped} tombstone(s) whose new key could not be determined — those deletions `
				+ `no longer protect against a stale write from a peer`,
		);
	}
	ctx.syncEvents.emitPrimaryKeyRekeyed({ schema, table, ...counts });
}

function planRekey(
	ctx: SyncContext,
	schema: string,
	table: string,
	oldKeyColumns: readonly string[],
	newKeyColumns: readonly string[],
): RekeyPlan | undefined {
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
	const position = new Map(columns.map((name, i): [string, number] => [name.toLowerCase(), i]));
	// The statement may spell a key column in any case; the plan carries the catalog's spelling.
	const canonical = (name: string): string => columns[position.get(name.toLowerCase())!];
	return {
		db: ctx.db,
		generation,
		columns,
		oldKeyColumns: oldKeyColumns.map(canonical),
		newKeyColumns: newKeyColumns.map(canonical),
		newKeyIndices: newKeyColumns.map(name => position.get(name.toLowerCase())!),
		oldKeying,
		newKeying,
	};
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
async function scanLiveRows(schema: string, table: string, plan: RekeyPlan): Promise<LiveRows> {
	const selected = [...new Set([...plan.oldKeyColumns, ...plan.newKeyColumns])];
	const alias = new Map(selected.map((name, i): [string, string] => [name, `k${i}`]));
	const sql = `select ${selected.map((name, i) => `${quoteIdentifier(name)} as k${i}`).join(', ')} `
		+ `from ${quoteIdentifier(schema)}.${quoteIdentifier(table)}`;
	const valueOf = (row: Record<string, SqlValue>, name: string): SqlValue => row[alias.get(name)!];

	const newPkByOld = new Map<string, SqlValue[]>();
	const oldByNew = new Map<string, string>();
	for await (const row of plan.db.eval(sql, undefined, { readConcurrency: 'committed' })) {
		const oldIdentity = encodePkIdentity(plan.oldKeyColumns.map(name => valueOf(row, name)), plan.oldKeying);
		const newPk = plan.newKeyColumns.map(name => valueOf(row, name));
		newPkByOld.set(oldIdentity, newPk);
		oldByNew.set(encodePkIdentity(newPk, plan.newKeying), oldIdentity);
	}
	return { newPkByOld, oldByNew };
}

/** Walk the generation's `cv:` records row group by row group (one row's cells are contiguous). */
async function rekeyCellVersions(
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
	let identity: string | undefined;
	let cells: CellRecord[] = [];
	const flush = (): void => {
		if (identity !== undefined) refileRowGroup(ctx, schema, table, plan, live, identity, cells, batch, puts, counts, staged);
		cells = [];
	};
	for await (const entry of ctx.kv.iterate(buildTableColumnVersionScanBounds(plan.generation))) {
		const parsed = parseColumnVersionKey(entry.key);
		if (!parsed) continue;
		if (parsed.identity !== identity) {
			flush();
			identity = parsed.identity;
		}
		cells.push({ key: entry.key, column: parsed.column, cv: deserializeColumnVersion(entry.value) });
	}
	flush();
}

function refileRowGroup(
	ctx: SyncContext,
	schema: string,
	table: string,
	plan: RekeyPlan,
	live: LiveRows,
	oldIdentity: string,
	cells: readonly CellRecord[],
	batch: WriteBatch,
	puts: Array<() => void>,
	counts: RekeyCounts,
	staged: StagedTransactionMetadata | undefined,
): void {
	const newPk = live.newPkByOld.get(oldIdentity);
	if (newPk === undefined) {
		// The table no longer holds the row — deleted since these records were written
		// (by the very batch whose DDL triggered this pass, whose delete cleanup would
		// have removed them a step later) — so nothing can address them now.
		for (const { key, column, cv } of cells) {
			batch.delete(key);
			ctx.changeLog.deleteEntryByIdentityBatch(batch, cv.hlc, 'column', plan.generation, oldIdentity, column);
		}
		counts.rowsDropped++;
		return;
	}

	const newIdentity = encodePkIdentity(newPk, plan.newKeying);
	if (newIdentity === oldIdentity) return; // the same identity under both keys: nothing moves

	for (const { key, column, cv } of cells) {
		batch.delete(key);
		ctx.changeLog.deleteEntryByIdentityBatch(batch, cv.hlc, 'column', plan.generation, oldIdentity, column);
		const { pk: _retiredPk, ...version } = cv;
		puts.push(() => {
			// Through the name-keyed writers, so the new identity is derived exactly as any
			// other write derives it (there is deliberately no caller-supplied-identity writer).
			ctx.columnVersions.setColumnVersionBatch(batch, schema, table, newPk, column, version);
			ctx.changeLog.recordColumnChangeBatch(batch, cv.hlc, schema, table, newPk, column);
			staged?.noteColumnVersion(schema, table, newPk, column, version);
		});
	}
	counts.cellsRekeyed += cells.length;
	counts.rowsRekeyed++;
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
		ctx.changeLog.deleteEntryByIdentityBatch(batch, tombstone.hlc, 'delete', plan.generation, parsed.identity);

		const liveOwner = newIdentity === undefined ? undefined : live.oldByNew.get(newIdentity);
		if (newPk === undefined || newIdentity === undefined || (liveOwner !== undefined && liveOwner !== parsed.identity)) {
			// No usable before-image, or the new key now belongs to a live row that was a
			// different row under the old key: the catalog says that key exists.
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
			// `createdAt` carried over: a re-filed tombstone keeps its original TTL clock.
			ctx.tombstones.setTombstoneBatch(batch, schema, table, newPk, tombstone.hlc, tombstone.priorRow, tombstone.createdAt);
			ctx.changeLog.recordDeletionBatch(batch, tombstone.hlc, schema, table, newPk);
			staged?.noteTombstone(schema, table, newPk, tombstone.hlc);
		});
		counts.tombstonesRekeyed++;
	}
}

/** The new key of a deleted row from its before-image, or `undefined` when the image is absent or of another layout. */
function projectKeyFromImage(priorRow: Row | undefined, plan: RekeyPlan): SqlValue[] | undefined {
	if (!priorRow || priorRow.length !== plan.columns.length) return undefined;
	return plan.newKeyIndices.map(i => priorRow[i]);
}
