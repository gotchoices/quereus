/**
 * Emitter for the ANALYZE statement.
 * Collects statistics from VTab instances and caches on TableSchema.
 */

import type { EmissionContext } from '../emission-context.js';
import type { AnalyzePlanNode } from '../../planner/nodes/analyze-node.js';
import type { Instruction, RuntimeContext } from '../types.js';
import { asRun } from '../types.js';
import type { Row } from '../../common/types.js';
import type { TableSchema } from '../../schema/table.js';
import { requireVtabModule } from '../../schema/table.js';
import type { BaseModuleConfig } from '../../vtab/module.js';
import type { TableStatistics } from '../../planner/stats/catalog-stats.js';
import { createLogger } from '../../common/logger.js';
import { collectStatisticsFromScan } from '../../planner/stats/analyze.js';

const log = createLogger('runtime:emit:analyze');

export function emitAnalyze(plan: AnalyzePlanNode, _ctx: EmissionContext): Instruction {
	const run = async function* (rctx: RuntimeContext): AsyncIterable<Row> {
		const schemaManager = rctx.db.schemaManager;
		const targetSchemaName = plan.targetSchemaName ?? 'main';
		const schema = schemaManager.getSchema(targetSchemaName);

		if (!schema) {
			log('Schema %s not found, nothing to analyze', targetSchemaName);
			return;
		}

		const tables: TableSchema[] = [];
		if (plan.targetTableName) {
			const table = schemaManager._findTable(plan.targetTableName, targetSchemaName);
			if (table) tables.push(table);
		} else {
			for (const table of schema.getAllTables()) {
				if (!table.isView) tables.push(table);
			}
		}

		for (const tableSchema of tables) {
			log('Analyzing table %s.%s', tableSchema.schemaName, tableSchema.name);

			try {
				// Connect to the table to get a VTable instance
				const module = requireVtabModule(tableSchema);
				if (typeof module.connect !== 'function') continue;

				const options: BaseModuleConfig = tableSchema.vtabArgs ?? {};
				const vtab = await module.connect(
					rctx.db,
					tableSchema.vtabAuxData,
					tableSchema.vtabModuleName,
					tableSchema.schemaName,
					tableSchema.name,
					options,
				);

				try {
					const stats: TableStatistics | undefined = typeof vtab.getStatistics === 'function'
						? await vtab.getStatistics()
						: await collectStatisticsFromScan(vtab, tableSchema) ?? undefined;

					if (stats) {
						log('Collected statistics for %s: %d rows', tableSchema.name, stats.rowCount);
						// Create a new schema with statistics (honor immutability of frozen schemas)
						const updatedTableSchema: TableSchema = { ...tableSchema, statistics: stats };
						schema.addTable(updatedTableSchema);
						schemaManager.getChangeNotifier().notifyChange({
							type: 'table_modified',
							schemaName: tableSchema.schemaName,
							objectName: tableSchema.name,
							oldObject: tableSchema,
							newObject: updatedTableSchema,
						});
						yield [tableSchema.name, stats.rowCount];
					}
				} finally {
					await vtab.disconnect();
				}
			} catch (e) {
				log('Failed to analyze %s: %s', tableSchema.name, e);
				// Continue with other tables on failure
			}
		}
	};

	return {
		params: [],
		run: asRun(run),
		note: `ANALYZE ${plan.targetTableName ?? 'all tables'}`
	};
}
