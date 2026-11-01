import type { Row } from '../../common/types.js';
import { createIntegratedTableValuedFunction } from '../registration.js';
import type { Database } from '../../core/database.js';
import type { ObservedRowCountSnapshot } from '../../core/database-cardinality-feedback.js';
import { INTEGER_TYPE, TEXT_TYPE } from '../../types/builtin-types.js';

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
				{ name: 'observed_rows', type: { typeClass: 'scalar', logicalType: INTEGER_TYPE, nullable: false, isReadOnly: true }, generated: true },
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
			yield [
				entry.schemaName,
				entry.tableName,
				entry.rows,
				entry.catalogRows ?? null,
				entry.baselineRows,
				entry.observations,
				entry.shifts,
			];
		}
	}
);
