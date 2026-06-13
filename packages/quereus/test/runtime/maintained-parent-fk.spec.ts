// Parent-side referential enforcement for maintained-table derivation writes
// (ticket maintained-table-parent-side-fk-orphan).
//
// A maintained table `M` can be the PARENT (FK target) of an FK declared on an
// ordinary table `C`. When a SOURCE write drives maintenance to delete or
// key-update the referenced `M` row, the maintenance write path must fire the
// SAME parent-side referential-action engine an ordinary `delete from M` does —
// RESTRICT / CASCADE / SET NULL / SET DEFAULT — instead of silently orphaning
// `C`. The enforcement is wired in `MaterializedViewManager` at both backing-write
// sites (`maintainRowTime` bounded-delta arms + `flushDeferredRebuilds` full-rebuild
// floor), reusing `runtime/foreign-key-actions.ts` unchanged.
//
// This is the DUAL of `maintained-table-declared-constraints.spec.ts` (constraints
// declared *on* `M`, the child-side validator). Here the FK lives elsewhere and
// references `M`.

import { expect } from 'chai';
import { Database } from '../../src/index.js';

/** White-box: the registered maintenance-plan kind for a maintained table, so a
 *  "full-rebuild arm" test proves it really routes to the floor (not a bounded-delta
 *  arm that would also be correct). Mirrors the helper in
 *  test/incremental/maintenance-equivalence.spec.ts. */
interface ManagerHandle { materializedViewManager: { rowTime: Map<string, { kind: string }> } }
function registeredPlanKind(db: Database, qualifiedName: string): string | undefined {
	const mgr = (db as unknown as ManagerHandle).materializedViewManager;
	return mgr.rowTime.get(qualifiedName.toLowerCase())?.kind;
}

