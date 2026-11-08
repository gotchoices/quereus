/**
 * Regression: the memory-table `scanLayer` seek-start selection must depend on
 * the *physical* walk direction, not just the key's declared direction. A
 * descending plan reaches here from SQL whenever the planner serves an ordering
 * by walking an index backwards (`reverse=1` in `idxStr`); these cases construct
 * the descending `ScanPlan` directly so each seek shape is pinned on its own,
 * scanning the committed memory layer.
 *
 * Before the fix, a DESC-leading key always seeked from `upperBound` and an
 * ASC-leading key always seeked from `lowerBound`, regardless of direction, so
 * a backward walk started from the wrong end and dropped front-of-order rows.
 * The fix seeks from the upper bound exactly when `isAscending === isDescBoundColumn`
 * (and terminates at the complement), covering all four
 * `{isAscending}×{isDescBoundColumn}` combinations symmetrically in both the
 * primary and secondary-index branches.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { IndexConstraintOp } from '../../src/common/constants.js';
import { scanLayer } from '../../src/vtab/memory/layer/scan-layer.js';
import type { ScanPlan } from '../../src/vtab/memory/layer/scan-plan.js';
import type { Layer } from '../../src/vtab/memory/layer/interface.js';
import type { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { Row } from '../../src/common/types.js';

/** Resolve the committed memory layer backing a table created on `db`. */
function getCommittedLayer(db: Database, tableName: string): Layer {
	const mod = db._getVtabModule('memory')?.module as MemoryTableModule | undefined;
	if (!mod) throw new Error('memory module not registered');
	const manager = mod.tables.get(`main.${tableName}`.toLowerCase());
	if (!manager) throw new Error(`no memory manager for table '${tableName}'`);
	return manager.currentCommittedLayer;
}

/** Scan a layer with the given plan and collect every yielded row. */
async function collect(layer: Layer, plan: ScanPlan): Promise<Row[]> {
	const rows: Row[] = [];
	for await (const row of scanLayer(layer, plan)) rows.push(row);
	return rows;
}

/** Numeric ascending sort, for direction-agnostic assertions. */
const num = (a: unknown, b: unknown) => (a as number) - (b as number);

