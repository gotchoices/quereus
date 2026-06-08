import type { AddConstraintNode } from '../../planner/nodes/add-constraint-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import { opsToMask } from '../../schema/table.js';

const log = createLogger('runtime:emit:add-constraint');

export function emitAddConstraint(plan: AddConstraintNode, _ctx: EmissionContext): Instruction {
	const tableSchema = plan.table.tableSchema;

	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start).
		await rctx.db._ensureTransaction();

		const constraint = plan.constraint;
		const schemaManager = rctx.db.schemaManager;
		const schema = schemaManager.getSchemaOrFail(tableSchema.schemaName);

		if (constraint.type === 'check') {
			return runAddCheck(rctx, tableSchema, schema, constraint);
		}

		return runAddConstraintViaModule(rctx, tableSchema, schema, constraint);
	}

	return {
		params: [],
		run: run as InstructionRun,
		note: `addConstraint(${plan.table.tableSchema.name}, ${plan.constraint.name || 'unnamed'})`
	};
}

async function runAddCheck(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	constraint: AddConstraintNode['constraint'],
): Promise<SqlValue> {
	if (!constraint.expr) {
		throw new QuereusError(
			'CHECK constraint requires an expression',
			StatusCode.ERROR
		);
	}

	// Note: We don't validate determinism here because constraints may reference NEW/OLD
	// which require special scoping. Determinism is validated at INSERT/UPDATE plan time
	// in constraint-builder.ts when the constraint is actually checked.
	const constraintSchema: RowConstraintSchema = {
		name: constraint.name || `check_${tableSchema.checkConstraints.length}`,
		expr: constraint.expr,
		operations: opsToMask(constraint.operations),
	};

	const updatedConstraints = [...tableSchema.checkConstraints, constraintSchema];
	const updatedTableSchema: TableSchema = {
		...tableSchema,
		checkConstraints: Object.freeze(updatedConstraints),
	};

	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema
	});

	log('Added CHECK constraint %s to table %s.%s', constraintSchema.name, tableSchema.schemaName, tableSchema.name);

	return null;
}

async function runAddConstraintViaModule(
	rctx: RuntimeContext,
	tableSchema: TableSchema,
	schema: import('../../schema/schema.js').Schema,
	constraint: AddConstraintNode['constraint'],
): Promise<SqlValue> {
	const module = tableSchema.vtabModule;
	if (!module.alterTable) {
		throw new QuereusError(
			`Module for table '${tableSchema.name}' does not support ADD CONSTRAINT`,
			StatusCode.UNSUPPORTED,
		);
	}

	const updatedTableSchema = await module.alterTable(
		rctx.db,
		tableSchema.schemaName,
		tableSchema.name,
		{ type: 'addConstraint', constraint },
	);

	schema.addTable(updatedTableSchema);

	rctx.db.schemaManager.getChangeNotifier().notifyChange({
		type: 'table_modified',
		schemaName: tableSchema.schemaName,
		objectName: tableSchema.name,
		oldObject: tableSchema,
		newObject: updatedTableSchema,
	});

	log('Added %s constraint %s to table %s.%s',
		constraint.type, constraint.name || 'unnamed', tableSchema.schemaName, tableSchema.name);

	return null;
}
