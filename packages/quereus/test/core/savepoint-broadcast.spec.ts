/**
 * Locks the Database savepoint-broadcast helpers:
 *   - `_createSavepointBroadcast`
 *   - `_releaseSavepointBroadcast`
 *   - `_rollbackToSavepointBroadcast`
 *   - `_rollbackAndReleaseSavepointBroadcast`
 *
 * Each must broadcast to every active VirtualTableConnection at the depth
 * the TransactionManager returned, so per-connection savepoint stacks stay
 * in lockstep with TxnMgr's stack. A regression here is the bug class the
 * helpers were factored to prevent.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import type { VirtualTableConnection } from '../../src/vtab/connection.js';

type SavepointEvent =
	| { op: 'begin' }
	| { op: 'create'; depth: number }
	| { op: 'release'; depth: number }
	| { op: 'rollbackTo'; depth: number };

/**
 * Bare recording connection — no data, just a transcript of every
 * begin / savepoint method call so the test can inspect what the
 * Database broadcast loop delivered.
 */
class RecordingConnection implements VirtualTableConnection {
	readonly connectionId: string;
	readonly tableName = 'recording';
	readonly trace: SavepointEvent[] = [];

	constructor(id: string) {
		this.connectionId = id;
	}

	begin(): void { this.trace.push({ op: 'begin' }); }
	commit(): void { /* not asserted */ }
	rollback(): void { /* not asserted */ }
	createSavepoint(depth: number): void { this.trace.push({ op: 'create', depth }); }
	releaseSavepoint(depth: number): void { this.trace.push({ op: 'release', depth }); }
	rollbackToSavepoint(depth: number): void { this.trace.push({ op: 'rollbackTo', depth }); }
	disconnect(): void { /* no-op */ }
}

describe('Database savepoint broadcast helpers', () => {
	let db: Database;
	let conn: RecordingConnection;

	beforeEach(async () => {
		db = new Database();
		conn = new RecordingConnection('recording-1');
		// Open a transaction first; registerConnection's depth-replay only
		// matters when there are existing savepoints — here the stack is
		// empty so registration just calls begin().
		await db._beginTransaction('explicit');
		await db.registerConnection(conn);
		// Clear the begin() so the per-test trace is just the helper output.
		conn.trace.length = 0;
	});

	afterEach(async () => {
		await db.close();
	});

	it('_createSavepointBroadcast forwards the TxnMgr depth to every connection', async () => {
		const depthA = await db._createSavepointBroadcast('sp_a');
		expect(depthA).to.equal(0);
		expect(conn.trace).to.deep.equal([{ op: 'create', depth: 0 }]);

		const depthB = await db._createSavepointBroadcast('sp_b');
		expect(depthB).to.equal(1);
		expect(conn.trace).to.deep.equal([
			{ op: 'create', depth: 0 },
			{ op: 'create', depth: 1 },
		]);
	});

	it('_releaseSavepointBroadcast forwards the target depth to every connection', async () => {
		await db._createSavepointBroadcast('sp_a');
		await db._createSavepointBroadcast('sp_b');
		conn.trace.length = 0;

		const releasedDepth = await db._releaseSavepointBroadcast('sp_a');
		expect(releasedDepth).to.equal(0);
		expect(conn.trace).to.deep.equal([{ op: 'release', depth: 0 }]);
	});

	it('_rollbackToSavepointBroadcast forwards the target depth to every connection', async () => {
		await db._createSavepointBroadcast('sp_a');
		await db._createSavepointBroadcast('sp_b');
		conn.trace.length = 0;

		const targetDepth = await db._rollbackToSavepointBroadcast('sp_a');
		expect(targetDepth).to.equal(0);
		expect(conn.trace).to.deep.equal([{ op: 'rollbackTo', depth: 0 }]);
	});

	it('broadcasts reach multiple active connections', async () => {
		const conn2 = new RecordingConnection('recording-2');
		await db.registerConnection(conn2);
		conn2.trace.length = 0;

		await db._createSavepointBroadcast('sp_a');
		expect(conn.trace).to.deep.equal([{ op: 'create', depth: 0 }]);
		expect(conn2.trace).to.deep.equal([{ op: 'create', depth: 0 }]);

		await db._releaseSavepointBroadcast('sp_a');
		expect(conn.trace).to.deep.equal([
			{ op: 'create', depth: 0 },
			{ op: 'release', depth: 0 },
		]);
		expect(conn2.trace).to.deep.equal([
			{ op: 'create', depth: 0 },
			{ op: 'release', depth: 0 },
		]);
	});

	it('_rollbackAndReleaseSavepointBroadcast issues rollback-then-release without rethrowing', async () => {
		await db._createSavepointBroadcast('sp_a');
		conn.trace.length = 0;

		await db._rollbackAndReleaseSavepointBroadcast('sp_a');
		expect(conn.trace).to.deep.equal([
			{ op: 'rollbackTo', depth: 0 },
			{ op: 'release', depth: 0 },
		]);
	});

	it('_rollbackAndReleaseSavepointBroadcast swallows missing-name errors', async () => {
		// No active savepoint with this name — both internal steps should fail
		// at the TxnMgr level but the combo helper must NOT surface that error.
		await db._rollbackAndReleaseSavepointBroadcast('no_such_savepoint');
		// And no broadcasts should reach the connection because each step
		// threw inside the TxnMgr call before reaching the loop.
		expect(conn.trace).to.deep.equal([]);
	});

	it('_rollbackAndReleaseSavepointBroadcast still releases even if rollback broadcast partially fails', async () => {
		// Simulate a connection whose rollbackToSavepoint throws — the combo
		// helper must still proceed to the release step (and reach a healthy
		// sibling connection).
		await db._createSavepointBroadcast('sp_a');

		const flaky = new RecordingConnection('flaky');
		const origRollback = flaky.rollbackToSavepoint.bind(flaky);
		flaky.rollbackToSavepoint = (depth: number) => {
			origRollback(depth);
			throw new Error('flaky rollback');
		};
		await db.registerConnection(flaky);
		// registerConnection calls begin + replay; flush its trace.
		flaky.trace.length = 0;
		conn.trace.length = 0;

		await db._rollbackAndReleaseSavepointBroadcast('sp_a');

		// Both connections saw the rollback (flaky's threw after recording).
		// Then release was still attempted; flaky.releaseSavepoint succeeded.
		expect(flaky.trace).to.deep.equal([
			{ op: 'rollbackTo', depth: 0 },
			{ op: 'release', depth: 0 },
		]);
		// The healthy `conn` either saw rollback before flaky (if iteration
		// order put it first) or did not (if flaky threw first). Either way,
		// it must have seen the subsequent release because the combo helper
		// runs release in its own try.
		expect(conn.trace.some(e => e.op === 'release' && e.depth === 0)).to.equal(true);
	});
});
