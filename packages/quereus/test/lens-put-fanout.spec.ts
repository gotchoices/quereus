/**
 * Decomposition **put** fan-out (docs/lens.md § The Default Mapper, ticket
 * `lens-multi-source-put-fanout`).
 *
 * A logical table backed by a `primary-storage` decomposition advertisement is
 * registered as a view whose body is the synthesized `anchor ⋈ members` join;
 * `propagate()` routes its writes to the advertisement-driven fan-out
 * (`planner/mutation/decomposition.ts`) instead of the generic two-table join
 * path. This ticket ships the **substrate-independent** half of that fan-out:
 *
 * - DELETE across every member (anchor-last, anchor-only predicate).
 * - UPDATE routed to the mandatory, non-EAV member backing each column.
 *
 * INSERT, a non-anchor-predicate DELETE/UPDATE, and an optional/EAV/key UPDATE
 * are deferred onto substrate not yet present (the shared-surrogate insert
 * envelope / snapshot-consistent multi-member execution) and asserted to raise a
 * precise diagnostic here.
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
});

describe('lens decomposition put: INSERT (deferred)', () => {
	it('raises the shared-surrogate-envelope diagnostic', async () => {
		const db = new Database();
		try {
			await setup(db);
			await expectThrows(
				() => db.exec('insert into x.T (id, a, b) values (3, 30, 300)'),
				/shared-surrogate mutation-context envelope/i,
			);
		} finally {
			await db.close();
		}
	});
});
