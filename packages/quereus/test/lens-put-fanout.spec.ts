/**
 * Decomposition **put** fan-out (docs/lens.md § The Default Mapper, ticket
 * `lens-multi-source-put-fanout`).
 *
 * A logical table backed by a `primary-storage` decomposition advertisement is
 * registered as a view whose body is the synthesized `anchor ⋈ members` join;
 * `propagate()` routes its writes to the advertisement-driven fan-out
 * (`planner/mutation/decomposition.ts`) instead of the generic two-table join
 * path. Shipped fan-out:
 *
 * - DELETE across every member (anchor-last, anchor-only predicate).
 * - UPDATE routed to the mandatory, non-EAV member backing each column.
 * - INSERT one per member (anchor first) off the shared-surrogate envelope
 *   (`view-mutation-shared-surrogate-insert`): a surrogate minted once per row and
 *   threaded (`integer-auto`, per-row / per-statement), or a logical-tuple PK
 *   threaded straight through; optional members gated per-row on a supplied value;
 *   EAV pivots emit one triple per supplied attribute; singleton over the empty key.
 *
 * Still deferred onto absent substrate (asserted to raise a precise diagnostic): a
 * non-anchor-predicate DELETE/UPDATE (snapshot-consistent multi-member execution),
 * an optional/EAV/key UPDATE transition (per-row insert-or-delete branching), and
 * non-integer surrogate generators.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { Schema } from '../src/schema/schema.js';
import type { MappingAdvertisement, LogicalColumnMapping } from '../src/vtab/mapping-advertisement.js';

async function rows(db: Database, sql: string): Promise<Array<Record<string, unknown>>> {
	const out: Array<Record<string, unknown>> = [];
	for await (const r of db.eval(sql)) out.push(r as Record<string, unknown>);
	return out;
}

async function expectThrows(fn: () => Promise<unknown>, matcher: RegExp): Promise<void> {
	let threw = false;
	try {
		await fn();
	} catch (e) {
		threw = true;
		const msg = e instanceof Error ? e.message : String(e);
		expect(msg, `error message should match ${matcher}`).to.match(matcher);
	}
	expect(threw, 'expected the operation to throw').to.be.true;
}

/** A memory module that advertises whatever decomposition a test assigns. */
class AdvertisingModule extends MemoryTableModule {
	ads: MappingAdvertisement[] = [];
	override getMappingAdvertisements(_db: DatabaseType, _basis: Schema): readonly MappingAdvertisement[] {
		return this.ads;
	}
}

function colMap(logicalColumn: string, basisCol: string): LogicalColumnMapping {
	return { logicalColumn, basisExpr: { type: 'column', name: basisCol } };
}

function keyMap(...entries: Array<[string, readonly string[]]>): ReadonlyMap<string, readonly string[]> {
	return new Map<string, readonly string[]>(entries);
}

/**
 * Columnar split over main.T_core (anchor: id,a), main.T_b (mandatory: b),
 * main.T_c (optional: c), keyed by the logical PK `id`.
 */
function split(): MappingAdvertisement {
	return {
		id: 'T_core',
		logicalTable: 'T',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'T_core',
			members: [
				{ relationId: 'T_core', relation: { schema: 'main', table: 'T_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
				{ relationId: 'T_b', relation: { schema: 'main', table: 'T_b' }, presence: 'mandatory', columns: [colMap('b', 'b')] },
				{ relationId: 'T_c', relation: { schema: 'main', table: 'T_c' }, presence: 'optional', columns: [colMap('c', 'c')] },
			],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_core', ['id']], ['T_b', ['id']], ['T_c', ['id']]) },
		},
	};
}

/** Deploys the split lens + seeds two logical rows (row 2 has no optional T_c). */
async function setup(db: Database): Promise<void> {
	const mod = new AdvertisingModule();
	mod.ads = [split()];
	db.registerModule('admod', mod);
	await db.exec('create table T_core (id integer primary key, a integer) using admod');
	await db.exec('create table T_b (id integer primary key, b integer) using admod');
	await db.exec('create table T_c (id integer primary key, c integer) using admod');
	await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer } }');
	await db.exec('apply schema x');

	await db.exec('insert into main.T_core values (1, 10), (2, 20)');
	await db.exec('insert into main.T_b values (1, 100), (2, 200)');
	await db.exec('insert into main.T_c values (1, 1000)');
}

