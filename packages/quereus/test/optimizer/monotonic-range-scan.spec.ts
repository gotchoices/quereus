import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';
import {
	TestMonotonicDeclineModule,
	setDeclineData,
	declineStore,
} from '../vtab/test-monotonic-decline-module.js';

interface PhysicalRow { node_type: string; op: string; detail: string; physical: string | null }

interface MonotonicOnEntry { attrId: number; strict: boolean; direction: 'asc' | 'desc' }
interface RangeBoundLower { op: '>=' | '>'; valueLiteral?: SqlValue }
interface RangeBoundUpper { op: '<=' | '<'; valueLiteral?: SqlValue }
interface RangeBoundedOn { attrId: number; lower?: RangeBoundLower; upper?: RangeBoundUpper }
interface PhysicalProps { monotonicOn?: MonotonicOnEntry[]; rangeBoundedOn?: RangeBoundedOn }

const isPhysicalLeaf = (r: PhysicalRow): boolean =>
	r.op === 'INDEXSCAN' || r.op === 'INDEXSEEK' || r.op === 'SEQSCAN';

async function getPhysicalRows(db: Database, sql: string): Promise<PhysicalRow[]> {
	const rows: PhysicalRow[] = [];
	for await (const r of db.eval(
		"SELECT node_type, op, detail, physical FROM query_plan(?)", [sql],
	)) {
		rows.push(r as unknown as PhysicalRow);
	}
	return rows;
}

function leafPhysical(rows: readonly PhysicalRow[]): PhysicalProps | undefined {
	const row = rows.find(isPhysicalLeaf);
	if (!row || !row.physical) return undefined;
	return JSON.parse(row.physical) as PhysicalProps;
}

async function evalRows(db: Database, sql: string, params?: SqlValue[]): Promise<Record<string, SqlValue>[]> {
	const rows: Record<string, SqlValue>[] = [];
	for await (const r of db.eval(sql, params)) {
		rows.push(r as Record<string, SqlValue>);
	}
	return rows;
}

