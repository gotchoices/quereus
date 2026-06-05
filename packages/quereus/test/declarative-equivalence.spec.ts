/**
 * Declarative-schema semantic equivalence harness.
 *
 * Guards the implicit contract that
 *
 *   direct  = freshDb(); direct.exec(canonicalDDL(S))
 *   applied = freshDb(); applied.exec(declarative_form(S))
 *
 *   ⇒  direct.schema ≡ applied.schema
 *      AND  ∀ probe ∈ S: run(probe, direct) ≡ run(probe, applied)
 *
 * Each test case is a `{ name, directDDL, declarativeBody, probes }`
 * tuple. The driver builds two `Database`s — one populated with the
 * canonical DDL, the other built via `declare schema main { ... }
 * apply schema main` — then asserts catalog equivalence per table /
 * view / assertion and iterates the probes through
 * `assertProbeEquivalent` (which also checks the test author's
 * expectation, so a regression that lands in both paths still fails).
 *
 * Harness location: Mocha + chai .spec.ts (not sqllogic). The sqllogic
 * runner assumes one database per file; carrying two parallel DBs
 * through a single block-comparison case is alien to it. Owning the
 * dual-DB plumbing in TypeScript keeps the Case shape readable and
 * lets each row drive both halves of the equivalence in one place.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import { StatusCode } from '../src/common/types.js';
import { computeSchemaHash } from '../src/schema/schema-hasher.js';
import { computeSchemaDiff } from '../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import {
	assertTableSchemaEqual,
	assertViewSchemaEqual,
	assertMaterializedViewSchemaEqual,
	assertAssertionSchemaEqual,
	assertProbeEquivalent,
	type Probe,
} from './util/schema-equivalence.js';

interface Case {
	name: string;
	/**
	 * Direct DDL — one statement per array entry. Run sequentially via
	 * `db.exec(stmt)`. Use lowercase keywords per project convention.
	 */
	directDDL: string[];
	/**
	 * Declarative body — content placed inside `declare schema main { ... }`.
	 * The driver wraps + appends `apply schema main`.
	 */
	declarativeBody: string;
	/** Names to compare across both DBs after schema apply. */
	expectTables?: string[];
	expectViews?: string[];
	expectMaterializedViews?: string[];
	expectAssertions?: string[];
	/** Probes to run against both DBs after schema apply. */
	probes: Probe[];
	/**
	 * Post-schema setup run against BOTH DBs after the schema is applied
	 * but before probes. Use this for INSERTs into tables that exist in
	 * the direct path's DDL but need to be populated symmetrically in the
	 * declarative path (where `apply schema main` skips `seed` blocks).
	 *
	 * Note: a `preamble` field is deliberately absent — `apply schema main`
	 * drops tables not present in the declarative body, so any table
	 * needed by the case must appear in BOTH `directDDL` and
	 * `declarativeBody`. Data loads belong in `postSetup`.
	 */
	postSetup?: string[];
	/**
	 * Mark the case as expected-to-fail until a referenced fix lands.
	 * Set to a short ticket reference (slug). When set, the case is
	 * `.skip`-ped; remove on fix landing to re-enable.
	 */
	skipUntil?: string;
}

async function buildDirect(c: Case): Promise<Database> {
	const db = new Database();
	for (const stmt of c.directDDL) await db.exec(stmt);
	for (const stmt of c.postSetup ?? []) await db.exec(stmt);
	return db;
}

async function buildApplied(c: Case): Promise<Database> {
	const db = new Database();
	await db.exec(`declare schema main {\n${c.declarativeBody}\n}`);
	await db.exec('apply schema main');
	for (const stmt of c.postSetup ?? []) await db.exec(stmt);
	return db;
}