describe('lens decomposition put: read-through baseline', () => {
	it('reads the synthesized join (optional member null when absent)', async () => {
		const db = new Database();
		try {
			await setup(db);
			expect(await rows(db, 'select * from x.T order by id')).to.deep.equal([
				{ id: 1, a: 10, b: 100, c: 1000 },
				{ id: 2, a: 20, b: 200, c: null },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens decomposition put: DELETE fan-out', () => {
	it('delete by key reaches every member', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('delete from x.T where id = 1');
			expect(await rows(db, 'select id from main.T_core order by id')).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, 'select id from main.T_b order by id')).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, 'select id from main.T_c order by id')).to.deep.equal([]);
			expect(await rows(db, 'select * from x.T order by id')).to.deep.equal([{ id: 2, a: 20, b: 200, c: null }]);
		} finally {
			await db.close();
		}
	});

	it('delete by an anchor column reaches every member', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('delete from x.T where a = 20');
			expect(await rows(db, 'select id from main.T_core order by id')).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select id from main.T_b order by id')).to.deep.equal([{ id: 1 }]);
			expect(await rows(db, 'select id from main.T_c order by id')).to.deep.equal([{ id: 1 }]);
		} finally {
			await db.close();
		}
	});

	it('delete with no WHERE truncates every member', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('delete from x.T');
			expect(await rows(db, 'select id from main.T_core')).to.deep.equal([]);
			expect(await rows(db, 'select id from main.T_b')).to.deep.equal([]);
			expect(await rows(db, 'select id from main.T_c')).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('delete filtered on a non-anchor member is deferred (snapshot-consistent execution)', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('delete from x.T where b = 100'), /non-anchor decomposition member/i);
			// Atomic: nothing deleted.
			expect(await rows(db, 'select id from main.T_b order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens decomposition put: UPDATE fan-out', () => {
	it('updates the anchor-backed column', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set a = 99 where id = 2');
			expect(await rows(db, 'select id, a from main.T_core order by id')).to.deep.equal([{ id: 1, a: 10 }, { id: 2, a: 99 }]);
			expect(await rows(db, 'select a from x.T where id = 2')).to.deep.equal([{ a: 99 }]);
		} finally {
			await db.close();
		}
	});

	it('routes an update to a mandatory non-anchor member', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set b = 999 where id = 1');
			expect(await rows(db, 'select id, b from main.T_b order by id')).to.deep.equal([{ id: 1, b: 999 }, { id: 2, b: 200 }]);
		} finally {
			await db.close();
		}
	});

	it('updates several members in one statement', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set a = 11, b = 111 where id = 1');
			expect(await rows(db, 'select * from x.T where id = 1')).to.deep.equal([{ id: 1, a: 11, b: 111, c: 1000 }]);
		} finally {
			await db.close();
		}
	});

	it('allows a self-member value reference but rejects a cross-member one', async () => {
		// A SET value may read the column's own member (rewritten + alias-stripped to
		// a bare reference on the per-member UPDATE), but a reference to a *different*
		// member is a cross-source assignment a single-table SET cannot express.
		const db = new Database();
		try {
			await setup(db);
			await db.exec('update x.T set b = b + 1 where id = 1');           // self-member: T_b.b
			expect(await rows(db, 'select b from main.T_b where id = 1')).to.deep.equal([{ b: 101 }]);
			await db.exec('update x.T set a = a * 2 where id = 2');           // self-member: T_core.a
			expect(await rows(db, 'select a from main.T_core where id = 2')).to.deep.equal([{ a: 40 }]);
			await expectThrows(() => db.exec('update x.T set a = b + 1 where id = 1'), /cross-member assignment/i); // anchor <- non-anchor
			await expectThrows(() => db.exec('update x.T set b = a + 1 where id = 1'), /cross-member assignment/i); // non-anchor <- anchor
		} finally {
			await db.close();
		}
	});

	it('defers an update to an optional member', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('update x.T set c = 5 where id = 1'), /optional member/i);
		} finally {
			await db.close();
		}
	});

	it('rejects an update of the shared key', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('update x.T set id = 9 where id = 1'), /shared key/i);
		} finally {
			await db.close();
		}
	});
});