describe('Monotonic range-scan rule', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function setupTable(): Promise<void> {
		await db.exec("CREATE TABLE r (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO r VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d'),(5,'e'),(6,'f'),(7,'g')");
	}

	describe('recognition patterns (positive)', () => {
		it('x BETWEEN a AND b → rangeBoundedOn with [>= a, <= b]', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id BETWEEN 2 AND 5");
			const phys = leafPhysical(rows);
			expect(phys, 'physical leaf present').to.not.equal(undefined);
			expect(phys!.monotonicOn, 'monotonicOn advertised').to.be.an('array').with.lengthOf(1);
			expect(phys!.rangeBoundedOn, 'rangeBoundedOn set').to.exist;
			expect(phys!.rangeBoundedOn!.lower).to.deep.include({ op: '>=', valueLiteral: 2 });
			expect(phys!.rangeBoundedOn!.upper).to.deep.include({ op: '<=', valueLiteral: 5 });

			const result = await evalRows(db, "SELECT id FROM r WHERE id BETWEEN 2 AND 5");
			expect(result.map(r => Number(r.id))).to.deep.equal([2, 3, 4, 5]);
		});

		it('x >= a AND x <= b → rangeBoundedOn with [>= a, <= b]', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id >= 2 AND id <= 5");
			const phys = leafPhysical(rows);
			expect(phys!.rangeBoundedOn, 'rangeBoundedOn set').to.exist;
			expect(phys!.rangeBoundedOn!.lower).to.deep.include({ op: '>=', valueLiteral: 2 });
			expect(phys!.rangeBoundedOn!.upper).to.deep.include({ op: '<=', valueLiteral: 5 });

			const result = await evalRows(db, "SELECT id FROM r WHERE id >= 2 AND id <= 5");
			expect(result.map(r => Number(r.id))).to.deep.equal([2, 3, 4, 5]);
		});

		it('x > a AND x < b → rangeBoundedOn with [> a, < b]', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id > 2 AND id < 5");
			const phys = leafPhysical(rows);
			expect(phys!.rangeBoundedOn, 'rangeBoundedOn set').to.exist;
			expect(phys!.rangeBoundedOn!.lower).to.deep.include({ op: '>', valueLiteral: 2 });
			expect(phys!.rangeBoundedOn!.upper).to.deep.include({ op: '<', valueLiteral: 5 });

			const result = await evalRows(db, "SELECT id FROM r WHERE id > 2 AND id < 5");
			expect(result.map(r => Number(r.id))).to.deep.equal([3, 4]);
		});

		it('x >= a AND x < b → rangeBoundedOn with [>= a, < b]', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id >= 2 AND id < 5");
			const phys = leafPhysical(rows);
			expect(phys!.rangeBoundedOn, 'rangeBoundedOn set').to.exist;
			expect(phys!.rangeBoundedOn!.lower).to.deep.include({ op: '>=', valueLiteral: 2 });
			expect(phys!.rangeBoundedOn!.upper).to.deep.include({ op: '<', valueLiteral: 5 });
		});

		it('x > a AND x <= b → rangeBoundedOn with [> a, <= b]', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id > 2 AND id <= 5");
			const phys = leafPhysical(rows);
			expect(phys!.rangeBoundedOn, 'rangeBoundedOn set').to.exist;
			expect(phys!.rangeBoundedOn!.lower).to.deep.include({ op: '>', valueLiteral: 2 });
			expect(phys!.rangeBoundedOn!.upper).to.deep.include({ op: '<=', valueLiteral: 5 });
		});

		it('half-bound x >= a → rangeBoundedOn with only lower', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id >= 4");
			const phys = leafPhysical(rows);
			expect(phys!.rangeBoundedOn, 'rangeBoundedOn set').to.exist;
			expect(phys!.rangeBoundedOn!.lower).to.deep.include({ op: '>=', valueLiteral: 4 });
			expect(phys!.rangeBoundedOn!.upper, 'no upper bound').to.equal(undefined);

			const result = await evalRows(db, "SELECT id FROM r WHERE id >= 4");
			expect(result.map(r => Number(r.id))).to.deep.equal([4, 5, 6, 7]);
		});

		it('half-bound x < b → rangeBoundedOn with only upper', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id < 4");
			const phys = leafPhysical(rows);
			expect(phys!.rangeBoundedOn, 'rangeBoundedOn set').to.exist;
			expect(phys!.rangeBoundedOn!.lower, 'no lower bound').to.equal(undefined);
			expect(phys!.rangeBoundedOn!.upper).to.deep.include({ op: '<', valueLiteral: 4 });
		});
	});

	describe('edge cases', () => {
		it('empty range (x > 5 AND x < 5) sets rangeBoundedOn; returns 0 rows', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id > 5 AND id < 5");
			const phys = leafPhysical(rows);
			expect(phys!.rangeBoundedOn, 'rangeBoundedOn set').to.exist;

			const result = await evalRows(db, "SELECT id FROM r WHERE id > 5 AND id < 5");
			expect(result).to.have.lengthOf(0);
		});

		it('single-element range (x BETWEEN 3 AND 3) sets rangeBoundedOn', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id BETWEEN 3 AND 3");
			const phys = leafPhysical(rows);
			expect(phys!.rangeBoundedOn, 'rangeBoundedOn set').to.exist;
			expect(phys!.rangeBoundedOn!.lower).to.deep.include({ op: '>=', valueLiteral: 3 });
			expect(phys!.rangeBoundedOn!.upper).to.deep.include({ op: '<=', valueLiteral: 3 });

			const result = await evalRows(db, "SELECT id FROM r WHERE id BETWEEN 3 AND 3");
			expect(result.map(r => Number(r.id))).to.deep.equal([3]);
		});

		it('multi-value IN does not set rangeBoundedOn (multi-seek emit non-monotonic)', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id IN (3, 5, 1)");
			const phys = leafPhysical(rows);
			// memory module declines monotonicOn for multi-IN; rule does not fire either way.
			expect(phys!.rangeBoundedOn ?? undefined).to.equal(undefined);
		});
	});

	describe('diagnostics', () => {
		it('physical JSON contains rangeBoundedOn when rule fires', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id BETWEEN 2 AND 5");
			const leaf = rows.find(isPhysicalLeaf);
			expect(leaf, 'physical leaf present').to.not.equal(undefined);
			expect(leaf!.physical).to.be.a('string');
			expect(String(leaf!.physical)).to.match(/"rangeBoundedOn"/);
			expect(String(leaf!.physical)).to.match(/"attrId"/);
			expect(String(leaf!.physical)).to.match(/"valueLiteral"\s*:\s*2/);
			expect(String(leaf!.physical)).to.match(/"valueLiteral"\s*:\s*5/);
		});
	});

	describe('negative cases', () => {
		it('no WHERE clause → monotonicOn advertised, rangeBoundedOn absent', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r");
			const phys = leafPhysical(rows);
			expect(phys!.monotonicOn, 'monotonicOn advertised').to.be.an('array').with.lengthOf(1);
			expect(phys!.rangeBoundedOn ?? undefined).to.equal(undefined);
		});

		it('equality on PK → monotonicOn not advertised, rangeBoundedOn absent', async () => {
			await setupTable();
			const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id = 3");
			const phys = leafPhysical(rows);
			// memory module: single-row equality seek does not advertise monotonicOn,
			// so the rule has nothing to annotate.
			expect(phys!.monotonicOn ?? []).to.deep.equal([]);
			expect(phys!.rangeBoundedOn ?? undefined).to.equal(undefined);
		});

		it('defensive: leaf with monotonicOn but Filter above carrying unhandled range → monotonicOn dropped', async () => {
			const declineModule = new TestMonotonicDeclineModule();
			db.registerModule('decline_mod', declineModule);
			declineStore.clear();
			await db.exec("CREATE TABLE d (id INTEGER PRIMARY KEY, v TEXT) USING decline_mod");
			setDeclineData('main', 'd', [[1, 'a'], [2, 'b'], [3, 'c'], [4, 'd']]);

			// The vtab declines the range filter, so a residual FilterNode sits
			// above the leaf. The defensive escalation must drop monotonicOn.
			const rows = await getPhysicalRows(db, "SELECT id FROM d WHERE id >= 2");
			const phys = leafPhysical(rows);
			expect(phys, 'physical leaf present').to.not.equal(undefined);
			expect(phys!.monotonicOn ?? [], 'monotonicOn was dropped').to.deep.equal([]);

			// The leaf must be IndexScan (the ordering-only access path), not
			// SeqScan. If the access path had degraded to SeqScan, monotonicOn
			// would never have been lifted in the first place and the test
			// wouldn't be exercising the defensive escalation at all.
			const leafRow = rows.find(r => r.op === 'INDEXSCAN' || r.op === 'INDEXSEEK' || r.op === 'SEQSCAN');
			expect(leafRow, 'physical leaf row').to.not.equal(undefined);
			expect(leafRow!.op, 'access path uses index').to.equal('INDEXSCAN');

			// Sanity: a FilterNode is present (vtab declined the predicate).
			const hasFilter = rows.some(r => r.op === 'FILTER');
			expect(hasFilter, 'FilterNode above leaf').to.equal(true);

			// Sanity: results still correct (Filter does the work).
			const result = await evalRows(db, "SELECT id FROM d WHERE id >= 2");
			expect(result.map(r => Number(r.id))).to.deep.equal([2, 3, 4]);
		});

		it('defensive: no offending predicate → monotonicOn preserved on leaf', async () => {
			const declineModule = new TestMonotonicDeclineModule();
			db.registerModule('decline_mod_b', declineModule);
			declineStore.clear();
			await db.exec("CREATE TABLE d2 (id INTEGER PRIMARY KEY, v TEXT) USING decline_mod_b");
			setDeclineData('main', 'd2', [[1, 'a'], [2, 'b']]);

			// No WHERE clause → no Filter above; monotonicOn stays.
			const rows = await getPhysicalRows(db, "SELECT id FROM d2");
			const phys = leafPhysical(rows);
			expect(phys!.monotonicOn).to.be.an('array').with.lengthOf(1);
		});

		it('rule-disabled tuning → rangeBoundedOn absent, results unchanged', async () => {
			await setupTable();
			const baseTuning = db.optimizer.tuning;
			db.optimizer.updateTuning({
				...baseTuning,
				disabledRules: new Set([
					...(baseTuning.disabledRules ?? []),
					'monotonic-range-access-IndexSeek',
					'monotonic-range-access-IndexScan',
					'monotonic-range-access-SeqScan',
					'monotonic-range-access-filter',
				]),
			});
			try {
				const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id BETWEEN 2 AND 5");
				const phys = leafPhysical(rows);
				expect(phys!.rangeBoundedOn ?? undefined).to.equal(undefined);
				const result = await evalRows(db, "SELECT id FROM r WHERE id BETWEEN 2 AND 5");
				expect(result.map(r => Number(r.id))).to.deep.equal([2, 3, 4, 5]);
			} finally {
				db.optimizer.updateTuning(baseTuning);
			}
		});
	});
});
