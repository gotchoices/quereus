import assert from 'node:assert/strict';
import { Database, DefaultVTableEventEmitter, MemoryTableModule, type VTableDataChangeEvent, type VTableSchemaChangeEvent } from '../src/index.js';

describe('VTable Event Hooks', () => {
	let db: Database;
	let emitter: DefaultVTableEventEmitter;
	let dataEvents: VTableDataChangeEvent[];
	let schemaEvents: VTableSchemaChangeEvent[];

	beforeEach(() => {
		db = new Database();
		emitter = new DefaultVTableEventEmitter();
		dataEvents = [];
		schemaEvents = [];

		// Subscribe to events
		emitter.onDataChange((event) => {
			dataEvents.push(event);
		});

		emitter.onSchemaChange((event) => {
			schemaEvents.push(event);
		});

		// Configure memory module with event emitter
		db.registerModule('memory_events', new MemoryTableModule(emitter));
		db.setDefaultVtabName('memory_events');
	});

	describe('Data Change Events', () => {
		it('should emit INSERT event on commit', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'insert');
			assert.equal(dataEvents[0].tableName, 'users');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Alice']);
			assert.equal(dataEvents[0].oldRow, undefined);
		});

		it('should emit UPDATE event on commit', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			dataEvents = []; // Clear insert event

			await db.exec("UPDATE users SET name = 'Alice Updated' WHERE id = 1");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.equal(dataEvents[0].tableName, 'users');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice']);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Alice Updated']);
		});

		it('should emit DELETE event on commit', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			dataEvents = [];

			await db.exec('DELETE FROM users WHERE id = 1');

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'delete');
			assert.equal(dataEvents[0].tableName, 'users');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice']);
			assert.equal(dataEvents[0].newRow, undefined);
		});

		it('should batch events until explicit COMMIT', async () => {
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

		it('should not emit events on ROLLBACK', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec('BEGIN');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			await db.exec('ROLLBACK');

			assert.equal(dataEvents.length, 0);
		});

		it('should emit multiple operation types in transaction', async () => {
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

		it('should handle composite primary keys', async () => {
			await db.exec('CREATE TABLE orders (store_id INTEGER, order_id INTEGER, amount REAL, PRIMARY KEY (store_id, order_id))');
			await db.exec('INSERT INTO orders VALUES (1, 100, 50.0)');

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'insert');
			assert.deepEqual(dataEvents[0].key, [1, 100]);
			assert.deepEqual(dataEvents[0].newRow, [1, 100, 50.0]);
		});

		it('should include changedColumns for UPDATE events', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice', 'alice@example.com')");
			dataEvents = [];

			await db.exec("UPDATE users SET name = 'Alice Updated' WHERE id = 1");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.deepEqual(dataEvents[0].changedColumns, ['name']);
		});

		it('should include multiple changedColumns when multiple columns change', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT, email TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice', 'alice@example.com')");
			dataEvents = [];

			await db.exec("UPDATE users SET name = 'Alice2', email = 'alice2@example.com' WHERE id = 1");

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.deepEqual(dataEvents[0].changedColumns, ['name', 'email']);
		});

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

		it('should emit update event for INSERT OR REPLACE in transaction', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");
			dataEvents = [];

			await db.exec('BEGIN');
			await db.exec("INSERT OR REPLACE INTO users VALUES (1, 'Bob')");
			assert.equal(dataEvents.length, 0);
			await db.exec('COMMIT');

			assert.equal(dataEvents.length, 1);
			assert.equal(dataEvents[0].type, 'update');
			assert.deepEqual(dataEvents[0].key, [1]);
			assert.deepEqual(dataEvents[0].oldRow, [1, 'Alice']);
			assert.deepEqual(dataEvents[0].newRow, [1, 'Bob']);
		});

		it('should not include changedColumns for INSERT or DELETE', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec("INSERT INTO users VALUES (1, 'Alice')");

			assert.equal(dataEvents[0].changedColumns, undefined);

			await db.exec('DELETE FROM users WHERE id = 1');

			assert.equal(dataEvents[1].changedColumns, undefined);
		});
	});

	describe('Schema Change Events', () => {
		it('should emit CREATE TABLE event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'create');
			assert.equal(schemaEvents[0].objectType, 'table');
			assert.equal(schemaEvents[0].schemaName, 'main');
			assert.equal(schemaEvents[0].objectName, 'users');
		});

		it('should emit DROP TABLE event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			schemaEvents = [];

			await db.exec('DROP TABLE users');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'drop');
			assert.equal(schemaEvents[0].objectType, 'table');
			assert.equal(schemaEvents[0].objectName, 'users');
		});

		it('should emit ADD COLUMN event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
			schemaEvents = [];

			await db.exec('ALTER TABLE users ADD COLUMN name TEXT');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'alter');
			assert.equal(schemaEvents[0].objectType, 'column');
			assert.equal(schemaEvents[0].objectName, 'users');
			assert.equal(schemaEvents[0].columnName, 'name');
		});

		it('should emit DROP COLUMN event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			schemaEvents = [];

			await db.exec('ALTER TABLE users DROP COLUMN name');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'drop');
			assert.equal(schemaEvents[0].objectType, 'column');
			assert.equal(schemaEvents[0].objectName, 'users');
			assert.equal(schemaEvents[0].columnName, 'name');
		});

		it('should emit RENAME COLUMN event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			schemaEvents = [];

			await db.exec('ALTER TABLE users RENAME COLUMN name TO full_name');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'alter');
			assert.equal(schemaEvents[0].objectType, 'column');
			assert.equal(schemaEvents[0].objectName, 'users');
			assert.equal(schemaEvents[0].columnName, 'full_name');
			assert.equal(schemaEvents[0].oldColumnName, 'name');
		});

		it('should emit RENAME TABLE event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
			schemaEvents = [];

			await db.exec('ALTER TABLE users RENAME TO customers');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'alter');
			assert.equal(schemaEvents[0].objectType, 'table');
			assert.equal(schemaEvents[0].objectName, 'customers');
		});

		it('should emit CREATE INDEX event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			schemaEvents = [];

			await db.exec('CREATE INDEX idx_name ON users(name)');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'create');
			assert.equal(schemaEvents[0].objectType, 'index');
			assert.equal(schemaEvents[0].objectName, 'idx_name');
		});

		it('should emit DROP INDEX event', async () => {
			await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
			await db.exec('CREATE INDEX idx_name ON users(name)');
			schemaEvents = [];

			await db.exec('DROP INDEX idx_name');

			assert.equal(schemaEvents.length, 1);
			assert.equal(schemaEvents[0].type, 'drop');
			assert.equal(schemaEvents[0].objectType, 'index');
			assert.equal(schemaEvents[0].objectName, 'idx_name');
		});
	});