/** EAV decomposition: anchor main.E_core (id) + a triple store main.E_eav (eid, attr, val). */
function eavSplit(): MappingAdvertisement {
	return {
		id: 'E_core',
		logicalTable: 'E',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'E_core',
			members: [
				{ relationId: 'E_core', relation: { schema: 'main', table: 'E_core' }, presence: 'mandatory', columns: [colMap('id', 'id')] },
				{
					relationId: 'E_eav', relation: { schema: 'main', table: 'E_eav' }, presence: 'optional', columns: [],
					attributePivot: { entityColumn: 'eid', attributeColumn: 'attr', valueColumn: 'val' },
				},
			],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['E_core', ['id']], ['E_eav', ['eid']]) },
		},
	};
}

describe('lens decomposition put: EAV DELETE fan-out', () => {
	async function setupEav(db: Database): Promise<void> {
		const mod = new AdvertisingModule();
		mod.ads = [eavSplit()];
		db.registerModule('eavmod', mod);
		await db.exec('create table E_core (id integer primary key) using eavmod');
		await db.exec('create table E_eav (eid integer, attr text, val integer, primary key (eid, attr)) using eavmod');
		await db.exec('declare logical schema x { table E { id integer primary key, p integer, q integer } }');
		await db.exec('apply schema x');
		await db.exec('insert into main.E_core values (1), (2)');
		await db.exec("insert into main.E_eav values (1, 'p', 11), (1, 'q', 12), (2, 'p', 21)");
	}

	it('delete by key removes the anchor row and every triple for the entity', async () => {
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('delete from x.E where id = 1');
			expect(await rows(db, 'select id from main.E_core order by id')).to.deep.equal([{ id: 2 }]);
			expect(await rows(db, 'select eid, attr from main.E_eav order by eid, attr')).to.deep.equal([{ eid: 2, attr: 'p' }]);
		} finally {
			await db.close();
		}
	});

	it('defers an update of an EAV-served column with the pivot diagnostic (not a bare no-inverse)', async () => {
		// An EAV column is projected by the get body as a correlated subquery, never a
		// member `columns` entry, so the value-routing loop cannot match it. It must
		// still defer with the EAV-pivot reason (writing it is an insert/delete of a
		// triple) — distinct from a genuine non-column, which stays a plain no-inverse.
		const db = new Database();
		try {
			await setupEav(db);
			await expectThrows(() => db.exec('update x.E set p = 99 where id = 1'), /EAV pivot member/i);
			await expectThrows(() => db.exec('update x.E set notacol = 1 where id = 1'), /not backed by any decomposition member/i);
			// Atomic: the deferred writes left every triple intact.
			expect(await rows(db, 'select eid, attr, val from main.E_eav order by eid, attr')).to.deep.equal([
				{ eid: 1, attr: 'p', val: 11 }, { eid: 1, attr: 'q', val: 12 }, { eid: 2, attr: 'p', val: 21 },
			]);
		} finally {
			await db.close();
		}
	});

	it('insert materializes the anchor row plus one triple per supplied non-null attribute', async () => {
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('insert into x.E (id, p, q) values (3, 33, 34)');
			expect(await rows(db, 'select id from main.E_core order by id')).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
			expect(await rows(db, 'select eid, attr, val from main.E_eav where eid = 3 order by attr')).to.deep.equal([
				{ eid: 3, attr: 'p', val: 33 }, { eid: 3, attr: 'q', val: 34 },
			]);
			expect(await rows(db, 'select * from x.E order by id')).to.deep.equal([
				{ id: 1, p: 11, q: 12 }, { id: 2, p: 21, q: null }, { id: 3, p: 33, q: 34 },
			]);
		} finally {
			await db.close();
		}
	});

	it('insert writes no triple for a null attribute value (the read yields null)', async () => {
		const db = new Database();
		try {
			await setupEav(db);
			await db.exec('insert into x.E (id, p, q) values (4, 44, null)');
			expect(await rows(db, 'select eid, attr, val from main.E_eav where eid = 4 order by attr')).to.deep.equal([
				{ eid: 4, attr: 'p', val: 44 }, // no 'q' triple
			]);
			expect(await rows(db, 'select * from x.E order by id')).to.deep.equal([
				{ id: 1, p: 11, q: 12 }, { id: 2, p: 21, q: null }, { id: 4, p: 44, q: null },
			]);
		} finally {
			await db.close();
		}
	});
});

