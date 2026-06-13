import { expect } from 'chai';
import { Database } from '../src/index.js';

/**
 * `refresh materialized view` re-validation pins for the one derivation write
 * path that previously bypassed declared-constraint validation — a manual
 * refresh of a constraint-bearing **table-form** maintained table
 * (`maintained-table-refresh-revalidation`).
 *
 * The real-world trigger is a STALE table: a body-relevant source schema change
 * marks the maintained table stale and releases its row-time plan, so subsequent
 * source writes are NOT maintained into it (nor validated against its declared
 * CHECK/FK). A later `refresh` recomputes from that drifted source state and —
 * before this ticket — committed it unvalidated. Now the constraint-bearing
 * `rebuildBacking` branch lands the recomputed set in the connection's pending
 * layer, runs the same bulk anti-join / `not(<check>)` scan the attach core uses,
 * throws the maintained-table-attributed diagnostic on the first violator BEFORE
 * committing, and only commits a conforming set.
 *
 * Orchestration note: each "stale → drift" flow does
 *   (1) seed a clean row → (2) a body-relevant source ALTER (stale + plan
 *   released) → (3) drift a violator into the unmaintained source →
 *   (4) `refresh` and assert.
 * `alter table src add column …` changes the source column COUNT, which is
 * body-RELEVANT (not recompilable in place), so it reliably marks the dependent
 * stale and detaches its plan.
 */
