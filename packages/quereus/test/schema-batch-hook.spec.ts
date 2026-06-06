/**
 * Tests for the optional `beginSchemaBatch` / `endSchemaBatch` module hooks
 * fired by APPLY SCHEMA's migration-DDL loop.
 *
 * The loop wraps DDL execution between exactly one begin and one end per
 * registered module that implements the hooks. Modules without the hooks
 * are unaffected (zero-cost). The hooks let storage-backed modules fold
 * an APPLY SCHEMA into a single substrate commit.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { TableSchema } from '../src/schema/table.js';
import type { MemoryTable } from '../src/vtab/memory/table.js';

interface BeginCall { schemaName: string; }
interface EndCall { schemaName: string; error?: unknown; }
interface CreateCall { tableName: string; batchActiveAtCall: boolean; }

/**
 * MemoryTableModule extension that records begin/end/create calls and
 * exposes a `batchActive` flag that `create` consults at call time. Used
 * to validate the visibility contract: per-table callbacks during the
 * loop see the active batch.
 */
class RecordingMemoryModule extends MemoryTableModule {
	beginCalls: BeginCall[] = [];
	endCalls: EndCall[] = [];
	createCalls: CreateCall[] = [];
	batchActive = false;
	/** When set, the named table's create call throws to simulate a per-DDL failure. */
	failOnCreateTable?: string;
	/** When true, `beginSchemaBatch` itself throws (begin-failure path). */
	failBegin = false;
	/** When true, `endSchemaBatch` throws after recording. */
	failEnd = false;

	async beginSchemaBatch(_db: DatabaseType, schemaName: string): Promise<void> {
		this.beginCalls.push({ schemaName });
		if (this.failBegin) {
			throw new Error('begin-failure');
		}
		this.batchActive = true;
	}

	async endSchemaBatch(_db: DatabaseType, schemaName: string, error?: unknown): Promise<void> {
		this.endCalls.push({ schemaName, error });
		this.batchActive = false;
		if (this.failEnd) {
			throw new Error('end-failure');
		}
	}

	override async create(db: DatabaseType, tableSchema: TableSchema): Promise<MemoryTable> {
		this.createCalls.push({ tableName: tableSchema.name, batchActiveAtCall: this.batchActive });
		if (this.failOnCreateTable && tableSchema.name.toLowerCase() === this.failOnCreateTable.toLowerCase()) {
			throw new Error(`forced create failure for ${tableSchema.name}`);
		}
		return super.create(db, tableSchema);
	}
}

