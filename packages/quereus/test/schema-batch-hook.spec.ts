/**
 * Tests for the optional `beginSchemaBatch` / `endSchemaBatch` module hooks
 * fired by APPLY SCHEMA's migration-DDL loop.
 *
 * The loop wraps DDL execution between one begin and one end per registered
 * module that implements the hooks; a refused end is followed by one more pair,
 * around the unwind. Modules without the hooks are unaffected (zero-cost). The
 * hooks let storage-backed modules fold an APPLY SCHEMA into a single substrate
 * commit.
 */

import { expect } from 'chai';
import { Database, type DatabaseSchemaChangeEvent } from '../src/index.js';
import { QuereusError } from '../src/common/errors.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { renderCatalogForRestoreCheck } from '../src/schema/catalog-rendering.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { TableSchema } from '../src/schema/table.js';
import type { MemoryTable } from '../src/vtab/memory/table.js';

interface BeginCall { schemaName: string; }
interface EndCall { schemaName: string; error?: unknown; }
interface CreateCall { tableName: string; batchActiveAtCall: boolean; }
interface DestroyCall { tableName: string; batchActiveAtCall: boolean; }

/**
 * MemoryTableModule extension that records begin/end/create/destroy calls and
 * exposes a `batchActive` flag that `create` / `destroy` consult at call time.
 * Used to validate the visibility contract: per-table callbacks during the
 * loop — including the undo DDL a failed loop runs — see the active batch.
 */