describe('Maintained-table refresh re-validation', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function readAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push({ ...row });
		return rows;
	}

	async function expectError(sql: string, messagePart: string): Promise<void> {
		try {
			await db.exec(sql);
		} catch (e) {
			expect((e as Error).message, `error message for '${sql}'`).to.contain(messagePart);
			return;
		}
		expect.fail(`expected '${sql}' to fail with: ${messagePart}`);
	}

	function isStale(name: string): boolean {
		return db.schemaManager.getMaintainedTable('main', name)!.derivation.stale === true;
	}

	describe('stale fast-path CHECK violation', () => {
		beforeEach(async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null);
				create table mt (id integer primary key, v text not null, check (v <> 'poison'))
					maintained as select id, v from src;
				insert into src values (1, 'clean');
			`);
			// Body-relevant source change: column count shifts ⇒ mt goes stale and its
			// row-time plan detaches, so the drift below is NOT maintained in.
			await db.exec(`alter table src add column pad integer null`);
			expect(isStale('mt'), 'add column marked mt stale').to.equal(true);
		});

		it('a refresh that recomputes a CHECK-violating row throws the attribution and leaves the pre-refresh rows intact', async () => {
			// Drift a violator into the (now unmaintained) source.
			await db.exec(`insert into src (id, v) values (2, 'poison')`);
			expect(await readAll('select id, v from mt order by id'), 'drift not maintained in')
				.to.deep.equal([{ id: 1, v: 'clean' }]);

			await expectError('refresh materialized view mt',
				`row derived into maintained table 'main.mt'`);

			// The pre-refresh committed contents survive; mt stays stale so the next read
			// re-validates/serves the snapshot rather than the rejected set.
			expect(await readAll('select id, v from mt order by id')).to.deep.equal([{ id: 1, v: 'clean' }]);
			expect(isStale('mt'), 'mt stays stale after a rejected refresh').to.equal(true);
		});

		it('a refresh that recomputes only conforming rows succeeds and clears stale', async () => {
			await db.exec(`insert into src (id, v) values (2, 'fresh')`);
			await db.exec('refresh materialized view mt');
			expect(await readAll('select id, v from mt order by id'))
				.to.deep.equal([{ id: 1, v: 'clean' }, { id: 2, v: 'fresh' }]);
			expect(isStale('mt'), 'a conforming refresh clears stale').to.equal(false);
		});
	});

	describe('stale fast-path child-side FK orphan', () => {
		beforeEach(async () => {
			await db.exec(`
				create table parent (pid integer primary key);
				create table src (id integer primary key, ref integer null);
				create table mt (id integer primary key, ref integer null references parent(pid))
					maintained as select id, ref from src;
				insert into parent values (1);
				insert into src values (1, 1);
			`);
			expect(await readAll('select id, ref from mt')).to.deep.equal([{ id: 1, ref: 1 }]);
			await db.exec(`alter table src add column pad integer null`);
			expect(isStale('mt'), 'add column marked mt stale').to.equal(true);
		});

		it('a refresh that recomputes an orphan throws the FK attribution and leaves the pre-refresh rows intact', async () => {
			await db.exec(`insert into src (id, ref) values (2, 99)`); // parent 99 absent
			await expectError('refresh materialized view mt',
				`references a missing 'main.parent'`);
			expect(await readAll('select id, ref from mt order by id')).to.deep.equal([{ id: 1, ref: 1 }]);
			expect(isStale('mt')).to.equal(true);
		});

		it('a refresh whose orphan-drift has a matching parent succeeds and clears stale', async () => {
			await db.exec(`insert into parent values (2)`);
			await db.exec(`insert into src (id, ref) values (2, 2)`);
			await db.exec('refresh materialized view mt');
			expect(await readAll('select id, ref from mt order by id'))
				.to.deep.equal([{ id: 1, ref: 1 }, { id: 2, ref: 2 }]);
			expect(isStale('mt')).to.equal(false);
		});

		it('a NULL-ref drift passes (MATCH SIMPLE)', async () => {
			await db.exec(`insert into src (id, ref) values (2, null)`);
			await db.exec('refresh materialized view mt');
			expect(await readAll('select id, ref from mt order by id'))
				.to.deep.equal([{ id: 1, ref: 1 }, { id: 2, ref: null }]);
			expect(isStale('mt')).to.equal(false);
		});

		it('an empty recomputed set succeeds (the bulk scan over empty contents trivially passes)', async () => {
			await db.exec('delete from src'); // unmaintained while stale
			await db.exec('refresh materialized view mt');
			expect(await readAll('select count(*) as n from mt')).to.deep.equal([{ n: 0 }]);
			expect(isStale('mt')).to.equal(false);
		});
	});

	describe('constraint-clean fast path is byte-identical (no validation scan)', () => {
		/** Run `body` with `db.prepare` wrapped, returning every SQL string prepared
		 *  during it. A bulk constraint validation prepares a `where not (<check>)`
		 *  CHECK scan or a `not exists (…)` FK anti-join; a constraint-less refresh
		 *  prepares only its body SELECT. */
		async function capturePrepares(body: () => Promise<void>): Promise<string[]> {
			const seen: string[] = [];
			const orig = db.prepare.bind(db);
			db.prepare = ((sql: string) => { seen.push(sql); return orig(sql); }) as typeof db.prepare;
			try {
				await body();
			} finally {
				db.prepare = orig;
			}
			return seen;
		}

		const isValidationScan = (sql: string): boolean =>
			/where not \(/i.test(sql) || /not exists \(/i.test(sql);

		it('a constraint-less table-form maintained table refresh runs no validation scan', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null);
				create table mt (id integer primary key, v text not null) maintained as select id, v from src;
				insert into src values (1, 'a');
			`);
			await db.exec(`alter table src add column pad integer null`); // stale
			await db.exec(`insert into src (id, v) values (2, 'b')`);

			const prepares = await capturePrepares(async () => {
				await db.exec('refresh materialized view mt');
			});
			expect(prepares.some(isValidationScan), 'no validation scan on a constraint-less refresh').to.equal(false);
			expect(await readAll('select id, v from mt order by id'))
				.to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
		});

		it('an MV-sugar refresh runs no validation scan', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null);
				create materialized view mv as select id, v from src;
				insert into src values (1, 'a');
			`);
			await db.exec(`alter table src add column pad integer null`); // stale
			await db.exec(`insert into src (id, v) values (2, 'b')`);

			const prepares = await capturePrepares(async () => {
				await db.exec('refresh materialized view mv');
			});
			expect(prepares.some(isValidationScan), 'no validation scan on an MV-sugar refresh').to.equal(false);
			expect(await readAll('select id, v from mv order by id'))
				.to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
		});

		it('positive control: a constraint-bearing refresh DOES run a validation scan', async () => {
			await db.exec(`
				create table src (id integer primary key, v text not null);
				create table mt (id integer primary key, v text not null, check (v <> 'poison'))
					maintained as select id, v from src;
				insert into src values (1, 'a');
			`);
			await db.exec(`alter table src add column pad integer null`); // stale
			await db.exec(`insert into src (id, v) values (2, 'b')`);

			const prepares = await capturePrepares(async () => {
				await db.exec('refresh materialized view mt');
			});
			expect(prepares.some(isValidationScan), 'a constraint-bearing refresh runs the bulk scan').to.equal(true);
		});
	});

	describe('pragma foreign_keys = off keeps the fast path (no retro-validation)', () => {
		it('an FK-only maintained table refresh succeeds over an orphan drift when enforcement is off', async () => {
			await db.exec(`pragma foreign_keys = off`);
			await db.exec(`
				create table parent (pid integer primary key);
				create table src (id integer primary key, ref integer null);
				create table mt (id integer primary key, ref integer null references parent(pid))
					maintained as select id, ref from src;
				insert into parent values (1);
				insert into src values (1, 1);
			`);
			await db.exec(`alter table src add column pad integer null`); // stale
			await db.exec(`insert into src (id, ref) values (2, 99)`); // orphan, unmaintained

			// FK enforcement off ⇒ the FK scan would no-op, so the table keeps the
			// validation-free fast path and the refresh admits the orphan (matching
			// ordinary tables — pragma flips do not retro-validate).
			await db.exec('refresh materialized view mt');
			expect(await readAll('select id, ref from mt order by id'))
				.to.deep.equal([{ id: 1, ref: 1 }, { id: 2, ref: 99 }]);
			expect(isStale('mt')).to.equal(false);
		});
	});

	describe('reshape arm + violation', () => {
		it('a stale reshape that recomputes a violator throws the attribution and is not left holding it', async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table mt (id integer primary key, v text, check (v <> 'poison'))
					maintained as select * from src;
				insert into src values (1, 'clean');
			`);
			// A trailing source add shifts the select* body's shape ⇒ refresh takes the
			// reshape arm; mt goes stale and its plan detaches.
			await db.exec(`alter table src add column w integer default 0`);
			expect(isStale('mt'), 'add column marked mt stale').to.equal(true);
			await db.exec(`insert into src (id, v, w) values (2, 'poison', 0)`); // drift, unmaintained

			await expectError('refresh materialized view mt',
				`row derived into maintained table 'main.mt'`);

			// The reshape's pre-reconcile structural add ran (non-transactional), so the
			// table now has the w column — but the validation threw before the swap
			// committed, so the violating row never landed and mt stays stale.
			const rows = await readAll('select id, v from mt order by id');
			expect(rows.every(r => r.v !== 'poison'), 'no violating row committed').to.equal(true);
			expect(rows).to.deep.equal([{ id: 1, v: 'clean' }]);
			expect(isStale('mt'), 'mt stays stale after a rejected reshape refresh').to.equal(true);
		});
	});

	describe('duplicate-key reject parity', () => {
		// A backing whose physical PK keys a TEXT column under NOCASE while the source
		// keys it under BINARY: 'a' and 'A' are distinct source rows but collide on the
		// backing key. Seeded with only 'a' (so create-fill is a clean set); after the
		// table goes stale, the unmaintained 'A' drift makes the recomputed set collide,
		// which both refresh branches must reject with the IDENTICAL "must be a set"
		// diagnostic (`materializedViewNotASetError`).
		const DUP_MESSAGE = 'body produces duplicate rows';

		it('a constraint-less refresh rejects duplicate derived keys (replaceContents fast path)', async () => {
			await db.exec(`
				create table src (k text primary key, v text);
				create materialized view mv as select k collate nocase as k, v from src;
				insert into src values ('a', 'x');
			`);
			await db.exec(`alter table src add column pad integer null`); // stale
			await db.exec(`insert into src (k, v) values ('A', 'y')`); // collides under NOCASE

			await expectError('refresh materialized view mv', DUP_MESSAGE);
		});

		it('a constraint-bearing refresh rejects duplicate derived keys with the SAME diagnostic', async () => {
			await db.exec(`
				create table src (k text primary key, v text);
				create table mt (k text collate nocase primary key, v text, check (v <> 'zzz'))
					maintained as select k collate nocase as k, v from src;
				insert into src values ('a', 'x');
			`);
			await db.exec(`alter table src add column pad integer null`); // stale
			await db.exec(`insert into src (k, v) values ('A', 'y')`); // collides under NOCASE

			await expectError('refresh materialized view mt', DUP_MESSAGE);
		});
	});
});
