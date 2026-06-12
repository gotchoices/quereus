import type { AddConstraintNode } from '../../planner/nodes/add-constraint-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { RowConstraintSchema, TableSchema } from '../../schema/table.js';
import { opsToMask, requireVtabModule } from '../../schema/table.js';
import { validateForeignKeyCollations } from '../../schema/constraint-builder.js';

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
	const module = requireVtabModule(tableSchema);
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

	// Reject a newly-added FK whose child/parent column collations declare a same-rank
	// conflict — before swapping the schema into the catalog, so a rejected ALTER leaves
	// the table untouched. Newly-added FKs are the entries in the updated schema not present
	// by reference in the original (the module appends; it never rewrites existing entries).
	// The module-side `validateForeignKeyOverExistingRows` stays where it is — it needs a row
	// scan, this is a pure schema check. (The `foreign_keys` pragma does NOT gate this:
	// a conflicting-collation declaration is malformed regardless of enforcement.)
	const priorFks = new Set(tableSchema.foreignKeys ?? []);
	for (const fk of updatedTableSchema.foreignKeys ?? []) {
		if (priorFks.has(fk)) continue;
		validateForeignKeyCollations(rctx.db, updatedTableSchema, fk);
	}

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