describe('scanLayer descending range seek-start', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('primary key', () => {
		// DESC-leading composite PK. Physical order is descending by `a`:
		// [30],[25],[20],[15],[10].
		beforeEach(async () => {
			await db.exec('create table td (a integer, b integer, v text, primary key (a desc, b))');
			await db.exec("insert into td values (30,0,'f'),(25,0,'e'),(20,0,'d'),(15,0,'c'),(10,0,'b')");
		});

		it('descending walk over DESC-leading PK with lower+upper bound drops no rows', async () => {
			// The repro: with the pre-fix code this seeks from upperBound (a=28),
			// the backward walk starts at the largest key <= 28 and immediately runs
			// off the front of the physical order, dropping every matching row.
			const plan: ScanPlan = {
				indexName: 'primary',
				descending: true,
				lowerBound: { op: IndexConstraintOp.GE, value: 12 },
				upperBound: { op: IndexConstraintOp.LT, value: 28 },
			};
			const rows = await collect(getCommittedLayer(db, 'td'), plan);
			expect(rows.map(r => r[0]).sort(num)).to.deep.equal([15, 20, 25]);
		});

		it('descending walk over DESC-leading PK with lower bound only', async () => {
			const plan: ScanPlan = {
				indexName: 'primary',
				descending: true,
				lowerBound: { op: IndexConstraintOp.GE, value: 12 },
			};
			const rows = await collect(getCommittedLayer(db, 'td'), plan);
			expect(rows.map(r => r[0]).sort(num)).to.deep.equal([15, 20, 25, 30]);
		});

		it('descending walk over DESC-leading PK with upper bound only', async () => {
			const plan: ScanPlan = {
				indexName: 'primary',
				descending: true,
				upperBound: { op: IndexConstraintOp.LT, value: 22 },
			};
			const rows = await collect(getCommittedLayer(db, 'td'), plan);
			expect(rows.map(r => r[0]).sort(num)).to.deep.equal([10, 15, 20]);
		});

		it('descending walk over ASC-leading PK with lower+upper bound drops no rows', async () => {
			// Mirror combination: ASC-leading key, descending walk must seek from the
			// upper bound (pre-fix it seeked from the lower bound and dropped rows).
			await db.exec('create table ta (a integer, b integer, v text, primary key (a, b))');
			await db.exec("insert into ta values (10,0,'b'),(15,0,'c'),(20,0,'d'),(25,0,'e'),(30,0,'f')");
			const plan: ScanPlan = {
				indexName: 'primary',
				descending: true,
				lowerBound: { op: IndexConstraintOp.GE, value: 12 },
				upperBound: { op: IndexConstraintOp.LT, value: 28 },
			};
			const rows = await collect(getCommittedLayer(db, 'ta'), plan);
			expect(rows.map(r => r[0]).sort(num)).to.deep.equal([15, 20, 25]);
		});
	});

	describe('backwards walk from a start key shorter than the tree key', () => {
		// The short seek tuple sorts before every key sharing it, so the seek lands at the
		// START of that group; a backwards walk must start from the group's END instead.
		it('prefix-only seek on a two-column secondary index returns the whole group', async () => {
			await db.exec('create table sk (id integer primary key, k integer, r integer)');
			await db.exec('create index idx_kr on sk (k, r)');
			await db.exec('insert into sk values (1,0,1),(2,1,5),(3,1,7),(4,1,6),(5,2,1)');
			const plan: ScanPlan = { indexName: 'idx_kr', descending: true, equalityPrefix: [1] };
			const rows = await collect(getCommittedLayer(db, 'sk'), plan);
			expect(rows.map(r => r[2])).to.deep.equal([7, 6, 5]);
		});

		it('inclusive bound on the leading column of a two-column primary key keeps the bound group', async () => {
			await db.exec('create table pk2 (a integer, b integer, primary key (a, b))');
			await db.exec('insert into pk2 values (3,1),(5,1),(5,2),(5,3),(7,1)');
			const plan: ScanPlan = {
				indexName: 'primary',
				descending: true,
				upperBound: { op: IndexConstraintOp.LE, value: 5 },
			};
			const rows = await collect(getCommittedLayer(db, 'pk2'), plan);
			expect(rows.map(r => [r[0], r[1]])).to.deep.equal([[5, 3], [5, 2], [5, 1], [3, 1]]);
		});
	});

	describe('secondary index', () => {
		// Scalar PK so the primary path is unaffected; a DESC-leading composite
		// secondary index drives the scan.
		beforeEach(async () => {
			await db.exec('create table sd (id integer primary key, k integer, name text)');
			await db.exec('create index idx_kd on sd (k desc, name)');
			await db.exec("insert into sd values (1,30,'a'),(2,25,'b'),(3,20,'c'),(4,15,'d'),(5,10,'e')");
		});

		it('descending walk over DESC-leading secondary index with lower+upper bound drops no rows', async () => {
			const plan: ScanPlan = {
				indexName: 'idx_kd',
				descending: true,
				lowerBound: { op: IndexConstraintOp.GE, value: 12 },
				upperBound: { op: IndexConstraintOp.LT, value: 28 },
			};
			const rows = await collect(getCommittedLayer(db, 'sd'), plan);
			// rows are full table rows [id, k, name]; matching k ∈ [12,28) → 25,20,15.
			expect(rows.map(r => r[0]).sort(num)).to.deep.equal([2, 3, 4]);
		});

		it('descending walk over ASC-leading secondary index with lower+upper bound drops no rows', async () => {
			await db.exec('create table sa (id integer primary key, k integer, name text)');
			await db.exec('create index idx_ka on sa (k, name)');
			await db.exec("insert into sa values (1,30,'a'),(2,25,'b'),(3,20,'c'),(4,15,'d'),(5,10,'e')");
			const plan: ScanPlan = {
				indexName: 'idx_ka',
				descending: true,
				lowerBound: { op: IndexConstraintOp.GE, value: 12 },
				upperBound: { op: IndexConstraintOp.LT, value: 28 },
			};
			const rows = await collect(getCommittedLayer(db, 'sa'), plan);
			expect(rows.map(r => r[0]).sort(num)).to.deep.equal([2, 3, 4]);
		});

		it('backwards walk is the exact reverse of the forward walk, PK order within a value included', async () => {
			await db.exec('create table sg (id integer primary key, g integer)');
			await db.exec('create index idx_g on sg (g)');
			await db.exec('insert into sg values (1,10),(2,20),(3,10),(4,20),(5,30),(6,10)');
			const layer = getCommittedLayer(db, 'sg');
			const shapes: Record<string, Omit<ScanPlan, 'descending'>> = {
				full: { indexName: 'idx_g' },
				range: {
					indexName: 'idx_g',
					lowerBound: { op: IndexConstraintOp.GE, value: 10 },
					upperBound: { op: IndexConstraintOp.LT, value: 30 },
				},
				equality: { indexName: 'idx_g', equalityKey: 10 },
				multiSeek: { indexName: 'idx_g', equalityKeys: [20, 10] },
			};
			const ids = async (shape: Omit<ScanPlan, 'descending'>, descending: boolean) =>
				(await collect(layer, { ...shape, descending })).map(r => r[0]);
			for (const [name, shape] of Object.entries(shapes)) {
				const forward = await ids(shape, false);
				const backward = await ids(shape, true);
				expect(backward, name).to.deep.equal([...forward].reverse());
				// A forward read after the backwards one would expose a mutated PK memo.
				expect(await ids(shape, false), `${name} (forward again)`).to.deep.equal(forward);
			}
			expect(await ids(shapes.full, true)).to.deep.equal([5, 4, 2, 6, 3, 1]);
		});
	});

	describe('ascending walk parity (reachable path unchanged)', () => {
		it('ascending DESC-leading PK lower-bound range still returns every row', async () => {
			await db.exec('create table td2 (a integer, b integer, v text, primary key (a desc, b))');
			await db.exec("insert into td2 values (30,0,'z'),(20,0,'y'),(10,0,'x')");
			const plan: ScanPlan = {
				indexName: 'primary',
				descending: false,
				lowerBound: { op: IndexConstraintOp.GE, value: 15 },
			};
			const rows = await collect(getCommittedLayer(db, 'td2'), plan);
			expect(rows.map(r => r[0]).sort(num)).to.deep.equal([20, 30]);
		});
	});
});
