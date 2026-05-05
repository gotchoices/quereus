import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Retrieve growth with index-style fallback (memory vtab)', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE mt (id INTEGER PRIMARY KEY, name TEXT, age INTEGER) USING memory");
		await db.exec("INSERT INTO mt VALUES (1, 'Alice', 30), (2, 'Bob', 40), (3, 'Charlie', 25)");
	}

	it('grows Filter(id = :id) and selects IndexSeek on PK', async () => {
		await setup();
		const res: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan('SELECT name FROM mt WHERE id = :id')")) {
			res.push(r);
		}
		expect(res).to.have.lengthOf(1);
		const ops = res[0].ops as string;
		expect(ops).to.match(/INDEXSEEK|INDEX SEEK|IndexSeek/i);
	});

	it('range + ORDER BY selects index access (scan or seek) with ordering', async () => {
		await setup();
		const res: ResultRow[] = [];
		for await (const r of db.eval("SELECT json_group_array(op) AS ops FROM query_plan('SELECT id FROM mt WHERE id >= 1 AND id <= 3 ORDER BY id')")) {
			res.push(r);
		}
		expect(res).to.have.lengthOf(1);
		const ops = res[0].ops as string;
		expect(ops).to.match(/INDEX(SEEK| SCAN)|Index(Seek|Scan)|INDEXSEEK|INDEX SCAN/i);
	});

	it('constant LIMIT is considered during growth (still produces correct result)', async () => {
		await setup();
		const rows: ResultRow[] = [];
		for await (const r of db.eval("SELECT id FROM mt ORDER BY id LIMIT 1")) rows.push(r);
		expect(rows).to.deep.equal([{ id: 1 }]);
	});
});



