import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { WindowNode } from '../../src/planner/nodes/window-node.js';
import type { RelationType } from '../../src/common/datatype.js';

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

	/** Logical type names of the topmost relation's output columns in the plan. */
	function getProjectionColumnTypes(sql: string): Array<{ name: string; type: string }> {
		const plan = db.getPlan(sql) as PlanNode;
		const stack: PlanNode[] = [plan];
		while (stack.length > 0) {
			const node = stack.pop();
			if (!node || typeof node !== 'object') continue;

			const t = node.getType?.();
			if (t && t.typeClass === 'relation') {
				const rel = t as RelationType;
				if (rel.columns.length > 0) {
					return rel.columns.map(c => ({ name: c.name, type: String(c.type.logicalType.name) }));
				}
			}

			if (typeof node.getChildren === 'function') {
				for (const child of node.getChildren()) {
					stack.push(child);
				}
			}
		}
		return [];
	}

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

	it('derives MIN/MAX window return type from a TEXT argument', async () => {
		const sql = 'select min(v) over () as mn, max(v) over () as mx from t';
		const types = getWindowFunctionTypesFromPlan(sql);

		expect(types.some(t => t.fn.toLowerCase() === 'min' && t.resultType === 'TEXT'), JSON.stringify(types)).to.equal(true);
		expect(types.some(t => t.fn.toLowerCase() === 'max' && t.resultType === 'TEXT'), JSON.stringify(types)).to.equal(true);
	});

	it('derives MIN/MAX window return type from an INTEGER argument', async () => {
		const sql = 'select min(id) over () as mn, max(id) over () as mx from t';
		const types = getWindowFunctionTypesFromPlan(sql);

		expect(types.some(t => t.fn.toLowerCase() === 'min' && t.resultType === 'INTEGER'), JSON.stringify(types)).to.equal(true);
		expect(types.some(t => t.fn.toLowerCase() === 'max' && t.resultType === 'INTEGER'), JSON.stringify(types)).to.equal(true);
	});

	it('derives MIN window return type from an expression argument', async () => {
		// `id || ''` is a concat expression typed TEXT, distinct from both the
		// INTEGER column type and the REAL fallback — so a TEXT result proves the
		// built expression's logical type flows through, not just a bare column ref.
		const sql = "select min(id || '') over () as mn from t";
		const types = getWindowFunctionTypesFromPlan(sql);

		expect(types.some(t => t.fn.toLowerCase() === 'min' && t.resultType === 'TEXT'), JSON.stringify(types)).to.equal(true);
	});

	it('flows MIN window TEXT type through a surrounding expression', async () => {
		// `min(v) over () || '!'` — the outer concat must type as TEXT, which only
		// holds if the WindowFunctionCallNode built on the projection/expression
		// side (expression.ts) also derives its argument type. Pins the gap the
		// implementer flagged: the expression-tree path, not just the WindowNode.
		const cols = getProjectionColumnTypes("select min(v) over () || '!' as c from t");
		expect(cols.some(c => c.name === 'c' && c.type === 'TEXT'), JSON.stringify(cols)).to.equal(true);
	});

	it('returns the argument value (not a float coercion) for MIN/MAX over TEXT/INTEGER at runtime', async () => {
		// End-to-end: the REAL→argument-type tightening must not float-coerce the
		// emitted window value. step/final pass the value through unchanged.
		async function one(sql: string): Promise<Record<string, unknown>> {
			for await (const r of db.eval(sql)) return r;
			throw new Error('no row');
		}

		const text = await one("select min(v) over () as mn, max(v) over () as mx from t");
		expect(text.mn).to.equal('a'); // TEXT preserved, not coerced toward a number
		expect(text.mx).to.equal('c');

		const int = await one('select min(id) over () as mn, max(id) over () as mx from t');
		expect(Number(int.mn)).to.equal(1);
		expect(Number(int.mx)).to.equal(3);
	});

	it('leaves non-polymorphic window functions at their declared returnType', async () => {
		// Regression: only MIN/MAX gained inferReturnType; SUM stays REAL, COUNT
		// stays INTEGER, ROW_NUMBER stays INTEGER even though argTypes now flow in.
		const sql = 'select sum(id) over () as s, count(id) over () as c, row_number() over (order by id) as rn from t';
		const types = getWindowFunctionTypesFromPlan(sql);

		expect(types.some(t => t.fn.toLowerCase() === 'sum' && t.resultType === 'REAL'), JSON.stringify(types)).to.equal(true);
		expect(types.some(t => t.fn.toLowerCase() === 'count' && t.resultType === 'INTEGER'), JSON.stringify(types)).to.equal(true);
		expect(types.some(t => t.fn.toLowerCase() === 'row_number' && t.resultType === 'INTEGER'), JSON.stringify(types)).to.equal(true);
	});
});

