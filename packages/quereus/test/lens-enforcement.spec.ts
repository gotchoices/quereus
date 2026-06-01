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
