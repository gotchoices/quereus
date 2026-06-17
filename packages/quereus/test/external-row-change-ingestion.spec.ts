/**
 * Database.ingestExternalRowChanges — batch ingestion seam for externally-applied
 * row changes (ticket `external-row-change-ingestion`).
 *
 * A write applied directly to module storage bypasses the DML executor and so
 * the post-write pipeline (change capture → watch/assertions, row-time MV
 * maintenance, FK actions). The seam replays those facets — selected per call —
 * over a caller-reported ordered batch, inside the coordinated transaction.
 *
 * "Externally-applied" writes are simulated two ways, per the ticket:
 *  - direct `vtab.update()` on the table instance (bypasses the DML executor
 *    exactly as an external storage write does) — needed where maintenance
 *    re-reads the source through the vtab (the full-rebuild arm);
 *  - synthesized changes alone — for facets that never re-read the source
 *    (inverse-projection maintenance, capture, FK actions).
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { ExternalRowChange } from '../src/core/database-internal.js';
import type { ChangeScope, WatchEvent } from '../src/index.js';
import { StatusCode, type SqlValue } from '../src/common/types.js';
import { QuereusError } from '../src/common/errors.js';
import { ConflictResolution } from '../src/common/constants.js';

async function expectThrows(fn: () => Promise<unknown>, messageContains: string): Promise<Error> {
	let thrown: unknown;
	try {
		await fn();
	} catch (e) {
		thrown = e;
	}
	void expect(thrown, 'expected throw').to.exist;
	const err = thrown as Error;
	void expect(err.message).to.include(messageContains);
	return err;
}

/**
 * Apply a row mutation directly through the vtab (`vtab.update()`), bypassing
 * the DML executor — the test stand-in for an external storage write. The
 * memory table registers its connection with the Database on first use, so the
 * write rides the coordinated transaction (or, with none active, sits in the
 * connection's pending layer until the next coordinated commit — the seam's
 * implicit commit included).
 */
async function directWrite(
	db: Database,
	tableName: string,
	op: 'insert' | 'delete',
	values: SqlValue[] | undefined,
	oldKeyValues?: SqlValue[],
): Promise<void> {
	const tableSchema = db.schemaManager.getTable('main', tableName);
	void expect(tableSchema, `table ${tableName} exists`).to.exist;
	const moduleInfo = db._getVtabModule(tableSchema!.vtabModuleName ?? 'memory');
	void expect(moduleInfo, 'memory module registered').to.exist;
	const vtab = await moduleInfo!.module.connect(
		db, moduleInfo!.auxData, 'memory', 'main', tableName, {}, tableSchema);
	await vtab.update!({
		operation: op,
		values,
		oldKeyValues,
		onConflict: ConflictResolution.ABORT,
	});
}

/** Collect all rows of a query as plain objects. */
async function readAll(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const rows: Array<Record<string, SqlValue>> = [];
	for await (const row of db.eval(sql)) rows.push(row);
	return rows;
}

/** A hand-built `rows` change-scope watch on a single-column-PK table
 *  (mirrors external-change-watch.spec.ts). */
function rowsWatch(table: string, key: string, value: unknown): ChangeScope {
	return {
		watches: [{
			table: { schema: 'main', table },
			columns: new Set([key]),
			scope: { kind: 'rows', key: [key], values: [[value as never]] },
		}],
		nonDeterministicSources: [],
		unboundParameters: [],
	};
}

/** Shorthand for one reported change against `main.<table>`. */
function chg(tableName: string, change: ExternalRowChange['change']): ExternalRowChange {
	return { tableName, change };
}

