import type { Database, Row, SqlValue, TableSchema, VirtualTable } from '@quereus/quereus';
import { QuereusError, StatusCode, logicalTypeCanHoldText, serializeKeyNullGrouping } from '@quereus/quereus';
import { makeFullScanFilterInfo } from './filter-info.js';

/**
 * One staged overlay row, decomposed into the three things every consumer of the overlay
 * needs: whether it is a deletion marker, its primary key, and its data columns with the
 * trailing tombstone column stripped.
 *
 * A tombstone row's `dataRow` carries the PK values and NULL everywhere else — see the
 * tombstone-insert branch of `IsolatedTable.update` — so only its `pk` is meaningful.
 */
export interface OverlayEntry {
	isTombstone: boolean;
	pk: SqlValue[];
	dataRow: Row;
}

/** Resolves the tombstone column's position in an overlay table's schema. */
export function resolveTombstoneIndex(overlayTable: VirtualTable, tombstoneColumn: string): number {
	const overlaySchema = overlayTable.tableSchema;
	if (!overlaySchema) {
		throw new QuereusError('Overlay table has no schema', StatusCode.INTERNAL);
	}
	const tombstoneIndex = overlaySchema.columnIndexMap.get(tombstoneColumn.toLowerCase());
	if (tombstoneIndex === undefined) {
		throw new QuereusError(`Tombstone column '${tombstoneColumn}' not found in overlay schema`, StatusCode.INTERNAL);
	}
	return tombstoneIndex;
}

/**
 * Reads every staged overlay row into memory, decomposed into {@link OverlayEntry}s.
 *
 * Materializing is bounded by the transaction's own write set, and both consumers need
 * random access to it: the commit flush re-orders deletes ahead of writes, and
 * {@link iterateEffectiveRows} probes it by primary key while streaming the underlying.
 */
export async function collectOverlayEntries(
	overlayTable: VirtualTable,
	tombstoneColumn: string,
	pkIndices: readonly number[],
): Promise<OverlayEntry[]> {
	if (!overlayTable.query) return [];
	const tombstoneIndex = resolveTombstoneIndex(overlayTable, tombstoneColumn);

	const entries: OverlayEntry[] = [];
	for await (const overlayRow of overlayTable.query(makeFullScanFilterInfo())) {
		entries.push({
			isTombstone: overlayRow[tombstoneIndex] === 1,
			pk: pkIndices.map(i => overlayRow[i]),
			dataRow: overlayRow.slice(0, tombstoneIndex),
		});
	}
	return entries;
}

/**
 * Builds the primary-key hash key used to align overlay rows with underlying rows.
 *
 * Each PK column is normalized under its own declared collation, so an overlay row whose
 * PK differs from the underlying row it shadows only by case matches under NOCASE. A
 * column whose declared type can never hold text takes the identity normalizer (the
 * serializer normalizes string values only), so a comparator-only collation declared on
 * an integer column does not raise here.
 *
 * NULL-grouping (rather than {@link serializeRowKey}'s NULL-poisoning) so a degenerate
 * nullable PK column still produces a usable key instead of collapsing to `null`.
 */
export function makePkKeySerializer(db: Database, schema: TableSchema): (pk: readonly SqlValue[]) => string {
	const resolver = db.getKeyNormalizerResolver();
	const normalizers = schema.primaryKeyDefinition.map(def => {
		const column = schema.columns[def.index];
		return resolver(column && logicalTypeCanHoldText(column.logicalType) ? column.collation : undefined);
	});
	return pk => serializeKeyNullGrouping(pk, normalizers);
}

/**
 * Yields the rows the overlay's owning connection can SEE: the underlying table's committed
 * rows, minus the ones its overlay tombstones, superseded by the ones its overlay rewrote,
 * plus the ones its overlay added.
 *
 * This is the stream the isolation layer hands to a row-validating DDL on the underlying
 * module (`EffectiveRowSource`), which cannot reach the overlay itself. Row ORDER is
 * unspecified — every consumer is a set-shaped uniqueness check.
 */
export async function* iterateEffectiveRows(
	underlyingTable: VirtualTable,
	overlayTable: VirtualTable,
	tombstoneColumn: string,
	pkIndices: readonly number[],
	pkKeyOf: (pk: readonly SqlValue[]) => string,
): AsyncIterable<Row> {
	const entries = await collectOverlayEntries(overlayTable, tombstoneColumn, pkIndices);
	// Every staged PK shadows its underlying row, tombstone or not: a tombstone drops it,
	// a rewrite replaces it with the overlay's version (yielded below).
	const staged = new Set(entries.map(entry => pkKeyOf(entry.pk)));

	if (underlyingTable.query) {
		for await (const row of underlyingTable.query(makeFullScanFilterInfo())) {
			if (staged.has(pkKeyOf(pkIndices.map(i => row[i])))) continue;
			yield row;
		}
	}

	for (const entry of entries) {
		if (!entry.isTombstone) yield entry.dataRow;
	}
}