describe('lens decomposition put: INSERT fan-out (logical-tuple)', () => {
	it('fans an insert out to every member, threading the logical PK', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('insert into x.T (id, a, b, c) values (3, 30, 300, 3000)');
			expect(await rows(db, 'select * from main.T_core where id = 3')).to.deep.equal([{ id: 3, a: 30 }]);
			expect(await rows(db, 'select * from main.T_b where id = 3')).to.deep.equal([{ id: 3, b: 300 }]);
			expect(await rows(db, 'select * from main.T_c where id = 3')).to.deep.equal([{ id: 3, c: 3000 }]);
			expect(await rows(db, 'select * from x.T where id = 3')).to.deep.equal([{ id: 3, a: 30, b: 300, c: 3000 }]);
		} finally {
			await db.close();
		}
	});

	it('omitting the optional component materializes no optional member row', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('insert into x.T (id, a, b) values (4, 40, 400)'); // no c
			expect(await rows(db, 'select id from main.T_c order by id')).to.deep.equal([{ id: 1 }]); // only the seeded c
			expect(await rows(db, 'select * from x.T where id = 4')).to.deep.equal([{ id: 4, a: 40, b: 400, c: null }]);
		} finally {
			await db.close();
		}
	});

	it('per-row presence gate: an explicit-null optional value materializes no member row, a non-null one does', async () => {
		const db = new Database();
		try {
			await setup(db);
			await db.exec('insert into x.T (id, a, b, c) values (5, 50, 500, null), (6, 60, 600, 6000)');
			expect(await rows(db, 'select id, c from main.T_c order by id')).to.deep.equal([
				{ id: 1, c: 1000 }, { id: 6, c: 6000 }, // row 5 (null c) is absent
			]);
			expect(await rows(db, 'select * from x.T where id in (5, 6) order by id')).to.deep.equal([
				{ id: 5, a: 50, b: 500, c: null }, { id: 6, a: 60, b: 600, c: 6000 },
			]);
		} finally {
			await db.close();
		}
	});

	it('inserting an unbacked logical column raises a precise diagnostic', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('insert into x.T (id, nope) values (9, 1)'), /not backed by any decomposition member/i);
		} finally {
			await db.close();
		}
	});

	it('omitting the logical-tuple shared key is rejected (no generator)', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(() => db.exec('insert into x.T (a, b) values (70, 700)'), /shared key.*is not supplied|must be provided/i);
		} finally {
			await db.close();
		}
	});

	it('insert or replace composes across every member op', async () => {
		const db = new Database();
		try {
			await setup(db);
			// id=1 exists on all three members; replace fans out to each.
			await db.exec('insert or replace into x.T (id, a, b, c) values (1, 999, 9990, 99900)');
			expect(await rows(db, 'select * from x.T where id = 1')).to.deep.equal([{ id: 1, a: 999, b: 9990, c: 99900 }]);
		} finally {
			await db.close();
		}
	});
});

/**
 * Surrogate decomposition: anchor Doc_core(sid pk, doc_key, title) + Doc_body
 * (doc_sid pk, body), joined on a surrogate spelled `sid`/`doc_sid`, generated
 * `integer-auto`. The logical key `docKey` is an ordinary value column.
 */
function surrogateAd(cadence: 'per-row' | 'per-statement'): MappingAdvertisement {
	return {
		id: 'Doc_core',
		logicalTable: 'Doc',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'Doc_core',
			members: [
				{ relationId: 'Doc_core', relation: { schema: 'main', table: 'Doc_core' }, presence: 'mandatory', columns: [colMap('docKey', 'doc_key'), colMap('title', 'title')] },
				{ relationId: 'Doc_body', relation: { schema: 'main', table: 'Doc_body' }, presence: 'mandatory', columns: [colMap('body', 'body')] },
			],
			sharedKey: {
				kind: 'surrogate',
				keyColumnsByRelation: keyMap(['Doc_core', ['sid']], ['Doc_body', ['doc_sid']]),
				generator: { strategy: 'integer-auto', cadence },
			},
		},
	};
}

async function setupSurrogate(db: Database, cadence: 'per-row' | 'per-statement'): Promise<void> {
	const mod = new AdvertisingModule();
	mod.ads = [surrogateAd(cadence)];
	db.registerModule('docmod', mod);
	await db.exec('create table Doc_core (sid integer primary key, doc_key text, title text) using docmod');
	await db.exec('create table Doc_body (doc_sid integer primary key, body text) using docmod');
	await db.exec('declare logical schema x { table Doc { docKey text primary key, title text, body text } }');
	await db.exec('apply schema x');
	await db.exec("insert into main.Doc_core values (100, 'k1', 'First'), (101, 'k2', 'Second')");
	await db.exec("insert into main.Doc_body values (100, 'b1'), (101, 'b2')");
}

