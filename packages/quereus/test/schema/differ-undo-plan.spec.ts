/**
 * The migration plan's undo half (`MigrationStep.undo` / `irreversible`), produced
 * by `generateMigrationPlan` when handed the pre-apply catalog.
 *
 * Covers, arm by arm, the exact undo text; the two rules that make an undo correct
 * (spell the target as the forward step did; forward-apply the renames in force to
 * catalog-sourced bodies); absent targets; schema qualification; tag clearing;
 * hand-built partial diffs and catalogs; and the guard that `generateMigrationDDL`
 * (which never passes a catalog) is byte-identical to what it produced before undo
 * existed.
 */

import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { Parser } from '../../src/parser/parser.js';
import { computeSchemaDiff, generateMigrationDDL, generateMigrationPlan } from '../../src/schema/schema-differ.js';
import type { SchemaDiff, MigrationStep, MigrationCreate } from '../../src/schema/schema-differ.js';
import { collectSchemaCatalog } from '../../src/schema/catalog.js';
import { renderCatalogForComparison } from '../../src/schema/catalog-rendering.js';
import type { SchemaCatalog, CatalogTable, CatalogView } from '../../src/schema/catalog.js';
import type * as AST from '../../src/parser/ast.js';
import { viewDefinitionToCanonicalString } from '../../src/emit/ast-stringify.js';

function parseDeclaredSchema(sql: string): AST.DeclareSchemaStmt {
	const stmt = new Parser().parse(sql);
	if (stmt.type !== 'declareSchema') throw new Error(`Expected declareSchema, got ${stmt.type}`);
	return stmt;
}

/** A fresh in-memory database with `ddl` applied, whose live catalog is the pre-apply state. */
async function databaseWith(ddl: string[]): Promise<Database> {
	const db = new Database();
	for (const stmt of ddl) await db.exec(stmt);
	return db;
}

/** The plan — with undo — that takes `db`'s live catalog to `declaredBody` (the items of `declare schema main { … }`). */
function planFor(db: Database, declaredBody: string, schemaName = 'main'): MigrationStep[] {
	const actual = collectSchemaCatalog(db, schemaName);
	const diff = computeSchemaDiff(parseDeclaredSchema(`declare schema ${schemaName} { ${declaredBody} }`), actual);
	return generateMigrationPlan(diff, schemaName, actual);
}

/** The one step whose `sql` starts with `prefix`; fails loudly when there is not exactly one. */
function stepStarting(plan: MigrationStep[], prefix: string): MigrationStep {
	const matches = plan.filter(s => s.sql.startsWith(prefix));
	expect(matches.map(s => s.sql), `exactly one step starting with "${prefix}" in ${JSON.stringify(plan.map(s => s.sql))}`).to.have.length(1);
	return matches[0];
}

function expectUndo(plan: MigrationStep[], prefix: string, undo: string[]): void {
	const step = stepStarting(plan, prefix);
	expect(step.irreversible, `${step.sql} must be reversible`).to.be.undefined;
	expect(step.undo, `undo of ${step.sql}`).to.deep.equal(undo);
}

function expectIrreversible(plan: MigrationStep[], prefix: string, reason: RegExp): void {
	const step = stepStarting(plan, prefix);
	expect(step.undo, `${step.sql} must carry no undo`).to.be.undefined;
	expect(step.irreversible, `reason on ${step.sql}`).to.match(reason);
}

/**
 * The catalog rendering with every view's `ddl` blanked. `ViewSchema.sql` holds the
 * original `create view` text until a rename propagation overwrites it with the
 * rewritten body alone, so after a table-rename round trip that one field differs
 * while the view itself is identical (recorded on ticket
 * apply-schema-rollback-journal, whose restore check compares this rendering).
 */
function fingerprint(db: Database): string {
	const catalog = collectSchemaCatalog(db, 'main');
	return renderCatalogForComparison({ ...catalog, views: catalog.views.map(v => ({ ...v, ddl: '' })) });
}

/** Runs the plan forward, then every undo in reverse, and requires the catalog to be back where it started. */
async function expectRoundTrip(ddl: string[], declaredBody: string): Promise<void> {
	const db = await databaseWith(ddl);
	const before = fingerprint(db);
	const plan = planFor(db, declaredBody);
	expect(plan.length, 'the scenario must produce a plan').to.be.greaterThan(0);
	for (const step of plan) {
		expect(step.irreversible, `a round trip needs every step reversible: ${step.sql}`).to.be.undefined;
		await db.exec(step.sql);
	}
	expect(fingerprint(db), 'the forward plan must change the catalog').to.not.equal(before);
	for (const step of [...plan].reverse()) {
		for (const sql of step.undo ?? []) await db.exec(sql);
	}
	expect(fingerprint(db), `after undoing ${JSON.stringify(plan.map(s => s.undo))}`).to.equal(before);
}

function makeEmptySchemaDiff(): SchemaDiff {
	return {
		tablesToCreate: [], tablesToDrop: [], tablesToAlter: [], maintainedModuleMigrations: [],
		viewsToCreate: [], viewsToDrop: [], indexesToCreate: [], indexesToDrop: [],
		assertionsToCreate: [], assertionsToDrop: [], viewTagsChanges: [], indexTagsChanges: [],
		renames: [], lensToAttach: [], lensToDetach: [],
	};
}

function emptyCatalog(schemaName = 'main'): SchemaCatalog {
	return { schemaName, tables: [], views: [], indexes: [], assertions: [] };
}

function migrationCreate(sql: string): MigrationCreate {
	return { sql, ast: new Parser().parse(sql) };
}

