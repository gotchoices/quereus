import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { SqlValue } from '../../src/common/types.js';

type ResultRow = Record<string, SqlValue>;

describe('Filter merge', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	async function setup(): Promise<void> {
		await db.exec("CREATE TABLE items (id INTEGER PRIMARY KEY, name TEXT, category TEXT, value INTEGER) USING memory");
		await db.exec("INSERT INTO items VALUES (1, 'Alpha', 'A', 100), (2, 'Beta', 'B', 200), (3, 'Gamma', 'A', 150), (4, 'Delta', 'B', 300)");
	}

	it('merges view WHERE + outer WHERE into a single filter', async () => {
		await setup();
		await db.exec("CREATE VIEW cat_a AS select id, name, value FROM items WHERE category = 'A'");
		const q = "select * FROM cat_a WHERE value > 100";

		// Verify correctness: only Gamma matches (category='A' AND value>100)
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) {
			results.push(r);
		}
		expect(results).to.have.lengthOf(1);
		expect(results[0].name).to.equal('Gamma');

		// Verify plan: at most one FILTER node (merged)
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("select count(*) as filters FROM query_plan(?) WHERE op = 'FILTER'", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		expect(planRows[0].filters).to.be.at.most(1);

		await db.exec("DROP VIEW cat_a");
	});

	it('merges adjacent filters from nested views', async () => {
		await setup();
		await db.exec("CREATE VIEW v1 AS select id, name, category, value FROM items WHERE value > 50");
		await db.exec("CREATE VIEW v2 AS select id, name, value FROM v1 WHERE category = 'A'");
		const q = "select * FROM v2 WHERE name != 'Alpha'";

		// Verify correctness: Gamma (category='A', value>50, name!='Alpha')
		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) {
			results.push(r);
		}
		expect(results).to.have.lengthOf(1);
		expect(results[0].name).to.equal('Gamma');

		// Nested views with Retrieve boundaries may not produce fully adjacent filters,
		// but at least the adjacent pair should be merged (< 3 filters from 3 source predicates)
		const planRows: ResultRow[] = [];
		for await (const r of db.eval("select count(*) as filters FROM query_plan(?) WHERE op = 'FILTER'", [q])) {
			planRows.push(r);
		}
		expect(planRows).to.have.lengthOf(1);
		expect(planRows[0].filters).to.be.lessThan(3);

		await db.exec("DROP VIEW v2");
		await db.exec("DROP VIEW v1");
	});

	it('preserves correct results when merging filters', async () => {
		await setup();
		await db.exec("CREATE VIEW high_val AS select * FROM items WHERE value >= 150");
		const q = "select name FROM high_val WHERE category = 'B' order by name";

		const results: ResultRow[] = [];
		for await (const r of db.eval(q)) {
			results.push(r);
		}
		// Beta (value=200, cat=B) and Delta (value=300, cat=B) match
		expect(results).to.have.lengthOf(2);
		expect(results[0].name).to.equal('Beta');
		expect(results[1].name).to.equal('Delta');

		await db.exec("DROP VIEW high_val");
	});
});
