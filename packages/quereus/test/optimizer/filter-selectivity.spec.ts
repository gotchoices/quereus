/**
 * Tests for `rule-filter-selectivity` and `FilterNode.selectivity`.
 *
 * The rule (Physical pass) reads `context.stats.selectivity(table, predicate)` and
 * stamps it onto the FilterNode; `FilterNode.estimatedRows` / `computePhysical`
 * then multiply the source cardinality by that factor instead of the flat
 * DEFAULT_FILTER_SELECTIVITY (0.5).
 */
import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { PlanNode } from '../../src/planner/nodes/plan-node.js';
import type { PhysicalProperties } from '../../src/planner/nodes/plan-node.js';
import { FilterNode, DEFAULT_FILTER_SELECTIVITY } from '../../src/planner/nodes/filter.js';
import { Parser } from '../../src/parser/parser.js';
import type * as AST from '../../src/parser/ast.js';

function walk(node: PlanNode, fn: (n: PlanNode) => void): void {
	fn(node);
	for (const child of node.getChildren()) walk(child as PlanNode, fn);
}

function findFilter(root: PlanNode): FilterNode | undefined {
	let found: FilterNode | undefined;
	walk(root, (n) => { if (!found && n instanceof FilterNode) found = n; });
	return found;
}

/** Build the RAW (unoptimized) plan and return its first FilterNode. */
function rawFilter(db: Database, sql: string): FilterNode {
	const ast = new Parser().parse(sql) as AST.Statement;
	const { plan } = (db as unknown as { _buildPlan(a: AST.Statement[]): { plan: PlanNode } })._buildPlan([ast]);
	const f = findFilter(plan);
	if (!f) throw new Error('no FilterNode in raw plan');
	return f;
}

/** Optimize `sql` against the current schema and return the first FilterNode. */
function optimizedFilter(db: Database, sql: string): FilterNode | undefined {
	const plan = (db as unknown as { getPlan(s: string): PlanNode }).getPlan(sql);
	return findFilter(plan);
}

/** Physical properties stub carrying only a source cardinality. */
function srcPhysical(rows: number): PhysicalProperties {
	return { estimatedRows: rows } as PhysicalProperties;
}

describe('FilterNode selectivity mechanics (computePhysical)', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, cat TEXT) USING memory');
	});
	afterEach(async () => { await db.close(); });

	it('multiplies the physical source cardinality by the stamped selectivity', () => {
		// Non-covering predicate (cat is not a key) so the covered-key branch stays out.
		const f = rawFilter(db, "SELECT * FROM t WHERE cat = 'a'");
		const stamped = new FilterNode(f.scope, f.source, f.predicate, undefined, 0.2);
		const phys = stamped.computePhysical([srcPhysical(200)]);
		expect(phys.estimatedRows).to.equal(40); // floor(200 * 0.2)
		// ...and this is NOT the flat-0.5 estimate the old code always produced.
		expect(phys.estimatedRows).to.not.equal(Math.floor(200 * DEFAULT_FILTER_SELECTIVITY));
	});

	it('a covered unique key still forces estimatedRows = 1, overriding any selectivity', () => {
		// `id = 2` covers the PK. Stamp an intentionally huge selectivity: the
		// covered-key branch must win (1, not floor(200 * 0.9) = 180).
		const f = rawFilter(db, 'SELECT * FROM t WHERE id = 2');
		const stamped = new FilterNode(f.scope, f.source, f.predicate, undefined, 0.9);
		const phys = stamped.computePhysical([srcPhysical(200)]);
		expect(phys.estimatedRows).to.equal(1);
	});

	it('selectivity 0 floors to 1 (matches the empty-source min-1 convention)', () => {
		const f = rawFilter(db, "SELECT * FROM t WHERE cat = 'a'");
		const stamped = new FilterNode(f.scope, f.source, f.predicate, undefined, 0);
		const phys = stamped.computePhysical([srcPhysical(200)]);
		expect(phys.estimatedRows).to.equal(1);
	});
});

describe('rule-filter-selectivity (end-to-end through the optimizer)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function seed(): Promise<number> {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, cat TEXT) USING memory');
		for (let i = 1; i <= 100; i++) {
			await db.exec(`INSERT INTO t VALUES (${i}, '${['a', 'b', 'c', 'd'][i % 4]}')`);
		}
		for await (const _ of db.eval('ANALYZE t')) { /* consume */ }
		const ndv = db.schemaManager.findTable('t')?.statistics?.columnStats.get('cat')?.distinctCount;
		expect(ndv, 'ANALYZE should record a distinct count for cat').to.be.a('number');
		return ndv as number;
	}

	it('stamps 1/ndv from catalog stats and derives estimatedRows from it (not 0.5)', async () => {
		const ndv = await seed(); // 4 distinct cat values

		// `id > 5` pushes into the range seek; the residual Filter is `cat = 'a'`
		// over that seek, so its physical source carries a positive cardinality.
		const f = optimizedFilter(db, "SELECT * FROM t WHERE cat = 'a' AND id > 5");
		expect(f, 'expected a residual Filter').to.not.be.undefined;

		expect(f!.selectivity).to.be.closeTo(1 / ndv, 1e-9);

		const srcRows = f!.source.physical?.estimatedRows;
		expect(srcRows, 'source physical cardinality').to.be.a('number');
		const expected = Math.max(1, Math.floor((srcRows as number) / ndv));
		expect(f!.physical?.estimatedRows).to.equal(expected);
		// Distinct from the old flat-0.5 behaviour.
		expect(f!.physical?.estimatedRows).to.not.equal(Math.floor((srcRows as number) * DEFAULT_FILTER_SELECTIVITY));
	});

	it('falls back to naive heuristic selectivity for a stats-less table (no crash)', async () => {
		await db.exec('CREATE TABLE u (id INTEGER PRIMARY KEY, cat TEXT) USING memory');
		for (let i = 1; i <= 20; i++) {
			await db.exec(`INSERT INTO u VALUES (${i}, '${['a', 'b'][i % 2]}')`);
		}
		// No ANALYZE → no catalog stats → NaiveStatsProvider (equality BinaryOp ≈ 0.1).
		const f = optimizedFilter(db, "SELECT * FROM u WHERE cat = 'a' AND id > 3");
		expect(f, 'expected a residual Filter').to.not.be.undefined;
		expect(f!.selectivity).to.be.closeTo(0.1, 1e-9);
		expect(f!.physical?.estimatedRows).to.be.at.least(1);
	});

	it('leaves selectivity unstamped for a multi-table (join) filter source', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, cat TEXT, age INTEGER) USING memory');
		await db.exec("INSERT INTO t VALUES (1, 'a', 10), (2, 'b', 20)");
		// `a.age > b.age` references both sides, so it cannot push to one table; the
		// residual Filter sits over the join, where extractTableSchema declines.
		const f = optimizedFilter(db, 'SELECT * FROM t a JOIN t b ON a.id = b.id WHERE a.age > b.age');
		if (f) {
			expect(f.selectivity, 'join-source filter must not be stamped').to.be.undefined;
		}
	});
});
