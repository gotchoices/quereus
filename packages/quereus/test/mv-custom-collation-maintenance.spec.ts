/**
 * Materialized-view maintenance resolves collations against the **database**, not the
 * process-global built-in registry (ticket `3.5-core-callers-collation-resolver`).
 *
 * Column DDL still refuses a collation name it has never heard of (see the
 * `feat-ddl-accepts-registered-collations` backlog ticket), so — as in
 * `test/collation-resolver.spec.ts` — these tests reach a *custom* comparator by
 * overriding the built-in `NOCASE` on one connection. The override equates any two
 * strings of the same length, which the built-in NOCASE never does; every assertion below
 * is therefore false under byte comparison and false under the real NOCASE.
 */
import { expect } from 'chai';
import { Database } from '../src/index.js';
import {
	backingPkEqual,
	residualRowMatchesKey,
	residualRowMatchesBasePrefix,
} from '../src/core/database-materialized-views-apply.js';
import type {
	BackingPkColumn,
	ForwardResidualPlan,
	PrefixDeletePlan,
} from '../src/core/database-materialized-views-plans.js';
import { uniqueEnforcementCollations } from '../src/schema/unique-enforcement.js';
import { BINARY_COLLATION, resolveCollationFunctions } from '../src/util/comparison.js';

/** A `NOCASE` that equates every pair of same-length strings. */
const lengthOnly = (a: string, b: string): number => a.length - b.length;
/** Partitions strings into the same classes as {@link lengthOnly}; hash-keyed paths need it. */
const lengthNormalizer = (s: string): string => 'x'.repeat(s.length);

async function results(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const r of db.eval(sql)) rows.push(r as Record<string, unknown>);
	return rows;
}

describe('materialized-view maintenance under a database-registered collation', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerCollation('NOCASE', lengthOnly, { normalizer: lengthNormalizer });
	});
	afterEach(async () => { await db.close(); });

	it("routes a covering-MV UNIQUE conflict under the source column's registered collation", async () => {
		await db.exec('create table t (id integer primary key, x text collate nocase not null, unique (x))');
		await db.exec('create materialized view ix as select x, id from t order by x');
		await db.exec("insert into t values (1, 'aa')");

		// 'bb' is NOCASE-equal to 'aa' under this connection's collation, so it violates
		// UNIQUE(x). Resolving NOCASE from the process-global registry would compare the
		// bytes, find no conflict, and admit the duplicate.
		let failed = false;
		try {
			await db.exec("insert into t values (2, 'bb')");
		} catch (e) {
			failed = true;
			expect(String(e)).to.match(/UNIQUE constraint failed/i);
		}
		expect(failed, 'duplicate under the registered collation must be rejected').to.equal(true);
		expect(await results(db, 'select id from t order by id')).to.deep.equal([{ id: 1 }]);
	});

	it('does not invent a conflict for values the registered collation keeps distinct', async () => {
		await db.exec('create table t (id integer primary key, x text collate nocase not null, unique (x))');
		await db.exec('create materialized view ix as select x, id from t order by x');
		await db.exec("insert into t values (1, 'aa')");
		await db.exec("insert into t values (2, 'bbb')"); // different length ⇒ distinct
		expect(await results(db, 'select id from t order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
		expect(await results(db, 'select x, id from ix order by id')).to.deep.equal([
			{ x: 'aa', id: 1 }, { x: 'bbb', id: 2 },
		]);
	});

	it('an UPDATE that is a no-op under the collation leaves the covering MV consistent', async () => {
		await db.exec('create table t (id integer primary key, x text collate nocase not null, unique (x))');
		await db.exec('create materialized view ix as select x, id from t order by x');
		await db.exec("insert into t values (1, 'aa')");
		// 'zz' is collation-equal to 'aa', so the row keeps its identity: the UNIQUE
		// self-conflict check must recognize the conflicting backing row as its own.
		await db.exec("update t set x = 'zz' where id = 1");
		expect(await results(db, 'select id, x from t')).to.deep.equal([{ id: 1, x: 'zz' }]);
		expect(await results(db, 'select x, id from ix')).to.deep.equal([{ x: 'zz', id: 1 }]);
	});

	it('the covering path and uniqueEnforcementCollations agree on the enforcement collation', async () => {
		await db.exec('create table t (id integer primary key, x text collate nocase not null, unique (x))');
		const schema = db.schemaManager.getTable('main', 't')!;
		const uc = schema.uniqueConstraints![0];
		// `lookupCoveringConflicts` compares under the *declared source column* collation.
		// For a non-index-derived UNIQUE that is exactly what the shared helper reports, and
		// both resolve through the same database resolver — not the process-global registry.
		expect(uniqueEnforcementCollations(schema, uc))
			.to.deep.equal(uc.columns.map(c => schema.columns[c].collation));
		const [fn] = resolveCollationFunctions(db.getCollationResolver(), uniqueEnforcementCollations(schema, uc));
		expect(fn).to.equal(lengthOnly);
	});
});

describe('materialized-view apply-path key comparisons use the plan-resolved collation', () => {
	// The three per-row helpers read `collationFn` off each backing-PK descriptor, which the
	// plan builder resolved against the database once. Exercised directly: the residual /
	// prefix-delete arms these belong to need an aggregate or lateral-TVF body whose group
	// key the hash-aggregate path cannot yet key under a custom collation (see the
	// `bug-key-normalizer-ignores-database-collations` fix ticket), so end-to-end coverage
	// of a *collation-equal, byte-different* key is not reachable through SQL today.
	const pkCol = (index: number, collationFn = BINARY_COLLATION): BackingPkColumn =>
		({ index, collation: 'NOCASE', collationFn });

	const custom = [pkCol(0, lengthOnly)];
	const binary = [pkCol(0)];

	it('residualRowMatchesKey keeps a residual row whose key is collation-equal', () => {
		const plan = { backingPkDefinition: custom } as unknown as ForwardResidualPlan;
		expect(residualRowMatchesKey(plan, ['aa'], ['bb'])).to.equal(true);
		expect(residualRowMatchesKey(plan, ['aa'], ['bbb'])).to.equal(false);

		const binaryPlan = { backingPkDefinition: binary } as unknown as ForwardResidualPlan;
		expect(residualRowMatchesKey(binaryPlan, ['aa'], ['bb'])).to.equal(false);
	});

	it('backingPkEqual pairs an existing backing row with its collation-equal replacement', () => {
		expect(backingPkEqual(custom, ['aa'], ['bb'])).to.equal(true);
		expect(backingPkEqual(binary, ['aa'], ['bb'])).to.equal(false);
	});

	it('residualRowMatchesBasePrefix compares the base prefix under its collation', () => {
		const plan = { backingPkDefinition: custom, basePrefixLength: 1 } as unknown as PrefixDeletePlan;
		expect(residualRowMatchesBasePrefix(plan, ['aa', 9], ['bb'])).to.equal(true);
		expect(residualRowMatchesBasePrefix(plan, ['aaa', 9], ['bb'])).to.equal(false);
	});
});