describe('Database.ingestExternalRowChanges (external row-change ingestion)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { if (db) await db.close(); });

	describe('inverse-projection covering MV maintenance', () => {
		beforeEach(async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec('create materialized view mv as select id, v from t');
		});

		const mvRows = async () => (await readAll(db, 'select id, v from mv order by id'))
			.map(r => ({ id: Number(r.id), v: r.v }));

		it('an insert change converges the backing', async () => {
			await db.ingestExternalRowChanges([chg('t', { op: 'insert', newRow: [1, 'a'] })]);
			expect(await mvRows()).to.deep.equal([{ id: 1, v: 'a' }]);
		});

		it('a PK-moving update change deletes the old backing key and upserts the new', async () => {
			await db.ingestExternalRowChanges([chg('t', { op: 'insert', newRow: [1, 'a'] })]);
			await db.ingestExternalRowChanges([
				chg('t', { op: 'update', oldRow: [1, 'a'], newRow: [2, 'b'] }),
			]);
			expect(await mvRows()).to.deep.equal([{ id: 2, v: 'b' }]);
		});

		it('a delete change removes the backing row', async () => {
			await db.ingestExternalRowChanges([chg('t', { op: 'insert', newRow: [1, 'a'] })]);
			await db.ingestExternalRowChanges([chg('t', { op: 'delete', oldRow: [1, 'a'] })]);
			expect(await mvRows()).to.deep.equal([]);
		});

		it('a multi-row batch (incl. the same row changed twice, in order) converges', async () => {
			// The second change to id=2 carries the FIRST change's newRow as its
			// oldRow — the accuracy contract for same-row-twice batches.
			await db.ingestExternalRowChanges([
				chg('t', { op: 'insert', newRow: [1, 'a'] }),
				chg('t', { op: 'insert', newRow: [2, 'b'] }),
				chg('t', { op: 'insert', newRow: [3, 'c'] }),
				chg('t', { op: 'update', oldRow: [2, 'b'], newRow: [2, 'b2'] }),
			]);
			expect(await mvRows()).to.deep.equal([
				{ id: 1, v: 'a' }, { id: 2, v: 'b2' }, { id: 3, v: 'c' },
			]);
		});

		it('maintainMaterializedViews: false skips the backing entirely', async () => {
			await db.ingestExternalRowChanges(
				[chg('t', { op: 'insert', newRow: [1, 'a'] })],
				{ maintainMaterializedViews: false },
			);
			expect(await mvRows()).to.deep.equal([]);
		});
	});

	describe('full-rebuild MV maintenance (re-reads the source through the vtab)', () => {
		it('N direct vtab writes + one seam batch rebuild the MV once, reflecting all N', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			// DISTINCT is a floor-only shape: created directly, maintained by full-rebuild.
			await db.exec('create materialized view mv as select distinct v from t');
			const mgr = (db as unknown as {
				materializedViewManager: { rowTime: Map<string, { kind: string }> };
			}).materializedViewManager;
			expect(mgr.rowTime.get('main.mv')?.kind, 'floor plan registered').to.equal('full-rebuild');

			// Externally-applied storage writes: direct vtab.update, no DML executor.
			await directWrite(db, 't', 'insert', [1, 'a']);
			await directWrite(db, 't', 'insert', [2, 'b']);
			await directWrite(db, 't', 'insert', [3, 'a']);

			await db.ingestExternalRowChanges([
				chg('t', { op: 'insert', newRow: [1, 'a'] }),
				chg('t', { op: 'insert', newRow: [2, 'b'] }),
				chg('t', { op: 'insert', newRow: [3, 'a'] }),
			]);

			const rows = await readAll(db, 'select v from mv order by v');
			expect(rows.map(r => r.v)).to.deep.equal(['a', 'b']);
			// The implicit transaction committed at batch end.
			expect(db.getAutocommit()).to.equal(true);
			expect((await readAll(db, 'select id from t order by id')).map(r => Number(r.id)))
				.to.deep.equal([1, 2, 3]);
		});
	});

	describe('change capture → watch dispatch', () => {
		beforeEach(async () => {
			await db.exec('create table t (id text primary key, v text)');
		});

		it('fires a row-granular watch post-commit when capture is on (default)', async () => {
			const events: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { events.push(e); });

			await db.ingestExternalRowChanges([chg('t', { op: 'insert', newRow: ['x', 'a'] })]);
			sub.unsubscribe();

			expect(events).to.have.length(1);
			expect(events[0].matched[0].hits).to.deep.equal([['x']]);
		});

		it('does not fire with captureChanges: false', async () => {
			const events: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { events.push(e); });

			await db.ingestExternalRowChanges(
				[chg('t', { op: 'insert', newRow: ['x', 'a'] })],
				{ captureChanges: false },
			);
			sub.unsubscribe();

			expect(events).to.have.length(0);
		});
	});

	describe('foreign-key actions facet', () => {
		beforeEach(async () => {
			await db.exec(`
				create table p (id integer primary key);
				create table c (id integer primary key, pid integer not null references p(id) on delete cascade);
				create table g (id integer primary key, cid integer not null references c(id) on delete cascade);
				insert into p values (1);
				insert into c values (10, 1);
				insert into g values (100, 10);
			`);
		});

		it('parent-delete change with the facet ON cascades to children and grandchildren', async () => {
			// The cascade DML re-enters the full DML pipeline, so the cascaded
			// child writes get their own capture (watch on c) and MV maintenance
			// (mv_c) — asserted here, not just the direct child delete.
			await db.exec('create materialized view mv_c as select id, pid from c');
			const cEvents: WatchEvent[] = [];
			const sub = db.watch(db.prepare('select * from c').getChangeScope(), e => { cEvents.push(e); });

			await directWrite(db, 'p', 'delete', undefined, [1]);
			await db.ingestExternalRowChanges(
				[chg('p', { op: 'delete', oldRow: [1] })],
				{ applyForeignKeyActions: true },
			);
			sub.unsubscribe();

			expect(await readAll(db, 'select * from c'), 'children cascaded').to.deep.equal([]);
			expect(await readAll(db, 'select * from g'), 'grandchildren cascaded').to.deep.equal([]);
			expect(await readAll(db, 'select * from mv_c'), "cascaded child writes drove c's MV").to.deep.equal([]);
			expect(cEvents.length, "cascaded child writes were captured (watch on c fired)").to.equal(1);
		});

		it('the facet is OFF by default — children untouched', async () => {
			await directWrite(db, 'p', 'delete', undefined, [1]);
			await db.ingestExternalRowChanges([chg('p', { op: 'delete', oldRow: [1] })]);

			expect((await readAll(db, 'select id from c')).map(r => Number(r.id))).to.deep.equal([10]);
			expect((await readAll(db, 'select id from g')).map(r => Number(r.id))).to.deep.equal([100]);
		});

		it('insert changes are a per-change no-op for the facet (no parent-side actions)', async () => {
			await db.ingestExternalRowChanges(
				[chg('p', { op: 'insert', newRow: [2] })],
				{ applyForeignKeyActions: true },
			);
			expect((await readAll(db, 'select id from c')).map(r => Number(r.id))).to.deep.equal([10]);
		});

		it('pragma foreign_keys = off + facet ON: no actions, no error', async () => {
			await db.exec('pragma foreign_keys = false');
			await directWrite(db, 'p', 'delete', undefined, [1]);
			await db.ingestExternalRowChanges(
				[chg('p', { op: 'delete', oldRow: [1] })],
				{ applyForeignKeyActions: true },
			);
			expect((await readAll(db, 'select id from c')).map(r => Number(r.id))).to.deep.equal([10]);
		});
	});

	describe('FK RESTRICT mid-batch: batch atomicity for derived effects', () => {
		it('throws, rolls back an earlier change\'s backing delta, fires no watch', async () => {
			await db.exec(`
				create table t (id integer primary key, v text);
				create materialized view mv as select id, v from t;
				create table p (id integer primary key);
				create table c (id integer primary key, pid integer not null references p(id) on delete restrict);
				insert into p values (1);
				insert into c values (10, 1);
			`);
			const events: WatchEvent[] = [];
			const sub = db.watch(db.prepare('select * from t').getChangeScope(), e => { events.push(e); });

			await expectThrows(
				() => db.ingestExternalRowChanges([
					chg('t', { op: 'insert', newRow: [1, 'a'] }),
					chg('p', { op: 'delete', oldRow: [1] }),
				], { applyForeignKeyActions: true }),
				'RESTRICT',
			);
			sub.unsubscribe();

			// The earlier change's backing delta unwound with the batch savepoint;
			// the implicit transaction rolled back; capture never dispatched.
			expect(await readAll(db, 'select * from mv')).to.deep.equal([]);
			expect(events).to.have.length(0);
			expect(db.getAutocommit(), 'no transaction left open').to.equal(true);
		});
	});

	describe('transaction boundaries', () => {
		beforeEach(async () => {
			await db.exec('create table t (id text primary key, v text)');
			await db.exec('create materialized view mv as select id, v from t');
		});

		it('implicit: the seam begins and commits its own transaction at batch end', async () => {
			expect(db.getAutocommit()).to.equal(true);
			await db.ingestExternalRowChanges([chg('t', { op: 'insert', newRow: ['x', 'a'] })]);
			expect(db.getAutocommit(), 'committed at batch end').to.equal(true);
			expect((await readAll(db, 'select id from mv')).map(r => r.id)).to.deep.equal(['x']);
		});

		it('explicit: derived effects are visible inside the transaction, watch waits for commit', async () => {
			const events: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { events.push(e); });

			await db.exec('begin');
			await db.ingestExternalRowChanges([chg('t', { op: 'insert', newRow: ['x', 'a'] })]);
			expect(db.getAutocommit(), 'caller transaction stays open').to.equal(false);
			expect((await readAll(db, 'select id from mv')).map(r => r.id),
				'backing delta visible in-transaction').to.deep.equal(['x']);
			expect(events, 'watch dispatch waits for the caller commit').to.have.length(0);

			await db.exec('commit');
			sub.unsubscribe();
			expect(events, 'watch fires at the caller commit').to.have.length(1);
			expect(events[0].matched[0].hits).to.deep.equal([['x']]);
		});

		it('explicit: rollback discards the backing delta and capture in lockstep', async () => {
			const events: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { events.push(e); });

			await db.exec('begin');
			await db.ingestExternalRowChanges([chg('t', { op: 'insert', newRow: ['x', 'a'] })]);
			await db.exec('rollback');
			sub.unsubscribe();

			expect(await readAll(db, 'select * from mv')).to.deep.equal([]);
			expect(events).to.have.length(0);
		});

		it('explicit: a mid-batch error leaves the caller transaction OPEN with only that batch unwound', async () => {
			const events: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 'x'), e => { events.push(e); });

			await db.exec('begin');
			await db.ingestExternalRowChanges([chg('t', { op: 'insert', newRow: ['x', 'a'] })]);
			await expectThrows(
				() => db.ingestExternalRowChanges([
					chg('t', { op: 'insert', newRow: ['y', 'b'] }),
					chg('t', { op: 'insert', newRow: ['z'] }), // arity error mid-batch
				]),
				'arity',
			);

			// The caller's transaction survives (caller decides); the failed
			// batch's savepoint unwound its derived effects; the earlier batch's
			// effects are intact and commit normally.
			expect(db.getAutocommit(), 'caller transaction left open').to.equal(false);
			expect((await readAll(db, 'select id from mv order by id')).map(r => r.id),
				'first batch intact, failed batch unwound').to.deep.equal(['x']);

			await db.exec('commit');
			sub.unsubscribe();
			expect(events, 'capture from the surviving batch dispatches at commit').to.have.length(1);
			expect(events[0].matched[0].hits).to.deep.equal([['x']]);
		});
	});

	describe('change capture → commit-time global assertions', () => {
		beforeEach(async () => {
			await db.exec('create table t (id integer primary key, v integer)');
			await db.exec(
				'create assertion non_negative check (not exists (select 1 from t where v < 0))');
		});

		it('a violating inbound batch fails the implicit commit; state resets cleanly', async () => {
			// Assertion evaluation re-reads the table, so the violating row must
			// be physically present — directWrite is the external storage write.
			await directWrite(db, 't', 'insert', [1, -5]);
			const events: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 1), e => { events.push(e); });

			await expectThrows(
				() => db.ingestExternalRowChanges([chg('t', { op: 'insert', newRow: [1, -5] })]),
				'non_negative',
			);
			sub.unsubscribe();

			expect(db.getAutocommit(), 'failed commit resets to autocommit').to.equal(true);
			expect(events, 'no watch dispatch on a failed commit').to.have.length(0);
		});

		it("assertionFailureMode: 'throw' (explicit) behaves identically to the default", async () => {
			await directWrite(db, 't', 'insert', [1, -5]);
			const events: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 1), e => { events.push(e); });

			await expectThrows(
				() => db.ingestExternalRowChanges(
					[chg('t', { op: 'insert', newRow: [1, -5] })],
					{ assertionFailureMode: 'throw' }),
				'non_negative',
			);
			sub.unsubscribe();

			expect(db.getAutocommit(), 'failed commit resets to autocommit').to.equal(true);
			expect(events, 'no watch dispatch on a failed commit').to.have.length(0);
		});

		it('report mode collects the violation, commits the batch, and fires the watch', async () => {
			await directWrite(db, 't', 'insert', [1, -5]);
			const events: WatchEvent[] = [];
			const sub = db.watch(rowsWatch('t', 'id', 1), e => { events.push(e); });

			const result = await db.ingestExternalRowChanges(
				[chg('t', { op: 'insert', newRow: [1, -5] })],
				{ assertionFailureMode: 'report' },
			);
			sub.unsubscribe();

			expect(result.assertionViolations.map(v => v.assertion)).to.deep.equal(['non_negative']);
			expect(result.assertionViolations[0].samples.length, 'samples non-empty').to.be.greaterThan(0);
			// Contrast the throw-mode test above: the batch committed (not rolled
			// back) and the watch DID fire for the violating row.
			expect(db.getAutocommit(), 'batch committed, not rolled back').to.equal(true);
			expect(events, 'watch fired for the row').to.have.length(1);
			expect(events[0].matched[0].hits).to.deep.equal([[1]]);
		});

		it('report mode + a covering MV: the violation is reported and the MV still converges', async () => {
			await db.exec('create materialized view mv as select id, v from t');
			await directWrite(db, 't', 'insert', [1, -5]);

			const result = await db.ingestExternalRowChanges(
				[chg('t', { op: 'insert', newRow: [1, -5] })],
				{ assertionFailureMode: 'report' },
			);

			expect(result.assertionViolations.map(v => v.assertion)).to.deep.equal(['non_negative']);
			// Derived effects persisted: the MV row is present and equals the base
			// row — consistent, no refresh. This is the whole point of report mode.
			const mvRows = (await readAll(db, 'select id, v from mv order by id'))
				.map(r => ({ id: Number(r.id), v: Number(r.v) }));
			expect(mvRows).to.deep.equal([{ id: 1, v: -5 }]);
			expect(db.getAutocommit()).to.equal(true);
		});

		it('report mode collects ALL violated assertions in one batch', async () => {
			await db.exec(
				'create assertion also_non_negative check (not exists (select 1 from t where v < 0))');
			await directWrite(db, 't', 'insert', [1, -5]);

			const result = await db.ingestExternalRowChanges(
				[chg('t', { op: 'insert', newRow: [1, -5] })],
				{ assertionFailureMode: 'report' },
			);

			expect(result.assertionViolations.map(v => v.assertion))
				.to.have.members(['non_negative', 'also_non_negative']);
			expect(db.getAutocommit()).to.equal(true);
		});

		it('report mode collects a no-dependency assertion (CHECK (1=0))', async () => {
			// A no-dependency assertion is evaluated via the direct loop whenever
			// the batch changed something. A non-negative row keeps `non_negative`
			// satisfied, isolating the no-dependency collection.
			await db.exec('create assertion always_false check (1 = 0)');
			await directWrite(db, 't', 'insert', [1, 5]);

			const result = await db.ingestExternalRowChanges(
				[chg('t', { op: 'insert', newRow: [1, 5] })],
				{ assertionFailureMode: 'report' },
			);

			expect(result.assertionViolations.map(v => v.assertion)).to.deep.equal(['always_false']);
			expect(db.getAutocommit()).to.equal(true);
		});

		it('report mode inside an explicit caller transaction does not collect (caller owns commit)', async () => {
			// The seam-owned implicit commit is the only place report mode is
			// honored. Inside an explicit transaction the seam does not commit, so
			// the sink is never consumed; assertions fire at the caller's commit in
			// throw mode.
			await db.exec('begin');
			// The violating row rides the caller's transaction so the assertion sees
			// it at the caller's commit.
			await directWrite(db, 't', 'insert', [1, -5]);
			const result = await db.ingestExternalRowChanges(
				[chg('t', { op: 'insert', newRow: [1, -5] })],
				{ assertionFailureMode: 'report' },
			);
			expect(result.assertionViolations, 'no collection under an explicit transaction').to.have.length(0);
			// The caller's commit still enforces the assertion (throw mode).
			await expectThrows(() => db.exec('commit'), 'non_negative');
		});

		it('captureChanges: false opts the batch out of assertion evaluation', async () => {
			await directWrite(db, 't', 'insert', [1, -5]);
			// Nothing captured → empty change log → assertions are not evaluated
			// at the implicit commit (the opt-out half of the capture facet).
			await db.ingestExternalRowChanges(
				[chg('t', { op: 'insert', newRow: [1, -5] })],
				{ captureChanges: false },
			);
			expect(db.getAutocommit()).to.equal(true);
		});
	});

	describe('validation and edge cases', () => {
		it('unknown table → NOTFOUND, zero effects', async () => {
			await db.exec('create table t (id text primary key, v text)');
			const err = await expectThrows(
				() => db.ingestExternalRowChanges([chg('nope', { op: 'insert', newRow: [1] })]),
				'not found',
			);
			expect((err as QuereusError).code).to.equal(StatusCode.NOTFOUND);
			expect(db.getAutocommit(), 'no transaction left open').to.equal(true);
		});

		it('unknown schema → NOTFOUND', async () => {
			await db.exec('create table t (id text primary key, v text)');
			const err = await expectThrows(
				() => db.ingestExternalRowChanges([
					{ schemaName: 'nope', tableName: 't', change: { op: 'insert', newRow: ['x', 'a'] } },
				]),
				'not found',
			);
			expect((err as QuereusError).code).to.equal(StatusCode.NOTFOUND);
		});

		it('row-arity mismatch → MISUSE, batch unwound', async () => {
			await db.exec('create table t (id text primary key, v text)');
			await db.exec('create materialized view mv as select id, v from t');
			const err = await expectThrows(
				() => db.ingestExternalRowChanges([
					chg('t', { op: 'insert', newRow: ['x', 'a'] }),
					chg('t', { op: 'insert', newRow: ['y'] }),
				]),
				'arity',
			);
			expect((err as QuereusError).code).to.equal(StatusCode.MISUSE);
			expect(await readAll(db, 'select * from mv'), 'earlier change unwound').to.deep.equal([]);
			expect(db.getAutocommit()).to.equal(true);
		});

		it('a change against a non-default schema resolves and captures with executor parity', async () => {
			await db.exec('create table temp.t2 (id text primary key, v text)');
			const events: WatchEvent[] = [];
			const sub = db.watch(db.prepare('select * from temp.t2').getChangeScope(), e => { events.push(e); });

			await db.ingestExternalRowChanges([
				{ schemaName: 'temp', tableName: 't2', change: { op: 'insert', newRow: ['x', 'a'] } },
			]);
			sub.unsubscribe();

			// The capture key resolved to temp.t2 (not main.t2), so the watch
			// projected onto the temp table matched.
			expect(events).to.have.length(1);
		});

		it("an update change missing its oldRow → MISUSE (shape, not a deep TypeError)", async () => {
			await db.exec('create table t (id text primary key, v text)');
			const err = await expectThrows(
				() => db.ingestExternalRowChanges([
					chg('t', { op: 'update', newRow: ['x', 'a'] } as unknown as ExternalRowChange['change']),
				]),
				"oldRow is required for op 'update'",
			);
			expect((err as QuereusError).code).to.equal(StatusCode.MISUSE);
		});

		it('an unrecognized op → MISUSE', async () => {
			await db.exec('create table t (id text primary key, v text)');
			const err = await expectThrows(
				() => db.ingestExternalRowChanges([
					chg('t', { op: 'upsert', newRow: ['x', 'a'] } as unknown as ExternalRowChange['change']),
				]),
				"unknown op 'upsert'",
			);
			expect((err as QuereusError).code).to.equal(StatusCode.MISUSE);
		});

		it('empty batch is a no-op and begins no transaction', async () => {
			await db.exec('create table t (id text primary key, v text)');
			expect(db.getAutocommit()).to.equal(true);
			await db.ingestExternalRowChanges([]);
			expect(db.getAutocommit()).to.equal(true);
		});
	});
});
