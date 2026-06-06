/* eslint-disable @typescript-eslint/no-explicit-any */
import { expect } from "chai";
import { Database } from "../src/index.js";

describe(`Basic query`, () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	it(`should execute a basic query`, async () => {
		await db.exec('create table basic_t (id integer primary key)');
		const resultRows: Record<string, any>[] = [];
		for await (const row of db.eval(`select * from schema()`)) {
			resultRows.push(row);
		}
		void expect(resultRows.length).to.be.greaterThan(0);
		const schemaEntry = resultRows.find(r => r.name === 'basic_t' && r.type === 'table');
		void expect(schemaEntry).to.exist;
	});

	it('should create a simple table', async () => {
		await db.exec('create table t (a text, b integer);');

		const resultRows: Record<string, any>[] = [];
		for await (const row of db.eval(`select * from schema()`)) {
			resultRows.push(row);
		}
		void expect(resultRows.length).to.be.greaterThan(0);
		const schemaEntry = resultRows.find(r => r.name === 't' && r.type === 'table');
		void expect(schemaEntry).to.exist;
	});

	describe('Parameter binding', () => {
		beforeEach(async () => {
			// Create a test table with some data
			await db.exec('CREATE TABLE test_params (id INTEGER primary key, name TEXT, value REAL)');
			await db.exec("INSERT INTO test_params VALUES (1, 'Alice', 100.5)");
			await db.exec("INSERT INTO test_params VALUES (2, 'Bob', 200.7)");
			await db.exec("INSERT INTO test_params VALUES (3, 'Charlie', 300.9)");
		});

		it('should support anonymous parameters (?)', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = ? AND name = ?');

			// Test with array parameters
			const rows1: any[] = [];
			for await (const row of stmt.all([2, "Bob"])) {
				rows1.push(row);
			}
			void expect(rows1).to.have.length(1);
			void expect(rows1[0].id).to.equal(2);
			void expect(rows1[0].name).to.equal("Bob");
			void expect(rows1[0].value).to.equal(200.7);

			await stmt.finalize();
		});

		it('should support indexed parameters (:1, :2)', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = :1 AND name = :2');

			// Test with object parameters using numeric keys
			const rows: any[] = [];
			for await (const row of stmt.all({1: 3, 2: "Charlie"})) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(3);
			void expect(rows[0].name).to.equal("Charlie");
			void expect(rows[0].value).to.equal(300.9);

			await stmt.finalize();
		});

		it('should support named parameters (:name)', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = :user_id AND name = :user_name');

			// Test with object parameters using named keys
			const rows: any[] = [];
			for await (const row of stmt.all({user_id: 1, user_name: "Alice"})) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(1);
			void expect(rows[0].name).to.equal("Alice");
			void expect(rows[0].value).to.equal(100.5);

			await stmt.finalize();
		});

		it('should support mixed parameter types', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id > ? AND value < :max_value');

			// Test with mixed parameters - key 1 for first ?, named for :max_value
			const rows: any[] = [];
			for await (const row of stmt.all({1: 1, max_value: 250})) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(2);
			void expect(rows[0].name).to.equal("Bob");

			await stmt.finalize();
		});

		it('should support parameter binding via bind methods', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = :id');

			stmt.bind('id', 2);

			const rows: any[] = [];
			for await (const row of stmt.all()) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(2);
			void expect(rows[0].name).to.equal("Bob");

			await stmt.finalize();
		});

		it('should support bindAll with object', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = :id AND name = :name');

			stmt.bindAll({id: 3, name: "Charlie"});

			const rows: any[] = [];
			for await (const row of stmt.all()) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(3);

			await stmt.finalize();
		});

		it('should support bindAll with array', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE id = ? AND name = ?');

			stmt.bindAll([1, "Alice"]);

			const rows: any[] = [];
			for await (const row of stmt.all()) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(1);

			await stmt.finalize();
		});

		it('should produce consistent results between bind() and bindAll() for positional params', async () => {
			const stmtBind = db.prepare('SELECT * FROM test_params WHERE id = ? AND name = ?');
			stmtBind.bind(1, 2);
			stmtBind.bind(2, 'Bob');
			const bindRows: any[] = [];
			for await (const row of stmtBind.all()) {
				bindRows.push(row);
			}
			await stmtBind.finalize();

			const stmtBindAll = db.prepare('SELECT * FROM test_params WHERE id = ? AND name = ?');
			stmtBindAll.bindAll([2, 'Bob']);
			const bindAllRows: any[] = [];
			for await (const row of stmtBindAll.all()) {
				bindAllRows.push(row);
			}
			await stmtBindAll.finalize();

			void expect(bindRows).to.deep.equal(bindAllRows);
			void expect(bindRows).to.have.length(1);
			void expect(bindRows[0].id).to.equal(2);
			void expect(bindRows[0].name).to.equal('Bob');
		});

		it('should support parameters in db.eval()', async () => {
			const rows: any[] = [];
			for await (const row of db.eval('SELECT * FROM test_params WHERE id = ? AND name = ?', [2, "Bob"])) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(2);
			void expect(rows[0].name).to.equal("Bob");
		});

		it('should handle null parameters', async () => {
			const stmt = db.prepare('SELECT * FROM test_params WHERE name = ?');

			const rows: any[] = [];
			for await (const row of stmt.all([null])) {
				rows.push(row);
			}
			void expect(rows).to.have.length(0); // No matches for NULL name

			await stmt.finalize();
		});

		it('should handle different data types as parameters', async () => {
			await db.exec('CREATE TABLE type_test (id INTEGER, flag BOOLEAN, data BLOB)');

			const stmt = db.prepare('INSERT INTO type_test VALUES (?, ?, ?)');
			await stmt.run([42, true, new Uint8Array([1, 2, 3])]);
			await stmt.finalize();

			const selectStmt = db.prepare('SELECT * FROM type_test WHERE id = ? AND flag = ?');
			const rows: any[] = [];
			for await (const row of selectStmt.all([42, true])) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(42);
			void expect(rows[0].flag).to.equal(true);
			void expect(rows[0].data).to.be.instanceof(Uint8Array);

			await selectStmt.finalize();
		});

		it('should update NULL column to non-NULL value with parameterized SET and WHERE', async () => {
			// Regression test: UPDATE with both SET and WHERE parameterized failed
			// because parameter indices were assigned in wrong order (WHERE before SET)
			await db.exec('CREATE TABLE items (id TEXT PRIMARY KEY, name TEXT, description TEXT NULL)');
			await db.exec('INSERT INTO items (id, name, description) VALUES (?, ?, ?)', ['item-1', 'Coffee', null]);

			// Verify initial value is null
			const beforeRows: any[] = [];
			for await (const row of db.eval('SELECT description FROM items WHERE id = ?', ['item-1'])) {
				beforeRows.push(row);
			}
			void expect(beforeRows).to.have.length(1);
			void expect(beforeRows[0].description).to.equal(null);

			// Update with parameterized SET and WHERE - this was the failing case
			await db.exec('UPDATE items SET description = ? WHERE id = ?', ['dddd', 'item-1']);

			// Verify update was applied
			const afterRows: any[] = [];
			for await (const row of db.eval('SELECT description FROM items WHERE id = ?', ['item-1'])) {
				afterRows.push(row);
			}
			void expect(afterRows).to.have.length(1);
			void expect(afterRows[0].description).to.equal('dddd');
		});

		it('should support parameters in simple CTEs', async () => {
			// Regression test: Parameters in CTEs were not resolved because
			// CTE scope creation skipped the ParameterScope in the scope chain
			const rows: any[] = [];
			for await (const row of db.eval(`
				WITH filtered AS (
					SELECT id, name FROM test_params WHERE id = ?
				)
				SELECT * FROM filtered
			`, [2])) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(2);
			void expect(rows[0].name).to.equal('Bob');
		});

		it('should support parameters in recursive CTE base case', async () => {
			// Create a tree structure for testing
			await db.exec('CREATE TABLE tree (id INTEGER PRIMARY KEY, parent_id INTEGER NULL, name TEXT)');
			await db.exec("INSERT INTO tree VALUES (1, null, 'Root')");
			await db.exec("INSERT INTO tree VALUES (2, 1, 'A')");
			await db.exec("INSERT INTO tree VALUES (3, 1, 'B')");
			await db.exec("INSERT INTO tree VALUES (4, 2, 'A1')");
			await db.exec("INSERT INTO tree VALUES (5, 3, 'B1')");

			// Query descendants starting from a parameterized root
			const rows: any[] = [];
			for await (const row of db.eval(`
				WITH RECURSIVE descendants(id) AS (
					SELECT ?
					UNION ALL
					SELECT t.id FROM tree t
					JOIN descendants d ON t.parent_id = d.id
				)
				SELECT d.id, t.name FROM descendants d JOIN tree t ON d.id = t.id ORDER BY d.id
			`, [1])) {
				rows.push(row);
			}
			void expect(rows).to.have.length(5);
			void expect(rows.map(r => r.id)).to.deep.equal([1, 2, 3, 4, 5]);
		});

		it('should support multiple parameters in recursive CTE', async () => {
			// Create a tree structure for testing
			await db.exec('CREATE TABLE tree2 (id INTEGER PRIMARY KEY, parent_id INTEGER NULL, name TEXT)');
			await db.exec("INSERT INTO tree2 VALUES (1, null, 'Root')");
			await db.exec("INSERT INTO tree2 VALUES (2, 1, 'A')");
			await db.exec("INSERT INTO tree2 VALUES (3, 1, 'B')");
			await db.exec("INSERT INTO tree2 VALUES (4, 2, 'A1')");
			await db.exec("INSERT INTO tree2 VALUES (5, 3, 'B1')");

			// Query descendants with filtering by name pattern
			const rows: any[] = [];
			for await (const row of db.eval(`
				WITH RECURSIVE descendants(id) AS (
					SELECT ?
					UNION ALL
					SELECT t.id FROM tree2 t
					JOIN descendants d ON t.parent_id = d.id
					WHERE t.name LIKE ?
				)
				SELECT d.id, t.name FROM descendants d JOIN tree2 t ON d.id = t.id ORDER BY d.id
			`, [1, 'A%'])) {
				rows.push(row);
			}
			// Should get: Root (1), A (2), A1 (4) - B and B1 are filtered out
			void expect(rows).to.have.length(3);
			void expect(rows.map(r => r.id)).to.deep.equal([1, 2, 4]);
		});

		it('should support same parameter value used multiple times', async () => {
			// Regression test matching the exact bug report pattern:
			// with recursive descendants(id) as (
			//   select ?
			//   union all
			//   select E.id from Entity E
			//   join descendants D on E.component_id = D.id
			//   where E.type = 'c'
			// )
			// with params: ['site', 'site']
			await db.exec('CREATE TABLE Entity (id TEXT PRIMARY KEY, component_id TEXT NULL, type TEXT)');
			await db.exec("INSERT INTO Entity VALUES ('site', null, 'c')");
			await db.exec("INSERT INTO Entity VALUES ('child1', 'site', 'c')");
			await db.exec("INSERT INTO Entity VALUES ('child2', 'site', 'c')");
			await db.exec("INSERT INTO Entity VALUES ('grandchild1', 'child1', 'c')");
			await db.exec("INSERT INTO Entity VALUES ('other', 'site', 'x')"); // different type, should be excluded

			const rows: any[] = [];
			for await (const row of db.eval(`
				WITH RECURSIVE descendants(id) AS (
					SELECT ?
					UNION ALL
					SELECT E.id FROM Entity E
					JOIN descendants D ON E.component_id = D.id
					WHERE E.type = 'c'
				)
				SELECT * FROM descendants ORDER BY id
			`, ['site'])) {
				rows.push(row);
			}
			// Should get: site, child1, child2, grandchild1 (not 'other' due to type filter)
			void expect(rows).to.have.length(4);
			void expect(rows.map(r => r.id).sort()).to.deep.equal(['child1', 'child2', 'grandchild1', 'site']);
		});

		it('should handle extra parameters gracefully', async () => {
			// Test what happens when more parameters are passed than needed
			// The bug report shows params: ['site', 'site'] for a query with one ?
			await db.exec('CREATE TABLE Entity2 (id TEXT PRIMARY KEY, component_id TEXT NULL, type TEXT)');
			await db.exec("INSERT INTO Entity2 VALUES ('site', null, 'c')");
			await db.exec("INSERT INTO Entity2 VALUES ('child1', 'site', 'c')");

			const rows: any[] = [];
			// Pass 2 params for a query with 1 ?
			for await (const row of db.eval(`
				WITH RECURSIVE descendants(id) AS (
					SELECT ?
					UNION ALL
					SELECT E.id FROM Entity2 E
					JOIN descendants D ON E.component_id = D.id
					WHERE E.type = 'c'
				)
				SELECT * FROM descendants ORDER BY id
			`, ['site', 'site'])) {
				rows.push(row);
			}
			void expect(rows).to.have.length(2);
		});

		it('should handle prepared statement with CTE parameters', async () => {
			// Test prepared statement flow - this is how quereus-worker likely uses it
			await db.exec('CREATE TABLE Entity3 (id TEXT PRIMARY KEY, component_id TEXT NULL, type TEXT)');
			await db.exec("INSERT INTO Entity3 VALUES ('site', null, 'c')");
			await db.exec("INSERT INTO Entity3 VALUES ('child1', 'site', 'c')");

			const sql = `
				WITH RECURSIVE descendants(id) AS (
					SELECT ?
					UNION ALL
					SELECT E.id FROM Entity3 E
					JOIN descendants D ON E.component_id = D.id
					WHERE E.type = 'c'
				)
				SELECT * FROM descendants ORDER BY id
			`;

			// Prepare without parameters first
			const stmt = db.prepare(sql);

			// Then bind and execute
			stmt.bindAll(['site']);
			const rows: any[] = [];
			for await (const row of stmt.iterateRows()) {
				rows.push(row);
			}
			void expect(rows).to.have.length(2);

			await stmt.finalize();
		});

		it('should support parameters in main query after CTE', async () => {
			// Test parameter in the main SELECT that uses the CTE
			// This tests if the CTE scope correctly chains to ParameterScope
			const rows: any[] = [];
			for await (const row of db.eval(`
				WITH filtered AS (
					SELECT id, name FROM test_params
				)
				SELECT * FROM filtered WHERE id = ?
			`, [2])) {
				rows.push(row);
			}
			void expect(rows).to.have.length(1);
			void expect(rows[0].id).to.equal(2);
			void expect(rows[0].name).to.equal('Bob');
		});
	});

	describe('Implicit transaction behavior', () => {
		// Most implicit transaction behavior is tested in test/logic/04-transactions.sqllogic
		// These tests just verify the TypeScript API works correctly

		it('statement.run() should complete successfully', async () => {
			await db.exec('CREATE TABLE implicit_tx (id INTEGER PRIMARY KEY, val TEXT)');

			const stmt = db.prepare('INSERT INTO implicit_tx VALUES (?, ?)');
			await stmt.run([1, 'a']);
			await stmt.finalize();

			// Verify data was committed
			const result = await db.get('SELECT val FROM implicit_tx WHERE id = 1');
			void expect(result).to.exist;
			void expect(result?.val).to.equal('a');
		});

		it('statement.run() should rollback on error', async () => {
			await db.exec('CREATE TABLE implicit_tx (id INTEGER PRIMARY KEY, val TEXT)');
			await db.exec("INSERT INTO implicit_tx VALUES (1, 'initial')");

			const stmt = db.prepare("INSERT INTO implicit_tx VALUES (1, 'duplicate')");

			// This should fail with duplicate key error and rollback
			let errorThrown = false;
			try {
				await stmt.run();
			} catch {
				errorThrown = true;
			}
			await stmt.finalize();

			void expect(errorThrown).to.be.true;

			// Verify original data is still there and not corrupted
			const result = await db.get('SELECT val FROM implicit_tx WHERE id = 1');
			void expect(result).to.exist;
			void expect(result?.val).to.equal('initial');
		});
	});
});
