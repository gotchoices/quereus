/**
 * Module mapping advertisement protocol (docs/lens.md § The Default Mapper,
 * ticket `lens-module-mapping-advertisement`).
 *
 * Covers the protocol seam: the `MappingAdvertisement` descriptor a module
 * exposes via `getMappingAdvertisements`, the `quereus.lens.decomp.*` reserved-tag
 * vocabulary + `buildAdvertisementsFromTags` builder the generic memory module
 * returns, and the lens-compiler **resolution + validation + slot storage +
 * introspection** seam (`resolveAdvertisement`). This ticket STORES the resolved
 * advertisement; the n-way join synthesis + put fan-out that consume it land in
 * `lens-multi-source-decomposition`, so the v1 name-match / override body
 * producer is unchanged — these tests provide name-match backing (or an override)
 * for the body and assert the advertisement is resolved + stored alongside it.
 */

import { expect } from 'chai';
import { Database } from '../src/index.js';
import { MemoryTableModule } from '../src/vtab/memory/module.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import type { Schema } from '../src/schema/schema.js';
import type {
	MappingAdvertisement,
	LogicalColumnMapping,
} from '../src/vtab/mapping-advertisement.js';

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

/** A memory module that advertises whatever decompositions a test assigns. */
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

/** The canonical 3-member columnar split over main.T_core / T_b / T_c (anchor T_core). */
function columnarSplit(): MappingAdvertisement {
	return {
		id: 'T_core',
		logicalTable: 'T',
		role: 'primary-storage',
		storage: {
			anchorRelationId: 'T_core',
			members: [
				{ relationId: 'T_core', relation: { schema: 'main', table: 'T_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
				{ relationId: 'T_b', relation: { schema: 'main', table: 'T_b' }, presence: 'optional', columns: [colMap('b', 'b')] },
				{ relationId: 'T_c', relation: { schema: 'main', table: 'T_c' }, presence: 'optional', columns: [colMap('c', 'c')] },
			],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_core', ['id']], ['T_b', ['id']], ['T_c', ['id']]) },
		},
	};
}

/** An nd-tree auxiliary-access advertisement over main.T_spatial. */
function ndTree(): MappingAdvertisement {
	return {
		id: 'T_spatial',
		logicalTable: 'T',
		role: 'auxiliary-access',
		storage: {
			anchorRelationId: 'T_spatial',
			members: [{ relationId: 'T_spatial', relation: { schema: 'main', table: 'T_spatial' }, presence: 'mandatory', columns: [colMap('id', 'id')] }],
			sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_spatial', ['id']]) },
		},
		access: { served: [{ columns: ['x', 'y'], forms: ['range', 'knn'] }] },
	};
}

/** Creates a basis (in main) backing the columnar split + a name-match table T for the v1 body. */
async function setupSplitBasis(db: Database, mod: AdvertisingModule): Promise<void> {
	db.registerModule('admod', mod);
	// T provides the v1 name-match body; T_core/T_b/T_c/T_spatial are decomposition members.
	await db.exec('create table T (id integer primary key, a integer, b integer, c integer) using admod');
	await db.exec('create table T_core (id integer primary key, a integer) using admod');
	await db.exec('create table T_b (id integer primary key, b integer) using admod');
	await db.exec('create table T_c (id integer primary key, c integer) using admod');
	await db.exec('create table T_spatial (id integer primary key, x real, y real) using admod');
}

describe('lens advertisement: resolution + storage', () => {
	it('stores the primary columnar split + the nd-tree auxiliary on the slot', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [columnarSplit(), ndTree()];
			await setupSplitBasis(db, mod);

			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer } }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('T')!;
			expect(slot.advertisement, 'primary advertisement stored').to.not.be.undefined;
			expect(slot.advertisement!.id).to.equal('T_core');
			expect(slot.advertisement!.role).to.equal('primary-storage');
			expect(slot.advertisement!.storage!.members.length).to.equal(3);

			expect(slot.auxiliaryAccess, 'auxiliary advertisement stored').to.not.be.undefined;
			expect(slot.auxiliaryAccess!.length).to.equal(1);
			expect(slot.auxiliaryAccess![0].id).to.equal('T_spatial');
			expect(slot.auxiliaryAccess![0].role).to.equal('auxiliary-access');
			expect(slot.auxiliaryAccess![0].access!.served[0].forms).to.deep.equal(['range', 'knn']);
		} finally {
			await db.close();
		}
	});

	it('IND existence-anchor contract: id === storage.anchorRelationId', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [columnarSplit()];
			await setupSplitBasis(db, mod);
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer } }');
			await db.exec('apply schema x');

			const ad = db.schemaManager.getSchema('x')!.getLensSlot('T')!.advertisement!;
			expect(ad.id).to.equal(ad.storage!.anchorRelationId);
		} finally {
			await db.close();
		}
	});

	it('no advertisement ⇒ name-match path untouched (slot.advertisement undefined)', async () => {
		const db = new Database();
		try {
			await db.exec("create table t (id integer primary key, name text)");
			await db.exec("insert into t values (1, 'a')");
			await db.exec('declare logical schema x { table t { id integer primary key, name text } }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('t')!;
			expect(slot.advertisement).to.be.undefined;
			expect(slot.auxiliaryAccess).to.be.undefined;
			expect(await rows(db, 'select * from x.t')).to.deep.equal([{ id: 1, name: 'a' }]);
		} finally {
			await db.close();
		}
	});
});

