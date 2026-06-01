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
	collectLensSetLevelConstraints,
	hasCommitTimeSetLevelObligation,
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

/**
 * The `mode` of every `enforced-set-level` obligation on a slot. Lets a test pin
 * the prover's *classification* — `row-time` vs `commit-time` — rather than only
 * the collector's output, which is `[]` for `row-time`, `proved`, AND `vacuous`
 * keys alike and so cannot, on its own, distinguish a genuine row-time key from a
 * key the body already proves.
 */
function setLevelModes(s: LensSlot): string[] {
	return (s.obligations ?? []).flatMap(o => (o.kind === 'enforced-set-level' ? [o.mode] : []));
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

describe('lens enforcement: set-level (unique / PK) commit-time at the write boundary', () => {
	it('a logical unique with no covering structure ABORTs a duplicate at commit (NULL-distinct)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			// Two distinct emails ⇒ ok.
			await db.exec(`insert into x.u (id, email) values (1, 'a@x'), (2, 'b@x')`);
			// A second insert that duplicates an existing email ⇒ ABORT at commit.
			await expectThrows(() => db.exec(`insert into x.u (id, email) values (3, 'a@x')`), /unique|constraint/i);
			// The original survives — the duplicating insert rolled back.
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 1 }]);
			// Two NULL emails are both accepted (SQL UNIQUE is NULL-distinct).
			await db.exec('insert into x.u (id, email) values (4, null)');
			await db.exec('insert into x.u (id, email) values (5, null)');
			expect(await rows(db, 'select count(*) as n from x.u where email is null')).to.deep.equal([{ n: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('a re-keyed PK (commit-time set-level) ABORTs a duplicate logical key', async () => {
		const db = new Database();
		try {
			// Basis keys on `id`; the logical table re-keys on `code` — reconstructible but
			// not basis-proved ⇒ the PK routes to a commit-time set-level scan.
			await db.exec('declare schema y { table t (id integer primary key, code text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (code text primary key, id integer) }');
			await db.exec('apply schema x');

			await db.exec(`insert into x.t (code, id) values ('A', 1)`);
			await db.exec(`insert into x.t (code, id) values ('B', 2)`); // distinct code ⇒ ok
			// Duplicate code (distinct basis id, so the basis PK does not catch it) ⇒ ABORT.
			await expectThrows(() => db.exec(`insert into x.t (code, id) values ('A', 3)`), /primary|unique|constraint/i);
			expect(await rows(db, `select id from x.t where code = 'A'`)).to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('the synthesized count check references the basis column on NEW and the logical column inside the subquery (rename override)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, mail text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('declare lens for x over y { view u as select id, mail as email from y.u }');
			await db.exec('apply schema x');

			const routed = collectLensSetLevelConstraints(slot(db, 'u'));
			expect(routed.length, 'one routed set-level check').to.equal(1);
			expect(routed[0].tags?.[LENS_BOUNDARY_ATTACHED_TAG], 'boundary marker present').to.equal(true);
			expect(routed[0].name, 'anonymous unique ⇒ lens:unique').to.equal('lens:unique');
			const exprSql = astToString(routed[0].expr);
			expect(exprSql, 'a count(*) existence-count check').to.match(/count\(\*\)/i);
			expect(exprSql, 'compared <= 1').to.match(/<=\s*1/);
			expect(exprSql, 'NEW side uses the basis column `mail`').to.match(/\bmail\b/i);
			expect(exprSql, 'subquery side keeps the logical column `email`').to.match(/\bemail\b/i);

			// And it enforces in basis terms: a duplicate email aborts; the basis stores `mail`.
			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			await expectThrows(() => db.exec(`insert into x.u (id, email) values (2, 'a@x')`), /unique|constraint/i);
			expect(await rows(db, 'select mail from y.u where id = 1')).to.deep.equal([{ mail: 'a@x' }]);
		} finally {
			await db.close();
		}
	});

	it('a composite unique key: all-/any-NULL tuples allowed, a fully-non-NULL duplicate ABORTs', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer null, b integer null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer null, b integer null, unique (a, b)) }');
			await db.exec('apply schema x');

			// (1, NULL) twice ⇒ both allowed (the b=NULL term makes the equality NULL, never counted).
			await db.exec('insert into x.t (id, a, b) values (1, 1, null)');
			await db.exec('insert into x.t (id, a, b) values (2, 1, null)');
			expect(await rows(db, 'select count(*) as n from x.t where a = 1 and b is null')).to.deep.equal([{ n: 2 }]);
			// (1, 2) twice ⇒ the second ABORTs.
			await db.exec('insert into x.t (id, a, b) values (3, 1, 2)');
			await expectThrows(() => db.exec('insert into x.t (id, a, b) values (4, 1, 2)'), /unique|constraint/i);
			expect(await rows(db, 'select count(*) as n from x.t where a = 1 and b = 2')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE that creates a duplicate ABORTs; one that keeps the key unique succeeds', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			await db.exec(`insert into x.u (id, email) values (1, 'a@x'), (2, 'b@x')`);
			// Update row 2's key to collide with row 1 ⇒ ABORT (row 2 unchanged).
			await expectThrows(() => db.exec(`update x.u set email = 'a@x' where id = 2`), /unique|constraint/i);
			expect(await rows(db, 'select email from x.u where id = 2')).to.deep.equal([{ email: 'b@x' }]);
			// Update to a still-unique key ⇒ ok.
			await db.exec(`update x.u set email = 'c@x' where id = 2`);
			expect(await rows(db, 'select email from x.u where id = 2')).to.deep.equal([{ email: 'c@x' }]);
		} finally {
			await db.close();
		}
	});

	it('an intra-statement duplicate (two new rows sharing the key) ABORTs the whole statement', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			await expectThrows(() => db.exec(`insert into x.u (id, email) values (1, 'dup'), (2, 'dup')`), /unique|constraint/i);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 0 }]);
		} finally {
			await db.close();
		}
	});

	it('deferred timing — a transient duplicate resolved before commit commits cleanly; still-duplicate ABORTs', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);

			// Transiently duplicate, then resolved by deleting the original before commit.
			await db.exec('begin');
			await db.exec(`insert into x.u (id, email) values (2, 'a@x')`); // dup at this point
			await db.exec('delete from x.u where id = 1'); // resolves it
			await db.exec('commit');
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 2 }]);

			// A state still duplicate at commit ABORTs.
			await expectThrows(async () => {
				await db.exec('begin');
				await db.exec(`insert into x.u (id, email) values (3, 'a@x')`); // collides with id=2
				await db.exec('commit');
			}, /unique|constraint/i);
			// id=2's row is the only 'a@x' (the failed txn rolled back).
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('rejects `or replace` / `or ignore` / upsert against a commit-time set-level key; `or abort` / plain insert pass', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			await expectThrows(() => db.exec(`insert or ignore into x.u (id, email) values (1, 'a@x')`), /covering|commit-time scan|conflict/i);
			await expectThrows(() => db.exec(`insert or replace into x.u (id, email) values (1, 'a@x')`), /covering|commit-time scan|conflict/i);
			await expectThrows(() => db.exec(`insert into x.u (id, email) values (1, 'a@x') on conflict (email) do nothing`), /covering|commit-time scan|conflict/i);

			// `or abort` and a plain insert are NOT rejected (still subject to the duplicate check).
			await db.exec(`insert or abort into x.u (id, email) values (1, 'a@x')`);
			await db.exec(`insert into x.u (id, email) values (2, 'b@x')`);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 2 }]);
			// The duplicate check still bites under `or abort`.
			await expectThrows(() => db.exec(`insert or abort into x.u (id, email) values (3, 'a@x')`), /unique|constraint/i);
		} finally {
			await db.close();
		}
	});

	it('a proved key (faithful projection of the basis PK) ⇒ collector returns [], write unaffected', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer) }');
			await db.exec('apply schema x');
			expect(collectLensSetLevelConstraints(slot(db, 't')), 'proved PK ⇒ []').to.deep.equal([]);
			await db.exec('insert into x.t (id, val) values (1, 7)');
			expect(await rows(db, 'select val from x.t where id = 1')).to.deep.equal([{ val: 7 }]);
		} finally {
			await db.close();
		}
	});

	it('a row-time key (a non-stale basis covering MV answers it) ⇒ collector returns [] (only commit-time emits)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema y');
			// Explicit basis covering MV over the UNIQUE columns ⇒ the unique classifies row-time.
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');
			expect(collectLensSetLevelConstraints(slot(db, 'u')), 'row-time unique ⇒ []').to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});

