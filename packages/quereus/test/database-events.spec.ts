import assert from 'node:assert/strict';
import { Database, type DatabaseDataChangeEvent, type DatabaseSchemaChangeEvent } from '../src/index.js';

describe('Database-Level Event System', () => {
	let db: Database;
	let dataEvents: DatabaseDataChangeEvent[];
	let schemaEvents: DatabaseSchemaChangeEvent[];
	let unsubData: () => void;
	let unsubSchema: () => void;

	beforeEach(() => {
		db = new Database();
		dataEvents = [];
		schemaEvents = [];

		// Subscribe to database-level events
		unsubData = db.onDataChange((event) => {
			dataEvents.push(event);
		});

		unsubSchema = db.onSchemaChange((event) => {
			schemaEvents.push(event);
		});
	});

	afterEach(async () => {
		// Unsubscribe
		unsubData?.();
		unsubSchema?.();
		await db.close();
	});

	describe('Data Change Events (Auto-emitted)', () => {
		it('should emit INSERT event with module name', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'insert');
			assert.equal(dataEvents[0].moduleName, 'memory');
			assert.equal(dataEvents[0].schemaName, 'main');
			assert.equal(dataEvents[0].tableName, 'users');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Alice']);
			assert.equal(dataEvents[0].oldRow, undefined);
			assert.equal(dataEvents[0].remote, false);
		});

		it('should emit UPDATE event with changed columns', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice', 'alice@example.com')");
			dataEvents = [];

			await db.exec("UPDATE users SET name = 'Alice Updated' WHERE id = 1");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.equal(dataEvents[0].moduleName, 'memory');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice', 'alice@example.com']);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Alice Updated', 'alice@example.com']);
			assert.deepEqual(dataEvents[0].changedColumns, ['name']);
			assert.equal(dataEvents[0].remote, false);
		});

		it('should emit DELETE event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			dataEvents = [];

			await db.exec('DELETE FROM users WHERE id = 1');

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'delete');
			assert.equal(dataEvents[0].moduleName, 'memory');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice']);
			assert.equal(dataEvents[0].newRow, undefined);
			assert.equal(dataEvents[0].remote, false);
		});

		it('should batch events until transaction commit', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");

			// No events yet - transaction not committed
			assert.equal(dataEvents.length, 0);

			await db.exec('COMMIT');

			// Both inserts emitted after commit
			assert.equal(dataEvents.length, 2);
			assert.equal(dataEvents[0].type, 'insert');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.equal(dataEvents[1].type, 'insert');
			assert.deepEqual(dataEvents[1].key, [2]);
		});

		it('should discard events on rollback', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec('ROLLBACK');

			assert.equal(dataEvents.length, 0);
		});

		it('should emit events for multiple operations in transaction', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");
			dataEvents = [];

			await db.exec('BEGIN');
			await db.exec("UPDATE users SET name = 'Alice2' WHERE id = 1");
			await db.exec("INSERT INTO users VALUES (3, 'Carol')");
			await db.exec('DELETE FROM users WHERE id = 2');
			await db.exec('COMMIT');

			assert.equal(dataEvents.length, 3);
			assert.equal(dataEvents[0].type, 'update');
			assert.equal(dataEvents[1].type, 'insert');
			assert.equal(dataEvents[2].type, 'delete');
		});

		it('should discard events on ROLLBACK TO SAVEPOINT', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec('SAVEPOINT sp1');
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");
			await db.exec('ROLLBACK TO sp1');
			await db.exec('COMMIT');

			// Only the first insert should be emitted
			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'insert');
			assert.deepEqual(dataEvents[0].key, [1]);
		});

		it('should emit events from released savepoint', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec('SAVEPOINT sp1');
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");
			await db.exec('RELEASE sp1');
			await db.exec('COMMIT');

			// Both inserts should be emitted
			assert.equal(dataEvents.length, 2);
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[1].key, [2]);
		});

		it('should handle nested savepoints correctly', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')"); // Before any savepoint
			await db.exec('SAVEPOINT sp1');
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");   // In sp1
			await db.exec('SAVEPOINT sp2');
			await db.exec("INSERT INTO users VALUES (3, 'Carol')"); // In sp2
			await db.exec('ROLLBACK TO sp2');                       // Discard Carol
			// Note: After ROLLBACK TO, we're back to sp1's state but sp2 still exists
			// So we release sp1 which merges both sp1 and the reset sp2
			await db.exec('RELEASE sp1');                           // Merge sp1 into base
			await db.exec('COMMIT');

			// Alice, Bob should be emitted; Carol was rolled back
			assert.equal(dataEvents.length, 2);
			assert.deepEqual(dataEvents[0].key, [1]); // Alice
			assert.deepEqual(dataEvents[1].key, [2]); // Bob
		});
	});

	describe('Schema Change Events (Auto-emitted)', () => {
		it('should emit CREATE TABLE event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'create');
			assert.equal(schemaEvents[0].objectType, 'table');
			assert.equal(schemaEvents[0].moduleName, 'memory');
			assert.equal(schemaEvents[0].schemaName, 'main');
			assert.equal(schemaEvents[0].objectName, 'users');
			assert.equal(schemaEvents[0].remote, false);
		});

		it('should emit DROP TABLE event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			schemaEvents = [];

			await db.exec('DROP TABLE users');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'drop');
			assert.equal(schemaEvents[0].objectType, 'table');
			assert.equal(schemaEvents[0].moduleName, 'memory');
			assert.equal(schemaEvents[0].objectName, 'users');
			assert.equal(schemaEvents[0].remote, false);
		});

		it('should emit CREATE INDEX event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			schemaEvents = [];

			await db.exec('CREATE INDEX idx_name ON users(name)');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'create');
			assert.equal(schemaEvents[0].objectType, 'index');
			assert.equal(schemaEvents[0].moduleName, 'memory');
			assert.equal(schemaEvents[0].objectName, 'idx_name');
			assert.equal(schemaEvents[0].remote, false);
		});
	});

	describe('Subscription Management', () => {
		it('should unsubscribe from data events', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			// Unsubscribe
			unsubData();

			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			// No events received after unsubscribe
			assert.equal(dataEvents.length, 0);
		});

		it('should unsubscribe from schema events', async () => {
			// Unsubscribe
			unsubSchema();

			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			// No events received after unsubscribe
			assert.equal(schemaEvents.length, 0);
		});

		it('should support multiple listeners', async () => {
			const extraEvents: DatabaseDataChangeEvent[] = [];
			const unsubExtra = db.onDataChange((event) => {
				extraEvents.push(event);
			});

			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			// Both listeners receive events
			assert.equal(dataEvents.length, 1);
			assert.equal(extraEvents.length, 1);

			unsubExtra();
		});

		it('should report listener status correctly', async () => {
			assert.equal(db.hasDataListeners(), true);
			assert.equal(db.hasSchemaListeners(), true);

			unsubData();
			unsubSchema();

			assert.equal(db.hasDataListeners(), false);
			assert.equal(db.hasSchemaListeners(), false);
		});
	});

	describe('Listener Error Handling', () => {
		it('should continue to other listeners on error', async () => {
			let secondListenerCalled = false;

			// Add a listener that throws
			const unsubBad = db.onDataChange(() => {
				throw new Error('Listener error');
			});

			// Add another listener
			const unsubGood = db.onDataChange(() => {
				secondListenerCalled = true;
			});

			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			// Second listener should still be called
			assert.equal(secondListenerCalled, true);

			unsubBad();
			unsubGood();
		});
	});

	describe('INSERT OR REPLACE Events', () => {
		it('should emit update event when INSERT OR REPLACE replaces existing row', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice', 'alice@example.com')");
			dataEvents = [];

			await db.exec("INSERT OR REPLACE INTO users VALUES (1, 'Alice Updated', 'alice2@example.com')");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice', 'alice@example.com']);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Alice Updated', 'alice2@example.com']);
			assert.deepEqual(dataEvents[0].changedColumns, ['name', 'email']);
		});

		it('should emit insert event when INSERT OR REPLACE inserts new row', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			await db.exec("INSERT OR REPLACE INTO users VALUES (1, 'Alice')");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'insert');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Alice']);
			assert.equal(dataEvents[0].oldRow, undefined);
		});

		it('should emit update event with only changed columns on partial replace', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice', 'alice@example.com')");
			dataEvents = [];

			// Replace but keep same email
			await db.exec("INSERT OR REPLACE INTO users VALUES (1, 'Alice Updated', 'alice@example.com')");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.deepEqual(dataEvents[0].changedColumns, ['name']);
		});

		it('should emit update event for INSERT OR REPLACE in transaction', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			dataEvents = [];

			await db.exec('BEGIN');
			await db.exec("INSERT OR REPLACE INTO users VALUES (1, 'Bob')");
			// No events yet — batched until commit
			assert.equal(dataEvents.length, 0);
			await db.exec('COMMIT');

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice']);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Bob']);
		});
	});

	describe('Edge Cases', () => {
		it('should handle composite primary keys', async () => {
			await db.exec('CREATE TABLE orders (store_id INTEGER, order_id INTEGER, amount REAL, PRIMARY KEY (store_id, order_id))');
			await db.exec('INSERT INTO orders VALUES (1, 100, 50.0)');

			assert.equal(dataEvents.length, 1);
			assert.deepEqual(dataEvents[0].key, [1, 100]);
		});

		it('should emit events in autocommit mode', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec("INSERT INTO users VALUES (2, 'Bob')");

			// Each statement commits immediately in autocommit mode
			assert.equal(dataEvents.length, 2);
		});

		it('should work with no listeners registered', async () => {
			// Unsubscribe all
			unsubData();
			unsubSchema();

			// Should not throw
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
		});
	});
});