describe('Parent-side referential enforcement for maintained-table maintenance writes', () => {
	let db: Database;
	beforeEach(async () => {
		db = new Database();
		await db.exec('pragma foreign_keys = true');
	});
	afterEach(async () => { await db.close(); });

	async function readAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push({ ...row });
		return rows;
	}

	async function count(table: string): Promise<number> {
		return (await readAll(`select count(*) as n from ${table}`))[0].n as number;
	}

	async function expectError(fn: () => Promise<unknown>, messagePart: string): Promise<void> {
		let thrown: unknown;
		try {
			await fn();
		} catch (e) {
			thrown = e;
		}
		expect(thrown, 'expected a throw').to.exist;
		expect((thrown as Error).message).to.contain(messagePart);
	}

	/* ──────────────────── bounded-delta arm (inverse-projection) ──────────────────── */

	describe('inverse-projection arm (covering-index body)', () => {
		it('RESTRICT blocks a maintenance delete that would orphan the child and rolls back the source write', async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table m (id integer primary key, v text) maintained as select id, v from src;
				create table c (cid integer primary key, m_id integer,
					foreign key (m_id) references m(id) on delete restrict);
				insert into src values (1, 'a'), (2, 'b');
				insert into c values (10, 1);
			`);
			// The delete of src(1) maintenance-deletes m(1), which the child c(10) references.
			await expectError(
				() => db.exec('delete from src where id = 1'),
				`DELETE on 'm' violates RESTRICT from 'c'`,
			);
			// Whole source write rolled back: src, m, c all unchanged.
			expect(await readAll('select * from src order by id')).to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
			expect(await readAll('select * from m order by id')).to.deep.equal([{ id: 1, v: 'a' }, { id: 2, v: 'b' }]);
			expect(await readAll('select * from c')).to.deep.equal([{ cid: 10, m_id: 1 }]);

			// An unreferenced row maintenance-deletes cleanly.
			await db.exec('delete from src where id = 2');
			expect(await readAll('select id from m order by id')).to.deep.equal([{ id: 1 }]);
		});

		it('CASCADE removes the matching child rows on a maintenance delete', async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table m (id integer primary key, v text) maintained as select id, v from src;
				create table c (cid integer primary key, m_id integer,
					foreign key (m_id) references m(id) on delete cascade);
				insert into src values (1, 'a');
				insert into c values (10, 1), (11, 1);
			`);
			await db.exec('delete from src where id = 1');
			expect(await count('m')).to.equal(0);
			expect(await count('c'), 'both children cascade-deleted').to.equal(0);
		});

		it('SET NULL nulls the child FK column on a maintenance delete', async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table m (id integer primary key, v text) maintained as select id, v from src;
				create table c (cid integer primary key, m_id integer null,
					foreign key (m_id) references m(id) on delete set null);
				insert into src values (1, 'a');
				insert into c values (10, 1);
			`);
			await db.exec('delete from src where id = 1');
			expect(await count('m')).to.equal(0);
			expect(await readAll('select * from c')).to.deep.equal([{ cid: 10, m_id: null }]);
		});

		it('SET DEFAULT resets the child FK column to its default on a maintenance delete', async () => {
			await db.exec(`
				create table src (id integer primary key);
				create table m (id integer primary key) maintained as select id from src;
				create table c (cid integer primary key, m_id integer default 99,
					foreign key (m_id) references m(id) on delete set default);
				insert into src values (1), (99);
				insert into c values (10, 1);
			`);
			// Delete src(1) ⇒ m(1) removed ⇒ SET DEFAULT points c at the surviving m(99).
			await db.exec('delete from src where id = 1');
			expect(await readAll('select id from m')).to.deep.equal([{ id: 99 }]);
			expect(await readAll('select * from c')).to.deep.equal([{ cid: 10, m_id: 99 }]);
		});

		it('ON UPDATE CASCADE propagates a maintenance key-update into the child (referenced non-PK UNIQUE column)', async () => {
			await db.exec(`
				create table src (id integer primary key, code text);
				create table m (id integer primary key, code text unique) maintained as select id, code from src;
				create table c (cid integer primary key, m_code text,
					foreign key (m_code) references m(code) on update cascade);
				insert into src values (1, 'AAA');
				insert into c values (10, 'AAA');
			`);
			// Update src.code ⇒ m's referenced UNIQUE column moves at the same backing key
			// (a single backing update, not delete+insert) ⇒ ON UPDATE CASCADE into c.
			await db.exec(`update src set code = 'BBB' where id = 1`);
			expect(await readAll('select * from m')).to.deep.equal([{ id: 1, code: 'BBB' }]);
			expect(await readAll('select * from c')).to.deep.equal([{ cid: 10, m_code: 'BBB' }]);
		});

		it('ON UPDATE RESTRICT blocks a maintenance key-update and rolls the source write back', async () => {
			await db.exec(`
				create table src (id integer primary key, code text);
				create table m (id integer primary key, code text unique) maintained as select id, code from src;
				create table c (cid integer primary key, m_code text,
					foreign key (m_code) references m(code) on update restrict);
				insert into src values (1, 'AAA');
				insert into c values (10, 'AAA');
			`);
			await expectError(
				() => db.exec(`update src set code = 'BBB' where id = 1`),
				`UPDATE on 'm' violates RESTRICT from 'c'`,
			);
			expect(await readAll('select * from src')).to.deep.equal([{ id: 1, code: 'AAA' }]);
			expect(await readAll('select * from m')).to.deep.equal([{ id: 1, code: 'AAA' }]);
			expect(await readAll('select * from c')).to.deep.equal([{ cid: 10, m_code: 'AAA' }]);
		});
	});

	/* ──────────────────── full-rebuild floor arm ──────────────────── */

	describe('full-rebuild floor arm (enforcement fires at the flush boundary)', () => {
		// A multi-source non-join body (the WHERE `in` subquery reads a second table) fits no
		// bounded-delta arm and routes to the full-rebuild floor, while the projection keeps
		// `src`'s single-column key `id` as the backing PK — so an FK can reference m(id) and
		// each deferred rebuild realizes a clean per-key delete diff.
		const floorBody = 'select id, v from src where id in (select g from gate)';

		async function seedFloor(childFk: string): Promise<void> {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table gate (g integer primary key);
				create table m (id integer primary key, v text) maintained as ${floorBody};
				create table c (cid integer primary key, m_id integer, ${childFk});
				insert into gate values (1), (2);
				insert into src values (1, 'a'), (2, 'b');
				insert into c values (100, 1);
			`);
			expect(registeredPlanKind(db, 'main.m'), 'body must route to the full-rebuild floor').to.equal('full-rebuild');
		}

		it('RESTRICT fails the statement at the end-of-statement flush', async () => {
			await seedFloor('foreign key (m_id) references m(id) on delete restrict');
			await expectError(
				() => db.exec('delete from src where id = 1'),
				`DELETE on 'm' violates RESTRICT from 'c'`,
			);
			// Atomic rollback across the whole statement (the rebuild diff's delete is unwound).
			expect(await count('src')).to.equal(2);
			expect(await readAll('select id from m order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
			expect(await count('c')).to.equal(1);
		});

		it('CASCADE removes children when the rebuild diff drops the referenced row', async () => {
			await seedFloor('foreign key (m_id) references m(id) on delete cascade');
			await db.exec('delete from src where id = 1');
			expect(await readAll('select id from m order by id')).to.deep.equal([{ id: 2 }]);
			expect(await count('c'), 'child cascade-deleted at flush').to.equal(0);
		});
	});

	/* ──────────────────── MV-over-MV intermediate parent ──────────────────── */

	describe('MV-over-MV chain with an intermediate FK parent', () => {
		beforeEach(async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table m1 (id integer primary key, v text) maintained as select id, v from src;
				create table m2 (id integer primary key, v text) maintained as select id, v from m1;
				insert into src values (1, 'a');
			`);
		});

		it('RESTRICT on the intermediate m1 blocks a root source write that would ripple a delete through', async () => {
			await db.exec(`
				create table c (cid integer primary key, m_id integer,
					foreign key (m_id) references m1(id) on delete restrict);
				insert into c values (10, 1);
			`);
			await expectError(
				() => db.exec('delete from src where id = 1'),
				`DELETE on 'm1' violates RESTRICT from 'c'`,
			);
			// All three levels + child intact.
			expect(await count('src')).to.equal(1);
			expect(await count('m1')).to.equal(1);
			expect(await count('m2')).to.equal(1);
			expect(await count('c')).to.equal(1);
		});

		it('CASCADE on the intermediate m1 fires while the chain still maintains m2', async () => {
			await db.exec(`
				create table c (cid integer primary key, m_id integer,
					foreign key (m_id) references m1(id) on delete cascade);
				insert into c values (10, 1);
			`);
			await db.exec('delete from src where id = 1');
			expect(await count('m1')).to.equal(0);
			expect(await count('m2'), 'MV-over-MV cascade still converges m2').to.equal(0);
			expect(await count('c'), 'intermediate-parent cascade removed the child').to.equal(0);
		});
	});

	/* ──────────────────── converging feedback loop ──────────────────── */

	describe('converging feedback loop (child C is a source of parent M)', () => {
		it('a maintenance delete that cascades into a source converges to a clean terminal state', async () => {
			// m is derived from c; c has an on-delete-cascade FK back to m. Deleting a c row
			// maintenance-deletes the matching m row, whose cascade deletes further c rows,
			// which re-drive m maintenance — data-converging (each pass removes rows). The
			// FK is added via ALTER to break the create-time cycle.
			await db.exec(`
				create table c (cid integer primary key, m_ref integer null);
				create table m (id integer primary key) maintained as select cid as id from c;
				insert into c values (1, null), (2, 1);
				alter table c add constraint fk_mref foreign key (m_ref) references m(id) on delete cascade;
			`);
			expect(await readAll('select id from m order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);

			// Delete c(1) ⇒ m(1) removed ⇒ cascade deletes c(2) (m_ref=1) ⇒ m(2) removed.
			await db.exec('delete from c where cid = 1');
			expect(await count('c'), 'feedback loop drained c').to.equal(0);
			expect(await count('m'), 'feedback loop drained m').to.equal(0);
		});
	});

	/* ──────────────────── negative / no-op cases ──────────────────── */

	describe('no enforcement when it should not fire', () => {
		it('foreign_keys pragma off ⇒ no RESTRICT, no cascade (child orphaned, as with a plain delete)', async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table m (id integer primary key, v text) maintained as select id, v from src;
				create table c (cid integer primary key, m_id integer,
					foreign key (m_id) references m(id) on delete restrict);
				insert into src values (1, 'a');
				insert into c values (10, 1);
				pragma foreign_keys = false;
			`);
			await db.exec('delete from src where id = 1'); // no RESTRICT
			expect(await count('m')).to.equal(0);
			expect(await readAll('select * from c'), 'child left orphaned, untouched').to.deep.equal([{ cid: 10, m_id: 1 }]);
		});

		it('a NULL referenced value fires no spurious action (MATCH SIMPLE)', async () => {
			await db.exec(`
				create table src (id integer primary key, code text null);
				create table m (id integer primary key, code text null unique) maintained as select id, code from src;
				create table c (cid integer primary key, m_code text null,
					foreign key (m_code) references m(code) on delete restrict on update restrict);
				insert into src values (1, null);
			`);
			// m(1) has a NULL referenced column ⇒ deleting it participates in no FK match.
			await db.exec('delete from src where id = 1');
			expect(await count('m')).to.equal(0);
		});

		it('an equal-image maintenance update (unprojected column) drives no backing change and no enforcement', async () => {
			await db.exec(`
				create table src (id integer primary key, v text, extra text);
				create table m (id integer primary key, v text) maintained as select id, v from src;
				create table c (cid integer primary key, m_id integer,
					foreign key (m_id) references m(id) on delete restrict on update restrict);
				insert into src values (1, 'a', 'x');
				insert into c values (10, 1);
			`);
			// Touch only the unprojected `extra` column ⇒ m's image is unchanged ⇒ the
			// inverse-projection short-circuit yields no backing delta ⇒ no parent-side
			// enforcement (an erroneous fire would RESTRICT-throw here).
			await db.exec(`update src set extra = 'y' where id = 1`);
			expect(await readAll('select * from m')).to.deep.equal([{ id: 1, v: 'a' }]);
			expect(await readAll('select * from c')).to.deep.equal([{ cid: 10, m_id: 1 }]);
		});
	});

	/* ──────────────────── child + parent on the same maintained table ──────────────────── */

	describe('M that is both an FK child (declared on M) and an FK parent (referenced by C)', () => {
		it('validates M\'s new image AND enforces parent-side actions on M\'s removed image', async () => {
			await db.exec(`
				create table pp (pid integer primary key);
				create table src (id integer primary key, ref integer);
				-- M declares its OWN child-side FK (ref → pp) and is the PARENT of c.
				create table m (id integer primary key, ref integer references pp(pid))
					maintained as select id, ref from src;
				create table c (cid integer primary key, m_id integer,
					foreign key (m_id) references m(id) on delete cascade);
				insert into pp values (7);
				insert into src values (1, 7);
				insert into c values (10, 1);
			`);
			// Child-side: a source row whose derived image orphans pp fails M's own validator.
			await expectError(
				() => db.exec('insert into src values (2, 999)'),
				`row derived into maintained table 'main.m'`,
			);
			// Parent-side: deleting src(1) removes m(1) and cascades into c.
			await db.exec('delete from src where id = 1');
			expect(await count('m')).to.equal(0);
			expect(await count('c'), 'parent-side cascade removed the child').to.equal(0);
		});
	});

	/* ──────────────────── residual-recompute (aggregate) arm ──────────────────── */

	describe('residual-recompute (aggregate) arm as an FK parent', () => {
		// A bare-group-column aggregate routes to the residual arm (white-box-asserted). An
		// emptied group is realized as a backing `delete-key` (count → 0), structurally
		// distinct from the inverse-projection arm's delta — so this exercises a second,
		// genuinely different apply path under the arm-agnostic enforcement hook.
		async function seedAgg(childFk: string): Promise<void> {
			await db.exec(`
				create table src (id integer primary key, g integer);
				create table m (g integer primary key, n integer)
					maintained as select g, count(*) as n from src group by g;
				create table c (cid integer primary key, m_g integer, ${childFk});
				insert into src values (1, 10), (2, 10), (3, 20);
				insert into c values (100, 10);
			`);
			expect(registeredPlanKind(db, 'main.m'), 'body must route to the aggregate residual arm').to.equal('residual-recompute');
		}

		it('CASCADE removes children when a maintenance delete empties the referenced group', async () => {
			await seedAgg('foreign key (m_g) references m(g) on delete cascade');
			// Delete both rows of group 10 ⇒ m(10) backing row removed (count → 0) ⇒ cascade c.
			await db.exec('delete from src where g = 10');
			expect(await readAll('select g from m order by g')).to.deep.equal([{ g: 20 }]);
			expect(await count('c'), 'child cascade-deleted when its group emptied').to.equal(0);
		});

		it('RESTRICT blocks the maintenance delete that would empty a referenced group', async () => {
			await seedAgg('foreign key (m_g) references m(g) on delete restrict');
			await expectError(
				() => db.exec('delete from src where g = 10'),
				`DELETE on 'm' violates RESTRICT from 'c'`,
			);
			// Source + aggregate + child all intact.
			expect(await count('src')).to.equal(3);
			expect(await readAll('select g, n from m order by g')).to.deep.equal([{ g: 10, n: 2 }, { g: 20, n: 1 }]);
			expect(await count('c')).to.equal(1);
		});

		it('a non-emptying group decrement (upsert at the same key, not delete) fires no parent-side action', async () => {
			await seedAgg('foreign key (m_g) references m(g) on delete restrict on update restrict');
			// Remove ONE of group 10's two rows ⇒ m(10) updates n 2→1 at the same backing key
			// (an upsert/REPLACE, not a delete; the referenced column `g` is unchanged) ⇒ the
			// UPDATE referenced-column short-circuit means no enforcement; the child stands.
			await db.exec('delete from src where id = 1');
			expect(await readAll('select g, n from m order by g')).to.deep.equal([{ g: 10, n: 1 }, { g: 20, n: 1 }]);
			expect(await count('c')).to.equal(1);
		});
	});
});
