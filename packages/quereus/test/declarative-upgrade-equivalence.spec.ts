/**
 * Fresh-vs-upgrade equivalence for declared table constraints.
 *
 * Guards the contract that
 *
 *   fresh    = freshDb(); declare(v2); apply
 *   upgraded = freshDb(); declare(v1); apply; declare(v2); apply
 *
 *   ⇒  both re-diff to nothing
 *      AND both carry the same constraint set (named by (name, body); unnamed
 *          as a (kind, body) multiset — an unnamed constraint's stored name is
 *          not identity, and is legitimately different between the two paths)
 *      AND ∀ probe: run(probe, fresh) ≡ run(probe, upgraded)
 *
 * and the reverse: dropping a constraint from the declaration converges an
 * upgraded database to the one a fresh create at the old version produces — or,
 * for a constraint stored with no name, is refused rather than silently ignored.
 *
 * The motivating defect: the differ diffed constraints only by name, so an
 * unnamed CHECK / UNIQUE / FOREIGN KEY added to (or removed from) a declaration
 * produced an empty diff, and an upgraded database never gained (or lost) it.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { StatusCode } from '../src/common/types.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { assertProbeEquivalent, type Probe } from './util/schema-equivalence.js';

interface UpgradeCase {
	name: string;
	/** Declared body (inside `declare schema main { … }`) of the starting version. */
	v1: string;
	/** Declared body of the target version — adds constraints to `v1`. */
	v2: string;
	/** Rows inserted at v1, before the upgrade (must satisfy v2's constraints). */
	seed?: string[];
	/** Run against both databases after reaching v2. */
	probes: Probe[];
	/**
	 * Whether a database created FRESH at v2 can be taken back to v1. False when v2
	 * adds a constraint CREATE TABLE stores without a name (a table-level CHECK, any
	 * UNIQUE) — no statement can drop it, so the differ refuses.
	 */
	freshRemovable: boolean;
}

const parent = `table p { id integer primary key }`;
const baseT = (extra = '', a = 'a integer null', b = 'b integer null') =>
	`table t { id integer primary key, ${a}, ${b}${extra ? `, ${extra}` : ''} }`;

const checkProbes: Probe[] = [
	{ sql: 'insert into t values (10, -1, null)', expect: { error: { status: StatusCode.CONSTRAINT, messageIncludes: 'CHECK constraint failed' } } },
	{ sql: 'insert into t values (11, 1, null)', expect: { rows: [] } },
];
const uniqueProbes: Probe[] = [
	{ sql: 'insert into t values (10, 7, null)', expect: { rows: [] } },
	{ sql: 'insert into t values (11, 7, null)', expect: { error: { messageIncludes: 'UNIQUE constraint failed' } } },
];
const fkProbes: Probe[] = [
	{ sql: 'insert into t values (10, null, 99)', expect: { error: { messageIncludes: '_fk_t_b' } } },
	{ sql: 'insert into t values (11, null, 5)', expect: { rows: [] } },
];

const cases: UpgradeCase[] = [
	{ name: 'table-level unnamed CHECK', v1: `${parent} ${baseT()}`, v2: `${parent} ${baseT('check (a > 0)')}`, probes: checkProbes, freshRemovable: false },
	{ name: 'column-level unnamed CHECK', v1: `${parent} ${baseT()}`, v2: `${parent} ${baseT('', 'a integer null check (a > 0)')}`, probes: checkProbes, freshRemovable: true },
	{ name: 'table-level unnamed UNIQUE', v1: `${parent} ${baseT()}`, v2: `${parent} ${baseT('unique (a)')}`, probes: uniqueProbes, freshRemovable: false },
	{ name: 'column-level unnamed UNIQUE', v1: `${parent} ${baseT()}`, v2: `${parent} ${baseT('', 'a integer null unique')}`, probes: uniqueProbes, freshRemovable: false },
	{ name: 'table-level unnamed FOREIGN KEY', v1: `${parent} ${baseT()}`, v2: `${parent} ${baseT('foreign key (b) references p(id)')}`, probes: fkProbes, freshRemovable: true },
	{ name: 'column-level unnamed FOREIGN KEY', v1: `${parent} ${baseT()}`, v2: `${parent} ${baseT('', undefined, 'b integer null references p(id)')}`, probes: fkProbes, freshRemovable: true },
	{ name: 'named CHECK (control)', v1: `${parent} ${baseT()}`, v2: `${parent} ${baseT('constraint pos check (a > 0)')}`, probes: checkProbes, freshRemovable: true },
	{
		name: 'a second identical unnamed CHECK is its own multiset entry',
		v1: `${parent} ${baseT('check (a > 0)')}`,
		v2: `${parent} ${baseT('check (a > 0), check (a > 0)')}`,
		probes: checkProbes,
		freshRemovable: false,
	},
	{
		name: 'unnamed CHECK carrying an operation list',
		v1: `${parent} ${baseT()}`,
		v2: `${parent} ${baseT('check on insert (a > 0)')}`,
		probes: [
			{ sql: 'insert into t values (10, -1, null)', expect: { error: { messageIncludes: 'CHECK constraint failed' } } },
			{ sql: 'update t set a = -5 where id = 1', expect: { rows: [] } },
		],
		freshRemovable: false,
	},
	{
		name: 'table-level unnamed CHECK over a column the upgrade adds',
		v1: `${parent} ${baseT()}`,
		v2: `${parent} table t { id integer primary key, a integer null, b integer null, c integer null, check (c > 0) }`,
		probes: [
			{ sql: 'insert into t values (10, null, null, -1)', expect: { error: { messageIncludes: 'CHECK constraint failed' } } },
			{ sql: 'insert into t values (11, null, null, 1)', expect: { rows: [] } },
		],
		freshRemovable: false,
	},
	{
		name: 'column-level unnamed CHECK on a column the upgrade adds',
		v1: `${parent} ${baseT()}`,
		v2: `${parent} table t { id integer primary key, a integer null, b integer null, c integer null check (c > 0) }`,
		probes: [
			{ sql: 'insert into t values (10, null, null, -1)', expect: { error: { messageIncludes: 'CHECK constraint failed' } } },
			{ sql: 'insert into t values (11, null, null, 1)', expect: { rows: [] } },
		],
		freshRemovable: true,
	},
	{
		name: 'named column-level CHECK on a column the upgrade adds',
		v1: `${parent} ${baseT()}`,
		v2: `${parent} table t { id integer primary key, a integer null, b integer null, c integer null constraint cpos check (c > 0) }`,
		probes: [
			{ sql: 'insert into t values (10, null, null, -1)', expect: { error: { messageIncludes: 'CHECK constraint failed: cpos' } } },
			{ sql: 'insert into t values (11, null, null, 1)', expect: { rows: [] } },
		],
		freshRemovable: true,
	},
	{
		name: 'every unnamed kind at once',
		v1: `${parent} ${baseT()}`,
		v2: `${parent} ${baseT('check (a > 0), unique (a), foreign key (b) references p(id)', 'a integer null check (a < 100)', 'b integer null unique')}`,
		probes: [
			{ sql: 'insert into t values (10, -1, null)', expect: { error: { messageIncludes: 'CHECK constraint failed' } } },
			{ sql: 'insert into t values (11, 100, null)', expect: { error: { messageIncludes: 'CHECK constraint failed' } } },
			{ sql: 'insert into t values (12, 7, null)', expect: { rows: [] } },
			{ sql: 'insert into t values (15, 9, 5)', expect: { error: { messageIncludes: 'UNIQUE constraint failed' } } },
			{ sql: 'insert into t values (13, 7, null)', expect: { error: { messageIncludes: 'UNIQUE constraint failed' } } },
			{ sql: 'insert into t values (14, 8, 99)', expect: { error: { messageIncludes: '_fk_t_b' } } },
		],
		freshRemovable: false,
	},
];