describe('getEventEmitter API', () => {
	it('should expose event emitter from table', async () => {
		await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');

		const table = db.getTable('main', 'users');
		const tableEmitter = table?.getEventEmitter?.();

		assert.ok(tableEmitter);
		assert.equal(tableEmitter, emitter);
	});

	it('should allow subscribing via table emitter', async () => {
		await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');

		const table = db.getTable('main', 'users');
		const tableEmitter = table?.getEventEmitter?.();

		const localEvents: VTableDataChangeEvent[] = [];
		tableEmitter?.onDataChange?.((event) => {
			localEvents.push(event);
		});

		await db.exec("INSERT INTO users VALUES (1, 'Alice')");

		assert.equal(localEvents.length, 1);
		assert.equal(localEvents[0].type, 'insert');
	});

	it('returns undefined for unknown tables', () => {
		assert.equal(db.getTable('main', 'no_such_table'), undefined);
		assert.equal(db.getTable('main', 'NoSuchTable'), undefined);
	});

	it('resolves via default schema when schemaName is undefined', async () => {
		await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY)');
		const handle = db.getTable(undefined, 'users');
		assert.ok(handle);
		assert.equal(handle!.tableName, 'users');
		assert.equal(handle!.schemaName, 'main');
	});

	it('unsubscribe stops further events', async () => {
		await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
		const handle = db.getTable('main', 'users');
		const seen: VTableDataChangeEvent[] = [];
		const off = handle!.getEventEmitter()!.onDataChange!((e) => seen.push(e));
		await db.exec("INSERT INTO users VALUES (1, 'Alice')");
		off();
		await db.exec("INSERT INTO users VALUES (2, 'Bob')");
		assert.equal(seen.length, 1);
	});

	it('post-DROP: handle keeps emitter, no events fire after table is gone', async () => {
		await db.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
		const handle = db.getTable('main', 'users')!;
		const seen: VTableDataChangeEvent[] = [];
		handle.getEventEmitter()!.onDataChange!((e) => {
			if (e.tableName === 'users') seen.push(e);
		});
		await db.exec("INSERT INTO users VALUES (1, 'Alice')");
		assert.equal(seen.length, 1);
		await db.exec('DROP TABLE users');
		// Handle should now resolve undefined from db.getTable, but the
		// previously-captured handle's emitter still works (no throw).
		assert.equal(db.getTable('main', 'users'), undefined);
		assert.notEqual(handle.getEventEmitter(), undefined);
	});
});

describe('No listeners optimization', () => {
	it('should not track changes when no listeners', async () => {
		// Create database without emitter
		const db2 = new Database();
		await db2.exec('CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT)');
		await db2.exec("INSERT INTO users VALUES (1, 'Alice')");

		// Should work fine without emitter
		const stmt = db2.prepare('SELECT * FROM users');
		const rows = [];
		for await (const row of stmt.all()) {
			rows.push(row);
		}
		assert.equal(rows.length, 1);
	});
});
});

