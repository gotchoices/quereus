/**
 * Lens explicit overrides + per-attribute merge (docs/lens.md, ticket
 * `lens-explicit-overrides-and-attribute-merge`).
 *
 * Covers the authoring half on top of the foundation: the
 * `declare lens for X over Y { view T as <select> [hiding (...)] }` surface, the
 * explicit-basis binding, the per-attribute sparse-override merger (covered ⊕
 * default-mapper gap-fill ⊖ hidden), the `quereus_effective_lens` introspection
 * TVF, and DDL round-trip. Read-correct only — write enforcement of attached
 * logical constraints is the prover ticket's concern.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { Parser } from '../src/parser/parser.js';
import { astToString } from '../src/emit/ast-stringify.js';
import { computeSchemaHash } from '../src/schema/schema-hasher.js';
import type * as AST from '../src/parser/ast.js';

async function rows(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

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

describe('lens overrides: rename', () => {
	it('binds maxSpeed -> CarCore.speed and surfaces the logical names', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('insert into y.CarCore values (1, 120), (2, 90)');

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore }');
			await db.exec('apply schema x');

			const body = astToString(db.schemaManager.getView('x', 'Car')!.selectAst).toLowerCase();
			expect(body).to.contain('speed as maxspeed');

			expect(await rows(db, 'select * from x.Car order by id')).to.deep.equal([
				{ id: 1, maxSpeed: 120 },
				{ id: 2, maxSpeed: 90 },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: sparse rename + gap-fill', () => {
	it('gap-fills an uncovered column from the override source', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer, color text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.CarCore values (1, 120, 'red')");

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer, color text } }');
			// Override covers id, maxSpeed; color is gap-filled from CarCore.
			await db.exec('declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore }');
			await db.exec('apply schema x');

			expect(await rows(db, 'select color from x.Car')).to.deep.equal([{ color: 'red' }]);
			expect(await rows(db, 'select * from x.Car')).to.deep.equal([{ id: 1, maxSpeed: 120, color: 'red' }]);
		} finally {
			await db.close();
		}
	});

	it('composes a later-added logical column without touching the override (rename + add)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer, color text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.CarCore values (1, 120, 'red')");

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore }');
			await db.exec('apply schema x');
			expect(await rows(db, 'select * from x.Car')).to.deep.equal([{ id: 1, maxSpeed: 120 }]);

			// Add a new logical column and re-apply; the stored override is untouched
			// and `color` appears as an uncovered attribute the mapper gap-fills.
			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer, color text } }');
			await db.exec('apply schema x');
			expect(await rows(db, 'select * from x.Car')).to.deep.equal([{ id: 1, maxSpeed: 120, color: 'red' }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: hiding', () => {
	it('hide-via-`hiding` omits the column from select * and resolution', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, name text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.CarCore values (1, 'ka')");

			await db.exec('declare logical schema x { table Car { id integer primary key, name text, maxSpeed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, name from y.CarCore hiding (maxSpeed) }');
			await db.exec('apply schema x');

			expect(db.schemaManager.getView('x', 'Car')!.columns).to.deep.equal(['id', 'name']);
			expect(await rows(db, 'select * from x.Car')).to.deep.equal([{ id: 1, name: 'ka' }]);
			await expectThrows(() => db.exec('select maxSpeed from x.Car'), /maxSpeed|column/i);
		} finally {
			await db.close();
		}
	});

	it('hide-via-gap-fill trap: an uncovered column the basis cannot back errors, naming it', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key } }');
			await db.exec('apply schema y');

			await db.exec('declare logical schema x { table Car { id integer primary key, name text } }');
			await db.exec('declare lens for x over y { view Car as select id from y.CarCore }');
			await expectThrows(() => db.exec('apply schema x'), /uncovered.*'name'|'name'.*uncovered|column 'name'/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: compute', () => {
	it('a computed column reads; writing it is rejected by view-updateability', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table U { id integer primary key, first text, last text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.U values (1, 'Ada', 'Lovelace')");

			await db.exec('declare logical schema x { table U { id integer primary key, full_name text } }');
			await db.exec("declare lens for x over y { view U as select id, first || ' ' || last as full_name from y.U }");
			await db.exec('apply schema x');

			expect(await rows(db, 'select full_name from x.U')).to.deep.equal([{ full_name: 'Ada Lovelace' }]);
			await expectThrows(() => db.exec("update x.U set full_name = 'x' where id = 1"));
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: filter', () => {
	it('a where filter restricts reads; star expands to logical columns', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table U { id integer primary key, active integer } }');
			await db.exec('apply schema y');
			await db.exec('insert into y.U values (1, 1), (2, 0), (3, 1)');

			await db.exec('declare logical schema x { table U { id integer primary key, active integer } }');
			await db.exec('declare lens for x over y { view U as select * from y.U where active = 1 }');
			await db.exec('apply schema x');

			expect(await rows(db, 'select id from x.U order by id')).to.deep.equal([{ id: 1 }, { id: 3 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: cross-basis join', () => {
	it('a fully-covered join is used verbatim (gap-fill no-op)', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Core { id integer primary key, name text } table Contact { id integer primary key, email text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.Core values (1, 'Ada')");
			await db.exec("insert into y.Contact values (1, 'ada@x.io')");

			await db.exec('declare logical schema x { table Person { id integer primary key, name text, email text } }');
			await db.exec('declare lens for x over y { view Person as select c.id, c.name, k.email from y.Core c join y.Contact k using (id) }');
			await db.exec('apply schema x');

			expect(await rows(db, 'select * from x.Person')).to.deep.equal([{ id: 1, name: 'Ada', email: 'ada@x.io' }]);
		} finally {
			await db.close();
		}
	});

	it('a partial join with an unreachable gap errors with a clear message', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Core { id integer primary key, name text } table Contact { id integer primary key, email text } }');
			await db.exec('apply schema y');

			await db.exec('declare logical schema x { table Person { id integer primary key, name text, email text, phone text } }');
			await db.exec('declare lens for x over y { view Person as select c.id, c.name, k.email from y.Core c join y.Contact k using (id) }');
			await expectThrows(() => db.exec('apply schema x'), /not reachable.*'phone'|'phone'.*not reachable|column 'phone'/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: duplicate view rejection', () => {
	it('two `view T as` for the same logical table in one block is an error', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table Car { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await expectThrows(
				() => db.exec('declare lens for x over y { view Car as select * from y.Car; view Car as select id from y.Car }'),
				/duplicate override.*Car/i,
			);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: body-shape validation', () => {
	// Defect 1: a compound set-operation override body composes only its top leg,
	// so it is rejected at parse time rather than silently mis-mapped.
	it('rejects a compound (union all) override body at parse time', async () => {
		const db = new Database();
		try {
			await expectThrows(
				() => db.exec('declare lens for x over y { view Car as select id, speed from y.CarCore union all select id, speed from y.CarOther }'),
				/single SELECT|compound|union/i,
			);
		} finally {
			await db.close();
		}
	});

	// Defect 2: a `values (...)` body is not a SELECT — the existing guard rejects it.
	it('rejects a values override body at parse time', async () => {
		const db = new Database();
		try {
			await expectThrows(
				() => db.exec('declare lens for x over y { view Car as values (1, 2) }'),
				/must be a SELECT.*values|values/i,
			);
		} finally {
			await db.close();
		}
	});

	// Defect 3: an unaliased computed projection term maps to no logical column;
	// it would be silently dropped and the logical column wrongly gap-filled.
	it('errors on an unaliased computed projection term, naming it', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed * 2 from y.CarCore }');
			await expectThrows(() => db.exec('apply schema x'), /computed projection term|no output name|add an alias/i);
		} finally {
			await db.close();
		}
	});

	// Defect 4: a `hiding (...)` name matching no logical column is a silent no-op.
	it('errors on a hiding name that matches no logical column, naming it', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, color text } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, color text } }');
			await db.exec('declare lens for x over y { view Car as select id, color from y.CarCore hiding (colour) }');
			await expectThrows(() => db.exec('apply schema x'), /hides unknown column 'colour'|unknown column.*colour/i);
		} finally {
			await db.close();
		}
	});

	// Defect 5: an override FROM source qualified with a different existing schema
	// silently re-anchors the lens off its declared `over Y` basis.
	it('errors on a FROM source outside the declared basis', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare schema z { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema z');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed from z.CarCore }');
			await expectThrows(() => db.exec('apply schema x'), /outside the declared basis|references basis relation 'z/i);
		} finally {
			await db.close();
		}
	});

	// Defect 5, join arm: the FROM walk descends both legs, so a cross-basis leg
	// inside a join is rejected too (not only a single top-level table source).
	it('errors on a cross-basis leg inside a join', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare schema z { table Extra { id integer primary key, note text } }');
			await db.exec('apply schema z');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer } }');
			await db.exec('declare lens for x over y { view Car as select c.id, c.speed from y.CarCore c join z.Extra e on e.id = c.id }');
			await expectThrows(() => db.exec('apply schema x'), /outside the declared basis|references basis relation 'z/i);
		} finally {
			await db.close();
		}
	});

	// Defect 3 guard must NOT over-reject: a computed projection term that *is*
	// aliased maps to a logical column, and an uncovered logical column is still
	// gap-filled from the basis. This pins the boundary so a future tightening of
	// the unaliased-term check cannot silently start rejecting valid bodies.
	it('accepts an aliased computed term alongside gap-fill', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer } }');
			await db.exec('apply schema y');
			await db.exec('declare logical schema x { table Car { id integer primary key, speed integer, fast integer } }');
			await db.exec('declare lens for x over y { view Car as select id, speed * 2 as fast from y.CarCore }');
			// `id`+`fast` covered by the override; `speed` gap-filled from y.CarCore.
			await db.exec('apply schema x');
			const cols = await rows(db, "select logical_column, source from quereus_effective_lens('x', 'Car') order by logical_column");
			expect(cols).to.deep.equal([
				{ logical_column: 'fast', source: 'override' },
				{ logical_column: 'id', source: 'override' },
				{ logical_column: 'speed', source: 'default' },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: quereus_effective_lens', () => {
	it('returns composed SQL + per-attribute source for a logical table', async () => {
		const db = new Database();
		try {
			await db.exec('declare schema y { table CarCore { id integer primary key, speed integer, color text } }');
			await db.exec('apply schema y');
			await db.exec("insert into y.CarCore values (1, 120, 'red')");

			await db.exec('declare logical schema x { table Car { id integer primary key, maxSpeed integer, color text, note text } }');
			await db.exec('declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore hiding (note) }');
			await db.exec('apply schema x');

			const provenance = await rows(db, "select logical_column, source from quereus_effective_lens('x', 'Car') order by logical_column");
			expect(provenance).to.deep.equal([
				{ logical_column: 'color', source: 'default' },   // gap-filled
				{ logical_column: 'id', source: 'override' },      // covered
				{ logical_column: 'maxSpeed', source: 'override' },// covered (renamed)
				{ logical_column: 'note', source: 'hidden' },      // hiding(note)
			]);

			const sqlRows = await rows(db, "select distinct effective_sql from quereus_effective_lens('x', 'Car')");
			expect(sqlRows.length).to.equal(1);
			expect(String(sqlRows[0].effective_sql).toLowerCase()).to.contain('speed as maxspeed');
		} finally {
			await db.close();
		}
	});

	it('errors on an unknown table or a non-logical schema', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key)');
			await expectThrows(() => rows(db, "select * from quereus_effective_lens('main', 't')"), /not a logical schema/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens overrides: DDL round-trip', () => {
	it('round-trips `declare lens` through stringify + reparse (equal AST + hash)', () => {
		const sql = "declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore hiding (note); view U as select * from y.U where active = 1 }";
		const ast1 = new Parser().parseAll(sql)[0] as AST.DeclareLensStmt;
		expect(ast1.type).to.equal('declareLens');
		expect(ast1.logicalSchema).to.equal('x');
		expect(ast1.basisSchema).to.equal('y');
		expect(ast1.overrides.length).to.equal(2);
		expect(ast1.overrides[0].hiding).to.deep.equal(['note']);

		const emitted = astToString(ast1);
		expect(emitted.toLowerCase()).to.match(/declare\s+lens\s+for\s+x\s+over\s+y/);
		expect(emitted.toLowerCase()).to.contain('hiding (note)');

		const ast2 = new Parser().parseAll(emitted)[0] as AST.DeclareLensStmt;
		expect(ast2.overrides.length).to.equal(2);
		expect(computeSchemaHash(ast2)).to.equal(computeSchemaHash(ast1));
	});

	it('the lens block participates in the hash (an override change changes it)', () => {
		const a = new Parser().parseAll('declare lens for x over y { view Car as select id from y.CarCore }')[0] as AST.DeclareLensStmt;
		const b = new Parser().parseAll('declare lens for x over y { view Car as select id, speed as maxSpeed from y.CarCore }')[0] as AST.DeclareLensStmt;
		expect(computeSchemaHash(a)).to.not.equal(computeSchemaHash(b));
	});
});