describe('generateMigrationPlan undo', () => {
	describe('when no pre-apply catalog is passed', () => {
		it('carries neither undo nor irreversible on any step, and diff schema text is unchanged from before undo existed', () => {
			// Pinned from `generateMigrationDDL` BEFORE the undo fields were added: the
			// preview text and the text an execution error names must not move.
			const plan = generateMigrationPlan(broadDiff(), 'main');
			for (const step of plan) {
				expect(step.undo, step.sql).to.be.undefined;
				expect(step.irreversible, step.sql).to.be.undefined;
			}
			expect(generateMigrationDDL(broadDiff(), 'main')).to.deep.equal(BROAD_DDL_MAIN);
			expect(generateMigrationDDL(broadDiff(), 'analytics')).to.deep.equal(BROAD_DDL_ANALYTICS);
		});

		it('the same diff with a catalog renders the same sql, in the same order, with an undo half on every step', () => {
			const withUndo = generateMigrationPlan(broadDiff(), 'main', emptyCatalog());
			expect(withUndo.map(s => s.sql)).to.deep.equal(BROAD_DDL_MAIN);
			for (const step of withUndo) {
				expect(step.undo !== undefined || step.irreversible !== undefined, `undo half on ${step.sql}`).to.equal(true);
			}
		});
	});

	describe('each arm, against a live catalog', () => {
		it('table rename', async () => {
			const db = await databaseWith(['create table client (id integer primary key, name text)']);
			const plan = planFor(db, `table customer { id integer primary key, name text } with tags ("quereus.previous_name" = 'client')`);
			expectUndo(plan, 'ALTER TABLE client RENAME TO customer', ['ALTER TABLE customer RENAME TO client']);
		});

		it('drop assertion → the assertion recreated from its catalog body', async () => {
			const db = await databaseWith([
				'create table t (id integer primary key, qty integer)',
				'create assertion a1 check (not exists (select 1 from t where qty < 0))',
			]);
			const plan = planFor(db, 'table t { id integer primary key, qty integer }');
			expectUndo(plan, 'DROP ASSERTION IF EXISTS a1', ['create assertion a1 check (not exists (select 1 from t where qty < 0))']);
		});

		it('drop view → the view recreated with its explicit column list and tags', async () => {
			const db = await databaseWith([
				'create table t (id integer primary key, qty integer)',
				`create view v (vid) as select id from t with tags (owner = 'x')`,
			]);
			const plan = planFor(db, 'table t { id integer primary key, qty integer }');
			expectUndo(plan, 'DROP VIEW IF EXISTS v', [`create view v (vid) as select id from t with tags (owner = 'x')`]);
		});

		it('drop index → the index recreated from its catalog DDL, unique/partial/tags intact', async () => {
			const db = await databaseWith([
				'create table t (id integer primary key, qty integer, active integer)',
				`create unique index idx_t on t (qty desc) where active = 1 with tags (owner = 'i')`,
			]);
			const plan = planFor(db, 'table t { id integer primary key, qty integer, active integer }');
			// `collate binary` is spelled out: the catalog's index DDL records the resolved
			// per-column collation explicitly, and the undo is that DDL re-rendered.
			expectUndo(plan, 'DROP INDEX IF EXISTS idx_t', [`create unique index idx_t on t (qty collate binary desc) where active = 1 with tags (owner = 'i')`]);
		});

		it('drop table is irreversible — the rows go with it', async () => {
			const db = await databaseWith(['create table gone (id integer primary key)']);
			const plan = planFor(db, '');
			expectIrreversible(plan, 'DROP TABLE IF EXISTS gone', /dropping table "gone".*rows/);
		});

		it('creates undo to a DROP … IF EXISTS of what they made (table, materialized-view sugar, view, index, assertion)', async () => {
			const db = await databaseWith(['create table src (id integer primary key, v integer)']);
			const plan = planFor(db, `
				table src { id integer primary key, v integer }
				table fresh { id integer primary key, name text }
				materialized view mv as select id, v from src
				view fv as select id from fresh
				index fi on fresh (name)
				assertion fa check (not exists (select 1 from fresh where id < 0))
			`);
			expectUndo(plan, 'create table fresh', ['DROP TABLE IF EXISTS fresh']);
			expectUndo(plan, 'create materialized view mv', ['DROP TABLE IF EXISTS mv']);
			expectUndo(plan, 'create view fv', ['DROP VIEW IF EXISTS fv']);
			expectUndo(plan, 'create index fi', ['DROP INDEX IF EXISTS fi']);
			expectUndo(plan, 'create assertion fa', ['DROP ASSERTION IF EXISTS fa']);
		});

		it('rename column / add column', async () => {
			const db = await databaseWith(['create table t (id integer primary key, x integer)']);
			const plan = planFor(db, `table t { id integer primary key, x2 integer with tags ("quereus.previous_name" = 'x'), extra text }`);
			expectUndo(plan, 'ALTER TABLE t RENAME COLUMN x TO x2', ['ALTER TABLE t RENAME COLUMN x2 TO x']);
			expectUndo(plan, 'ALTER TABLE t ADD COLUMN extra', ['ALTER TABLE t DROP COLUMN extra']);
		});

		it('drop default → the prior default; set default → the prior default or DROP DEFAULT when there was none', async () => {
			const db = await databaseWith(['create table t (id integer primary key, a integer default 7, b integer, c integer default 1)']);
			const plan = planFor(db, 'table t { id integer primary key, a integer, b integer default 5, c integer default 2 }');
			expectUndo(plan, 'ALTER TABLE t ALTER COLUMN a DROP DEFAULT', ['ALTER TABLE t ALTER COLUMN a SET DEFAULT 7']);
			expectUndo(plan, 'ALTER TABLE t ALTER COLUMN b SET DEFAULT 5', ['ALTER TABLE t ALTER COLUMN b DROP DEFAULT']);
			expectUndo(plan, 'ALTER TABLE t ALTER COLUMN c SET DEFAULT 2', ['ALTER TABLE t ALTER COLUMN c SET DEFAULT 1']);
		});

		it('a retype is irreversible; the stale-default clear before it restores the old default and the re-set after it undoes to DROP DEFAULT', async () => {
			const db = await databaseWith([`create table t (id integer primary key, q text default 'abc')`]);
			const plan = planFor(db, 'table t { id integer primary key, q integer default 0 }');
			expect(plan.map(s => s.sql)).to.deep.equal([
				'ALTER TABLE t ALTER COLUMN q DROP DEFAULT',
				'ALTER TABLE t ALTER COLUMN q SET DATA TYPE integer',
				'ALTER TABLE t ALTER COLUMN q SET DEFAULT 0',
			]);
			expect(plan[0].undo).to.deep.equal([`ALTER TABLE t ALTER COLUMN q SET DEFAULT 'abc'`]);
			expectIrreversible(plan, 'ALTER TABLE t ALTER COLUMN q SET DATA TYPE', /changing the type of column "q" in table "t"/);
			// Rule 1: at the SET DEFAULT step the column has no default (cleared two steps
			// earlier), so its undo is a plain clear — not the pre-apply 'abc'.
			expect(plan[2].undo).to.deep.equal(['ALTER TABLE t ALTER COLUMN q DROP DEFAULT']);
		});

		it('set collate → the prior collation, both directions', async () => {
			const db = await databaseWith(['create table t (id integer primary key, a text, b text collate nocase)']);
			const plan = planFor(db, 'table t { id integer primary key, a text collate nocase, b text }');
			expectUndo(plan, 'ALTER TABLE t ALTER COLUMN a SET COLLATE NOCASE', ['ALTER TABLE t ALTER COLUMN a SET COLLATE BINARY']);
			expectUndo(plan, 'ALTER TABLE t ALTER COLUMN b SET COLLATE BINARY', ['ALTER TABLE t ALTER COLUMN b SET COLLATE NOCASE']);
		});

		it('set / drop not null swap', async () => {
			// Columns default to NOT NULL in this engine, so `a` is made nullable explicitly.
			const db = await databaseWith(['create table t (id integer primary key, a text null, b text not null)']);
			const plan = planFor(db, 'table t { id integer primary key, a text not null, b text null }');
			expectUndo(plan, 'ALTER TABLE t ALTER COLUMN a SET NOT NULL', ['ALTER TABLE t ALTER COLUMN a DROP NOT NULL']);
			expectUndo(plan, 'ALTER TABLE t ALTER COLUMN b DROP NOT NULL', ['ALTER TABLE t ALTER COLUMN b SET NOT NULL']);
		});

		it('rename constraint / add constraint', async () => {
			const db = await databaseWith(['create table t (id integer primary key, qty integer, constraint ck_a check (qty > 0))']);
			const plan = planFor(db, `table t {
				id integer primary key, qty integer,
				constraint ck_b check (qty > 0) with tags ("quereus.previous_name" = 'ck_a'),
				constraint ck_new check (qty < 100)
			}`);
			expectUndo(plan, 'ALTER TABLE t RENAME CONSTRAINT ck_a TO ck_b', ['ALTER TABLE t RENAME CONSTRAINT ck_b TO ck_a']);
			expectUndo(plan, 'ALTER TABLE t ADD constraint ck_new', ['ALTER TABLE t DROP CONSTRAINT ck_new']);
		});

		it('drop constraint → ADD of the full-fidelity catalog constraint, for CHECK, UNIQUE and a deferrable FK with tags', async () => {
			const db = await databaseWith([
				'create table p (id integer primary key)',
				`create table t (
					id integer primary key, qty integer, code text, pid integer,
					constraint ck_qty check (qty >= 0) with tags (owner = 'c'),
					constraint uq_code unique (code),
					constraint fk_p foreign key (pid) references p (id) on delete cascade deferrable initially deferred
				)`,
			]);
			const plan = planFor(db, 'table p { id integer primary key } table t { id integer primary key, qty integer, code text, pid integer }');
			// Full fidelity, as `generateTableDDL` persists it: the CHECK's operation set and
			// the FK's actions are spelled out even where they are the defaults, and the
			// FK's deferrability (which the canonical `definition` drops) survives.
			expectUndo(plan, 'ALTER TABLE t DROP CONSTRAINT ck_qty', [`ALTER TABLE t ADD constraint ck_qty check on insert, update (qty >= 0) with tags (owner = 'c')`]);
			expectUndo(plan, 'ALTER TABLE t DROP CONSTRAINT uq_code', ['ALTER TABLE t ADD constraint uq_code unique (code)']);
			expectUndo(plan, 'ALTER TABLE t DROP CONSTRAINT fk_p', ['ALTER TABLE t ADD constraint fk_p foreign key (pid) references p(id) on delete cascade on update restrict deferrable initially deferred']);
		});

		it('alter primary key → the prior key with its directions', async () => {
			const db = await databaseWith(['create table t (a integer, b integer, c integer, primary key (a, b desc))']);
			const plan = planFor(db, 'table t { a integer, b integer, c integer, primary key (c) }');
			expectUndo(plan, 'ALTER TABLE t ALTER PRIMARY KEY (c)', ['ALTER TABLE t ALTER PRIMARY KEY (a, b desc)']);
		});

		it('drop column is irreversible — the values go with it', async () => {
			const db = await databaseWith(['create table t (id integer primary key, stale integer)']);
			const plan = planFor(db, 'table t { id integer primary key }');
			expectIrreversible(plan, 'ALTER TABLE t DROP COLUMN stale', /dropping column "stale" from table "t"/);
		});

		it('SET TAGS on table / column / constraint / view / index: a clear undoes to the full prior set, a set onto untagged undoes to the empty set', async () => {
			const db = await databaseWith([
				`create table t (id integer primary key, a integer with tags (pii = 'yes'), b integer, constraint ck check (a > 0) with tags (severity = 'high')) with tags (owner = 'a', team = 'x')`,
				`create view v as select id from t with tags (owner = 'v')`,
				`create index ix on t (b)`,
			]);
			const plan = planFor(db, `
				table t { id integer primary key, a integer, b integer with tags (unit = 'kg'), constraint ck check (a > 0) }
				view v as select id from t
				index ix on t (b) with tags (owner = 'i')
			`);
			expectUndo(plan, 'ALTER TABLE t SET TAGS ()', [`ALTER TABLE t SET TAGS (owner = 'a', team = 'x')`]);
			expectUndo(plan, 'ALTER TABLE t ALTER COLUMN a SET TAGS ()', [`ALTER TABLE t ALTER COLUMN a SET TAGS (pii = 'yes')`]);
			expectUndo(plan, `ALTER TABLE t ALTER COLUMN b SET TAGS (unit = 'kg')`, ['ALTER TABLE t ALTER COLUMN b SET TAGS ()']);
			expectUndo(plan, 'ALTER TABLE t ALTER CONSTRAINT ck SET TAGS ()', [`ALTER TABLE t ALTER CONSTRAINT ck SET TAGS (severity = 'high')`]);
			expectUndo(plan, 'ALTER VIEW v SET TAGS ()', [`ALTER VIEW v SET TAGS (owner = 'v')`]);
			expectUndo(plan, `ALTER INDEX ix SET TAGS (owner = 'i')`, ['ALTER INDEX ix SET TAGS ()']);
		});

		it('a maintained table tag edit undoes through the same ALTER MATERIALIZED VIEW verb', async () => {
			const db = await databaseWith([
				'create table src (id integer primary key, v integer)',
				`create materialized view mv as select id, v from src with tags (owner = 'old')`,
			]);
			const plan = planFor(db, `table src { id integer primary key, v integer } materialized view mv as select id, v from src with tags (owner = 'new')`);
			expectUndo(plan, `ALTER MATERIALIZED VIEW mv SET TAGS (owner = 'new')`, [`ALTER MATERIALIZED VIEW mv SET TAGS (owner = 'old')`]);
		});

		it('drop maintained → the prior derivation re-attached, with its recorded column list', async () => {
			const db = await databaseWith([
				'create table src (id integer primary key, v integer)',
				'create materialized view mv (a, b) as select id, v from src',
			]);
			const plan = planFor(db, 'table src { id integer primary key, v integer } table mv { a integer primary key, b integer }');
			expectUndo(plan, 'ALTER TABLE mv DROP MAINTAINED', ['alter table mv set maintained (a, b) as select id, v from src']);
		});

		it('set maintained on a plain table (attach) → drop maintained', async () => {
			const db = await databaseWith([
				'create table src (id integer primary key, v integer)',
				'create table mv (a integer primary key, b integer)',
			]);
			const plan = planFor(db, 'table src { id integer primary key, v integer } materialized view mv (a, b) as select id, v from src');
			expectUndo(plan, 'alter table mv set maintained (a, b) as select id, v from src', ['ALTER TABLE mv DROP MAINTAINED']);
		});

		it('set maintained on a maintained table (same-shape re-attach) → the prior derivation', async () => {
			const db = await databaseWith([
				'create table src (id integer primary key, v integer)',
				'create materialized view mv (a, b) as select id, v from src',
			]);
			const plan = planFor(db, 'table src { id integer primary key, v integer } materialized view mv (a, b) as select id, v + 1 from src');
			expectUndo(plan, 'alter table mv set maintained (a, b) as select id, v + 1 from src', ['alter table mv set maintained (a, b) as select id, v from src']);
		});

		it('the reshape leg (detach → column op → re-attach): the two undos compose back to the original derivation', async () => {
			const db = await databaseWith([
				'create table src (id integer primary key, v integer, w integer)',
				'create table m (id integer primary key, v integer) maintained as select id, v from src',
			]);
			const plan = planFor(db, `
				table src { id integer primary key, v integer, w integer }
				table m { id integer primary key, v integer, w integer } maintained as select id, v, w from src
			`);
			expect(plan.map(s => s.sql)).to.deep.equal([
				'ALTER TABLE m DROP MAINTAINED',
				'ALTER TABLE m ADD COLUMN w integer',
				'alter table m set maintained as select id, v, w from src',
			]);
			expect(plan[0].undo).to.deep.equal(['alter table m set maintained as select id, v from src']);
			expect(plan[1].undo).to.deep.equal(['ALTER TABLE m DROP COLUMN w']);
			// Rule 1: at the re-attach step the table is plain (detached two steps earlier),
			// so the re-attach undoes to a detach, and the detach's undo restores the original.
			expect(plan[2].undo).to.deep.equal(['ALTER TABLE m DROP MAINTAINED']);
		});
	});

	describe('the two rules under renames', () => {
		it('a constraint dropped after a column it names was renamed: the restored body names the post-rename column', async () => {
			const db = await databaseWith(['create table t (id integer primary key, qty integer, constraint ck_qty check (qty > 0))']);
			const plan = planFor(db, `table t { id integer primary key, cap integer with tags ("quereus.previous_name" = 'qty') }`);
			expect(plan.map(s => s.sql)).to.deep.equal([
				'ALTER TABLE t RENAME COLUMN qty TO cap',
				'ALTER TABLE t DROP CONSTRAINT ck_qty',
			]);
			expectUndo(plan, 'ALTER TABLE t DROP CONSTRAINT ck_qty', ['ALTER TABLE t ADD constraint ck_qty check on insert, update (cap > 0)']);
		});

		it('UNIQUE and FK column lists, and the FK parent, follow the renames in force', async () => {
			const db = await databaseWith([
				'create table p (pid integer primary key)',
				'create table t (id integer primary key, code text, ref integer, constraint uq unique (code), constraint fk foreign key (ref) references p (pid))',
			]);
			// The parent table is renamed (first step) and, in the SAME table block as the
			// drops, the child's columns are renamed before the constraints drop.
			const plan = planFor(db, `
				table parent { pid2 integer primary key with tags ("quereus.previous_name" = 'pid') } with tags ("quereus.previous_name" = 'p')
				table t { id integer primary key, code2 text with tags ("quereus.previous_name" = 'code'), ref2 integer with tags ("quereus.previous_name" = 'ref') }
			`);
			expectUndo(plan, 'ALTER TABLE t DROP CONSTRAINT uq', ['ALTER TABLE t ADD constraint uq unique (code2)']);
			// The parent's column rename lives in `parent`'s alter block. Whether it is in force at
			// this step depends on block order; pin whichever the differ produces so a change is noticed.
			const parentRenamedFirst = plan.findIndex(s => s.sql === 'ALTER TABLE parent RENAME COLUMN pid TO pid2') < plan.findIndex(s => s.sql === 'ALTER TABLE t DROP CONSTRAINT fk');
			expectUndo(plan, 'ALTER TABLE t DROP CONSTRAINT fk', [`ALTER TABLE t ADD constraint fk foreign key (ref2) references parent(${parentRenamedFirst ? 'pid2' : 'pid'}) on delete restrict on update restrict`]);
		});

		it('a view and an assertion dropped in a diff that renames their source table are restored against the new name', async () => {
			const db = await databaseWith([
				'create table a (id integer primary key, qty integer)',
				'create view v as select id from a',
				'create assertion chk check (not exists (select 1 from a where qty < 0))',
				'create index ia on a (qty)',
			]);
			const plan = planFor(db, `table b { id integer primary key, qty integer } with tags ("quereus.previous_name" = 'a')`);
			expectUndo(plan, 'ALTER TABLE a RENAME TO b', ['ALTER TABLE b RENAME TO a']);
			expectUndo(plan, 'DROP VIEW IF EXISTS v', ['create view v as select id from b']);
			expectUndo(plan, 'DROP ASSERTION IF EXISTS chk', ['create assertion chk check (not exists (select 1 from b where qty < 0))']);
			expectUndo(plan, 'DROP INDEX IF EXISTS ia', ['create index ia on b (qty collate binary)']);
		});

		it('a table renamed and then altered: every alter undo names the new table', async () => {
			const db = await databaseWith([`create table a (id integer primary key, qty integer default 3, constraint ck check (qty > 0)) with tags (owner = 'x')`]);
			const plan = planFor(db, `table b { id integer primary key, qty integer, extra text } with tags ("quereus.previous_name" = 'a')`);
			expectUndo(plan, 'ALTER TABLE b ADD COLUMN extra', ['ALTER TABLE b DROP COLUMN extra']);
			expectUndo(plan, 'ALTER TABLE b ALTER COLUMN qty DROP DEFAULT', ['ALTER TABLE b ALTER COLUMN qty SET DEFAULT 3']);
			expectUndo(plan, 'ALTER TABLE b DROP CONSTRAINT ck', ['ALTER TABLE b ADD constraint ck check on insert, update (qty > 0)']);
			// The rename hint stays in the emitted set (it is excluded from drift compare only).
			expectUndo(plan, `ALTER TABLE b SET TAGS ("quereus.previous_name" = 'a')`, [`ALTER TABLE b SET TAGS (owner = 'x')`]);
		});

		it('only renames whose steps PRECEDE the step count: a view dropped before the column-rename phase keeps the old column name', async () => {
			const db = await databaseWith([
				'create table t (id integer primary key, qty integer)',
				'create view v as select qty from t',
			]);
			const plan = planFor(db, `table t { id integer primary key, cap integer with tags ("quereus.previous_name" = 'qty') }`);
			expect(plan.map(s => s.sql)).to.deep.equal([
				'DROP VIEW IF EXISTS v',
				'ALTER TABLE t RENAME COLUMN qty TO cap',
			]);
			// When the DROP VIEW undo runs, the RENAME COLUMN has already been reversed.
			expectUndo(plan, 'DROP VIEW IF EXISTS v', ['create view v as select qty from t']);
		});

		it('a CHECK whose subquery reads ANOTHER table follows that table\'s column rename when it precedes the drop', async () => {
			const db = await databaseWith([
				'create table p (id integer primary key, flag integer)',
				'create table t (id integer primary key, pid integer, constraint ck check ((select count(*) from p where p.flag = 1) >= 0))',
			]);
			const plan = planFor(db, `
				table p { id integer primary key, active integer with tags ("quereus.previous_name" = 'flag') }
				table t { id integer primary key, pid integer }
			`);
			expect(plan.map(s => s.sql)).to.deep.equal([
				'ALTER TABLE p RENAME COLUMN flag TO active',
				'ALTER TABLE t DROP CONSTRAINT ck',
			]);
			expectUndo(plan, 'ALTER TABLE t DROP CONSTRAINT ck', ['ALTER TABLE t ADD constraint ck check on insert, update ((select count(*) from p where p.active = 1) >= 0)']);
		});

		it('a CHECK with a qualified self-reference follows the table rename, then the column rename', async () => {
			const db = await databaseWith(['create table a (id integer primary key, qty integer, constraint ck check (a.qty > 0))']);
			const plan = planFor(db, `table b { id integer primary key, cap integer with tags ("quereus.previous_name" = 'qty') } with tags ("quereus.previous_name" = 'a')`);
			expectUndo(plan, 'ALTER TABLE b DROP CONSTRAINT ck', ['ALTER TABLE b ADD constraint ck check on insert, update (b.cap > 0)']);
		});
	});

	describe('executing the undo restores the catalog (forward in order, then every undo in reverse)', () => {
		it('constraint drops of every kind plus an add', () => expectRoundTrip([
			'create table p (id integer primary key)',
			`create table t (id integer primary key, qty integer, code text, pid integer, constraint ck_qty check (qty >= 0) with tags (owner = 'c'), constraint uq_code unique (code), constraint fk_p foreign key (pid) references p (id) on delete cascade deferrable initially deferred)`,
		], 'table p { id integer primary key } table t { id integer primary key, qty integer, code text, pid integer, constraint ck_new check (qty < 100) }'));

		it('a column rename with a CHECK over it dropped (Rule 2)', () => expectRoundTrip(
			['create table t (id integer primary key, qty integer, constraint ck_qty check (qty > 0))'],
			`table t { id integer primary key, cap integer with tags ("quereus.previous_name" = 'qty') }`));

		it('another table\'s column rename with a cross-table CHECK subquery dropped (the non-owning walk)', () => expectRoundTrip([
			'create table p (id integer primary key, flag integer)',
			'create table t (id integer primary key, pid integer, constraint ck check ((select count(*) from p where p.flag = 1) >= 0))',
		], `
			table p { id integer primary key, active integer with tags ("quereus.previous_name" = 'flag') }
			table t { id integer primary key, pid integer }
		`));

		it('a table rename with its dependent view, assertion and index dropped', () => expectRoundTrip([
			'create table a (id integer primary key, qty integer)',
			'create view v as select id from a',
			'create assertion chk check (not exists (select 1 from a where qty < 0))',
			'create index ia on a (qty)',
		], `table b { id integer primary key, qty integer } with tags ("quereus.previous_name" = 'a')`));

		it('column attribute changes and tag edits on every object kind', () => expectRoundTrip([
			`create table t (id integer primary key, a integer default 7, b text null, c text collate nocase, d integer with tags (pii = 'yes'), constraint ck check (a > 0) with tags (severity = 'high')) with tags (owner = 'a')`,
			`create view v as select id from t with tags (owner = 'v')`,
			'create index ix on t (b)',
		], `
			table t { id integer primary key, a integer, b text not null default 'x', c text, d integer, constraint ck check (a > 0) with tags (severity = 'low') } with tags (team = 'z')
			view v as select id from t
			index ix on t (b) with tags (owner = 'i')
		`));

		it('a primary key change and a constraint rename', () => expectRoundTrip(
			['create table t (a integer, b integer, c integer, constraint ck_a check (a > 0), primary key (a, b desc))'],
			`table t { a integer, b integer, c integer, constraint ck_b check (a > 0) with tags ("quereus.previous_name" = 'ck_a'), primary key (c) }`));

		it('maintained tables: a detach, an attach, and the reshape leg', async () => {
			await expectRoundTrip(
				['create table src (id integer primary key, v integer)', 'create materialized view mv (a, b) as select id, v from src'],
				'table src { id integer primary key, v integer } table mv { a integer primary key, b integer }');
			await expectRoundTrip(
				['create table src (id integer primary key, v integer)', 'create table mv (a integer primary key, b integer)'],
				'table src { id integer primary key, v integer } materialized view mv (a, b) as select id, v from src');
			await expectRoundTrip(
				['create table src (id integer primary key, v integer, w integer)', 'create table m (id integer primary key, v integer) maintained as select id, v from src'],
				'table src { id integer primary key, v integer, w integer } table m { id integer primary key, v integer, w integer } maintained as select id, v, w from src');
		});

		it('creates of every kind', () => expectRoundTrip(['create table src (id integer primary key, v integer)'], `
			table src { id integer primary key, v integer }
			table fresh { id integer primary key, name text }
			materialized view mv as select id, v from src
			view fv as select id from fresh
			index fi on fresh (name)
			assertion fa check (not exists (select 1 from fresh where id < 0))
		`));
	});

	describe('absent targets and hand-built inputs', () => {
		it('an IF EXISTS drop whose target is absent undoes to nothing and is NOT irreversible', () => {
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				tablesToDrop: ['never_there'], viewsToDrop: ['nv'], indexesToDrop: ['ni'], assertionsToDrop: ['na'],
			};
			const plan = generateMigrationPlan(diff, 'main', emptyCatalog());
			expect(plan).to.have.length(4);
			for (const step of plan) {
				expect(step.irreversible, step.sql).to.be.undefined;
				expect(step.undo, step.sql).to.deep.equal([]);
			}
		});

		it('a partial diff against a catalog that mentions none of its objects neither throws nor loses template undos', () => {
			const plan = generateMigrationPlan(broadDiff(), 'main', emptyCatalog());
			expectUndo(plan, 'ALTER TABLE old_t RENAME TO new_t', ['ALTER TABLE new_t RENAME TO old_t']);
			expectUndo(plan, 'ALTER TABLE new_t RENAME COLUMN a TO b', ['ALTER TABLE new_t RENAME COLUMN b TO a']);
			expectUndo(plan, 'ALTER TABLE new_t ADD COLUMN extra integer', ['ALTER TABLE new_t DROP COLUMN extra']);
			expectUndo(plan, 'ALTER TABLE new_t ADD constraint ck_fresh', ['ALTER TABLE new_t DROP CONSTRAINT ck_fresh']);
			expectUndo(plan, 'ALTER TABLE new_t ALTER COLUMN name SET NOT NULL', ['ALTER TABLE new_t ALTER COLUMN name DROP NOT NULL']);
			expectUndo(plan, 'create table fresh', ['DROP TABLE IF EXISTS fresh']);
			// Catalog-sourced arms over an unknown object: nothing to restore, nothing irreversible.
			expectUndo(plan, 'ALTER TABLE new_t DROP CONSTRAINT ck_stale', []);
			expectUndo(plan, 'ALTER TABLE new_t ALTER PRIMARY KEY', []);
			expectUndo(plan, 'ALTER TABLE new_t DROP MAINTAINED', []);
			expectUndo(plan, 'ALTER TABLE new_t DROP COLUMN stale', []);
			expectUndo(plan, 'ALTER TABLE new_t ALTER COLUMN name SET DATA TYPE text', []);
			expectUndo(plan, 'ALTER VIEW fresh_v SET TAGS', []);
		});

		it('a catalog entry that lacks what its restore needs is reported irreversible with the reason, not thrown', () => {
			const table: CatalogTable = {
				name: 't', ddl: '',
				columns: [{ name: 'id', type: 'integer', notNull: true, primaryKey: true, defaultValue: null, collation: 'BINARY' }],
				primaryKey: [{ columnName: 'id', desc: false }],
				referencedTables: [],
				namedConstraints: [{ name: 'ck', definition: 'check (id > 0)' }], // no bodyAst
			};
			const actual: SchemaCatalog = {
				...emptyCatalog(),
				tables: [table],
				indexes: [{ name: 'ix', tableName: 't', ddl: '', definition: 'index (id)' }], // empty ddl
			};
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				indexesToDrop: ['ix'],
				tablesToAlter: [{ tableName: 't', columnsToAdd: [], columnsToDrop: [], columnsToAlter: [], columnsToRename: [], constraintsToDrop: ['ck'] }],
			};
			const plan = generateMigrationPlan(diff, 'main', actual);
			expectIrreversible(plan, 'DROP INDEX IF EXISTS ix', /DROP INDEX ix cannot be undone: its recorded DDL does not parse/);
			expectIrreversible(plan, 'ALTER TABLE t DROP CONSTRAINT ck', /DROP CONSTRAINT ck cannot be undone: the pre-apply catalog carries no body/);
		});

		it('a view or a derivation without a body AST is reported irreversible with the reason, not thrown', () => {
			const maintained: CatalogTable = {
				name: 'm', ddl: '',
				columns: [{ name: 'id', type: 'integer', notNull: true, primaryKey: true, defaultValue: null, collation: 'BINARY' }],
				primaryKey: [{ columnName: 'id', desc: false }],
				referencedTables: [],
				namedConstraints: [],
				maintained: { bodyHash: 'h' }, // no select
			};
			const actual: SchemaCatalog = {
				...emptyCatalog(),
				tables: [maintained],
				views: [{ name: 'v', ddl: '', definition: 'select 1' }], // no select
			};
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				viewsToDrop: ['v'],
				tablesToAlter: [{ tableName: 'm', columnsToAdd: [], columnsToDrop: [], columnsToAlter: [], columnsToRename: [], dropMaintained: true }],
			};
			const plan = generateMigrationPlan(diff, 'main', actual);
			expectIrreversible(plan, 'DROP VIEW IF EXISTS v', /DROP VIEW v cannot be undone: the pre-apply catalog carries no body/);
			expectIrreversible(plan, 'ALTER TABLE m DROP MAINTAINED', /the derivation of m cannot be undone: the pre-apply catalog carries no body/);
		});

		it('a name a rename in force vacated denotes no pre-apply object: whatever now sits there, this plan created', () => {
			// `a` is renamed to `b`, and a fresh `a` is created in the same plan. A tag edit
			// on the NEW `a` must not restore the OLD `a`'s tags (that table is now `b`), and
			// the same holds for a column name vacated by a column rename.
			const old: CatalogTable = {
				name: 'a', ddl: '', tags: { owner: 'old' },
				columns: [
					{ name: 'id', type: 'integer', notNull: true, primaryKey: true, defaultValue: null, collation: 'BINARY' },
					{ name: 'x', type: 'integer', notNull: false, primaryKey: false, defaultValue: null, collation: 'BINARY', tags: { pii: 'yes' } },
				],
				primaryKey: [{ columnName: 'id', desc: false }],
				referencedTables: [],
				namedConstraints: [],
			};
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				renames: [{ kind: 'table', oldName: 'a', newName: 'b' }],
				tablesToCreate: [migrationCreate('create table a (id integer primary key)')],
				tablesToAlter: [
					{ tableName: 'a', columnsToAdd: [], columnsToDrop: [], columnsToAlter: [], columnsToRename: [], tableTagsChange: { owner: 'new' } },
					{ tableName: 'b', columnsToAdd: [], columnsToDrop: [], columnsToAlter: [{ columnName: 'x', tags: { pii: 'no' } }], columnsToRename: [{ oldName: 'x', newName: 'y' }] },
				],
			};
			const plan = generateMigrationPlan(diff, 'main', { ...emptyCatalog(), tables: [old] });
			expectUndo(plan, `ALTER TABLE a SET TAGS (owner = 'new')`, []);
			// `b.x` after `RENAME COLUMN x TO y` is a vacated name, not the pre-apply `x`.
			expectUndo(plan, `ALTER TABLE b ALTER COLUMN x SET TAGS (pii = 'no')`, []);
		});
	});

	describe('schema qualification', () => {
		it('undo DDL carries the same schema prefix the forward step used', () => {
			const viewStmt = new Parser().parse('create view v (vid) as select id from t') as AST.CreateViewStmt;
			const view: CatalogView = {
				name: 'v', ddl: '', definition: viewDefinitionToCanonicalString(viewStmt.columns, viewStmt.select),
				select: viewStmt.select, columns: viewStmt.columns,
			};
			const actual: SchemaCatalog = { ...emptyCatalog('analytics'), views: [view] };
			const diff: SchemaDiff = {
				...makeEmptySchemaDiff(),
				renames: [{ kind: 'table', oldName: 'a', newName: 'b' }],
				viewsToDrop: ['v'],
				tablesToCreate: [migrationCreate('create table analytics.fresh (id integer primary key)')],
				tablesToAlter: [{ tableName: 'b', columnsToAdd: ['extra integer'], columnsToDrop: [], columnsToAlter: [], columnsToRename: [{ oldName: 'x', newName: 'y' }] }],
			};
			const plan = generateMigrationPlan(diff, 'analytics', actual);
			expectUndo(plan, 'ALTER TABLE analytics.a RENAME TO b', ['ALTER TABLE analytics.b RENAME TO a']);
			expectUndo(plan, 'DROP VIEW IF EXISTS analytics.v', ['create view analytics.v (vid) as select id from t']);
			expectUndo(plan, 'create table analytics.fresh', ['DROP TABLE IF EXISTS analytics.fresh']);
			expectUndo(plan, 'ALTER TABLE analytics.b RENAME COLUMN x TO y', ['ALTER TABLE analytics.b RENAME COLUMN y TO x']);
			expectUndo(plan, 'ALTER TABLE analytics.b ADD COLUMN extra integer', ['ALTER TABLE analytics.b DROP COLUMN extra']);
		});
	});
});

