import type { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { BestAccessPlanRequest, BestAccessPlanResult, PredicateConstraint } from '../../src/vtab/best-access-plan.js';
import type { TableSchema } from '../../src/schema/table.js';

function withoutCollation(filter: PredicateConstraint): PredicateConstraint {
	const { collation: _collation, ...rest } = filter;
	return rest;
}

/**
 * The stock memory module with `PredicateConstraint.collation` hidden from it, so it plans
 * like a module written before the field existed: it offers seeks and ordering claims a
 * predicate's collation rules out. Tests over it exercise the engine's own collation
 * checks, which are the backstop for every such module.
 */
export class CollationBlindMemoryModule extends MemoryTableModule {
	override getBestAccessPlan(db: Database, tableInfo: TableSchema, request: BestAccessPlanRequest): BestAccessPlanResult {
		return super.getBestAccessPlan(db, tableInfo, { ...request, filters: request.filters.map(withoutCollation) });
	}
}
