import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { TestQueryModule, TestQueryTable } from './test-query-module.js';

describe('RemoteQuery vtable disconnect', () => {
	let db: Database;
	let mod: TestQueryModule;

	beforeEach(async () => {
		TestQueryTable.resetSharedData();
		db = new Database();
		mod = new TestQueryModule();
		db.registerModule('query_test', mod);
		await db.exec("CREATE TABLE qt (id INTEGER PRIMARY KEY, name TEXT) USING query_test");
		// Insert test rows via the module's backing store
		await db.exec("INSERT INTO qt (id, name) VALUES (1, 'a'), (2, 'b'), (3, 'c')");
	});

	afterEach(async () => {
		await db.close();
	});

	it('disconnects vtable after full iteration of remote query', async () => {
		const rows: unknown[] = [];
		for await (const r of db.eval("SELECT id, name FROM qt WHERE id >= 1")) {
			rows.push(r);
		}
		expect(rows.length).to.be.greaterThan(0);
		// The table created for the remote query should have been disconnected
		expect(mod.lastConnectedTable).to.exist;
		expect(mod.lastConnectedTable!.disconnectCount).to.equal(1);
	});

	it('disconnects vtable on early break from remote query', async () => {
		for await (const _r of db.eval("SELECT id, name FROM qt WHERE id >= 1")) {
			break; // consume only one row
		}
		expect(mod.lastConnectedTable).to.exist;
		expect(mod.lastConnectedTable!.disconnectCount).to.equal(1);
	});
});