describe('lens advertisement: validation errors (atomic, before catalog mutation)', () => {
	async function expectBadAdvertisement(ad: MappingAdvertisement, matcher: RegExp): Promise<void> {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [ad];
			await setupSplitBasis(db, mod);
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer } }');
			await expectThrows(() => db.exec('apply schema x'), matcher);
			// Atomic: the failed deploy left no lens slot behind.
			expect(db.schemaManager.getSchema('x')?.getLensSlot('T')).to.be.undefined;
		} finally {
			await db.close();
		}
	}

	it('anchor not among members', async () => {
		const ad = columnarSplit();
		await expectBadAdvertisement(
			{ ...ad, id: 'ghost', storage: { ...ad.storage!, anchorRelationId: 'ghost' } },
			/anchor 'ghost' is not among the members/i,
		);
	});

	it('a member relation that does not exist', async () => {
		const ad = columnarSplit();
		const members = ad.storage!.members.map(m =>
			m.relationId === 'T_c' ? { ...m, relation: { schema: 'main', table: 'ghost' } } : m);
		await expectBadAdvertisement(
			{ ...ad, storage: { ...ad.storage!, members } },
			/references basis relation 'main\.ghost', which does not exist/i,
		);
	});

	it('a basisExpr referencing a missing basis column', async () => {
		const ad = columnarSplit();
		const members = ad.storage!.members.map(m =>
			m.relationId === 'T_core' ? { ...m, columns: [colMap('id', 'id'), colMap('a', 'nonexistent')] } : m);
		await expectBadAdvertisement(
			{ ...ad, storage: { ...ad.storage!, members } },
			/column 'nonexistent', which does not exist on 'T_core'/i,
		);
	});

	it('two primary-storage advertisements for one logical table', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			const second: MappingAdvertisement = { ...columnarSplit(), id: 'T_alt' };
			mod.ads = [columnarSplit(), second];
			await setupSplitBasis(db, mod);
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer } }');
			await expectThrows(() => db.exec('apply schema x'), /2 primary-storage advertisements|at most one is allowed/i);
		} finally {
			await db.close();
		}
	});

	it('surrogate shared key with no generator', async () => {
		const ad = columnarSplit();
		await expectBadAdvertisement(
			{ ...ad, storage: { ...ad.storage!, sharedKey: { kind: 'surrogate', keyColumnsByRelation: ad.storage!.sharedKey.keyColumnsByRelation } } },
			/surrogate.*no generator/i,
		);
	});

	it('logical-tuple shared key carrying a generator', async () => {
		const ad = columnarSplit();
		await expectBadAdvertisement(
			{
				...ad,
				storage: {
					...ad.storage!,
					sharedKey: {
						kind: 'logical-tuple',
						keyColumnsByRelation: ad.storage!.sharedKey.keyColumnsByRelation,
						generator: { strategy: 'integer-auto', cadence: 'per-row' },
					},
				},
			},
			/logical-tuple.*generator/i,
		);
	});

	it('claims the table but leaves a logical column unbacked and uncovered', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			// Single-member advertisement backs id + a; logical T also declares b,
			// which is unbacked and (no basis table T) not name-matchable.
			mod.ads = [{
				id: 'T_core',
				logicalTable: 'T',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'T_core',
					members: [{ relationId: 'T_core', relation: { schema: 'main', table: 'T_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] }],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_core', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table T_core (id integer primary key, a integer) using admod');
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer } }');
			await expectThrows(() => db.exec('apply schema x'), /'b' is left unbacked/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens advertisement: override composition', () => {
	it('an override renaming an advertised value column stores the advertisement + records provenance', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'T_core',
				logicalTable: 'T',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'T_core',
					members: [{ relationId: 'T_core', relation: { schema: 'main', table: 'T_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('maxSpeed', 'speed')] }],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_core', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table T_core (id integer primary key, speed integer) using admod');
			await db.exec("insert into T_core values (1, 120)");

			await db.exec('declare logical schema x { table T { id integer primary key, maxSpeed integer } }');
			await db.exec('declare lens for x over main { view T as select id, speed as maxSpeed from main.T_core }');
			await db.exec('apply schema x');

			const slot = db.schemaManager.getSchema('x')!.getLensSlot('T')!;
			expect(slot.advertisement, 'advertisement still stored under an override').to.not.be.undefined;
			expect(slot.advertisement!.id).to.equal('T_core');

			const prov = await rows(db, "select logical_column, source, advertised_member from quereus_effective_lens('x', 'T') order by logical_column");
			expect(prov).to.deep.equal([
				{ logical_column: 'id', source: 'override', advertised_member: 'T_core' },
				{ logical_column: 'maxSpeed', source: 'override', advertised_member: 'T_core' },
			]);
			expect(await rows(db, 'select * from x.T')).to.deep.equal([{ id: 1, maxSpeed: 120 }]);
		} finally {
			await db.close();
		}
	});

	it('a sparse override whose FROM contradicts the advertised anchor errors with the conflict named', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [{
				id: 'T_core',
				logicalTable: 'T',
				role: 'primary-storage',
				storage: {
					anchorRelationId: 'T_core',
					members: [
						{ relationId: 'T_core', relation: { schema: 'main', table: 'T_core' }, presence: 'mandatory', columns: [colMap('id', 'id'), colMap('a', 'a')] },
						{ relationId: 'T_b', relation: { schema: 'main', table: 'T_b' }, presence: 'optional', columns: [colMap('b', 'b')] },
					],
					sharedKey: { kind: 'logical-tuple', keyColumnsByRelation: keyMap(['T_core', ['id']], ['T_b', ['id']]) },
				},
			}];
			db.registerModule('admod', mod);
			await db.exec('create table T_core (id integer primary key, a integer) using admod');
			await db.exec('create table T_b (id integer primary key, b integer) using admod');
			// `Other` is NOT part of the advertised decomposition; the override covers
			// only id and gap-fills a + b from Other (which has them), so the body
			// compiles — and then the re-anchor conflict fires.
			await db.exec('create table Other (id integer primary key, a integer, b integer) using admod');

			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer } }');
			await db.exec('declare lens for x over main { view T as select id from main.Other }');
			await expectThrows(() => db.exec('apply schema x'), /references basis relation 'main\.Other', which is not part of the advertised decomposition/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens advertisement: tag builder (buildAdvertisementsFromTags via memory module)', () => {
	it('assembles an advertisement from quereus.lens.decomp.* tags on basis tables', async () => {
		const db = new Database();
		try {
			// T provides the v1 name-match body; T_core/T_ext carry the decomp facts.
			await db.exec('create table T (id integer primary key, a integer, b integer)');
			await db.exec(`create table T_core (id integer primary key, a integer) with tags (
				"quereus.lens.decomp.logical.d1" = 'T',
				"quereus.lens.decomp.role.d1" = 'primary-storage',
				"quereus.lens.decomp.anchor.d1" = 'T_core',
				"quereus.lens.decomp.presence.d1" = 'mandatory',
				"quereus.lens.decomp.keykind.d1" = 'logical-tuple',
				"quereus.lens.decomp.key.d1" = 'id',
				"quereus.lens.decomp.col.d1.id" = 'id',
				"quereus.lens.decomp.col.d1.a" = 'a'
			)`);
			await db.exec(`create table T_ext (id integer primary key, b integer) with tags (
				"quereus.lens.decomp.logical.d1" = 'T',
				"quereus.lens.decomp.role.d1" = 'primary-storage',
				"quereus.lens.decomp.anchor.d1" = 'T_core',
				"quereus.lens.decomp.presence.d1" = 'optional',
				"quereus.lens.decomp.keykind.d1" = 'logical-tuple',
				"quereus.lens.decomp.key.d1" = 'id',
				"quereus.lens.decomp.col.d1.b" = 'b'
			)`);

			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer } }');
			await db.exec('apply schema x');

			const ad = db.schemaManager.getSchema('x')!.getLensSlot('T')!.advertisement!;
			expect(ad, 'tag-derived advertisement resolved').to.not.be.undefined;
			expect(ad.id).to.equal('T_core');
			expect(ad.logicalTable).to.equal('T');
			expect(ad.role).to.equal('primary-storage');
			expect(ad.storage!.anchorRelationId).to.equal('T_core');
			expect(ad.storage!.members.length).to.equal(2);
			// Anchor first in member order.
			expect(ad.storage!.members[0].relationId).to.equal('T_core');

			const tcore = ad.storage!.members.find(m => m.relationId === 'T_core')!;
			expect(tcore.presence).to.equal('mandatory');
			expect(tcore.columns.map(c => c.logicalColumn).sort()).to.deep.equal(['a', 'id']);
			const text = ad.storage!.members.find(m => m.relationId === 'T_ext')!;
			expect(text.presence).to.equal('optional');
			expect(text.columns.map(c => c.logicalColumn)).to.deep.equal(['b']);
			expect(ad.storage!.sharedKey.kind).to.equal('logical-tuple');
			expect([...ad.storage!.sharedKey.keyColumnsByRelation.get('T_core')!]).to.deep.equal(['id']);
		} finally {
			await db.close();
		}
	});

	it('a malformed decomp tag fails through the validateReservedTags path', async () => {
		const db = new Database();
		try {
			await db.exec(`create table T_core (id integer primary key, a integer) with tags (
				"quereus.lens.decomp.logical.d1" = 'T',
				"quereus.lens.decomp.role.d1" = 'bogus-role'
			)`);
			await db.exec('declare logical schema x { table T { id integer primary key, a integer } }');
			await expectThrows(() => db.exec('apply schema x'), /quereus\.lens\.decomp\.role\.d1.*expected one of: primary-storage/i);
		} finally {
			await db.close();
		}
	});
});

describe('lens advertisement: introspection', () => {
	it('quereus_effective_lens surfaces advertisement-backed provenance per column', async () => {
		const db = new Database();
		try {
			const mod = new AdvertisingModule();
			mod.ads = [columnarSplit()];
			await setupSplitBasis(db, mod);
			await db.exec('declare logical schema x { table T { id integer primary key, a integer, b integer, c integer } }');
			await db.exec('apply schema x');

			const prov = await rows(db, "select logical_column, advertised_member, advertisement_anchor from quereus_effective_lens('x', 'T') order by logical_column");
			expect(prov).to.deep.equal([
				{ logical_column: 'a', advertised_member: 'T_core', advertisement_anchor: 'T_core' },
				{ logical_column: 'b', advertised_member: 'T_b', advertisement_anchor: 'T_core' },
				{ logical_column: 'c', advertised_member: 'T_c', advertisement_anchor: 'T_core' },
				{ logical_column: 'id', advertised_member: 'T_core', advertisement_anchor: 'T_core' },
			]);
		} finally {
			await db.close();
		}
	});
});
