/**
 * Lens prover + constraint attachment (docs/lens.md §§ Constraint Attachment /
 * Coverage checklist; ticket `lens-prover-and-attachment`).
 *
 * Covers the prover that flips the lens layer from read-correct to read-correct
 * AND classified-for-write-soundness: the five blocking errors, the three
 * advisory warnings, and the per-constraint obligation classification
 * (proved / enforced-row-local / enforced-set-level{row-time|commit-time} /
 * enforced-fk / vacuous). Also covers the read-only mutation gate and that a
 * logical UNIQUE creates no implicit index (Phase D).
 *
 * Each scenario gets a fresh Database; deploys go through the full
 * `apply schema` pipeline so the prover runs exactly as in production.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { proveLens, type ConstraintObligation, type LensDeployReport } from '../src/schema/lens-prover.js';
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

/** The lens slot for `x.<table>` after a deploy. */
function slot(db: Database, table: string): LensSlot {
	const s = db.schemaManager.getSchema('x')!.getLensSlot(table);
	expect(s, `lens slot for x.${table}`).to.not.be.undefined;
	return s!;
}

function report(db: Database): LensDeployReport {
	const r = db.declaredSchemaManager.getDeployedLensReport('x');
	expect(r, 'deploy report for x').to.not.be.undefined;
	return r!;
}

function findObligation(s: LensSlot, kind: ConstraintObligation['constraint']['kind']): ConstraintObligation {
	const o = s.obligations!.find(o => o.constraint.kind === kind);
	expect(o, `obligation for a ${kind} constraint`).to.not.be.undefined;
	return o!;
}

function warningCodes(db: Database): string[] {
	return report(db).warnings.map(w => w.code);
}