// --- The no-movement guard: `generateMigrationDDL` over a diff touching every bucket,
// pinned from the output BEFORE this undo work landed. ---

function selectOf(sql: string): AST.QueryExpr {
	const stmt = new Parser().parse(sql);
	if (stmt.type !== 'createView') throw new Error(`Expected createView, got ${stmt.type}`);
	return stmt.select;
}

/** A diff touching every bucket `generateMigrationPlan` reads, including the ordering-sensitive column-alter combinations. */
function broadDiff(): SchemaDiff {
	return {
		renames: [{ kind: 'table', oldName: 'old_t', newName: 'new_t' }, { kind: 'view', oldName: 'old_v', newName: 'new_v' }],
		tablesToCreate: [migrationCreate('create table fresh (id integer primary key, name text)'), migrationCreate('create materialized view mv1 as select id from fresh')],
		tablesToDrop: ['gone_t'],
		tablesToAlter: [{
			tableName: 'new_t',
			columnsToAdd: ['extra integer', `more text default 'x'`],
			columnsToDrop: ['stale'],
			columnsToAlter: [
				{ columnName: 'name', notNull: true, dataType: 'text', collation: 'BINARY', defaultValue: { type: 'literal', value: 'x' }, tags: { pii: 'true' }, dropStaleDefaultFirst: true },
				{ columnName: 'qty', notNull: false, collation: 'NOCASE', defaultValue: null },
			],
			columnsToRename: [{ oldName: 'a', newName: 'b' }],
			constraintsToRename: [{ oldName: 'ck_old', newName: 'ck_new' }],
			constraintsToDrop: ['ck_stale'],
			constraintsToAdd: ['constraint ck_fresh check (extra > 0)'],
			primaryKeyChange: { oldPkColumns: ['id'], newPkColumns: [{ name: 'id' }, { name: 'b', direction: 'desc' }] },
			tableTagsChange: { owner: 'z' },
			constraintTagsChanges: [{ constraintName: 'ck_new', tags: { severity: 'high' } }],
			dropMaintained: true,
			setMaintained: { columns: ['b'], select: selectOf('create view tmp as select id from fresh') },
		}, {
			tableName: 'plain',
			columnsToAdd: [], columnsToDrop: [], columnsToAlter: [], columnsToRename: [],
			tableTagsChange: {},
			maintainedTags: true,
		}],
		maintainedModuleMigrations: [],
		viewsToCreate: [migrationCreate('create view fresh_v as select id from fresh')],
		viewsToDrop: ['gone_v'],
		indexesToCreate: [migrationCreate('create index idx_fresh on fresh (name)')],
		indexesToDrop: ['gone_idx'],
		assertionsToCreate: [migrationCreate('create assertion a1 check (not exists (select 1 from fresh where id < 0))')],
		assertionsToDrop: ['gone_a'],
		viewTagsChanges: [{ name: 'fresh_v', tags: { owner: 'x' } }],
		indexTagsChanges: [{ name: 'idx_fresh', tags: {} }],
		lensToAttach: [],
		lensToDetach: [],
	};
}