describe('lens decomposition put: INSERT fan-out (surrogate)', () => {
	it('per-row: mints one surrogate per row, threaded across members, distinct per row', async () => {
		const db = new Database();
		try {
			await setupSurrogate(db, 'per-row');
			await db.exec("insert into x.Doc (docKey, title, body) values ('k3', 'T3', 'B3'), ('k4', 'T4', 'B4')");
			// seed = max(sid) = 101 → minted 102, 103 (per-row, distinct).
			expect(await rows(db, 'select sid, doc_key from main.Doc_core order by sid')).to.deep.equal([
				{ sid: 100, doc_key: 'k1' }, { sid: 101, doc_key: 'k2' }, { sid: 102, doc_key: 'k3' }, { sid: 103, doc_key: 'k4' },
			]);
			// Each minted sid is identical on the Doc_body side (one generation, threaded).
			expect(await rows(db, 'select doc_sid, body from main.Doc_body order by doc_sid')).to.deep.equal([
				{ doc_sid: 100, body: 'b1' }, { doc_sid: 101, body: 'b2' }, { doc_sid: 102, body: 'B3' }, { doc_sid: 103, body: 'B4' },
			]);
			expect(await rows(db, 'select * from x.Doc order by docKey')).to.deep.equal([
				{ docKey: 'k1', title: 'First', body: 'b1' }, { docKey: 'k2', title: 'Second', body: 'b2' },
				{ docKey: 'k3', title: 'T3', body: 'B3' }, { docKey: 'k4', title: 'T4', body: 'B4' },
			]);
		} finally {
			await db.close();
		}
	});

	it('per-statement: a single row mints one surrogate (seed + 1), threaded across members', async () => {
		const db = new Database();
		try {
			await setupSurrogate(db, 'per-statement');
			await db.exec("insert into x.Doc (docKey, title, body) values ('k3', 'T3', 'B3')");
			expect(await rows(db, 'select sid, doc_key from main.Doc_core where sid >= 102')).to.deep.equal([{ sid: 102, doc_key: 'k3' }]);
			expect(await rows(db, 'select doc_sid, body from main.Doc_body where doc_sid >= 102')).to.deep.equal([{ doc_sid: 102, body: 'B3' }]);
			expect(await rows(db, "select * from x.Doc where docKey = 'k3'")).to.deep.equal([{ docKey: 'k3', title: 'T3', body: 'B3' }]);
		} finally {
			await db.close();
		}
	});

	it('per-statement: a multi-row insert binds one key for the whole statement → collides atomically', async () => {
		const db = new Database();
		try {
			await setupSurrogate(db, 'per-statement');
			// Both rows mint the same surrogate (seed + 1 = 102); the second member insert
			// collides on the PK, the statement aborts, and nothing persists.
			await expectThrows(() => db.exec("insert into x.Doc (docKey, title, body) values ('k3', 'T3', 'B3'), ('k4', 'T4', 'B4')"), /constraint|unique|primary/i);
			expect(await rows(db, 'select sid from main.Doc_core order by sid')).to.deep.equal([{ sid: 100 }, { sid: 101 }]);
		} finally {
			await db.close();
		}
	});
});

/**
 * Singleton (`primary key ()`): two value-carrying members joined on `1 = 1`, no
 * key to thread. Inserts are unconditional over the empty key.
 */
function singletonAd(): MappingAdvertisement {
	return {
		id: 'Cfg_a',
		logicalTable: 'Cfg',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'Cfg_a',
			members: [
				{ relationId: 'Cfg_a', relation: { schema: 'main', table: 'Cfg_a' }, presence: 'mandatory', columns: [colMap('theme', 'theme')] },
				{ relationId: 'Cfg_b', relation: { schema: 'main', table: 'Cfg_b' }, presence: 'mandatory', columns: [colMap('lang', 'lang')] },
			],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['Cfg_a', []], ['Cfg_b', []]) },
		},
	};
}

