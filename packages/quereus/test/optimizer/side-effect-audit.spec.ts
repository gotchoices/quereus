/**
 * Audit fixtures for the side-effect awareness discipline (`2-query-expr-side-effect-audit`).
 *
 * Every rule that moves, duplicates, drops, or merges a subtree must consult
 * `PlanNodeCharacteristics.hasSideEffects` (or `subtreeHasSideEffects`) and
 * refuse / weaken when any participating subtree carries a write.
 *
 * These fixtures use FROM-position DML — `INSERT ... RETURNING *` materialized
 * as a relational source — to plant a side-effect-bearing subtree where a
 * rule would otherwise have happily dropped / reordered / dedup-merged it.
 * They assert the **negative cases**: the rewrite must not fire. The matching
 * positive cases are covered by each rule's existing spec (where a pure subtree
 * lets the rule fire normally).
 *
 * The propagation pin and the registry rejection test live here too.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PassManager, createPass, TraversalOrder } from '../../src/planner/framework/pass.js';
import { PlanNodeType } from '../../src/planner/nodes/plan-node-type.js';
import type { RuleHandle } from '../../src/planner/framework/registry.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { PlanNodeCharacteristics } from '../../src/planner/framework/characteristics.js';

interface PlanRow {
	node_type: string;
	op: string;
	detail: string;
	properties: string | null;
	physical: string | null;
}

async function planRows(db: Database, sql: string): Promise<PlanRow[]> {
	const rows: PlanRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, properties, physical FROM query_plan(?)',
		[sql],
	)) {
		rows.push(r as unknown as PlanRow);
	}
	return rows;
}

function hasOp(rows: readonly PlanRow[], op: string): boolean {
	return rows.some(r => r.op === op);
}

async function setupBase(db: Database): Promise<void> {
	await db.exec(
		'CREATE TABLE writes_log (id INTEGER PRIMARY KEY, x INTEGER NOT NULL) USING memory',
	);
	await db.exec(
		'CREATE TABLE seed (id INTEGER PRIMARY KEY, x INTEGER NOT NULL) USING memory',
	);
	await db.exec('INSERT INTO seed VALUES (1, 10), (2, 20), (3, 30)');
}

describe('Side-effect audit: rules must refuse on impure subtrees', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	describe('Empty-relation / contradiction folds', () => {
		it('Filter(InsertReturning, false) does NOT fold to EmptyRelation', async () => {
			await setupBase(db);
			// FROM-position DML: a SELECT whose source is a RETURNING-bearing
			// INSERT. The outer `where false` would normally fold the whole
			// subtree to EmptyRelation; the audit forbids that because it would
			// silently skip the INSERT.
			const q = `select * from (insert into writes_log (id, x)
				select id, x from seed returning id) z where false`;
			const plan = await planRows(db, q);
			// The fold must NOT have replaced the INSERT with an EmptyRelation
			// host carrying writes_log's attributes.
			expect(hasOp(plan, 'EMPTYRELATION'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(false);
		});
	});

	describe('Join folds / eliminations', () => {
		it('cross join with empty side does NOT fold when other side has side effects', async () => {
			await setupBase(db);
			const q = `select * from (insert into writes_log (id, x)
				select id, x from seed returning id) z cross join (select * from seed where false) e`;
			const plan = await planRows(db, q);
			// The other side is EmptyRelation, but the InsertReturning side has
			// side effects, so the cross-join fold must abstain.
			expect(hasOp(plan, 'INSERT')).to.equal(true);
		});
	});

	describe('Propagation', () => {
		it('plan walk surfaces a FROM-position INSERT in the plan tree', async () => {
			// A node whose physical.readonly is undefined-with-children inherits
			// AND-of-children, so a Sink (write) wrapped in pure relational ops
			// reports hasSideEffects=true at the root via the unified surface.
			// Here we verify the precondition that the plan still contains the
			// INSERT (i.e. nothing in the audit discipline elided it before the
			// runtime can fire); the per-rule audits above pin specific cases.
			await setupBase(db);
			const q = `select * from (insert into writes_log (id, x) values (99, 99) returning id) z`;
			const plan = await planRows(db, q);
			expect(hasOp(plan, 'INSERT'), `plan ops=${plan.map(r => r.op).join(',')}`).to.equal(true);
		});
	});
});

describe('Registry guardrail: unannotated rules are rejected', () => {
	it('PassManager.addRuleToPass rejects a rule missing sideEffectMode', () => {
		const pass = createPass(
			'audit-test',
			'Audit test',
			'Synthesizes a rule registration to validate the guardrail',
			0,
			TraversalOrder.TopDown,
		);
		const pm = new PassManager([]);
		pm.registerPass(pass);

		const unannotated = {
			id: 'unannotated-rule',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: (n: PlanNode) => n,
		} as unknown as RuleHandle;

		expect(() => pm.addRuleToPass('audit-test', unannotated))
			.to.throw(/sideEffectMode/);
	});

	it('accepts a rule that declares safe', () => {
		const pass = createPass(
			'audit-test-safe',
			'Audit test safe',
			'',
			0,
			TraversalOrder.TopDown,
		);
		const pm = new PassManager([]);
		pm.registerPass(pass);
		expect(() => pm.addRuleToPass('audit-test-safe', {
			id: 'rule-safe',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: () => null,
			sideEffectMode: 'safe',
		})).to.not.throw();
	});

	it('accepts a rule that declares aware', () => {
		const pass = createPass(
			'audit-test-aware',
			'Audit test aware',
			'',
			0,
			TraversalOrder.TopDown,
		);
		const pm = new PassManager([]);
		pm.registerPass(pass);
		expect(() => pm.addRuleToPass('audit-test-aware', {
			id: 'rule-aware',
			nodeType: PlanNodeType.Filter,
			phase: 'rewrite',
			fn: () => null,
			sideEffectMode: 'aware',
		})).to.not.throw();
	});
});

describe('subtreeHasSideEffects helper', () => {
	it('reports true when any descendant has readonly=false', () => {
		// Build a minimal plan-node mock tree: Project → Filter → Sink (write).
		const writeLeaf = {
			physical: { readonly: false, deterministic: true },
			getChildren: () => [],
		} as unknown as PlanNode;
		const filter = {
			physical: { readonly: false, deterministic: true },
			getChildren: () => [writeLeaf],
		} as unknown as PlanNode;
		const project = {
			physical: { readonly: false, deterministic: true },
			getChildren: () => [filter],
		} as unknown as PlanNode;

		expect(PlanNodeCharacteristics.subtreeHasSideEffects(project)).to.equal(true);
	});

	it('reports false on a pure subtree', () => {
		const leaf = {
			physical: { readonly: true, deterministic: true },
			getChildren: () => [],
		} as unknown as PlanNode;
		const project = {
			physical: { readonly: true, deterministic: true },
			getChildren: () => [leaf],
		} as unknown as PlanNode;

		expect(PlanNodeCharacteristics.subtreeHasSideEffects(project)).to.equal(false);
	});

	it('reports true when the local node is pure but a deep descendant writes', () => {
		const writeLeaf = {
			physical: { readonly: false },
			getChildren: () => [],
		} as unknown as PlanNode;
		// Pure wrapper that fails to propagate readonly=false to its own
		// physical (defensive belt — the AND-of-children defaults are normally
		// applied, but a custom computePhysical override could lie).
		const lyingWrapper = {
			physical: { readonly: true },
			getChildren: () => [writeLeaf],
		} as unknown as PlanNode;
		expect(PlanNodeCharacteristics.subtreeHasSideEffects(lyingWrapper)).to.equal(true);
	});
});