async function runCase(c: Case): Promise<void> {
	let direct!: Database;
	let applied!: Database;
	try {
		direct = await buildDirect(c);
		applied = await buildApplied(c);

		// Schema-level equivalence
		for (const tableName of c.expectTables ?? []) {
			const d = direct.schemaManager.getTable('main', tableName);
			const a = applied.schemaManager.getTable('main', tableName);
			expect(d, `direct missing table ${tableName}`).to.not.be.undefined;
			expect(a, `applied missing table ${tableName}`).to.not.be.undefined;
			assertTableSchemaEqual(d!, a!, tableName);
		}
		for (const viewName of c.expectViews ?? []) {
			const d = direct.schemaManager.getView('main', viewName);
			const a = applied.schemaManager.getView('main', viewName);
			expect(d, `direct missing view ${viewName}`).to.not.be.undefined;
			expect(a, `applied missing view ${viewName}`).to.not.be.undefined;
			assertViewSchemaEqual(d!, a!, viewName);
		}
		for (const mvName of c.expectMaterializedViews ?? []) {
			const d = direct.schemaManager.getMaterializedView('main', mvName);
			const a = applied.schemaManager.getMaterializedView('main', mvName);
			expect(d, `direct missing materialized view ${mvName}`).to.not.be.undefined;
			expect(a, `applied missing materialized view ${mvName}`).to.not.be.undefined;
			assertMaterializedViewSchemaEqual(d!, a!, mvName);
		}
		for (const aName of c.expectAssertions ?? []) {
			const dSchema = direct.schemaManager.getSchema('main');
			const aSchema = applied.schemaManager.getSchema('main');
			const d = dSchema?.getAssertion(aName);
			const a = aSchema?.getAssertion(aName);
			expect(d, `direct missing assertion ${aName}`).to.not.be.undefined;
			expect(a, `applied missing assertion ${aName}`).to.not.be.undefined;
			assertAssertionSchemaEqual(d!, a!, aName);
		}

		// Probe equivalence
		for (const probe of c.probes) {
			await assertProbeEquivalent(direct, applied, probe, probe.sql);
		}
	} finally {
		if (direct) await direct.close();
		if (applied) await applied.close();
	}
}

// ============================================================================
// Self-tests for the harness — two trivially identical, two trivially divergent.
// ============================================================================

describe('declarative-equivalence harness: self-tests', () => {
	it('passes for a trivially identical schema', async () => {
		await runCase({
			name: 'sanity-identical',
			directDDL: ['create table t (id integer primary key, name text not null)'],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				name TEXT NOT NULL
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'select count(*) as n from t', expect: { rows: [{ n: 0 }] } },
			],
		});
	});

	it('detects a NOT NULL diff between direct and declarative bodies', async () => {
		let threw = false;
		try {
			await runCase({
				name: 'sanity-divergent-notnull',
				directDDL: ['create table t (id integer primary key, name text not null)'],
				// Declarative body omits NOT NULL on `name` → catalog diverges.
				declarativeBody: `table t {
					id INTEGER PRIMARY KEY,
					name TEXT null
				}`,
				expectTables: ['t'],
				probes: [],
			});
		} catch (e) {
			threw = true;
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).to.match(/notNull|columns\[1\]/i);
		}
		expect(threw, 'expected the harness to fail on a NOT NULL divergence').to.be.true;
	});

	it('detects a probe expectation mismatch even when the two DBs agree', async () => {
		let threw = false;
		try {
			await runCase({
				name: 'sanity-divergent-expectation',
				directDDL: ['create table t (id integer primary key)'],
				declarativeBody: `table t { id INTEGER PRIMARY KEY }`,
				expectTables: ['t'],
				probes: [
					// Both DBs will return [{n: 0}], but expectation is wrong.
					{ sql: 'select count(*) as n from t', expect: { rows: [{ n: 99 }] } },
				],
			});
		} catch (e) {
			threw = true;
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).to.match(/expected/i);
		}
		expect(threw, 'expected the harness to fail on a wrong author expectation').to.be.true;
	});

	it('detects a row-vs-error outcome class divergence', async () => {
		let threw = false;
		try {
			await runCase({
				name: 'sanity-divergent-outcome',
				directDDL: ['create table t (id integer primary key)'],
				declarativeBody: `table t { id INTEGER PRIMARY KEY }`,
				expectTables: ['t'],
				probes: [
					// Probe expects rows, but the SQL is invalid → both DBs will error.
					{ sql: 'select * from nonexistent_table', expect: { rows: [] } },
				],
			});
		} catch (e) {
			threw = true;
			const msg = e instanceof Error ? e.message : String(e);
			expect(msg).to.match(/expected rows but both DBs threw/i);
		}
		expect(threw, 'expected outcome-class mismatch to fail').to.be.true;
	});
});

