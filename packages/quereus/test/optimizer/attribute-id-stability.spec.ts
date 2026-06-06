import { expect } from 'chai';
import { Database } from '../../src/core/database.js';

describe('Attribute ID stability', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory");
		await db.exec("INSERT INTO t VALUES (1,'a'),(2,'b'),(3,'c')");
	}

	it('preserves attributeId across SELECT aliasing and ORDER BY references', async () => {
		await setup();

		const sql = "SELECT v AS vv, id AS ii FROM t ORDER BY id";
		const refs: Array<{ attributeId: number; column: string }> = [];

		for await (const r of db.eval("SELECT properties FROM query_plan(?) WHERE node_type = 'ColumnReference'", [sql])) {
			const properties = (r as { properties?: string | null }).properties ?? null;
			if (!properties) continue;
			const parsed = JSON.parse(properties);
			if (typeof parsed?.attributeId === 'number' && typeof parsed?.column === 'string') {
				refs.push({ attributeId: parsed.attributeId, column: parsed.column });
			}
		}

		const idRefs = refs.filter(r => r.column === 'id' || r.column === 'ii');
		expect(idRefs.length).to.be.greaterThan(0);

		const uniqueIds = new Set(idRefs.map(r => r.attributeId));
		expect(uniqueIds.size).to.equal(1);
	});
});

