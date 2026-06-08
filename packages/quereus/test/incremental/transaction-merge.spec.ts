import { expect } from 'chai';
import { Database } from '../../src/index.js';

/**
 * Regression test for the savepoint-merge state machine in
 * `TransactionManager`. The change-capture path is exercised end-to-end via
 * `registerCaptureSpec` + `getChangedTuples` so that any divergence between
 * `mergeRecord` (record-time merge) and `releaseSavepointLayer` (savepoint
 * RELEASE merge) shows up here.
 *
 * Specifically targets the case where an UPDATE in a parent layer is
 * followed by another UPDATE in a savepoint that is then RELEASEd: the
 * merged record must keep the parent layer's `oldProjection` so per-group
 * dispatch can still see the row's pre-savepoint state.
 */
describe('TransactionManager: savepoint merge preserves earliest oldProjection', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('UPDATE-then-savepoint-UPDATE-then-RELEASE keeps the original OLD projection', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, grp INTEGER) USING memory');
		await db.exec('INSERT INTO t VALUES (1, 100)');

		// Register capture demand for the `grp` column (index 1) so OLD/NEW
		// projections retain it across record paths and savepoint merges.
		const dispose = db.registerCaptureSpec('main.t', { extraColumns: new Set([1]) });
		try {
			await db.exec('BEGIN');
			// Outer UPDATE: 100 → 200 (oldProjection.grp = 100)
			await db.exec('UPDATE t SET grp = 200 WHERE id = 1');
			await db.exec('SAVEPOINT sp1');
			// Inner UPDATE: 200 → 300. After RELEASE, the merged record must
			// carry oldProjection.grp = 100 (from the parent layer) and
			// newProjection.grp = 300 (from the inner layer).
			await db.exec('UPDATE t SET grp = 300 WHERE id = 1');
			await db.exec('RELEASE SAVEPOINT sp1');

			const tuples = db.getChangedTuples('main.t', [1], [0]);
			// For an UPDATE, getChangedTuples emits BOTH OLD and NEW projections.
			// We expect to see the original OLD value (100) AND the latest NEW
			// value (300). The intermediate value (200) may or may not appear
			// depending on the merge path, but 100 must appear or per-group
			// dispatch will silently miss the original group.
			const flat = tuples.map(t => t[0]);
			expect(flat).to.include(100, 'original OLD projection lost on RELEASE');
			expect(flat).to.include(300, 'latest NEW projection missing after RELEASE');

			await db.exec('ROLLBACK');
		} finally {
			dispose();
		}
	});

	it('mergeRecord and savepoint RELEASE produce equivalent results for INSERT-then-UPDATE', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, grp INTEGER) USING memory');
		const dispose = db.registerCaptureSpec('main.t', { extraColumns: new Set([1]) });
		try {
			await db.exec('BEGIN');
			await db.exec('INSERT INTO t VALUES (1, 100)');
			await db.exec('SAVEPOINT sp1');
			await db.exec('UPDATE t SET grp = 200 WHERE id = 1');
			await db.exec('RELEASE SAVEPOINT sp1');

			// INSERT-then-UPDATE merges to INSERT with refreshed newProjection;
			// no oldProjection should be emitted.
			const tuples = db.getChangedTuples('main.t', [1], [0]);
			const flat = tuples.map(t => t[0]);
			expect(flat).to.deep.equal([200]);
			await db.exec('ROLLBACK');
		} finally {
			dispose();
		}
	});

	it('savepoint INSERT-then-DELETE collapses to no entry on RELEASE', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, grp INTEGER) USING memory');
		const dispose = db.registerCaptureSpec('main.t', { extraColumns: new Set([1]) });
		try {
			await db.exec('BEGIN');
			await db.exec('SAVEPOINT sp1');
			await db.exec('INSERT INTO t VALUES (1, 100)');
			await db.exec('DELETE FROM t WHERE id = 1');
			await db.exec('RELEASE SAVEPOINT sp1');

			expect(db.getChangedTuples('main.t', [1], [0])).to.deep.equal([]);
			await db.exec('ROLLBACK');
		} finally {
			dispose();
		}
	});
});
