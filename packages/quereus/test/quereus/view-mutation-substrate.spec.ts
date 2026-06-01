import { describe, it } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { BuildTimeDependencyTracker, type PlanningContext } from '../../src/planner/planning-context.js';
import { GlobalScope } from '../../src/planner/scopes/global.js';
import { ParameterScope } from '../../src/planner/scopes/param.js';
import { buildInsertStmt } from '../../src/planner/building/insert.js';
import { buildUpdateStmt } from '../../src/planner/building/update.js';
import { buildDeleteStmt } from '../../src/planner/building/delete.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import { ViewMutationNode } from '../../src/planner/nodes/view-mutation-node.js';
import type { DmlExecutorNode } from '../../src/planner/nodes/dml-executor-node.js';
import { isRelationalNode, type PlanNode } from '../../src/planner/nodes/plan-node.js';
import type * as AST from '../../src/parser/ast.js';

/**
 * Parity gate for the view-mutation substrate (ticket 3.1).
 *
 * A single-source projection-and-filter view write must plan to a single
 * `ViewMutationNode` over exactly one base op, and the wrapped base-table DML
 * subtree must still carry the real `DmlExecutorNode` on the underlying base
 * table — the structural proof that the substrate reuses the base-table builder
 * verbatim (the retired AST rewrite's output, wrapped).
 */
describe('View Mutation Substrate (single-source parity)', () => {
	async function ctxFor(): Promise<PlanningContext> {
		const db = new Database();
		await db.exec(`create table t (id integer primary key, name text, color text)`);
		await db.exec(`create view gv as select id, name from t where color = 'green'`);
		// Assemble a root planning context the same way Statement compilation does.
		const parameterScope = new ParameterScope(new GlobalScope(db.schemaManager));
		return {
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
	}

	/** Depth-first search for the first DmlExecutorNode in a plan subtree. */
	function findDmlExecutor(node: PlanNode): DmlExecutorNode | undefined {
		if (node.nodeType === PlanNodeType.UpdateExecutor) return node as DmlExecutorNode;
		for (const child of node.getChildren()) {
			const found = findDmlExecutor(child);
			if (found) return found;
		}
		return undefined;
	}

	function assertSingleSourceSubstrate(plan: PlanNode, expectedBase: string): void {
		expect(plan.nodeType).to.equal(PlanNodeType.ViewMutation);
		const vm = plan as ViewMutationNode;
		expect(vm.baseOps.length).to.equal(1);
		const dml = findDmlExecutor(vm);
		expect(dml, 'wrapped DmlExecutorNode present').to.not.equal(undefined);
		expect(dml!.table.tableSchema.name).to.equal(expectedBase);
	}

	it('insert through a view builds a ViewMutationNode over one base op on the base table', async () => {
		const ctx = await ctxFor();
		const ast = new Parser().parseAll(`insert into gv (id, name) values (1, 'bob')`)[0] as AST.InsertStmt;
		assertSingleSourceSubstrate(buildInsertStmt(ctx, ast), 't');
	});

	it('update through a view builds a ViewMutationNode over one base op on the base table', async () => {
		const ctx = await ctxFor();
		const ast = new Parser().parseAll(`update gv set name = 'x' where id = 1`)[0] as AST.UpdateStmt;
		assertSingleSourceSubstrate(buildUpdateStmt(ctx, ast), 't');
	});

	it('delete through a view builds a ViewMutationNode over one base op on the base table', async () => {
		const ctx = await ctxFor();
		const ast = new Parser().parseAll(`delete from gv where id = 1`)[0] as AST.DeleteStmt;
		assertSingleSourceSubstrate(buildDeleteStmt(ctx, ast), 't');
	});

	it('builds a relational ViewMutationNode for single-source RETURNING-through-view', async () => {
		const ctx = await ctxFor();
		const ast = new Parser().parseAll(`insert into gv (id, name) values (1, 'bob') returning id, name`)[0] as AST.InsertStmt;
		const plan = buildInsertStmt(ctx, ast);
		expect(plan.nodeType).to.equal(PlanNodeType.ViewMutation);
		const vm = plan as ViewMutationNode;
		// The node is relational: its row type / attributes are the view-projected
		// RETURNING columns (named as the user wrote them).
		expect(vm.getType().typeClass).to.equal('relation');
		expect(vm.getAttributes().map(a => a.name)).to.deep.equal(['id', 'name']);
		// Single-source: the RETURNING rides the (sole) base op, which is now relational.
		expect(vm.returning, 'no separate re-query node for single-source').to.equal(undefined);
		expect(vm.baseOps.some(op => isRelationalNode(op)), 'base op carries the RETURNING projection').to.equal(true);
		// And it still wraps the real base-table DmlExecutorNode on the base table.
		const dml = findDmlExecutor(vm);
		expect(dml!.table.tableSchema.name).to.equal('t');
	});
});
