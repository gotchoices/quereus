import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

interface PhysicalRow { node_type: string; op: string; detail: string; physical: string | null }

interface MonotonicOnEntry { attrId: number; strict: boolean; direction: 'asc' | 'desc' }
interface AccessCapabilities { ordinalSeek?: boolean; asofRight?: boolean }
interface PhysicalProps {
	monotonicOn?: MonotonicOnEntry[];
	accessCapabilities?: AccessCapabilities;
}

async function getPhysicalRows(db: Database, sql: string): Promise<PhysicalRow[]> {
	const rows: PhysicalRow[] = [];
	for await (const r of db.eval(
		"SELECT node_type, op, detail, physical FROM query_plan(?)", [sql],
	)) {
		rows.push(r as unknown as PhysicalRow);
	}
	return rows;
}

function physicalOf(rows: readonly PhysicalRow[], opPredicate: (r: PhysicalRow) => boolean): PhysicalProps | undefined {
	const row = rows.find(opPredicate);
	if (!row || !row.physical) return undefined;
	return JSON.parse(row.physical) as PhysicalProps;
}

const isPhysicalLeaf = (r: PhysicalRow): boolean =>
	r.op === 'INDEXSCAN' || r.op === 'INDEXSEEK' || r.op === 'SEQSCAN';

describe('BestAccessPlan monotonicOn advertisement (memory module)', () => {
	let db: Database;

	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('full PK scan on a single-column PK lifts strict monotonicOn onto the physical leaf', async () => {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')");

		const rows = await getPhysicalRows(db, "SELECT id, v FROM t");
		const leaf = physicalOf(rows, isPhysicalLeaf);
		expect(leaf, 'physical leaf present').to.not.equal(undefined);
		expect(leaf!.monotonicOn).to.be.an('array').with.lengthOf(1);
		expect(leaf!.monotonicOn![0].direction).to.equal('asc');
		expect(leaf!.monotonicOn![0].strict).to.equal(true);
		expect(leaf!.accessCapabilities, 'asofRight capability advertised').to.deep.include({ asofRight: true });
	});

	it('PK range scan lifts strict monotonicOn on the range column', async () => {
		await db.exec("CREATE TABLE r (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO r VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d')");

		const rows = await getPhysicalRows(db, "SELECT id FROM r WHERE id > 1 AND id < 4");
		const leaf = physicalOf(rows, isPhysicalLeaf);
		expect(leaf, 'physical leaf present').to.not.equal(undefined);
		expect(leaf!.monotonicOn).to.be.an('array').with.lengthOf(1);
		expect(leaf!.monotonicOn![0].strict).to.equal(true);
	});

	it('composite PK full scan emits non-strict monotonicOn on the leading column', async () => {
		await db.exec("CREATE TABLE cp (a INTEGER NOT NULL, b INTEGER NOT NULL, v TEXT, PRIMARY KEY (a, b)) USING memory");
		await db.exec("INSERT INTO cp VALUES (1,1,'x'),(1,2,'y'),(2,1,'z')");

		const rows = await getPhysicalRows(db, "SELECT a, b FROM cp");
		const leaf = physicalOf(rows, isPhysicalLeaf);
		expect(leaf, 'physical leaf present').to.not.equal(undefined);
		expect(leaf!.monotonicOn).to.be.an('array').with.lengthOf(1);
		expect(leaf!.monotonicOn![0].strict, 'leading PK column may have duplicates').to.equal(false);
	});

	it('single-row equality seek does not advertise monotonicOn', async () => {
		await db.exec("CREATE TABLE e (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO e VALUES (1,'a'),(2,'b')");

		const rows = await getPhysicalRows(db, "SELECT v FROM e WHERE id = 1");
		const leaf = physicalOf(rows, isPhysicalLeaf);
		expect(leaf, 'physical leaf present').to.not.equal(undefined);
		// Equality seek collapses to a single row — no monotonic ordering advertised.
		expect(leaf!.monotonicOn ?? []).to.deep.equal([]);
	});

	it('multi-value IN multi-seek does not advertise monotonicOn (IN-list emit order)', async () => {
		await db.exec("CREATE TABLE m (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO m VALUES (1,'a'),(2,'b'),(3,'c'),(4,'d')");

		const rows = await getPhysicalRows(db, "SELECT id FROM m WHERE id IN (3, 1, 2)");
		const leaf = physicalOf(rows, isPhysicalLeaf);
		expect(leaf, 'physical leaf present').to.not.equal(undefined);
		expect(leaf!.monotonicOn ?? []).to.deep.equal([]);
	});

	it('EXPLAIN serializes monotonicOn and accessCapabilities in physical JSON', async () => {
		await db.exec("CREATE TABLE x (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO x VALUES (1,'a'),(2,'b')");

		const rows = await getPhysicalRows(db, "SELECT id FROM x");
		const leaf = rows.find(isPhysicalLeaf);
		expect(leaf, 'physical leaf row present').to.not.equal(undefined);
		expect(leaf!.physical).to.be.a('string');
		expect(String(leaf!.physical)).to.match(/"monotonicOn"/);
		expect(String(leaf!.physical)).to.match(/"accessCapabilities"/);
		expect(String(leaf!.physical)).to.match(/"asofRight"\s*:\s*true/);
	});
});