describe('lens decomposition put: INSERT fan-out (singleton)', () => {
	it('writes each member unconditionally over the empty key', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [singletonAd()];
			db.registerModule('cfgmod', mod);
			await db.exec('create table Cfg_a (theme text, primary key ()) using cfgmod');
			await db.exec('create table Cfg_b (lang text, primary key ()) using cfgmod');
			await db.exec('declare logical schema x { table Cfg { theme text, lang text, primary key () } }');
			await db.exec('apply schema x');

			await db.exec("insert into x.Cfg (theme, lang) values ('dark', 'en')");
			expect(await rows(db, 'select theme from main.Cfg_a')).to.deep.equal([{ theme: 'dark' }]);
			expect(await rows(db, 'select lang from main.Cfg_b')).to.deep.equal([{ lang: 'en' }]);
			expect(await rows(db, 'select * from x.Cfg')).to.deep.equal([{ theme: 'dark', lang: 'en' }]);
		} finally {
			await db.close();
		}
	});
});

/**
 * Review-pass regression coverage for shapes the implement pass flagged as
 * untested boundaries (treat the implementer's tests as a floor).
 */
describe('lens decomposition put: INSERT fan-out (edge cases)', () => {
	// EAV with a MIXED-CASE logical attribute column — the write must store the
	// attribute spelled as the column is declared (the read matches the literal by
	// exact value, no case-fold), so a round-trip recovers it.
	function eavMixedAd(): MappingAdvertisement {
		return {
			id: 'M_core', logicalTable: 'M', role: 'primary-storage',
			storage: {
				anchorRelationId: 'M_core',
				members: [
					{ relationId: 'M_core', relation: { schema: 'main', table: 'M_core' }, presence: 'mandatory', columns: [colMap('id', 'id')] },
					{ relationId: 'M_eav', relation: { schema: 'main', table: 'M_eav' }, presence: 'optional', columns: [],
						attributePivot: { entityColumn: 'eid', attributeColumn: 'attr', valueColumn: 'val' } },
				],
				sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['M_core', ['id']], ['M_eav', ['eid']]) },
			},
		};
	}

	it('an EAV write stores the declared (mixed) case attribute and reads it back', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [eavMixedAd()];
			db.registerModule('mmod', mod);
			await db.exec('create table M_core (id integer primary key) using mmod');
			await db.exec('create table M_eav (eid integer, attr text, val integer, primary key (eid, attr)) using mmod');
			await db.exec('declare logical schema x { table M { id integer primary key, City integer } }');
			await db.exec('apply schema x');

			await db.exec('insert into x.M (id, City) values (1, 555)');
			// The attribute literal preserves the declared case (not lowercased).
			expect(await rows(db, 'select eid, attr, val from main.M_eav')).to.deep.equal([{ eid: 1, attr: 'City', val: 555 }]);
			expect(await rows(db, 'select * from x.M order by id')).to.deep.equal([{ id: 1, City: 555 }]);
		} finally {
			await db.close();
		}
	});

	it('a mid-fan-out member failure rolls the whole statement back (atomic, anchor included)', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [split()];
			db.registerModule('atomicmod', mod);
			await db.exec('create table T_core (id integer primary key, a integer) using atomicmod');
			await db.exec('create table T_b (id integer primary key, b integer) using atomicmod');
			await db.exec('create table T_c (id integer primary key, c integer) using atomicmod');
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer } }');
			await db.exec('apply schema x');
			// Pre-seed ONLY T_b at id=7, so the anchor (T_core) insert succeeds but the
			// second member (T_b) insert collides on its PK mid-fan-out.
			await db.exec('insert into main.T_b values (7, 700)');

			await expectThrows(() => db.exec('insert into x.T (id, a, b, c) values (7, 70, 777, 7000)'), /constraint|unique|primary/i);
			// Nothing persists: the anchor row that inserted first is rolled back too.
			expect(await rows(db, 'select * from main.T_core where id = 7')).to.deep.equal([]);
			expect(await rows(db, 'select * from main.T_c where id = 7')).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});

	it('omitting a mandatory member NOT NULL column is rejected with no partial write', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [split()];
			db.registerModule('nnmod', mod);
			await db.exec('create table T_core (id integer primary key, a integer) using nnmod');
			await db.exec('create table T_b (id integer primary key, b integer not null) using nnmod');
			await db.exec('create table T_c (id integer primary key, c integer) using nnmod');
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer } }');
			await db.exec('apply schema x');
			// `b` (mandatory member T_b, NOT NULL, no default) is omitted — caught at
			// analysis time, before any base op fires.
			await expectThrows(() => db.exec('insert into x.T (id, a) values (5, 50)'), /NOT NULL with no default|no value reaches it/i);
			expect(await rows(db, 'select * from main.T_core')).to.deep.equal([]);
		} finally {
			await db.close();
		}
	});
});
