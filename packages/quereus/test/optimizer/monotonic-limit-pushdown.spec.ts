import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import {
	TestOrdinalSeekModule,
	setOrdSeekData,
	ordSeekStore,
} from '../vtab/test-ordinal-seek-module.js';

interface PhysicalRow { node_type: string; op: string; detail: string; physical: string | null }

async function getPlanOps(db: Database, sql: string): Promise<string[]> {
	const ops: string[] = [];
	for await (const r of db.eval('SELECT op FROM query_plan(?)', [sql])) {
		const row = r as unknown as { op: string };
		ops.push(row.op);
	}
	return ops;
}

async function getPhysicalRows(db: Database, sql: string): Promise<PhysicalRow[]> {
	const rows: PhysicalRow[] = [];
	for await (const r of db.eval(
		'SELECT node_type, op, detail, physical FROM query_plan(?)', [sql],
	)) {
		rows.push(r as unknown as PhysicalRow);
	}
	return rows;
}

async function evalRows(db: Database, sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql, params)) {
		rows.push(r as Record<string, SqlValue>);
	}
	return rows;
}

function makeRows(n: number): Array<[number, string]> {
	const rows: Array<[number, string]> = [];
	for (let i = 0; i < n; i++) {
		rows.push([i + 1, `v${i + 1}`]);
	}
	return rows;
}