const BROAD_DDL_MAIN = [
	'ALTER TABLE old_t RENAME TO new_t',
	'DROP ASSERTION IF EXISTS gone_a',
	'ALTER TABLE new_t DROP MAINTAINED',
	'DROP TABLE IF EXISTS gone_t',
	'DROP VIEW IF EXISTS gone_v',
	'DROP INDEX IF EXISTS gone_idx',
	'create table fresh (id integer primary key, name text)',
	'create materialized view mv1 as select id from fresh',
	'create view fresh_v as select id from fresh',
	'create index idx_fresh on fresh (name)',
	'ALTER TABLE new_t RENAME COLUMN a TO b',
	'ALTER TABLE new_t ADD COLUMN extra integer',
	`ALTER TABLE new_t ADD COLUMN more text default 'x'`,
	'ALTER TABLE new_t ALTER COLUMN name DROP DEFAULT',
	'ALTER TABLE new_t ALTER COLUMN name SET COLLATE BINARY',
	'ALTER TABLE new_t ALTER COLUMN name SET DATA TYPE text',
	`ALTER TABLE new_t ALTER COLUMN name SET DEFAULT 'x'`,
	'ALTER TABLE new_t ALTER COLUMN name SET NOT NULL',
	'ALTER TABLE new_t ALTER COLUMN qty SET COLLATE NOCASE',
	'ALTER TABLE new_t ALTER COLUMN qty DROP DEFAULT',
	'ALTER TABLE new_t ALTER COLUMN qty DROP NOT NULL',
	'ALTER TABLE new_t RENAME CONSTRAINT ck_old TO ck_new',
	'ALTER TABLE new_t DROP CONSTRAINT ck_stale',
	'ALTER TABLE new_t ALTER PRIMARY KEY (id, b desc)',
	'ALTER TABLE new_t ADD constraint ck_fresh check (extra > 0)',
	'ALTER TABLE new_t DROP COLUMN stale',
	`ALTER TABLE new_t SET TAGS (owner = 'z')`,
	`ALTER TABLE new_t ALTER COLUMN name SET TAGS (pii = 'true')`,
	`ALTER TABLE new_t ALTER CONSTRAINT ck_new SET TAGS (severity = 'high')`,
	'ALTER MATERIALIZED VIEW plain SET TAGS ()',
	'alter table new_t set maintained (b) as select id from fresh',
	'create assertion a1 check (not exists (select 1 from fresh where id < 0))',
	`ALTER VIEW fresh_v SET TAGS (owner = 'x')`,
	'ALTER INDEX idx_fresh SET TAGS ()',
];