// ============================================================================
// CHECK constraints
// ============================================================================

describe('declarative-equivalence: CHECK constraints', () => {
	it('row-only inline CHECK matches across paths', async function () {
		await runCase({
			name: 'check-row-only',
			directDDL: [
				'create table t (id integer primary key, age integer check (age >= 0))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				age INTEGER CHECK (age >= 0)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: "insert into t values (1, 5)", expect: { rows: [] } },
				{ sql: 'select age from t where id = 1', expect: { rows: [{ age: 5 }] } },
				{
					sql: 'insert into t values (2, -1)',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});

	it('CHECK with on insert,update operations mask', async function () {
		await runCase({
			name: 'check-ops-iu',
			directDDL: [
				'create table t (id integer primary key, v integer, check on insert,update (v > 0))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				v INTEGER,
				check on insert, update (v > 0)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t values (1, 10)', expect: { rows: [] } },
				{
					sql: 'insert into t values (2, 0)',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
				// UPDATE path is also constrained
				{
					sql: 'update t set v = -5 where id = 1',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});

	it('CHECK with on delete mask preserves DELETE-firing behaviour (issue #23 surface)', async function () {
		await runCase({
			name: 'check-ops-delete',
			directDDL: [
				'create table t (id integer primary key, v integer)',
				// CHECK that always evaluates true on DELETE — purpose is to exercise the
				// mask round-trip: if the `on delete` is dropped during declarative apply,
				// the catalog will show a different `operations` mask.
				'alter table t add constraint c1 check on delete (v <> -999)',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				v INTEGER,
				constraint c1 check on delete (v <> -999)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t values (1, 1)', expect: { rows: [] } },
				{ sql: 'delete from t where id = 1', expect: { rows: [] } },
				{ sql: 'select count(*) as n from t', expect: { rows: [{ n: 0 }] } },
			],
		});
	});

	it('CHECK with on update-only mask leaves INSERT path unconstrained', async function () {
		await runCase({
			name: 'check-ops-update-only',
			directDDL: [
				'create table t (id integer primary key, v integer, check on update (v >= 0))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				v INTEGER,
				check on update (v >= 0)
			}`,
			expectTables: ['t'],
			probes: [
				// INSERT with violating value MUST succeed (UPDATE-only mask).
				{ sql: 'insert into t values (1, -5)', expect: { rows: [] } },
				// UPDATE that keeps it negative violates.
				{
					sql: 'update t set v = -10 where id = 1',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
				// UPDATE that fixes it succeeds.
				{ sql: 'update t set v = 7 where id = 1', expect: { rows: [] } },
			],
		});
	});

	it('CHECK with on insert-only mask leaves UPDATE path unconstrained', async function () {
		await runCase({
			name: 'check-ops-insert-only',
			directDDL: [
				'create table t (id integer primary key, v integer, check on insert (v >= 0))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				v INTEGER,
				check on insert (v >= 0)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t values (1, 1)', expect: { rows: [] } },
				{
					sql: 'insert into t values (2, -1)',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
				// UPDATE may make it negative (mask excludes UPDATE).
				{ sql: 'update t set v = -1 where id = 1', expect: { rows: [] } },
			],
		});
	});

	it('table-level named CHECK with subquery (issue #22 surface)', async function () {
		await runCase({
			name: 'check-not-in-subquery',
			directDDL: [
				'create table forbidden (id integer primary key, code integer not null)',
				'create table t (id integer primary key, code integer not null, constraint c_code check (code not in (select code from forbidden)))',
			],
			declarativeBody: `table forbidden {
				id INTEGER PRIMARY KEY,
				code INTEGER NOT NULL
			}

			table t {
				id INTEGER PRIMARY KEY,
				code INTEGER NOT NULL,
				constraint c_code check (code not in (select code from forbidden))
			}`,
			expectTables: ['t', 'forbidden'],
			postSetup: [
				'insert into forbidden values (1, 99)',
			],
			probes: [
				{ sql: 'insert into t values (1, 1)', expect: { rows: [] } },
				{
					sql: 'insert into t values (2, 99)',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});
});

// ============================================================================
// Defaults
// ============================================================================

describe('declarative-equivalence: defaults', () => {
	it('literal default round-trips', async function () {
		await runCase({
			name: 'default-literal',
			directDDL: [
				"create table t (id integer primary key, status text default 'pending' not null)",
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				status TEXT NOT NULL DEFAULT 'pending'
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t (id) values (1)', expect: { rows: [] } },
				{ sql: 'select status from t where id = 1', expect: { rows: [{ status: 'pending' }] } },
			],
		});
	});

	it('expression default round-trips', async function () {
		await runCase({
			name: 'default-expression',
			directDDL: [
				'create table t (id integer primary key, total integer not null default (1 + 2))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				total INTEGER NOT NULL DEFAULT (1 + 2)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t (id) values (1)', expect: { rows: [] } },
				{ sql: 'select total from t where id = 1', expect: { rows: [{ total: 3 }] } },
			],
		});
	});

	it('new.<column> default survives the declarative round-trip', async function () {
		// The deferred `new.` default must re-emit and re-apply identically — a
		// dropped qualifier would silently corrupt the schema under apply.
		await runCase({
			name: 'default-new-ref',
			directDDL: [
				'create table t (id integer primary key, base integer, doubled integer default (new.base * 2))',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				base INTEGER,
				doubled INTEGER DEFAULT (new.base * 2)
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t (id, base) values (1, 21)', expect: { rows: [] } },
				{ sql: 'select doubled from t where id = 1', expect: { rows: [{ doubled: 42 }] } },
			],
		});
	});
});

// ============================================================================
// Generated columns
// ============================================================================

describe('declarative-equivalence: generated columns', () => {
	it('virtual generated column', async function () {
		await runCase({
			name: 'gen-virtual',
			directDDL: [
				'create table t (id integer primary key, x integer not null, y integer not null, sum integer generated always as (x + y) virtual)',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				x INTEGER NOT NULL,
				y INTEGER NOT NULL,
				sum INTEGER GENERATED ALWAYS AS (x + y) VIRTUAL
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t (id, x, y) values (1, 3, 4)', expect: { rows: [] } },
				{ sql: 'select sum from t where id = 1', expect: { rows: [{ sum: 7 }] } },
			],
		});
	});

	it('stored generated column', async function () {
		await runCase({
			name: 'gen-stored',
			directDDL: [
				'create table t (id integer primary key, x integer not null, y integer not null, p integer generated always as (x * y) stored)',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				x INTEGER NOT NULL,
				y INTEGER NOT NULL,
				p INTEGER GENERATED ALWAYS AS (x * y) STORED
			}`,
			expectTables: ['t'],
			probes: [
				{ sql: 'insert into t (id, x, y) values (1, 6, 7)', expect: { rows: [] } },
				{ sql: 'select p from t where id = 1', expect: { rows: [{ p: 42 }] } },
			],
		});
	});
});

// ============================================================================
// Foreign keys
// ============================================================================

describe('declarative-equivalence: foreign keys', () => {
	it('FK on delete cascade fires through both paths', async function () {
		await runCase({
			name: 'fk-on-delete-cascade',
			directDDL: [
				'create table parent (id integer primary key, label text)',
				'create table child (id integer primary key, parent_id integer not null, constraint fk_parent foreign key (parent_id) references parent(id) on delete cascade)',
			],
			declarativeBody: `table parent {
				id INTEGER PRIMARY KEY,
				label TEXT
			}

			table child {
				id INTEGER PRIMARY KEY,
				parent_id INTEGER NOT NULL,
				constraint fk_parent foreign key (parent_id) references parent(id) on delete cascade
			}`,
			expectTables: ['parent', 'child'],
			postSetup: [
				"insert into parent values (1, 'a'), (2, 'b')",
				'insert into child values (10, 1), (11, 1), (12, 2)',
			],
			probes: [
				{ sql: 'delete from parent where id = 1', expect: { rows: [] } },
				{ sql: 'select count(*) as n from child', expect: { rows: [{ n: 1 }] } },
				{ sql: 'select id from child order by id', expect: { rows: [{ id: 12 }] } },
			],
		});
	});

	it('FK restrict blocks delete', async function () {
		await runCase({
			name: 'fk-on-delete-restrict',
			directDDL: [
				'create table parent2 (id integer primary key)',
				'create table child2 (id integer primary key, parent_id integer not null, constraint fk_parent2 foreign key (parent_id) references parent2(id) on delete restrict)',
			],
			declarativeBody: `table parent2 {
				id INTEGER PRIMARY KEY
			}

			table child2 {
				id INTEGER PRIMARY KEY,
				parent_id INTEGER NOT NULL,
				constraint fk_parent2 foreign key (parent_id) references parent2(id) on delete restrict
			}`,
			expectTables: ['parent2', 'child2'],
			postSetup: [
				'insert into parent2 values (1)',
				'insert into child2 values (10, 1)',
			],
			probes: [
				{
					sql: 'delete from parent2 where id = 1',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});
});

// ============================================================================
// Indexes
// ============================================================================

describe('declarative-equivalence: indexes', () => {
	it('plain index round-trips', async function () {
		await runCase({
			name: 'index-plain',
			directDDL: [
				'create table t (id integer primary key, name text)',
				'create index t_name_idx on t (name)',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				name TEXT
			}

			index t_name_idx on t (name)`,
			expectTables: ['t'],
			probes: [
				{ sql: "insert into t values (1, 'alice'), (2, 'bob')", expect: { rows: [] } },
				{ sql: "select id from t where name = 'alice'", expect: { rows: [{ id: 1 }] } },
			],
		});
	});

	it('unique index round-trips and enforces uniqueness', async function () {
		await runCase({
			name: 'index-unique',
			directDDL: [
				'create table t (id integer primary key, email text)',
				'create unique index t_email_uniq on t (email)',
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY,
				email TEXT
			}

			unique index t_email_uniq on t (email)`,
			expectTables: ['t'],
			probes: [
				{ sql: "insert into t values (1, 'a@x'), (2, 'b@x')", expect: { rows: [] } },
				{
					sql: "insert into t values (3, 'a@x')",
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});
});

// ============================================================================
// Views — body shapes that round-trip through compound selects (issue #21)
// ============================================================================

describe('declarative-equivalence: views', () => {
	it('view body with union all preserves all legs (issue #21 surface)', async function () {
		await runCase({
			name: 'view-union-all',
			directDDL: [
				'create table base_a (id integer primary key, v integer)',
				'create table base_b (id integer primary key, v integer)',
				'create table base_c (id integer primary key, v integer)',
				'create view v_all as select v from base_a union all select v from base_b union all select v from base_c',
			],
			declarativeBody: `table base_a { id INTEGER PRIMARY KEY, v INTEGER }
			table base_b { id INTEGER PRIMARY KEY, v INTEGER }
			table base_c { id INTEGER PRIMARY KEY, v INTEGER }

			view v_all as
				select v from base_a
				union all
				select v from base_b
				union all
				select v from base_c`,
			expectTables: ['base_a', 'base_b', 'base_c'],
			expectViews: ['v_all'],
			postSetup: [
				'insert into base_a values (1, 10), (2, 20)',
				'insert into base_b values (3, 30), (4, 40)',
				'insert into base_c values (5, 50), (6, 60)',
			],
			probes: [
				{ sql: 'select count(*) as n from v_all', expect: { rows: [{ n: 6 }] } },
				{
					sql: 'select v from v_all order by v',
					expect: { rows: [{ v: 10 }, { v: 20 }, { v: 30 }, { v: 40 }, { v: 50 }, { v: 60 }] },
				},
			],
		});
	});

	it('view body with explicit column list', async function () {
		await runCase({
			name: 'view-explicit-cols',
			directDDL: [
				'create table src (id integer primary key, name text not null)',
				'create view v_renamed (vid, vname) as select id, name from src',
			],
			declarativeBody: `table src { id INTEGER PRIMARY KEY, name TEXT NOT NULL }

			view v_renamed (vid, vname) as
				select id, name from src`,
			expectTables: ['src'],
			expectViews: ['v_renamed'],
			postSetup: [
				"insert into src values (1, 'alpha'), (2, 'beta')",
			],
			probes: [
				{
					sql: 'select vid, vname from v_renamed order by vid',
					expect: { rows: [{ vid: 1, vname: 'alpha' }, { vid: 2, vname: 'beta' }] },
				},
			],
		});
	});
});

// ============================================================================
// Cross-shape probe — view inside CHECK
// ============================================================================

describe('declarative-equivalence: cross-shape (view + CHECK)', () => {
	it('CHECK against a compound-select view body matches both paths', async function () {
		await runCase({
			name: 'check-against-compound-view',
			directDDL: [
				'create table allow_a (code integer primary key)',
				'create table allow_b (code integer primary key)',
				'create view all_allowed as select code from allow_a union all select code from allow_b',
				'create table t (id integer primary key, code integer check (code in (select code from all_allowed)))',
			],
			declarativeBody: `table allow_a { code INTEGER PRIMARY KEY }
			table allow_b { code INTEGER PRIMARY KEY }

			view all_allowed as
				select code from allow_a
				union all
				select code from allow_b

			table t {
				id INTEGER PRIMARY KEY,
				code INTEGER CHECK (code in (select code from all_allowed))
			}`,
			expectTables: ['t', 'allow_a', 'allow_b'],
			expectViews: ['all_allowed'],
			postSetup: [
				'insert into allow_a values (1), (2)',
				'insert into allow_b values (3), (4)',
			],
			probes: [
				{ sql: 'insert into t values (1, 1)', expect: { rows: [] } },
				{ sql: 'insert into t values (2, 4)', expect: { rows: [] } },
				{
					sql: 'insert into t values (3, 99)',
					expect: { error: { status: StatusCode.CONSTRAINT } },
				},
			],
		});
	});
});

// ============================================================================
// Assertions
// ============================================================================

describe('declarative-equivalence: assertions', () => {
	it('assertion fires on violating INSERT through both paths', async function () {
		await runCase({
			name: 'assertion-positive-balance',
			directDDL: [
				'create table accounts (id integer primary key, balance integer not null)',
				'create assertion positive_balance check (not exists (select 1 from accounts where balance < 0))',
			],
			declarativeBody: `table accounts {
				id INTEGER PRIMARY KEY,
				balance INTEGER NOT NULL
			}

			assertion positive_balance check (not exists (select 1 from accounts where balance < 0))`,
			expectTables: ['accounts'],
			expectAssertions: ['positive_balance'],
			probes: [
				{ sql: 'insert into accounts values (1, 100)', expect: { rows: [] } },
				{
					sql: 'insert into accounts values (2, -10)',
					expect: { error: {} },
				},
			],
		});
	});
});

// ============================================================================
// Decorations — tags at table / column / constraint level
// ============================================================================

describe('declarative-equivalence: decorations (tags)', () => {
	it('table-level tags round-trip', async function () {
		await runCase({
			name: 'tags-table-level',
			directDDL: [
				`create table t (id integer primary key) with tags (owner = 'team-a', layer = 'core')`,
			],
			declarativeBody: `table t {
				id INTEGER PRIMARY KEY
			} with tags (owner = 'team-a', layer = 'core')`,
			expectTables: ['t'],
			probes: [
				{ sql: 'select count(*) as n from t', expect: { rows: [{ n: 0 }] } },
			],
		});
	});
});

// ============================================================================
// Materialized views — declarative round-trip, body-change rebuild, hash
// ============================================================================

describe('declarative-equivalence: materialized views', () => {
	it('MV body round-trips through declarative apply (create + refresh)', async function () {
		await runCase({
			name: 'mv-roundtrip-basic',
			directDDL: [
				'create table t (id integer primary key, x integer not null)',
				'create materialized view mv as select id, x from t',
			],
			declarativeBody: `table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }

			materialized view mv as select id, x from t`,
			expectTables: ['t'],
			expectMaterializedViews: ['mv'],
			// MV is materialized empty at create time (t is empty); both paths
			// then INSERT + REFRESH symmetrically so the backing tables agree.
			postSetup: [
				'insert into t values (1, 10), (2, 20)',
				'refresh materialized view mv',
			],
			probes: [
				{ sql: 'select count(*) as n from mv', expect: { rows: [{ n: 2 }] } },
				{
					sql: 'select id, x from mv order by id',
					expect: { rows: [{ id: 1, x: 10 }, { id: 2, x: 20 }] },
				},
			],
		});
	});

	it('explicit column-list MV round-trips and renames the body columns', async function () {
		await runCase({
			name: 'mv-roundtrip-collist',
			directDDL: [
				'create table t (id integer primary key, x integer not null)',
				'create materialized view mv (a, b) as select id, x from t',
			],
			declarativeBody: `table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }

			materialized view mv (a, b) as select id, x from t`,
			expectTables: ['t'],
			expectMaterializedViews: ['mv'],
			postSetup: [
				'insert into t values (1, 10), (2, 20)',
				'refresh materialized view mv',
			],
			probes: [
				{
					sql: 'select a, b from mv order by a',
					expect: { rows: [{ a: 1, b: 10 }, { a: 2, b: 20 }] },
				},
			],
		});
	});

	it('tagged MV round-trips and the schema hash is tag-invariant', async function () {
		await runCase({
			name: 'mv-roundtrip-tagged',
			directDDL: [
				'create table t (id integer primary key, x integer not null)',
				`create materialized view mv as select id, x from t with tags (owner = 'analytics')`,
			],
			declarativeBody: `table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }

			materialized view mv as select id, x from t with tags (owner = 'analytics')`,
			expectTables: ['t'],
			// assertMaterializedViewSchemaEqual compares tags, so a dropped/garbled
			// tag would fail the round-trip here.
			expectMaterializedViews: ['mv'],
			probes: [
				{ sql: 'select count(*) as n from mv', expect: { rows: [{ n: 0 }] } },
			],
		});

		// Tags are non-behavioral metadata: a tagged MV and an otherwise-identical
		// untagged MV must hash the same, and re-applying the tagged schema is a no-op.
		const tagged = new Database();
		const untagged = new Database();
		try {
			await tagged.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t with tags (owner = 'analytics')
			}`);
			await tagged.exec('apply schema main');
			await untagged.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			const hTagged = computeSchemaHash(tagged.declaredSchemaManager.getDeclaredSchema('main')!);
			const hUntagged = computeSchemaHash(untagged.declaredSchemaManager.getDeclaredSchema('main')!);
			expect(hTagged, 'tags must not perturb the schema hash').to.equal(hUntagged);

			const diff = computeSchemaDiff(
				tagged.declaredSchemaManager.getDeclaredSchema('main')!,
				collectSchemaCatalog(tagged, 'main'),
			);
			expect(diff.materializedViewsToCreate, 'tagged unchanged MV should not recreate').to.deep.equal([]);
			expect(diff.materializedViewsToDrop, 'tagged unchanged MV should not drop').to.deep.equal([]);
		} finally {
			await tagged.close();
			await untagged.close();
		}
	});

	it('changing the MV body triggers a drop+recreate rebuild on re-apply', async function () {
		const db = new Database();
		try {
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`);
			await db.exec('apply schema main');
			await db.exec('insert into t values (1, 10, 100)');
			await db.exec('refresh materialized view mv');

			// Body A exposes column x.
			const beforeRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, x from mv')) beforeRows.push(r);
			expect(beforeRows).to.deep.equal([{ id: 1, x: 10 }]);
			const beforeHash = db.schemaManager.getMaterializedView('main', 'mv')!.bodyHash;

			// Re-declare with a changed body (select y instead of x) and re-apply.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL, y INTEGER NOT NULL }
				materialized view mv as select id, y from t
			}`);
			await db.exec('apply schema main');

			// Rebuild happened: the new body re-materialized from current t.
			const afterRows: Array<Record<string, unknown>> = [];
			for await (const r of db.eval('select id, y from mv')) afterRows.push(r);
			expect(afterRows).to.deep.equal([{ id: 1, y: 100 }]);

			const afterHash = db.schemaManager.getMaterializedView('main', 'mv')!.bodyHash;
			expect(afterHash, 'bodyHash should change when the body changes').to.not.equal(beforeHash);

			// The old column is gone after the rebuild.
			let threw = false;
			try {
				for await (const _ of db.eval('select x from mv')) { /* drain */ }
			} catch {
				threw = true;
			}
			expect(threw, 'expected `select x from mv` to fail after the rebuild').to.be.true;
		} finally {
			await db.close();
		}
	});

	it('re-applying an unchanged MV is a no-op and the schema hash is stable', async function () {
		const db = new Database();
		try {
			const declSql = `declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x from t
			}`;
			await db.exec(declSql);
			await db.exec('apply schema main');

			const declared = db.declaredSchemaManager.getDeclaredSchema('main')!;
			const hash1 = computeSchemaHash(declared);

			// Diff the declared schema against the freshly-applied catalog: an
			// unchanged MV body yields no create and no drop.
			const catalog = collectSchemaCatalog(db, 'main');
			const diff = computeSchemaDiff(declared, catalog);
			expect(diff.materializedViewsToCreate, 'unchanged MV should not be recreated').to.deep.equal([]);
			expect(diff.materializedViewsToDrop, 'unchanged MV should not be dropped').to.deep.equal([]);

			// Re-declaring the identical schema yields an identical hash.
			await db.exec(declSql);
			const hash2 = computeSchemaHash(db.declaredSchemaManager.getDeclaredSchema('main')!);
			expect(hash2, 'schema hash should be stable across re-emit of an unchanged MV').to.equal(hash1);

			// A changed MV body changes the hash.
			await db.exec(`declare schema main {
				table t { id INTEGER PRIMARY KEY, x INTEGER NOT NULL }
				materialized view mv as select id, x + 1 from t
			}`);
			const hash3 = computeSchemaHash(db.declaredSchemaManager.getDeclaredSchema('main')!);
			expect(hash3, 'changing the MV body should change the schema hash').to.not.equal(hash1);
		} finally {
			await db.close();
		}
	});
});
