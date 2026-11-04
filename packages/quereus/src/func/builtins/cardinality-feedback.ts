import type { Row } from '../../common/types.js';
import { createIntegratedTableValuedFunction } from '../registration.js';
import type { Database } from '../../core/database.js';
import type { ObservedRowCountSnapshot, ObservedRowsPerKeySnapshot } from '../../core/database-cardinality-feedback.js';
import { INTEGER_TYPE, REAL_TYPE, TEXT_TYPE } from '../../types/builtin-types.js';

/** Code-unit order, not `localeCompare`: row order must not vary with the host's locale. */
function compareText(a: string, b: string): number {
	return a < b ? -1 : a > b ? 1 : 0;
}

function byTable(a: ObservedRowCountSnapshot, b: ObservedRowCountSnapshot): number {
	return compareText(a.schemaName, b.schemaName) || compareText(a.tableName, b.tableName);
}

/**
 * The cardinality-feedback overlay: table sizes learned from execution
 * (docs/progressive-optimizer.md §3.9). Non-deterministic — its output is session
 * state, and a deterministic zero-argument call could be folded into a cached plan.
 * Runs under the caller's exec mutex, so it reads the manager directly and must
 * never issue a nested `db.eval` / `db.exec`.
 */
export const cardinalityFeedbackFunc = createIntegratedTableValuedFunction(
	{
		name: 'cardinality_feedback',
		numArgs: 0,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'schema_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'table_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'observed_rows', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'lower_bound_rows', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'catalog_rows', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: true, isReadOnly: true }, generated: true },
				{ name: 'baseline_rows', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'observations', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'shifts', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			keys: [[{ index: 0 }, { index: 1 }]],
		},
	},
	async function* (db: Database): AsyncIterable<Row> {
		for (const entry of db._cardinalityFeedback.snapshot().sort(byTable)) {
			// NOTE: catalog_rows relays `getStatistics`' rowCount, documented as "exact or estimated"
			// and, unlike a `getRowCount` answer, not validated as a whole number. A module reporting
			// a fractional estimate would trip QUEREUS_REPR_STRICT here (and at baseline_rows, which
			// can inherit it); if one legitimately does, round where statistics are ingested rather
			// than loosening these declarations.
			yield [
				entry.schemaName,
				entry.tableName,
				entry.rows ?? null,
				entry.atLeast ?? null,
				entry.catalogRows ?? null,
				entry.baselineRows,
				entry.observations,
				entry.shifts,
			];
		}
	}
);

/** One remembered column set, with the table it belongs to, for ordering and output. */
interface KeyRow {
	readonly table: ObservedRowCountSnapshot;
	readonly perKey: ObservedRowsPerKeySnapshot;
	readonly keyColumns: string;
}

function byTableThenKey(a: KeyRow, b: KeyRow): number {
	return byTable(a.table, b.table) || compareText(a.keyColumns, b.keyColumns);
}

/**
 * The overlay's rows per key: for each remembered table, the running mean of rows one
 * key matched per equality column set seeked through a non-unique index
 * (docs/progressive-optimizer.md §3.9). Same contract as {@link cardinalityFeedbackFunc}.
 */
export const cardinalityFeedbackKeysFunc = createIntegratedTableValuedFunction(
	{
		name: 'cardinality_feedback_keys',
		numArgs: 0,
		deterministic: false,
		returnType: {
			typeClass: 'relation',
			isReadOnly: true,
			isSet: false,
			columns: [
				{ name: 'schema_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'table_name', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'key_columns', type: { typeClass: 'scalar', logicalType: TEXT_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'rows_per_key', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'samples', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'baseline_rows_per_key', type: { typeClass: 'scalar', logicalType: REAL_TYPE, nullable: false, isReadOnly: true }, generated: true },
				{ name: 'shifts', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
			],
			keys: [],
			rowConstraints: []
		},
		relationalAdvertisement: {
			isSet: true,
			keys: [[{ index: 0 }, { index: 1 }, { index: 2 }]],
		},
	},
	async function* (db: Database): AsyncIterable<Row> {
		const rows: KeyRow[] = [];
		for (const table of db._cardinalityFeedback.snapshot()) {
			for (const perKey of table.perKey) rows.push({ table, perKey, keyColumns: perKey.keyColumns.join(',') });
		}
		for (const { table, perKey, keyColumns } of rows.sort(byTableThenKey)) {
			yield [
				table.schemaName,
				table.tableName,
				keyColumns,
				perKey.rowsPerKey,
				perKey.samples,
				perKey.baselineRowsPerKey,
				perKey.shifts,
			];
		}
	}
);
