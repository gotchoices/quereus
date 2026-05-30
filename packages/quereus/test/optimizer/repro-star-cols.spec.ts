import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { buildBlock } from '../../src/planner/building/block.js';
import { analyzeChangeScope } from '../../src/planner/analysis/change-scope.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';

function analyzedPlan(db: Database, sql: string): PlanNode {
	const parser = new Parser();
	const ast = parser.parse(sql) as AST.Statement;
	const globalScope = new GlobalScope(db.schemaManager);
	const parameterScope = new ParameterScope(globalScope);
	const ctx: PlanningContext = {
		db,
		schemaManager: db.schemaManager,
		parameters: {},
		scope: parameterScope,
		cteNodes: new Map(),
		schemaDependencies: new BuildTimeDependencyTracker(),
		schemaCache: new Map(),
		cteReferenceCache: new Map(),
		outputScopes: new Map(),
	};
	const plan = buildBlock(ctx, [ast]);
	return db.optimizer.optimizeForAnalysis(plan, db) as unknown as PlanNode;
}

describe('REPRO star cols', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('select * from Entity where id = 200 → columns', async () => {
		await db.exec('CREATE TABLE Entity (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER) USING memory');
		const scope = analyzeChangeScope(analyzedPlan(db, 'select * from Entity where id = 200'));
		const w = scope.watches[0];
		console.log('STAR columns =', w.columns === 'all' ? 'all' : [...w.columns]);
		console.log('STAR scope =', JSON.stringify(w.scope));
	});

	it('select name from Entity where id = 200 → columns', async () => {
		await db.exec('CREATE TABLE Entity (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER) USING memory');
		const scope = analyzeChangeScope(analyzedPlan(db, 'select name from Entity where id = 200'));
		const w = scope.watches[0];
		console.log('EXPLICIT columns =', w.columns === 'all' ? 'all' : [...w.columns]);
	});
});
