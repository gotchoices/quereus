import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { WindowNode } from '../../src/planner/nodes/window-node.js';

describe('Planner: window function types', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v text) using memory');
		await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");
	});

	afterEach(async () => {
		await db.close();
	});

	function getWindowFunctionTypesFromPlan(sql: string): Array<{ fn: string; resultType: string }> {
		const plan = db.getPlan(sql) as PlanNode;

		const windows: WindowNode[] = [];
		const stack: PlanNode[] = [plan];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node || typeof node !== 'object') continue;

			if (node.nodeType === PlanNodeType.Window) {
				windows.push(node as WindowNode);
			}

			if (typeof node.getChildren === 'function') {
				for (const child of node.getChildren()) {
					stack.push(child);
				}
			}
		}

		const out: Array<{ fn: string; resultType: string }> = [];
		for (const w of windows) {
			for (const f of (w.functions ?? [])) {
				out.push({ fn: String(f.functionName), resultType: String(f.getType().logicalType.name) });
			}
		}
		return out;
	}

	it('uses schema returnType for ranking window functions', async () => {
		const sql = 'select row_number() over (order by id) as rn, rank() over (order by id) as r from t';
		const types = getWindowFunctionTypesFromPlan(sql);

		expect(types.some(t => t.fn.toLowerCase() === 'row_number' && t.resultType === 'INTEGER'), JSON.stringify(types)).to.equal(true);
		expect(types.some(t => t.fn.toLowerCase() === 'rank' && t.resultType === 'INTEGER'), JSON.stringify(types)).to.equal(true);
	});

	it('uses schema returnType for aggregate window functions', async () => {
		const sql = 'select sum(id) over () as s, count(v) over () as c from t';
		const types = getWindowFunctionTypesFromPlan(sql);

		expect(types.some(t => t.fn.toLowerCase() === 'sum' && t.resultType === 'REAL')).to.equal(true);
		expect(types.some(t => t.fn.toLowerCase() === 'count' && t.resultType === 'INTEGER')).to.equal(true);
	});
});

