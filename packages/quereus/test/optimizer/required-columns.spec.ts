/**
 * `FilterInfo.requiredColumns`: the columns the finished plan reads from each table scan
 * (planner/analysis/required-columns.ts, docs/module-authoring.md § "Required columns").
 *
 * The set is what licenses a module to leave every other column of an emitted row unset,
 * so each case pins one kind of reader above the scan. Whether the set is complete is
 * checked across the whole corpus by the `QUEREUS_COLUMNS_STRICT` harness; these cases
 * pin what it is.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { PlanNode } from '../../src/planner/nodes/plan-node.js';
import { TableAccessNode } from '../../src/planner/nodes/table-access-nodes.js';
import { FilterNode } from '../../src/planner/nodes/filter.js';

function scansOf(root: PlanNode, table: string): TableAccessNode[] {
	const found: TableAccessNode[] = [];
	const seen = new Set<PlanNode>();
	const walk = (node: PlanNode): void => {
		if (seen.has(node)) return;
		seen.add(node);
		if (node instanceof TableAccessNode && node.tableSchema.name === table) found.push(node);
		for (const child of node.getChildren()) walk(child);
	};
	walk(root);
	return found;
}

function hasFilter(root: PlanNode): boolean {
	if (root instanceof FilterNode) return true;
	return root.getChildren().some(hasFilter);
}

describe('required columns of a table scan', () => {
	let db: Database;

	/** Column names the single scan of `table` is told it must fill, or 'all' when unstamped. */
	function requiredOf(sql: string, table = 't'): string[] | 'all' {
		const scans = scansOf(db.getPlan(sql), table);
		expect(scans, `exactly one scan of ${table} for: ${sql}`).to.have.lengthOf(1);
		const [scan] = scans;
		const required = scan.filterInfo.requiredColumns;
		if (!required) return 'all';
		return scan.tableSchema.columns.filter((_, i) => required.has(i)).map(c => c.name);
	}

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, a integer, b integer, c integer, d integer) using memory');
		await db.exec('create table u (k integer primary key, v integer, w integer) using memory');
		await db.exec('insert into t values (1, 10, 100, 1000, 5), (2, 20, 200, 2000, 6)');
		await db.exec('insert into u values (100, 1, 2), (200, 3, 4)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('names only the projected column', () => {
		expect(requiredOf('select a from t')).to.deep.equal(['a']);
	});

	it('names no column for count(*)', () => {
		expect(requiredOf('select count(*) from t')).to.deep.equal([]);
	});

	it('names the column of a filter the module left to the engine', () => {
		const sql = 'select a from t where b > 150';
		expect(hasFilter(db.getPlan(sql)), 'b > 150 stays a residual filter').to.equal(true);
		expect(requiredOf(sql)).to.deep.equal(['a', 'b']);
	});

	it('leaves out the column of a filter the module consumed as a seek', () => {
		const sql = 'select a from t where id > 1';
		expect(hasFilter(db.getPlan(sql)), 'id > 1 is a key range, not a residual').to.equal(false);
		expect(requiredOf(sql)).to.deep.equal(['a']);
	});

	it('names the join keys on both sides', () => {
		const sql = 'select t.a, u.v from t join u on t.b = u.k';
		expect(requiredOf(sql, 't')).to.deep.equal(['a', 'b']);
		expect(requiredOf(sql, 'u')).to.deep.equal(['k', 'v']);
	});

	it('names the sort column', () => {
		expect(requiredOf('select a from t order by c')).to.deep.equal(['a', 'c']);
	});

	it('reads every column of a scan whose rows a delete or update consumes', () => {
		expect(requiredOf('delete from t where b > 150')).to.equal('all');
		expect(requiredOf('update t set a = 0 where b > 150')).to.equal('all');
	});
});