class RecordingMemoryModule extends MemoryTableModule {
	beginCalls: BeginCall[] = [];
	endCalls: EndCall[] = [];
	createCalls: CreateCall[] = [];
	destroyCalls: DestroyCall[] = [];
	batchActive = false;
	/** When set, the named table's create call throws to simulate a per-DDL failure. */
	failOnCreateTable?: string;
	/** When true, `beginSchemaBatch` itself throws (begin-failure path). */
	failBegin = false;
	/** When true, every `endSchemaBatch` throws after recording. */
	failEnd = false;
	/** When set, only this `endSchemaBatch` call (1-based) throws after recording. */
	failEndOnCall?: number;
	/** What `endSchemaBatch` threw, so a test can check error identity rather than message. */
	endErrors: Error[] = [];

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
		if (this.failEnd || this.failEndOnCall === this.endCalls.length) {
			const refusal = new Error('end-failure');
			this.endErrors.push(refusal);
			throw refusal;
		}
	}

	override async create(db: DatabaseType, tableSchema: TableSchema): Promise<MemoryTable> {
		this.createCalls.push({ tableName: tableSchema.name, batchActiveAtCall: this.batchActive });
		if (this.failOnCreateTable && tableSchema.name.toLowerCase() === this.failOnCreateTable.toLowerCase()) {
			throw new Error(`forced create failure for ${tableSchema.name}`);
		}
		return super.create(db, tableSchema);
	}

	override async destroy(db: DatabaseType, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		this.destroyCalls.push({ tableName, batchActiveAtCall: this.batchActive });
		return super.destroy(db, pAux, moduleName, schemaName, tableName);
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
		expect(recording.endCalls[0].error, 'end should receive the loop error').to.equal(caught);
		expect(recording.batchActive, 'batch should be cleared on error').to.be.false;

		// The unwind ran INSIDE the batch, before end fired: the undo of `create table users`
		// (`DROP TABLE IF EXISTS users`) reached the module while the batch was still active,
		// so a module that discards its overlay on error discards the forward and the undo
		// DDL together, and one that applies for real has had both applied.
		expect(recording.destroyCalls).to.deep.equal([{ tableName: 'users', batchActiveAtCall: true }]);
		expect(db.schemaManager.getTable('main', 'users'), 'the catalog is back at its pre-apply state').to.be.undefined;
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

	describe('a module refuses endSchemaBatch after a clean loop', () => {
		const DECLARE_USERS = `
			declare schema main {
				table users (
					id INTEGER PRIMARY KEY
				)
			}
		`;

		function restoreFingerprint(): string {
			return renderCatalogForRestoreCheck(collectSchemaCatalog(db, 'main'));
		}

		async function refusedApply(): Promise<Error> {
			try {
				await db.exec('apply schema main');
			} catch (e) {
				return e as Error;
			}
			throw new Error('expected apply schema to reject');
		}

		function useModule(name: string, module: RecordingMemoryModule): void {
			db.registerModule(name, module);
			db.setDefaultVtabName(name);
		}

		it('unwinds the apply and rethrows the refusal, and a retry re-sends the DDL', async () => {
			db = new Database();
			const recording = new RecordingMemoryModule();
			useModule('recording', recording);
			await db.exec(DECLARE_USERS);
			const before = restoreFingerprint();
			recording.failEnd = true;
			const events: DatabaseSchemaChangeEvent[] = [];
			const unsubscribe = db.onSchemaChange(e => events.push(e));

			// Inside a transaction, so a leaked event would be delivered at commit rather than
			// dropped by an autocommit rollback.
			await db.exec('begin');
			const inTransaction = await refusedApply();
			await db.exec('commit');
			unsubscribe();

			expect(inTransaction).to.equal(recording.endErrors[0]);
			expect(restoreFingerprint()).to.equal(before);
			expect(events).to.deep.equal([]);
			// The undo reached the module inside a second batch, which ended with no error so
			// that a module whose first commit landed commits the undo too.
			expect(recording.destroyCalls).to.deep.equal([{ tableName: 'users', batchActiveAtCall: true }]);
			expect(recording.beginCalls).to.have.lengthOf(2);
			expect(recording.endCalls.map(c => c.error)).to.deep.equal([undefined, undefined]);

			const inAutocommit = await refusedApply();
			expect(inAutocommit).to.equal(recording.endErrors[2]);
			expect(restoreFingerprint()).to.equal(before);

			recording.failEnd = false;
			await db.exec('apply schema main');
			expect(recording.createCalls, 'each of the three applies sent the create').to.have.lengthOf(3);
			expect(db.schemaManager.getTable('main', 'users')).to.exist;
		});

		it('an irreversible step leaves the apply in place and reports it, with the refusal as cause', async () => {
			db = new Database();
			const recording = new RecordingMemoryModule();
			useModule('recording', recording);
			await db.exec('create table t (id integer primary key, v text null)');
			await db.exec(`
				declare schema main {
					table t {
						id INTEGER PRIMARY KEY
					}
				}
			`);
			recording.failEnd = true;
			const events: DatabaseSchemaChangeEvent[] = [];
			const unsubscribe = db.onSchemaChange(e => events.push(e));

			await db.exec('begin');
			const err = await refusedApply();
			await db.exec('commit');
			unsubscribe();

			expect(err).to.be.instanceOf(QuereusError);
			expect(err.message).to.match(/^end-failure\n.*partially migrated.*DROP COLUMN v/i);
			expect(err.cause).to.equal(recording.endErrors[0]);
			expect(db.schemaManager.getTable('main', 't')!.columns.map(c => c.name), 'nothing was unwound').to.deep.equal(['id']);
			expect(recording.beginCalls, 'no batch was reopened').to.have.lengthOf(1);
			expect(events, 'the step that landed really happened').to.not.be.empty;
		});

		it('a module that committed the migration and then refuses its undo is reported as not restored', async () => {
			db = new Database();
			const refuser = new RecordingMemoryModule();
			const committer = new RecordingMemoryModule();
			useModule('refuser', refuser);
			db.registerModule('committer', committer);
			await db.exec(DECLARE_USERS);
			refuser.failEnd = true;
			committer.failEndOnCall = 2;

			const err = await refusedApply();

			// The catalog itself IS restored, so the fingerprint check alone would have passed.
			expect(db.schemaManager.getTable('main', 'users')).to.be.undefined;
			expect(err.message).to.match(/^end-failure\n.*partially migrated.*module 'committer' committed the migration/);
			expect(err.cause).to.equal(refuser.endErrors[0]);
		});
	});
});
