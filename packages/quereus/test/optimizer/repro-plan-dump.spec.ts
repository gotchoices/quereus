import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { buildBlock } from '../../src/planner/building/block.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';

function analyzedPlan(db: Database, sql: string): PlanNode {
	const parser = new Parser();
	const ast = parser.parse(sql) as AST.Statement;
	const ctx: PlanningContext = {
		db, schemaManager: db.schemaManager, parameters: {},
		scope: new ParameterScope(new GlobalScope(db.schemaManager)),
		cteNodes: new Map(), schemaDependencies: new BuildTimeDependencyTracker(),
		schemaCache: new Map(), cteReferenceCache: new Map(), outputScopes: new Map(),
	};
	return db.optimizer.optimizeForAnalysis(buildBlock(ctx, [ast]), db) as unknown as PlanNode;
}

function dump(node: any, depth = 0): void {
	const attrs = typeof node.getAttributes === 'function' ? node.getAttributes().map((a: any) => `${a.name}#${a.id}`).join(',') : '-';
	console.log('  '.repeat(depth) + `${node.nodeType} [attrs: ${attrs}]`);
	for (const c of node.getChildren()) dump(c, depth + 1);
	for (const r of (node.getRelations ? node.getRelations() : [])) {}
}

describe('REPRO plan dump', () => {
	it('dumps select * plan', async () => {
		const db = new Database();
		await db.exec('CREATE TABLE Entity (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER) USING memory');
		console.log('=== select * from Entity where id = 200 ===');
		dump(analyzedPlan(db, 'select * from Entity where id = 200'));
		console.log('=== select name from Entity where id = 200 ===');
		dump(analyzedPlan(db, 'select name from Entity where id = 200'));
		await db.close();
	});
});