describe('APPLY SCHEMA batch hooks', () => {
	let db: Database;

	afterEach(async () => {
		if (db) await db.close();
	});

	it('pass-through: module without hooks produces same final catalog as today', async () => {
		db = new Database();
		// memory module is registered as the default in Database's constructor
		await db.exec(`
			declare schema main {
				table users {
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL
				}

				table posts {
					id INTEGER PRIMARY KEY,
					title TEXT NOT NULL
				}
			}
		`);
		await db.exec('apply schema main;');

		const users = db.schemaManager.getTable('main', 'users');
		const posts = db.schemaManager.getTable('main', 'posts');
		expect(users).to.exist;
		expect(posts).to.exist;
		expect(users!.columns.map(c => c.name)).to.deep.equal(['id', 'name']);
		expect(posts!.columns.map(c => c.name)).to.deep.equal(['id', 'title']);
	});

	it('begin/end fire exactly once around the migration loop with no error', async () => {
		db = new Database();
		const recording = new RecordingMemoryModule();
		db.registerModule('recording', recording);
		db.setDefaultVtabName('recording');

		await db.exec(`
			declare schema main {
				table users {
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL
				}

				table posts {
					id INTEGER PRIMARY KEY,
					title TEXT NOT NULL
				}
			}
		`);
		await db.exec('apply schema main;');

		expect(recording.beginCalls).to.have.lengthOf(1);
		expect(recording.beginCalls[0].schemaName).to.equal('main');
		expect(recording.endCalls).to.have.lengthOf(1);
		expect(recording.endCalls[0].schemaName).to.equal('main');
		expect(recording.endCalls[0].error).to.be.undefined;
		// Both tables should have been created (loop body ran ≥ 2 times)
		expect(recording.createCalls.map(c => c.tableName)).to.deep.equal(['users', 'posts']);
	});

	it('xCreate sees batchActive = true during the loop', async () => {
		db = new Database();
		const recording = new RecordingMemoryModule();
		db.registerModule('recording', recording);
		db.setDefaultVtabName('recording');

		await db.exec(`
			declare schema main {
				table t1 (
					id INTEGER PRIMARY KEY
				)
				table t2 (
					id INTEGER PRIMARY KEY
				)
			}
		`);
		await db.exec('apply schema main;');

		expect(recording.createCalls).to.have.lengthOf(2);
		for (const call of recording.createCalls) {
			expect(call.batchActiveAtCall, `batch should be active when creating ${call.tableName}`).to.be.true;
		}
		// After end-batch fires, batch is inactive again
		expect(recording.batchActive).to.be.false;
	});

	it('endSchemaBatch fires with the loop error when a DDL fails', async () => {
		db = new Database();
		const recording = new RecordingMemoryModule();
		recording.failOnCreateTable = 'posts';
		db.registerModule('recording', recording);
		db.setDefaultVtabName('recording');

		await db.exec(`
			declare schema main {
				table users (
					id INTEGER PRIMARY KEY
				)
				table posts (
					id INTEGER PRIMARY KEY
				)
			}
		`);

		let caught: Error | undefined;
		try {
			await db.exec('apply schema main;');
		} catch (e) {
			caught = e as Error;
		}

		expect(caught, 'apply schema should propagate the DDL failure').to.exist;
		expect(caught!.message).to.match(/posts/);

		expect(recording.beginCalls).to.have.lengthOf(1);
		expect(recording.endCalls).to.have.lengthOf(1);
		expect(recording.endCalls[0].error, 'end should receive the loop error').to.exist;
		expect(recording.batchActive, 'batch should be cleared on error').to.be.false;
	});

	it('idempotency fast-path: no DDL → no begin/end fired', async () => {
		db = new Database();
		const recording = new RecordingMemoryModule();
		db.registerModule('recording', recording);
		db.setDefaultVtabName('recording');

		await db.exec(`
			declare schema main {
				table users (
					id INTEGER PRIMARY KEY,
					name TEXT NOT NULL
				)
			}
		`);
		// First apply creates the table
		await db.exec('apply schema main;');
		expect(recording.beginCalls).to.have.lengthOf(1);
		expect(recording.endCalls).to.have.lengthOf(1);

		// Second apply against an already-up-to-date schema should not fire hooks
		await db.exec('apply schema main;');
		expect(recording.beginCalls, 'no further begin on idempotent apply').to.have.lengthOf(1);
		expect(recording.endCalls, 'no further end on idempotent apply').to.have.lengthOf(1);
		expect(recording.createCalls, 'no further create on idempotent apply').to.have.lengthOf(1);
	});

	it('begin-failure: no DDL runs and end is not called for the failing module', async () => {
		db = new Database();
		const recording = new RecordingMemoryModule();
		recording.failBegin = true;
		db.registerModule('recording', recording);
		db.setDefaultVtabName('recording');

		await db.exec(`
			declare schema main {
				table users (
					id INTEGER PRIMARY KEY
				)
			}
		`);

		let caught: Error | undefined;
		try {
			await db.exec('apply schema main;');
		} catch (e) {
			caught = e as Error;
		}

		expect(caught, 'apply schema should rethrow the begin-failure').to.exist;
		expect(caught!.message).to.match(/begin-failure/);

		expect(recording.beginCalls).to.have.lengthOf(1);
		// The failing module never "started" successfully → its end is not called.
		expect(recording.endCalls).to.have.lengthOf(0);
		// No DDL should have run, so no create() calls.
		expect(recording.createCalls).to.have.lengthOf(0);
		// No table registered.
		expect(db.schemaManager.getTable('main', 'users')).to.be.undefined;
	});
});