describe('lens enforcement: set-level (unique / PK) row-time at the write boundary', () => {
	/**
	 * Deploys a row-time set-level lens: a basis `unique(email)` plus an explicit
	 * covering materialized view `order by email` (so the logical `unique(email)`
	 * classifies `enforced-set-level` `row-time`, backed by the basis UC's physical
	 * covering-MV enforcement path). No new lens enforcement code carries this — the
	 * single-source re-plan reaches the basis UC, whose `checkUniqueViaMaterializedView`
	 * does the O(log n) existence lookup and honors ABORT/IGNORE/REPLACE.
	 */
	async function deployRowTimeUniqueLens(db: Database): Promise<void> {
		await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email)) }');
		await db.exec('apply schema y');
		await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
		await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
		await db.exec('apply schema x');
	}

	it('row-time unique ⇒ the commit-time collector emits nothing (separate covering-MV path)', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			// Pin the classification itself, not just the collector: the unique(email)
			// must be `enforced-set-level` `row-time` (the covering MV answers it). A
			// `proved` key would also pass the two assertions below, so without this
			// the suite could silently exercise a proved key instead of a row-time one.
			expect(setLevelModes(slot(db, 'u')), 'unique classifies row-time').to.deep.equal(['row-time']);
			// The commit-time count-subquery collector is the wrong class for a row-time
			// key: detection + resolution ride the basis UC's covering-MV path, not this.
			expect(collectLensSetLevelConstraints(slot(db, 'u')), 'row-time unique ⇒ []').to.deep.equal([]);
			expect(hasCommitTimeSetLevelObligation(slot(db, 'u')), 'no commit-time obligation').to.be.false;
		} finally {
			await db.close();
		}
	});

	it('detection aborts a duplicate; the original survives', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			await db.exec(`insert into x.u (id, email) values (1, 'a@x'), (2, 'b@x')`);
			// A third row duplicating an existing key ABORTs (basis UC via covering MV).
			await expectThrows(() => db.exec(`insert into x.u (id, email) values (3, 'a@x')`), /unique|constraint/i);
			// The original survives — the duplicating insert rolled back.
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('`insert or replace` resolves through the lens — evicts the prior row, lands the new one', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			// REPLACE on the unique(email) conflict evicts id=1 and lands id=5.
			await db.exec(`insert or replace into x.u (id, email) values (5, 'a@x')`);
			// Only the new id remains for that key — asserted by both logical and basis reads.
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 5 }]);
			expect(await rows(db, `select id from y.u where email = 'a@x'`)).to.deep.equal([{ id: 5 }]);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('`insert or ignore` resolves through the lens — skips the duplicate, leaves the original; a fresh key still lands', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			// IGNORE silently drops the duplicate; the original is untouched.
			await db.exec(`insert or ignore into x.u (id, email) values (5, 'a@x')`);
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 1 }]);
			// A fresh-key `or ignore` still lands.
			await db.exec(`insert or ignore into x.u (id, email) values (6, 'b@x')`);
			expect(await rows(db, `select id from x.u where email = 'b@x'`)).to.deep.equal([{ id: 6 }]);
		} finally {
			await db.close();
		}
	});

	it('explicit `or abort` ABORTs on a duplicate (consistent with a plain insert)', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			await expectThrows(() => db.exec(`insert or abort into x.u (id, email) values (2, 'a@x')`), /unique|constraint/i);
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('conflict resolution is NOT rejected — `or replace` / `or ignore` / upsert plan against a row-time key', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			// The negative of the commit-time rejection test: a row-time key has no
			// `enforced-set-level` `commit-time` obligation, so the conflict-resolution
			// gate (`rejectLensSetLevelConflictResolution`) declines to reject — the
			// covering MV resolves at row-time. None of these raise the
			// `lens-set-level-conflict-resolution` diagnostic.
			await db.exec(`insert or replace into x.u (id, email) values (1, 'a@x')`);
			await db.exec(`insert or ignore into x.u (id, email) values (2, 'b@x')`);
			await db.exec(`insert into x.u (id, email) values (3, 'c@x') on conflict (email) do nothing`);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 3 }]);
		} finally {
			await db.close();
		}
	});

	it('an UPDATE that creates a duplicate ABORTs; one that keeps the key unique succeeds', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			await db.exec(`insert into x.u (id, email) values (1, 'a@x'), (2, 'b@x')`);
			// Re-key row 2 onto row 1's key ⇒ ABORT (row 2 unchanged).
			await expectThrows(() => db.exec(`update x.u set email = 'a@x' where id = 2`), /unique|constraint/i);
			expect(await rows(db, 'select email from x.u where id = 2')).to.deep.equal([{ email: 'b@x' }]);
			// Re-key to a still-unique value ⇒ ok.
			await db.exec(`update x.u set email = 'c@x' where id = 2`);
			expect(await rows(db, 'select email from x.u where id = 2')).to.deep.equal([{ email: 'c@x' }]);
		} finally {
			await db.close();
		}
	});

	it('NULL-distinct holds — multiple NULL-key rows are all accepted', async () => {
		const db = new Database();
		try {
			await deployRowTimeUniqueLens(db);
			// The basis UC skips NULL columns and the covering MV is `where email is not
			// null`, so SQL UNIQUE's NULL-distinct semantics hold through the lens.
			await db.exec('insert into x.u (id, email) values (1, null)');
			await db.exec('insert into x.u (id, email) values (2, null)');
			expect(await rows(db, 'select count(*) as n from x.u where email is null')).to.deep.equal([{ n: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('rename override — detection + replace fire in basis terms (covering MV over `mail`)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, mail text null, unique (mail)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_mail as select mail, id from y.u where mail is not null order by mail');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('declare lens for x over y { view u as select id, mail as email from y.u }');
			await db.exec('apply schema x');

			// No commit-time obligation — the row-time covering MV over `mail` answers it.
			expect(setLevelModes(slot(db, 'u')), 'rename classifies row-time').to.deep.equal(['row-time']);
			expect(collectLensSetLevelConstraints(slot(db, 'u')), 'rename row-time ⇒ []').to.deep.equal([]);

			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			// Detection fires in basis terms; the single-source re-plan maps email→mail.
			await expectThrows(() => db.exec(`insert into x.u (id, email) values (2, 'a@x')`), /unique|constraint/i);
			// Replace resolves through the lens, evicting id=1.
			await db.exec(`insert or replace into x.u (id, email) values (5, 'a@x')`);
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 5 }]);
			expect(await rows(db, `select mail from y.u where id = 5`)).to.deep.equal([{ mail: 'a@x' }]);
		} finally {
			await db.close();
		}
	});

	it('re-keyed PK over a basis `unique(code)` is PROVED (not row-time) yet still resolves detection + replace through the basis key', async () => {
		const db = new Database();
		try {
			// A logical PK is NOT NULL, so when the basis carries a matching NOT-NULL
			// `unique(code)` the body *proves* the key outright ⇒ obligation `proved`,
			// never `enforced-set-level`. A row-time PK is therefore unreachable for a
			// faithful single-source projection: a basis UNIQUE+NOT-NULL proves it, and
			// with no basis UNIQUE it falls to a `commit-time` scan (covered in the
			// commit-time suite's re-keyed-PK case). The covering MV here is incidental.
			// What this still pins: a re-keyed PK backed by a basis key resolves detection
			// AND `or replace` end-to-end through that basis key (no lens code, as for the
			// row-time class — both ride the basis structure).
			await db.exec('declare schema y { table t (id integer primary key, code text, unique (code)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_t_code as select code, id from y.t order by code');
			await db.exec('declare logical schema x { table t (code text primary key, id integer) }');
			await db.exec('apply schema x');

			// The body proves the key ⇒ no set-level obligation at all (not row-time).
			expect(setLevelModes(slot(db, 't')), 're-keyed PK over basis unique ⇒ proved, no set-level obligation').to.deep.equal([]);
			expect(
				(slot(db, 't').obligations ?? []).some(o => o.kind === 'proved' && o.constraint.kind === 'primaryKey'),
				'the PK is classified proved',
			).to.be.true;
			expect(collectLensSetLevelConstraints(slot(db, 't')), 'proved PK ⇒ []').to.deep.equal([]);

			await db.exec(`insert into x.t (code, id) values ('A', 1)`);
			await db.exec(`insert into x.t (code, id) values ('B', 2)`);
			await expectThrows(() => db.exec(`insert into x.t (code, id) values ('A', 3)`), /primary|unique|constraint/i);
			// Replace evicts the old code='A' row and lands the new one.
			await db.exec(`insert or replace into x.t (code, id) values ('A', 9)`);
			expect(await rows(db, `select id from x.t where code = 'A'`)).to.deep.equal([{ id: 9 }]);
		} finally {
			await db.close();
		}
	});

	it('composite row-time key — detection ABORTs a duplicate tuple, `or replace` resolves it (NULL-distinct holds)', async () => {
		const db = new Database();
		try {
			// A two-column unique answered by a covering MV over both columns classifies
			// row-time, so the basis UC's covering-MV path enforces the composite key with
			// no lens code (the corner the source ticket flagged as untested).
			await db.exec('declare schema y { table t (id integer primary key, a integer null, b integer null, unique (a, b)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_t_ab as select a, b, id from y.t where a is not null and b is not null order by a, b');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer null, b integer null, unique (a, b)) }');
			await db.exec('apply schema x');

			expect(setLevelModes(slot(db, 't')), 'composite key classifies row-time').to.deep.equal(['row-time']);

			await db.exec('insert into x.t (id, a, b) values (1, 1, 2)');
			// A duplicate composite tuple ABORTs.
			await expectThrows(() => db.exec('insert into x.t (id, a, b) values (2, 1, 2)'), /unique|constraint/i);
			// REPLACE on the composite conflict evicts the prior row and lands the new one.
			await db.exec('insert or replace into x.t (id, a, b) values (9, 1, 2)');
			expect(await rows(db, 'select id from x.t where a = 1 and b = 2')).to.deep.equal([{ id: 9 }]);
			// Any-NULL component ⇒ NULL-distinct, both accepted.
			await db.exec('insert into x.t (id, a, b) values (10, 1, null)');
			await db.exec('insert into x.t (id, a, b) values (11, 1, null)');
			expect(await rows(db, 'select count(*) as n from x.t where a = 1 and b is null')).to.deep.equal([{ n: 2 }]);
		} finally {
			await db.close();
		}
	});

	it('`on conflict (key) do update` upsert resolves through a row-time key — updates the existing row, no new row', async () => {
		const db = new Database();
		try {
			// An upsert with a DO UPDATE action (vs. the DO NOTHING covered above) against a
			// row-time key: the basis UC's covering-MV resolution applies the update to the
			// conflicting row rather than inserting a duplicate. The other untested corner
			// the source ticket called out.
			await db.exec('declare schema y { table u (id integer primary key, email text null, n integer null, unique (email)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, n integer null, unique (email)) }');
			await db.exec('apply schema x');

			expect(setLevelModes(slot(db, 'u')), 'upsert target classifies row-time').to.deep.equal(['row-time']);

			await db.exec(`insert into x.u (id, email, n) values (1, 'a@x', 10)`);
			// The conflicting key triggers DO UPDATE on the existing row (id stays 1, n→77);
			// no second row is inserted.
			await db.exec(`insert into x.u (id, email, n) values (2, 'a@x', 99) on conflict (email) do update set n = 77`);
			expect(await rows(db, 'select id, email, n from x.u order by id')).to.deep.equal([{ id: 1, email: 'a@x', n: 77 }]);
		} finally {
			await db.close();
		}
	});

	it('composes with a row-local check — the check ABORTs a bad row, the row-time key ABORTs a duplicate, a clean row lands', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, val integer, unique (email)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, val integer, constraint nonneg check (val >= 0), unique (email)) }');
			await db.exec('apply schema x');

			expect(setLevelModes(slot(db, 'u')), 'the unique classifies row-time').to.deep.equal(['row-time']);

			await db.exec(`insert into x.u (id, email, val) values (1, 'a@x', 5)`);
			// Row-local check ABORTs a bad row.
			await expectThrows(() => db.exec(`insert into x.u (id, email, val) values (2, 'b@x', -1)`), /nonneg|constraint/i);
			// Row-time unique ABORTs a duplicate.
			await expectThrows(() => db.exec(`insert into x.u (id, email, val) values (3, 'a@x', 5)`), /unique|constraint/i);
			// Both satisfied ⇒ lands.
			await db.exec(`insert into x.u (id, email, val) values (4, 'd@x', 7)`);
			expect(await rows(db, 'select id, email, val from x.u where id = 4')).to.deep.equal([{ id: 4, email: 'd@x', val: 7 }]);
		} finally {
			await db.close();
		}
	});

	it('composition caveat — a slot carrying both a commit-time and a row-time key still rejects `or replace` (the commit-time key cannot replace-resolve)', async () => {
		const db = new Database();
		try {
			// Basis proves `email` unique (covering MV ⇒ row-time) but NOT `code` (no
			// covering structure ⇒ commit-time). The slot then carries both classes.
			await db.exec('declare schema y { table u (id integer primary key, email text null, code text null, unique (email)) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, code text null, unique (email), unique (code)) }');
			await db.exec('apply schema x');

			// The commit-time `code` key keeps the slot's commit-time obligation set non-empty,
			// so `rejectLensSetLevelConflictResolution` fires on ANY conflict-resolution write —
			// this is the intended conservative behavior (the commit-time key genuinely cannot
			// replace-resolve), even though `email` alone is row-time-capable.
			expect(hasCommitTimeSetLevelObligation(slot(db, 'u')), 'commit-time obligation present').to.be.true;
			// Both classes genuinely co-exist on the slot (email row-time, code commit-time).
			expect(setLevelModes(slot(db, 'u')).slice().sort(), 'one row-time + one commit-time key').to.deep.equal(['commit-time', 'row-time']);
			await expectThrows(() => db.exec(`insert or replace into x.u (id, email, code) values (1, 'a@x', 'A')`), /covering|commit-time scan|conflict/i);
		} finally {
			await db.close();
		}
	});

	it('a matching basis-UC `on conflict replace` honors REPLACE on a plain duplicate insert (the verified remediation)', async () => {
		const db = new Database();
		try {
			// The remediation for the dropped-action gap (`lens-set-level-rowtime-logical-
			// conflict-action-not-honored`): declare the matching REPLACE on the *basis* UC.
			// The row-time re-plan then resolves REPLACE from the basis UC's `defaultConflict`
			// (`statement-OR ?? uc.defaultConflict ?? ABORT`), so a plain (no statement-OR)
			// duplicate insert REPLACEs through the lens. (The deploy-time prover requires
			// this matching action — a logical `on conflict replace` over a no-action basis UC
			// is rejected; see lens-prover.spec.ts's row-time conflict-action suite.)
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await db.exec('apply schema y');
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email) on conflict replace) }');
			await db.exec('apply schema x');

			expect(setLevelModes(slot(db, 'u')), 'classifies row-time').to.deep.equal(['row-time']);

			await db.exec(`insert into x.u (id, email) values (1, 'a@x')`);
			// A plain duplicate insert (no statement-level OR) REPLACEs via the basis UC's
			// declared REPLACE — evicts id=1, lands id=2.
			await db.exec(`insert into x.u (id, email) values (2, 'a@x')`);
			expect(await rows(db, `select id from x.u where email = 'a@x'`)).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, `select id from y.u where email = 'a@x'`)).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, 'select count(*) as n from x.u')).to.deep.equal([{ n: 1 }]);
		} finally {
			await db.close();
		}
	});
});