const BROAD_DDL_ANALYTICS = [
	'ALTER TABLE analytics.old_t RENAME TO new_t',
	'DROP ASSERTION IF EXISTS analytics.gone_a',
	'ALTER TABLE analytics.new_t DROP MAINTAINED',
	'DROP TABLE IF EXISTS analytics.gone_t',
	'DROP VIEW IF EXISTS analytics.gone_v',
	'DROP INDEX IF EXISTS analytics.gone_idx',
	'create table fresh (id integer primary key, name text)',
	'create materialized view mv1 as select id from fresh',
	'create view fresh_v as select id from fresh',
	'create index idx_fresh on fresh (name)',
	'ALTER TABLE analytics.new_t RENAME COLUMN a TO b',
	'ALTER TABLE analytics.new_t ADD COLUMN extra integer',
	`ALTER TABLE analytics.new_t ADD COLUMN more text default 'x'`,
	'ALTER TABLE analytics.new_t ALTER COLUMN name DROP DEFAULT',
	'ALTER TABLE analytics.new_t ALTER COLUMN name SET COLLATE BINARY',
	'ALTER TABLE analytics.new_t ALTER COLUMN name SET DATA TYPE text',
	`ALTER TABLE analytics.new_t ALTER COLUMN name SET DEFAULT 'x'`,
	'ALTER TABLE analytics.new_t ALTER COLUMN name SET NOT NULL',
	'ALTER TABLE analytics.new_t ALTER COLUMN qty SET COLLATE NOCASE',
	'ALTER TABLE analytics.new_t ALTER COLUMN qty DROP DEFAULT',
	'ALTER TABLE analytics.new_t ALTER COLUMN qty DROP NOT NULL',
	'ALTER TABLE analytics.new_t RENAME CONSTRAINT ck_old TO ck_new',
	'ALTER TABLE analytics.new_t DROP CONSTRAINT ck_stale',
	'ALTER TABLE analytics.new_t ALTER PRIMARY KEY (id, b desc)',
	'ALTER TABLE analytics.new_t ADD constraint ck_fresh check (extra > 0)',
	'ALTER TABLE analytics.new_t DROP COLUMN stale',
	`ALTER TABLE analytics.new_t SET TAGS (owner = 'z')`,
	`ALTER TABLE analytics.new_t ALTER COLUMN name SET TAGS (pii = 'true')`,
	`ALTER TABLE analytics.new_t ALTER CONSTRAINT ck_new SET TAGS (severity = 'high')`,
	'ALTER MATERIALIZED VIEW analytics.plain SET TAGS ()',
	'alter table analytics.new_t set maintained (b) as select id from fresh',
	'create assertion a1 check (not exists (select 1 from fresh where id < 0))',
	`ALTER VIEW analytics.fresh_v SET TAGS (owner = 'x')`,
	'ALTER INDEX analytics.idx_fresh SET TAGS ()',
];
