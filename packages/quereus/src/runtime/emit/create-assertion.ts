import type { CreateAssertionNode } from '../../planner/nodes/create-assertion-node.js';
import type { Instruction, RuntimeContext, InstructionRun } from '../types.js';
import type { EmissionContext } from '../emission-context.js';
import { QuereusError } from '../../common/errors.js';
import { SqlValue, StatusCode } from '../../common/types.js';
import { createLogger } from '../../common/logger.js';
import type { IntegrityAssertionSchema, AssertionDependentTable } from '../../schema/assertion.js';
import { expressionToString } from '../../emit/ast-stringify.js';

const log = createLogger('runtime:emit:create-assertion');

export function emitCreateAssertion(plan: CreateAssertionNode, _ctx: EmissionContext): Instruction {

	async function run(rctx: RuntimeContext): Promise<SqlValue> {
		// Ensure we're in a transaction before DDL (lazy/JIT transaction start)
		await rctx.db._ensureTransaction();

		// Convert the CHECK expression to SQL text for storage
		// The CHECK expression should be negated to become a violation query:
		// check (condition) becomes "select 1 where not (condition)"
		let violationSql: string;
		try {
			const exprSql = expressionToString(plan.checkExpression);
			violationSql = `select 1 where not (${exprSql})`;
		} catch (e) {
			throw new QuereusError(
				`Cannot create assertion '${plan.name}': failed to convert check expression to SQL`,
				StatusCode.ERROR,
				e instanceof Error ? e : undefined
			);
		}

		// Create the assertion schema object
		const assertionSchema: IntegrityAssertionSchema = {
			name: plan.name,
			violationSql,
			deferrable: true, // Auto-deferred for multi-table constraints
			initiallyDeferred: true,
			dependentTables: []
		};

		// Discover dependent base tables (best-effort; conservative if any failure)
		try {
			const planNode = rctx.db.getPlan(violationSql);
			const deps = new Map<string, AssertionDependentTable>();
			(function collect(node: unknown) {
				const candidate = node as {
					getRelations?: () => Iterable<unknown>;
					tableSchema?: { name?: string; schemaName?: string };
					id?: unknown;
				};
				if (candidate && typeof candidate.getRelations === 'function') {
					for (const child of candidate.getRelations()) collect(child);
				}
				if (candidate?.tableSchema?.name && candidate?.id !== undefined) {
					const base = `${candidate.tableSchema.schemaName}.${candidate.tableSchema.name}`.toLowerCase();
					const relationKey = `${base}#${String(candidate.id)}`;
					if (!deps.has(relationKey)) deps.set(relationKey, { relationKey, base });
				}
			})(planNode);
			assertionSchema.dependentTables = Array.from(deps.values());
			log('Assertion %s dependencies discovered: %o', plan.name, assertionSchema.dependentTables);
		} catch (depErr) {
			log('Dependency discovery failed for assertion %s: %O', plan.name, depErr);
		}

		// Add to schema
		const schemaManager = rctx.db.schemaManager;
		const schema = schemaManager.getMainSchema(); // Store in main schema for now

		// Check for existing assertion
		const existing = schema.getAssertion(plan.name);
		if (existing) {
			throw new QuereusError(
				`Assertion ${plan.name} already exists`,
				StatusCode.CONSTRAINT
			);
		}

		schema.addAssertion(assertionSchema);

		log('Created assertion %s with violationSql: %s', plan.name, violationSql);
		return null;
	}

	return {
		params: [],
		run: run as InstructionRun,
		note: `createAssertion(${plan.name})`
	};
}
