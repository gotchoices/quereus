/**
 * Lens constraint enforcement — live per-write firing of the prover's
 * `enforced-row-local` obligations (docs/lens.md § Constraint Attachment; ticket
 * `lens-constraint-enforcement-wiring`).
 *
 * The prover (`lens-prover-and-attachment`) classifies a scalar logical `check`
 * over non-computed columns as `enforced-row-local`. This suite asserts that such
 * a check actually fires *at the lens write boundary* — on inserts and updates
 * through the logical table — even when the basis table carries no such check, and
 * that the logical→basis column rewrite holds under a rename override.
 *
 * Each scenario gets a fresh Database and deploys through the full `apply schema`
 * pipeline, so enforcement runs exactly as in production.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { astToString } from '../src/emit/ast-stringify.js';
import {
	collectLensRowLocalConstraints,
	collectLensForeignKeyConstraints,
	LENS_BOUNDARY_ATTACHED_TAG,
} from '../src/planner/mutation/lens-enforcement.js';
import type { LensSlot } from '../src/schema/lens.js';

async function expectThrows(fn: () => Promise<unknown>, matcher?: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		if (matcher) {
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg, `error message should match ${matcher}`).to.match(matcher);
		}
	}
	expect(threw, 'expected the operation to throw').to.be.true;
}

function slot(db: Database, table: string): LensSlot {
	const s = db.schemaManager.getSchema('x')!.getLensSlot(table);
	expect(s, `lens slot for x.${table}`).to.not.be.undefined;
	return s!;
}

async function rows(db: Database, sql: string): Promise<unknown[]> {
	const out: unknown[] = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

describe('lens enforcement: row-local CHECK at the write boundary', () => {
	it('a logical check fires on insert/update through the lens, though the basis has none', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			// The basis carries no such check — a violating value goes straight in.
			await db.exec('insert into y.t values (100, -99)');

			// Through the lens, the logical check fires on insert...
			await expectThrows(() => db.exec('insert into x.t (id, val) values (1, -5)'), /nonneg|constraint/i);
			// ...and a satisfying insert succeeds.
			await db.exec('insert into x.t (id, val) values (2, 5)');
			expect(await rows(db, 'select id, val from x.t where id = 2')).to.deep.equal([{ id: 2, val: 5 }]);

			// ...and on update.
			await expectThrows(() => db.exec('update x.t set val = -1 where id = 2'), /nonneg|constraint/i);
			await db.exec('update x.t set val = 10 where id = 2');
			expect(await rows(db, 'select val from x.t where id = 2')).to.deep.equal([{ val: 10 }]);

			// The violating basis row inserted directly is untouched (enforcement is
			// at the lens, not retroactive against the basis).
			expect(await rows(db, 'select val from x.t where id = 100')).to.deep.equal([{ val: -99 }]);
		} finally {
			await db.close();
		}
	});

	it('enforces the logical check in basis terms under a rename override', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, speed integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, maxSpeed integer, constraint pos check (maxSpeed >= 0)) }');
			await db.exec('declare lens for x over y { view t as select id, speed as maxSpeed from y.t }');
			await db.exec('apply schema x');

			// The check is declared over the logical column `maxSpeed`; the lens
			// rewrites it to the basis column `speed`, so it still fires on a write.
			await expectThrows(() => db.exec('insert into x.t (id, maxSpeed) values (1, -5)'), /pos|constraint/i);
			await db.exec('insert into x.t (id, maxSpeed) values (2, 5)');
			expect(await rows(db, 'select id, maxSpeed from x.t where id = 2')).to.deep.equal([{ id: 2, maxSpeed: 5 }]);

			// The rewrite is visible on the synthesized basis-term constraint.
			const basisConstraints = collectLensRowLocalConstraints(slot(db, 't'));
			expect(basisConstraints.length, 'one routed row-local check').to.equal(1);
			const exprSql = astToString(basisConstraints[0].expr);
			expect(exprSql, 'rewritten to the basis column').to.match(/\bspeed\b/i);
			expect(exprSql, 'no longer references the logical column').to.not.match(/maxspeed/i);
		} finally {
			await db.close();
		}
	});

	it('stamps the boundary-attached marker on each routed constraint', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			const routed = collectLensRowLocalConstraints(slot(db, 't'));
			expect(routed.length).to.equal(1);
			expect(routed[0].tags?.[LENS_BOUNDARY_ATTACHED_TAG], 'marker present').to.equal(true);
			expect(routed[0].name).to.equal('lens:nonneg');
		} finally {
			await db.close();
		}
	});

	it('a check-free / non-lens write routes no extra constraints', async () => {
		const db = new Database();
		try {
			// Logical table with no check constraint ⇒ no row-local obligations.
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer) }');
			await db.exec('apply schema x');

			expect(collectLensRowLocalConstraints(slot(db, 't'))).to.deep.equal([]);

			// And a plain physical table's write is unaffected: a normal insert works.
			await db.exec('insert into x.t (id, val) values (1, -5)');
			expect(await rows(db, 'select val from x.t where id = 1')).to.deep.equal([{ val: -5 }]);
		} finally {
			await db.close();
		}
	});

	it('does not enforce a row-local check on delete (no NEW row to guard)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			// Seed a satisfying row through the lens, then delete it — the check must
			// not spuriously block the delete.
			await db.exec('insert into x.t (id, val) values (1, 5)');
			await db.exec('delete from x.t where id = 1');
			expect(await rows(db, 'select count(*) as n from x.t')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: row-local CHECK — multi-column / aliasing / conflict resolution', () => {
	it('a check over two renamed logical columns rewrites both to their basis terms', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, lo integer, hi integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, constraint ord check (a <= b)) }');
			await db.exec('declare lens for x over y { view t as select id, lo as a, hi as b from y.t }');
			await db.exec('apply schema x');

			await expectThrows(() => db.exec('insert into x.t (id, a, b) values (1, 5, 2)'), /ord|constraint/i);
			await db.exec('insert into x.t (id, a, b) values (2, 2, 5)');
			expect(await rows(db, 'select a, b from x.t where id = 2')).to.deep.equal([{ a: 2, b: 5 }]);
			// The rewrite landed in basis terms (lo/hi), so the basis row reflects the mapping.
			expect(await rows(db, 'select lo, hi from y.t where id = 2')).to.deep.equal([{ lo: 2, hi: 5 }]);
		} finally {
			await db.close();
		}
	});

	it('a column-swapping override rewrites each logical column independently (no double-substitution)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, p integer, q integer) }');
			await db.exec('apply schema y');
			// logical a ← basis q, logical b ← basis p (a swap); the check `a > b` must
			// rewrite to `q > p`, NOT collapse under re-substitution.
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer, constraint gt check (a > b)) }');
			await db.exec('declare lens for x over y { view t as select id, q as a, p as b from y.t }');
			await db.exec('apply schema x');

			await db.exec('insert into x.t (id, a, b) values (1, 10, 1)');
			expect(await rows(db, 'select p, q from y.t where id = 1')).to.deep.equal([{ p: 1, q: 10 }]);
			await expectThrows(() => db.exec('insert into x.t (id, a, b) values (2, 1, 10)'), /gt|constraint/i);
		} finally {
			await db.close();
		}
	});

	it('OR IGNORE skips a row that violates the lens row-local check (no throw, not inserted)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			// The synthetic constraint inherits statement-level conflict handling via the
			// basis ConstraintCheckNode: OR IGNORE silently drops the offending row.
			await db.exec('insert or ignore into x.t (id, val) values (1, -5)');
			expect(await rows(db, 'select count(*) as n from x.t')).to.deep.equal([{ n: 0 }]);
			// A satisfying row in the same shape still lands.
			await db.exec('insert or ignore into x.t (id, val) values (2, 5)');
			expect(await rows(db, 'select val from x.t where id = 2')).to.deep.equal([{ val: 5 }]);
		} finally {
			await db.close();
		}
	});

	it('OR REPLACE still aborts on a lens row-local CHECK violation (REPLACE resolves uniqueness/NOT NULL, not CHECK)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			await expectThrows(() => db.exec('insert or replace into x.t (id, val) values (1, -5)'), /nonneg|constraint/i);
			expect(await rows(db, 'select count(*) as n from x.t')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: child-side FK existence at the write boundary', () => {
	/**
	 * Deploys a basis schema with **no** FK and a logical schema declaring the FK,
	 * over an optional override body. The basis tables hold the data; the logical FK
	 * exists only at the lens boundary, so it is the lens — not the basis — that must
	 * enforce it. `foreign_keys` defaults on.
	 */
	async function deployFkLens(db: Database, opts?: { override?: string; childBasis?: string }): Promise<void> {
		// `default_column_nullability` is `not_null` (Third Manifesto), so the FK
		// column is declared explicitly nullable to exercise MATCH SIMPLE.
		await db.exec(`declare schema y { table parent (id integer primary key, name text); table child (id integer primary key, ${opts?.childBasis ?? 'pid integer null'}) }`);
		await db.exec('apply schema y');
		await db.exec('declare logical schema x { table parent (id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent(id)) }');
		if (opts?.override) await db.exec(opts.override);
		await db.exec('apply schema x');
	}

	it('the core gap — a dangling FK insert ABORTs through the lens though the basis has no FK', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			// Basis accepts a dangling reference directly (no basis FK).
			await db.exec('insert into y.child values (500, 999)');
			// Through the lens, the logical FK fires: no parent id=99 ⇒ ABORT.
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, 99)'), /fk_pid|constraint|foreign/i);
			expect(await rows(db, 'select count(*) as n from x.child where id = 10')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('a satisfying insert succeeds once the parent exists', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			expect(await rows(db, 'select id, pid from x.child where id = 10')).to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('a NULL FK column is allowed (MATCH SIMPLE) with no parent lookup', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			await db.exec('insert into x.child (id, pid) values (10, null)');
			expect(await rows(db, 'select id, pid from x.child where id = 10')).to.deep.equal([{ id: 10, pid: null }]);
		} finally {
			await db.close();
		}
	});

	it('the foreign_keys pragma gates it — off ⇒ dangling insert accepted', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			await db.exec('pragma foreign_keys = false');
			// No synthesized check ⇒ the dangling reference is accepted, matching the
			// physical child-side FK gate.
			await db.exec('insert into x.child (id, pid) values (10, 99)');
			expect(await rows(db, 'select pid from x.child where id = 10')).to.deep.equal([{ pid: 99 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE to a dangling FK value ABORTs; to a valid value succeeds', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			await db.exec(`insert into x.parent (id, name) values (1, 'a'), (2, 'b')`);
			await db.exec('insert into x.child (id, pid) values (10, 1)');
			await expectThrows(() => db.exec('update x.child set pid = 99 where id = 10'), /fk_pid|constraint|foreign/i);
			expect(await rows(db, 'select pid from x.child where id = 10')).to.deep.equal([{ pid: 1 }]);
			await db.exec('update x.child set pid = 2 where id = 10');
			expect(await rows(db, 'select pid from x.child where id = 10')).to.deep.equal([{ pid: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('a rename override rewrites the child FK column to basis terms (still ABORTs dangling)', async () => {
		const db = new Database();
		try {
			await deployFkLens(db, {
				childBasis: 'basis_pid integer',
				override: 'declare lens for x over y { view child as select id, basis_pid as pid from y.child }',
			});

			await db.exec(`insert into x.parent (id, name) values (1, 'a')`);
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, 99)'), /fk_pid|constraint|foreign/i);
			await db.exec('insert into x.child (id, pid) values (11, 1)');
			expect(await rows(db, 'select basis_pid from y.child where id = 11')).to.deep.equal([{ basis_pid: 1 }]);

			// The synthesized constraint references the BASIS child column, not the logical one.
			const routed = collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager);
			expect(routed.length, 'one routed FK check').to.equal(1);
			const exprSql = astToString(routed[0].expr);
			expect(exprSql, 'rewritten to basis child column').to.match(/basis_pid/i);
			expect(exprSql, 'no standalone logical pid reference').to.not.match(/\bpid\b/i);
		} finally {
			await db.close();
		}
	});

	it('no FK obligation ⇒ no routed FK constraint, no behavior change', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer) }');
			await db.exec('apply schema x');

			expect(collectLensForeignKeyConstraints(slot(db, 't'), db.schemaManager)).to.deep.equal([]);
			await db.exec('insert into x.t (id, val) values (1, 7)');
			expect(await rows(db, 'select val from x.t where id = 1')).to.deep.equal([{ val: 7 }]);
		} finally {
			await db.close();
		}
	});

	it('composes with a row-local check — both classes fire on the same write', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (id integer primary key); table child (id integer primary key, pid integer, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key); table child (id integer primary key, pid integer, val integer, constraint nonneg check (val >= 0), constraint fk_pid foreign key (pid) references parent(id)) }');
			await db.exec('apply schema x');
			await db.exec('insert into x.parent (id) values (1)');

			// Row-local check violation ABORTs (check).
			await expectThrows(() => db.exec('insert into x.child (id, pid, val) values (10, 1, -1)'), /nonneg|constraint/i);
			// Dangling FK ABORTs (FK).
			await expectThrows(() => db.exec('insert into x.child (id, pid, val) values (11, 99, 1)'), /fk_pid|constraint|foreign/i);
			// Both satisfied ⇒ ok.
			await db.exec('insert into x.child (id, pid, val) values (12, 1, 5)');
			expect(await rows(db, 'select id, pid, val from x.child where id = 12')).to.deep.equal([{ id: 12, pid: 1, val: 5 }]);
		} finally {
			await db.close();
		}
	});

	it('deferred semantics — child inserted before its parent in one transaction commits', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			// The synthesized EXISTS check auto-defers to commit (it contains a subquery),
			// so a child may precede its parent within a transaction.
			await db.exec('begin');
			await db.exec('insert into x.child (id, pid) values (10, 1)'); // dangling at this point
			await db.exec(`insert into x.parent (id, name) values (1, 'a')`); // satisfied before commit
			await db.exec('commit');
			expect(await rows(db, 'select id, pid from x.child where id = 10')).to.deep.equal([{ id: 10, pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('a composite (multi-column) FK enforces all components under MATCH SIMPLE', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (px integer, py integer, name text, primary key (px, py)); table child (id integer primary key, a integer null, b integer null, constraint fk_ab foreign key (a, b) references parent(px, py)) }');
			await db.exec('apply schema x');
			await db.exec(`insert into x.parent (px, py, name) values (1, 2, 'a')`);

			// Dangling composite reference ABORTs.
			await expectThrows(() => db.exec('insert into x.child (id, a, b) values (10, 1, 9)'), /fk_ab|constraint|foreign/i);
			// Matching composite reference succeeds.
			await db.exec('insert into x.child (id, a, b) values (11, 1, 2)');
			expect(await rows(db, 'select a, b from x.child where id = 11')).to.deep.equal([{ a: 1, b: 2 }]);
			// Any-NULL component is allowed under MATCH SIMPLE.
			await db.exec('insert into x.child (id, a, b) values (12, null, 5)');
			expect(await rows(db, 'select a, b from x.child where id = 12')).to.deep.equal([{ a: null, b: 5 }]);
		} finally {
			await db.close();
		}
	});

	it('a bare `references parent` (no column list) falls back to the parent PK', async () => {
		// The common FK idiom omits the parent column list, so the parser leaves
		// `referencedColumnNames` empty and the collector must resolve the parent
		// logical table's PK (`id`) via the fallback path. Distinct PK/non-PK column
		// names on the parent ensure the fallback picks the PK, not a positional guess.
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (pk_id integer primary key, name text); table child (id integer primary key, pid integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (pk_id integer primary key, name text); table child (id integer primary key, pid integer null, constraint fk_pid foreign key (pid) references parent) }');
			await db.exec('apply schema x');

			// The fallback resolves the parent column to its PK name `pk_id`.
			const routed = collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager);
			expect(routed.length, 'one routed FK check').to.equal(1);
			expect(astToString(routed[0].expr), 'parent side filters on the PK column').to.match(/pk_id/i);

			// And it actually enforces: dangling aborts, satisfied succeeds.
			await expectThrows(() => db.exec('insert into x.child (id, pid) values (10, 99)'), /fk_pid|constraint|foreign/i);
			await db.exec(`insert into x.parent (pk_id, name) values (1, 'a')`);
			await db.exec('insert into x.child (id, pid) values (11, 1)');
			expect(await rows(db, 'select pid from x.child where id = 11')).to.deep.equal([{ pid: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('unit: the collector returns one boundary-tagged EXISTS over the qualified logical parent', async () => {
		const db = new Database();
		try {
			await deployFkLens(db);
			const routed = collectLensForeignKeyConstraints(slot(db, 'child'), db.schemaManager);
			expect(routed.length).to.equal(1);
			expect(routed[0].tags?.[LENS_BOUNDARY_ATTACHED_TAG], 'boundary marker present').to.equal(true);
			expect(routed[0].name).to.equal('lens:fk:fk_pid');
			const exprSql = astToString(routed[0].expr);
			expect(exprSql, 'an EXISTS existence check').to.match(/exists/i);
			expect(exprSql, 'over the qualified logical parent').to.match(/parent/i);
			expect(exprSql, 'references the basis child column NEW.pid').to.match(/\bpid\b/i);
		} finally {
			await db.close();
		}
	});
});