async function declareAndApply(db: Database, body: string): Promise<void> {
	await db.exec(`declare schema main { ${body} }`);
	await db.exec('apply schema main');
}

async function diffRows(db: Database): Promise<unknown[]> {
	const rows: unknown[] = [];
	for await (const row of db.eval('diff schema main')) rows.push(row);
	return rows;
}

async function newDb(): Promise<Database> {
	const db = new Database();
	await db.exec('pragma foreign_keys = true');
	return db;
}

/** The constraint set of `t` as the differ sees it: named by (name, body), unnamed as a (kind, body) multiset. */
function constraintSet(db: Database): { named: string[]; unnamed: string[] } {
	const t = collectSchemaCatalog(db, 'main').tables.find(x => x.name.toLowerCase() === 't')!;
	return {
		named: t.namedConstraints.map(c => `${c.name.toLowerCase()} ${c.definition}`).sort(),
		unnamed: t.unnamedConstraints.map(c => `${c.kind} ${c.definition}`).sort(),
	};
}

async function upgrade(c: UpgradeCase): Promise<Database> {
	const db = await newDb();
	await declareAndApply(db, c.v1);
	await db.exec('insert into p values (5)');
	await db.exec('insert into t (id, a, b) values (1, 5, 5)');
	for (const s of c.seed ?? []) await db.exec(s);
	await declareAndApply(db, c.v2);
	return db;
}

async function fresh(body: string): Promise<Database> {
	const db = await newDb();
	await declareAndApply(db, body);
	await db.exec('insert into p values (5)');
	await db.exec('insert into t (id, a, b) values (1, 5, 5)');
	return db;
}

describe('Declarative fresh-vs-upgrade constraint equivalence', () => {
	for (const c of cases) {
		it(`${c.name}: an upgrade to v2 matches a fresh create at v2`, async () => {
			const freshDb = await fresh(c.v2);
			const upgradedDb = await upgrade(c);
			try {
				expect(await diffRows(freshDb), 'fresh re-diff').to.deep.equal([]);
				expect(await diffRows(upgradedDb), 'upgraded re-diff').to.deep.equal([]);
				expect(constraintSet(upgradedDb)).to.deep.equal(constraintSet(freshDb));
				for (const p of c.probes) await assertProbeEquivalent(freshDb, upgradedDb, p, c.name);
			} finally {
				await freshDb.close();
				await upgradedDb.close();
			}
		});

		it(`${c.name}: a downgrade of the upgraded database matches a fresh create at v1`, async () => {
			const freshDb = await fresh(c.v1);
			const upgradedDb = await upgrade(c);
			try {
				await declareAndApply(upgradedDb, c.v1);
				expect(await diffRows(upgradedDb), 'downgraded re-diff').to.deep.equal([]);
				expect(constraintSet(upgradedDb)).to.deep.equal(constraintSet(freshDb));
			} finally {
				await freshDb.close();
				await upgradedDb.close();
			}
		});

		it(`${c.name}: a downgrade of a fresh v2 database ${c.freshRemovable ? 'converges' : 'is refused, not ignored'}`, async () => {
			const freshDb = await fresh(c.v2);
			try {
				await freshDb.exec(`declare schema main { ${c.v1} }`);
				if (c.freshRemovable) {
					await freshDb.exec('apply schema main');
					expect(await diffRows(freshDb)).to.deep.equal([]);
				} else {
					let message = '';
					try {
						await diffRows(freshDb);
					} catch (e) {
						message = (e as Error).message;
					}
					expect(message).to.include('created without a name, so no statement can drop it');
				}
			} finally {
				await freshDb.close();
			}
		});
	}
});