describe('Monotonic LIMIT/OFFSET pushdown rule', () => {
	let db: Database;
	let module: TestOrdinalSeekModule;

	beforeEach(() => {
		db = new Database();
		module = new TestOrdinalSeekModule();
		db.registerModule('ord_seek', module);
		ordSeekStore.clear();
	});

	afterEach(async () => {
		await db.close();
	});

	async function createTable(rowCount = 1000): Promise<void> {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING ord_seek');
		setOrdSeekData('main', 't', makeRows(rowCount));
	}

	describe('positive cases (rule fires)', () => {
		it('order by id limit 5 offset 100 emits ORDINALSLICE', async () => {
			await createTable();
			const ops = await getPlanOps(db, 'SELECT id, v FROM t ORDER BY id LIMIT 5 OFFSET 100');
			expect(ops).to.include('ORDINALSLICE');
			expect(ops).to.not.include('LIMITOFFSET');
		});

		it('order by id limit 10 (no offset) emits ORDINALSLICE', async () => {
			await createTable();
			const ops = await getPlanOps(db, 'SELECT id FROM t ORDER BY id LIMIT 10');
			expect(ops).to.include('ORDINALSLICE');
			expect(ops).to.not.include('LIMITOFFSET');
		});

		it('limit 5 offset 100 (no ORDER BY, leaf already monotonic) emits ORDINALSLICE', async () => {
			await createTable();
			const ops = await getPlanOps(db, 'SELECT id FROM t LIMIT 5 OFFSET 100');
			expect(ops).to.include('ORDINALSLICE');
			expect(ops).to.not.include('LIMITOFFSET');
		});

		it('parameterized order by id limit ? offset ? emits ORDINALSLICE', async () => {
			await createTable();
			const ops = await getPlanOps(db, 'SELECT id FROM t ORDER BY id LIMIT ? OFFSET ?');
			expect(ops).to.include('ORDINALSLICE');
		});
	});

	describe('negative cases (rule does NOT fire)', () => {
		it('order by id desc against an asc-monotonic leaf keeps LIMITOFFSET', async () => {
			await createTable();
			const ops = await getPlanOps(db, 'SELECT id FROM t ORDER BY id DESC LIMIT 5 OFFSET 100');
			expect(ops).to.not.include('ORDINALSLICE');
			expect(ops).to.include('LIMITOFFSET');
		});

		it('multi-key ORDER BY keeps LIMITOFFSET', async () => {
			await createTable();
			// `ruleOrderByFdPruning` would otherwise prune the trailing key here:
			// the leading `id` is a unique key, so the rows are totally ordered and
			// `v || 'x'` is a no-op tiebreaker. Disable that rule so a genuine
			// multi-key sort reaches the pushdown rule and exercises its multi-key
			// bail (the behavior under test).
			const baseTuning = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...baseTuning,
				disabledRules: new Set([
					...(baseTuning.disabledRules ?? []),
					'orderby-fd-pruning',
				]),
			});
			try {
				const ops = await getPlanOps(db, "SELECT id FROM t ORDER BY id, v || 'x' LIMIT 5 OFFSET 100");
				expect(ops).to.not.include('ORDINALSLICE');
				expect(ops).to.include('LIMITOFFSET');
			} finally {
				db.optimizer.updateTuning(baseTuning);
			}
		});

		it('WHERE clause (residual filter) keeps LIMITOFFSET', async () => {
			await createTable();
			const ops = await getPlanOps(db, "SELECT id FROM t WHERE v = 'v500' ORDER BY id LIMIT 5 OFFSET 100");
			expect(ops).to.not.include('ORDINALSLICE');
			expect(ops).to.include('LIMITOFFSET');
		});

		it('leaf without ordinalSeek capability keeps LIMITOFFSET', async () => {
			module.advertiseOrdinalSeek = false;
			await createTable();
			const ops = await getPlanOps(db, 'SELECT id FROM t ORDER BY id LIMIT 5 OFFSET 100');
			expect(ops).to.not.include('ORDINALSLICE');
			expect(ops).to.include('LIMITOFFSET');
		});

		it('leaf without monotonicOn advertisement keeps LIMITOFFSET', async () => {
			module.advertiseMonotonic = false;
			await createTable();
			const ops = await getPlanOps(db, 'SELECT id FROM t ORDER BY id LIMIT 5 OFFSET 100');
			expect(ops).to.not.include('ORDINALSLICE');
			expect(ops).to.include('LIMITOFFSET');
		});
	});

	describe('behavioral correctness', () => {
		it('returns the correct slice for (n=10, k=0)', async () => {
			await createTable();
			const rows = await evalRows(db, 'SELECT id FROM t ORDER BY id LIMIT 10 OFFSET 0');
			expect(rows.map(r => Number(r.id))).to.deep.equal([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
		});

		it('returns the correct slice for (n=10, k=500)', async () => {
			await createTable();
			const rows = await evalRows(db, 'SELECT id FROM t ORDER BY id LIMIT 10 OFFSET 500');
			expect(rows.map(r => Number(r.id))).to.deep.equal([501, 502, 503, 504, 505, 506, 507, 508, 509, 510]);
		});

		it('returns the correct slice near the end of the table (n=10, k=995)', async () => {
			await createTable();
			const rows = await evalRows(db, 'SELECT id FROM t ORDER BY id LIMIT 10 OFFSET 995');
			expect(rows.map(r => Number(r.id))).to.deep.equal([996, 997, 998, 999, 1000]);
		});

		it('returns empty result for offset past end of table', async () => {
			await createTable();
			const rows = await evalRows(db, 'SELECT id FROM t ORDER BY id LIMIT 10 OFFSET 10000');
			expect(rows).to.have.length(0);
		});

		it('returns empty result for limit 0', async () => {
			await createTable();
			const rows = await evalRows(db, 'SELECT id FROM t ORDER BY id LIMIT 0 OFFSET 0');
			expect(rows).to.have.length(0);
		});

		it('parameterized bounds resolve correctly at runtime', async () => {
			await createTable();
			const rows = await evalRows(db, 'SELECT id FROM t ORDER BY id LIMIT ? OFFSET ?', [3, 7]);
			expect(rows.map(r => Number(r.id))).to.deep.equal([8, 9, 10]);
		});

		it('produces identical results with the rule disabled', async () => {
			await createTable();
			const sql = 'SELECT id FROM t ORDER BY id LIMIT 10 OFFSET 500';
			const withRule = await evalRows(db, sql);

			const baseTuning = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...baseTuning,
				disabledRules: new Set([
					...(baseTuning.disabledRules ?? []),
					'monotonic-limit-pushdown',
				]),
			});
			try {
				const withoutRule = await evalRows(db, sql);
				expect(withRule).to.deep.equal(withoutRule);
				expect(withRule.map(r => Number(r.id))).to.deep.equal(
					[501, 502, 503, 504, 505, 506, 507, 508, 509, 510],
				);
			} finally {
				db.optimizer.updateTuning(baseTuning);
			}
		});
	});

	describe('FilterInfo offset/limit pushdown', () => {
		it('vtab observes pushed offset/limit when rule fires', async () => {
			await createTable();
			module.lastObservedOffset = undefined;
			module.lastObservedLimit = undefined;
			await evalRows(db, 'SELECT id FROM t ORDER BY id LIMIT 5 OFFSET 100');
			expect(module.lastObservedOffset).to.equal(100);
			expect(module.lastObservedLimit).to.equal(5);
		});

		it('vtab does NOT observe offset/limit when rule cannot fire', async () => {
			module.advertiseOrdinalSeek = false;
			await createTable();
			module.lastObservedOffset = undefined;
			module.lastObservedLimit = undefined;
			await evalRows(db, 'SELECT id FROM t ORDER BY id LIMIT 5 OFFSET 100');
			expect(module.lastObservedOffset).to.equal(undefined);
			expect(module.lastObservedLimit).to.equal(undefined);
		});
	});

	describe('physical properties', () => {
		it('OrdinalSlice preserves source ordering and monotonicOn in physical JSON', async () => {
			await createTable();
			const rows = await getPhysicalRows(db, 'SELECT id FROM t ORDER BY id LIMIT 5 OFFSET 100');
			const slice = rows.find(r => r.op === 'ORDINALSLICE');
			expect(slice, 'OrdinalSlice present').to.not.equal(undefined);
			const physical = slice!.physical ? JSON.parse(slice!.physical) as Record<string, unknown> : undefined;
			expect(physical, 'physical JSON present').to.not.equal(undefined);
			expect(physical!.monotonicOn).to.be.an('array').with.lengthOf(1);
		});
	});
});
