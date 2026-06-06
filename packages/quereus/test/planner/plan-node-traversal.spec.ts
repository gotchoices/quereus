import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';

describe('PlanNode: visit and getTotalCost traversal', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, v text) using memory');
		await db.exec("insert into t values (1, 'a'), (2, 'b'), (3, 'c')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('visit() should not visit any node more than once', () => {
		// FilterNode has getChildren() = [source, predicate], getRelations() = [source]
		// If visit() iterates both, source subtree gets visited twice
		const plan = db.getPlan('select * from t where id > 1');

		const visitCounts = new Map<PlanNode, number>();
		plan.visit((node) => {
			visitCounts.set(node, (visitCounts.get(node) || 0) + 1);
		});

		for (const [node, count] of visitCounts) {
			expect(count, `Node ${node.nodeType} [${node.id}] visited ${count} times`).to.equal(1);
		}
	});

	it('getTotalCost() should equal estimatedCost + sum of children getTotalCost()', () => {
		// For any node, cost should be purely additive through getChildren()
		// The current bug multiplies by getRelations() cost, double-counting
		const plan = db.getPlan('select * from t where id > 1');

		const stack: PlanNode[] = [plan];
		while (stack.length > 0) {
			const node = stack.pop()!;
			const children = node.getChildren();
			const expectedTotal = node.estimatedCost + children.reduce(
				(sum, child) => sum + child.getTotalCost(), 0
			);

			expect(node.getTotalCost(),
				`Node ${node.nodeType} [${node.id}]: getTotalCost() should be additive`
			).to.equal(expectedTotal);

			for (const child of children) {
				stack.push(child);
			}
		}
	});

	it('visit() should not double-visit with subquery nodes', () => {
		// ExistsNode/ScalarSubqueryNode have getChildren() = [subquery],
		// getRelations() = [subquery] — same node in both
		const plan = db.getPlan('select * from t where exists (select 1 from t as t2 where t2.id = t.id)');

		const visitCounts = new Map<PlanNode, number>();
		plan.visit((node) => {
			visitCounts.set(node, (visitCounts.get(node) || 0) + 1);
		});

		for (const [node, count] of visitCounts) {
			expect(count, `Node ${node.nodeType} [${node.id}] visited ${count} times`).to.equal(1);
		}
	});
});