describe('lens prover: obligation classification', () => {
	it('proved — a logical PK / unique the basis body intrinsically guarantees (zero runtime cost)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, name text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, name text, unique (id)) }');
			await db.exec('apply schema x');

			const s = slot(db, 't');
			expect(s.readOnly ?? false, 'writable').to.equal(false);
			expect(findObligation(s, 'primaryKey').kind, 'PK proved by basis PK').to.equal('proved');
			expect(findObligation(s, 'unique').kind, 'unique(id) proved by basis PK').to.equal('proved');
			// A proved constraint emits no no-backing-index advisory.
			expect(warningCodes(db)).to.not.include('lens.no-backing-index');
		} finally {
			await db.close();
		}
	});

	it('enforced-set-level commit-time — a logical unique with no basis covering structure (+ no-backing-index warning)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			const o = findObligation(slot(db, 'u'), 'unique');
			expect(o.kind).to.equal('enforced-set-level');
			expect(o.kind === 'enforced-set-level' && o.mode).to.equal('commit-time');

			const warnings = report(db).warnings.filter(w => w.code === 'lens.no-backing-index');
			expect(warnings.length, 'one no-backing-index advisory').to.equal(1);
			expect(warnings[0].fingerprintInputs?.constraintColumns).to.deep.equal(['email']);
			expect(warnings[0].fingerprintInputs?.hasCoveringStructure).to.equal(false);
		} finally {
			await db.close();
		}
	});

	it('enforced-set-level row-time — a logical unique answered by a basis covering MV (no advisory)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema y');
			// Explicit basis covering MV over the UNIQUE columns + source PK, ordered by
			// the UC. `email` is nullable, so the MV must skip NULLs to align with the
			// NULL-permissive UNIQUE scope (else the coverage prover won't link it).
			await db.exec('create materialized view y.ix_u_email as select email, id from y.u where email is not null order by email');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			const o = findObligation(slot(db, 'u'), 'unique');
			expect(o.kind).to.equal('enforced-set-level');
			expect(o.kind === 'enforced-set-level' && o.mode, 'row-time via covering MV').to.equal('row-time');
			expect(o.kind === 'enforced-set-level' && o.structure?.kind).to.equal('materialized-view');
			expect(warningCodes(db)).to.not.include('lens.no-backing-index');
		} finally {
			await db.close();
		}
	});

	it('enforced-row-local — a scalar check over non-computed columns', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, val integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, val integer, constraint nonneg check (val >= 0)) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 't'), 'check').kind).to.equal('enforced-row-local');
		} finally {
			await db.close();
		}
	});

	it('enforced-fk — a foreign key is classified for commit-time existence enforcement', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table parent (id integer primary key); table child (id integer primary key, pid integer null, foreign key (pid) references parent (id)) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table parent (id integer primary key); table child (id integer primary key, pid integer null, foreign key (pid) references parent (id)) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 'child'), 'foreignKey').kind).to.equal('enforced-fk');
		} finally {
			await db.close();
		}
	});

	it('vacuous — the empty (singleton) primary key', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table cfg (theme text null, primary key ()) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table cfg (theme text null, primary key ()) }');
			await db.exec('apply schema x');

			expect(findObligation(slot(db, 'cfg'), 'primaryKey').kind).to.equal('vacuous');
		} finally {
			await db.close();
		}
	});

	it('enforced-set-level commit-time — a reconstructible PK the basis does not prove (set-level, not read-only)', async () => {
		const db = new Database();
		try {
			// Basis keys on `id`; the logical table re-keys on `code`, a plain
			// (reconstructible) basis column the basis does not guarantee unique. The PK
			// is therefore neither `proved` nor read-only — it routes to a set-level
			// existence check, exercising the PK (not just unique) set-level path and the
			// no-backing-index advisory labelled for a primary key.
			await db.exec('declare schema y { table t (id integer primary key, code text) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (code text primary key, id integer) }');
			await db.exec('apply schema x');

			const s = slot(db, 't');
			expect(s.readOnly ?? false, 'reconstructible PK ⇒ writable').to.equal(false);
			const pk = findObligation(s, 'primaryKey');
			expect(pk.kind).to.equal('enforced-set-level');
			expect(pk.kind === 'enforced-set-level' && pk.mode).to.equal('commit-time');

			const warns = report(db).warnings.filter(w => w.code === 'lens.no-backing-index');
			expect(warns.length, 'one no-backing-index advisory for the PK').to.equal(1);
			expect(warns[0].site.constraint, 'advisory sited on the primary key').to.match(/primary key/);
			expect(warns[0].fingerprintInputs?.constraintColumns).to.deep.equal(['code']);
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: blocking errors', () => {
	it('type-mismatch — a logical int column over a basis text column blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id text primary key) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.type-mismatch|incompatible storage affinities/);
		} finally {
			await db.close();
		}
	});

	it('nullability-mismatch — a NOT NULL logical column over a nullable basis column blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, note text null) }');
			await db.exec('apply schema y');
			// `note text` defaults to NOT NULL (Third Manifesto); basis `note` is nullable.
			await db.exec('declare logical schema x { table t (id integer primary key, note text) }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.nullability-mismatch|declared NOT NULL/);
		} finally {
			await db.close();
		}
	});

	it('uncovered-column — a logical column with no basis backing blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key) }');
			await db.exec('apply schema y');
			// `extra` has no name-match on the basis.
			await db.exec('declare logical schema x { table t (id integer primary key, extra text null) }');
			await expectThrows(() => db.exec('apply schema x'), /no basis backing|uncovered-column/);
		} finally {
			await db.close();
		}
	});

	it('unrealizable-constraint — a check over a computed (non-invertible) column blocks the deploy', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, v integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table m (id integer primary key, doubled integer, constraint pos check (doubled >= 0)) }');
			await db.exec('declare lens for x over y { view m as select id, v * 2 as doubled from y.src }');
			await expectThrows(() => db.exec('apply schema x'), /lens\.unrealizable-constraint|no write path|computed/);
		} finally {
			await db.close();
		}
	});

	it('aggregates every blocking error into one atomic deploy failure (no catalog mutation)', async () => {
		const db = new Database();
		try {
			// Two independent type mismatches (`a`, `b` both int-over-text) must both be
			// reported in a single aggregated error — the deploy blocks atomically before
			// any catalog mutation, so the prior (absent) lens state is untouched.
			await db.exec('declare schema y { table t (a text primary key, b text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (a integer primary key, b integer null) }');
			await expectThrows(() => db.exec('apply schema x'), /blocked by 2 error\(s\)/);

			// Atomicity: a blocked deploy leaves no deploy report behind.
			expect(db.declaredSchemaManager.getDeployedLensReport('x'), 'no report after a blocked deploy').to.be.undefined;
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: read-only (key reconstructibility)', () => {
	it('a non-reconstructible PK deploys read-only and rejects mutation at the lens boundary', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table src (id integer primary key, v integer) }');
			await db.exec('apply schema y');
			await db.exec("insert into y.src values (1, 10)");
			// The logical PK `k` maps to a computed expression (v + 1) — not reconstructible.
			await db.exec('declare logical schema x { table m (k integer primary key, v integer) }');
			await db.exec('declare lens for x over y { view m as select v + 1 as k, v from y.src }');
			await db.exec('apply schema x'); // deploys — read-only is not a deploy error

			const s = slot(db, 'm');
			expect(s.readOnly, 'table is read-only').to.equal(true);
			expect(warningCodes(db)).to.include('lens.pk-not-reconstructible');

			// Reads still work through the lens.
			const out: unknown[] = [];
			for await (const r of db.eval('select k, v from x.m')) out.push(r);
			expect(out).to.deep.equal([{ k: 11, v: 10 }]);

			// Any mutation errors at the lens boundary.
			await expectThrows(() => db.exec('insert into x.m (k, v) values (5, 4)'), /read-only|not reconstructible/);
			await expectThrows(() => db.exec('update x.m set v = 0'), /read-only|not reconstructible/);
			await expectThrows(() => db.exec('delete from x.m'), /read-only|not reconstructible/);
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: advisories', () => {
	it('partial-override — lists override-authored vs default gap-filled columns', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, a integer, b integer) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, a integer, b integer) }');
			// Override covers only `id`; `a` and `b` gap-fill from the basis.
			await db.exec('declare lens for x over y { view t as select id from y.t }');
			await db.exec('apply schema x');

			const partial = report(db).warnings.filter(w => w.code === 'lens.partial-override');
			expect(partial.length, 'one partial-override advisory').to.equal(1);
			expect(partial[0].message).to.match(/\bid\b/);
			expect(partial[0].message).to.match(/\ba\b/);
			expect(partial[0].message).to.match(/\bb\b/);
		} finally {
			await db.close();
		}
	});

	it('no-answering-structure — a declared access pattern with no serving basis structure', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, name text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, name text null) with tags ("quereus.lens.access.name" = \'equality\') }');
			await db.exec('apply schema x');

			const advisory = report(db).warnings.filter(w => w.code === 'lens.no-answering-structure');
			expect(advisory.length, 'one no-answering-structure advisory for name').to.equal(1);
			expect(advisory[0].site.column).to.equal('name');
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: Phase D — logical schemas create no implicit index', () => {
	it('a logical UNIQUE builds no auto-index; it enforces via the commit-time scan path', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table t (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table t (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			// The logical table is a registered view, not a module-backed table — it
			// carries no indexes, and its UNIQUE classified to a commit-time scan.
			const s = slot(db, 't');
			expect(s.logicalTable.indexes ?? [], 'no implicit index on the logical spec').to.deep.equal([]);
			const o = findObligation(s, 'unique');
			expect(o.kind === 'enforced-set-level' && o.mode).to.equal('commit-time');
		} finally {
			await db.close();
		}
	});
});

describe('lens prover: proveLens unit (direct slot proof)', () => {
	it('classifies and reports without mutating the slot when called directly', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table u (id integer primary key, email text null) }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table u (id integer primary key, email text null, unique (email)) }');
			await db.exec('apply schema x');

			const result = proveLens(slot(db, 'u'), db);
			expect(result.errors, 'no blocking errors').to.deep.equal([]);
			expect(result.readOnly).to.equal(false);
			expect(result.obligations.some(o => o.kind === 'enforced-set-level')).to.equal(true);
			expect(result.warnings.some(w => w.code === 'lens.no-backing-index')).to.equal(true);
		} finally {
			await db.close();
		}
	});
});
