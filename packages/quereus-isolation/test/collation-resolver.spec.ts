/**
 * IsolatedTable resolves collation names against its OWN database.
 *
 * The overlay/underlying merge aligns rows by a primary-key comparator, and the
 * read-your-own-writes write path decides "same logical key" with `keysEqual`. Both
 * used to resolve the PK columns' declared collation through the process-global
 * `compareSqlValues(a, b, name)`, which knows only BINARY / NOCASE / RTRIM and falls
 * back to BINARY on a miss. They now resolve through `db.getCollationResolver()`, so a
 * collation registered (or a built-in overridden) on the connection participates — and
 * agrees with the collation the underlying table keys its rows by.
 *
 * A custom collation cannot yet be named on a *column* (`validateCollationForType`
 * checks a static per-type list), so these tests override the built-in `NOCASE` on the
 * database. A comparison that reached the global registry would still get the built-in
 * case-folding comparator, which is what makes the override a discriminating probe.
 * The custom-name-on-an-index-column shape is exercised too.
 */

import { describe, it, beforeEach, afterEach } from 'mocha';
import { expect } from 'chai';
import { Database, MemoryTableModule, type SqlValue } from '@quereus/quereus';
import { IsolationModule } from '../src/index.js';

/** Ignores spaces, so `'a b'` and `'ab'` are one value. Does NOT fold case. */
const stripSpaces = (s: string): string => s.replace(/ /g, '');
const noSpace = (a: string, b: string): number => {
	const sa = stripSpaces(a);
	const sb = stripSpaces(b);
	return sa < sb ? -1 : sa > sb ? 1 : 0;
};

async function collect(db: Database, sql: string): Promise<Record<string, SqlValue>[]> {
	const out: Record<string, SqlValue>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

/** Runs `sql`, returning the thrown error or null. */
async function attempt(db: Database, sql: string): Promise<Error | null> {
	try {
		await db.exec(sql);
		return null;
	} catch (e) {
		return e as Error;
	}
}

describe('IsolatedTable collation resolution', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
		db.registerModule('isolated', new IsolationModule({ underlying: new MemoryTableModule() }));
	});

	afterEach(async () => {
		await db.close();
	});

	describe('primary key under an overridden NOCASE', () => {
		beforeEach(async () => {
			// NOCASE now means "ignore spaces", on this database only.
			db.registerCollation('NOCASE', noSpace, stripSpaces);
			await db.exec(`create table t (k text collate NOCASE primary key, v text) using isolated`);
			await db.exec(`insert into t values ('a b', 'base')`);
		});

		it('treats a collation-equal PK rewrite as an in-place update, not a relocation', async () => {
			// 'ab' is the SAME logical key as 'a b' under the overridden NOCASE. Resolved
			// against the global registry the two are distinct, so the write is classified
			// as a PK relocation whose "new" key resolves back to the same underlying row —
			// a false PK conflict.
			await db.exec(`begin`);
			expect(await attempt(db, `update t set k = 'ab', v = 'staged' where k = 'a b'`)).to.be.null;

			const staged = await collect(db, `select k, v from t`);
			expect(staged, 'the staged row shadows the base row exactly once').to.deep.equal([
				{ k: 'ab', v: 'staged' },
			]);
			await db.exec(`commit`);

			const committed = await collect(db, `select k, v from t`);
			expect(committed).to.deep.equal([{ k: 'ab', v: 'staged' }]);
		});

		it('restores the base row on rollback', async () => {
			await db.exec(`begin`);
			await db.exec(`update t set k = 'ab', v = 'staged' where k = 'a b'`);
			await db.exec(`rollback`);

			const rows = await collect(db, `select k, v from t`);
			expect(rows).to.deep.equal([{ k: 'a b', v: 'base' }]);
		});

		it('shadows the base row exactly once when only a non-key column is staged', async () => {
			await db.exec(`begin`);
			await db.exec(`update t set v = 'staged' where k = 'a b'`);

			const rows = await collect(db, `select k, v from t`);
			expect(rows).to.deep.equal([{ k: 'a b', v: 'staged' }]);
			await db.exec(`rollback`);
		});

		it('rejects an insert whose PK collation-equals a committed row', async () => {
			await db.exec(`begin`);
			const err = await attempt(db, `insert into t values ('ab', 'dup')`);
			expect(err, 'expected a PK conflict against the underlying row').to.not.be.null;
			expect(err!.message).to.match(/constraint failed|unique/i);
			await db.exec(`rollback`);

			const rows = await collect(db, `select k, v from t`);
			expect(rows).to.deep.equal([{ k: 'a b', v: 'base' }]);
		});

		it('accepts an insert whose PK the overridden NOCASE keeps distinct', async () => {
			await db.exec(`begin`);
			expect(await attempt(db, `insert into t values ('a c', 'other')`)).to.be.null;
			await db.exec(`commit`);

			const rows = await collect(db, `select k, v from t order by k`);
			expect(rows).to.have.lengthOf(2);
		});
	});

	describe('UNIQUE against committed rows', () => {
		it('enforces an index-derived UNIQUE under a custom collation named on the index column', async () => {
			db.registerCollation('NOSPACE', noSpace, stripSpaces);
			await db.exec(`create table t (id integer primary key, code text) using isolated`);
			await db.exec(`create unique index ix_code on t (code collate NOSPACE)`);
			await db.exec(`insert into t values (1, 'a b')`);

			await db.exec(`begin`);
			const err = await attempt(db, `insert into t values (2, 'ab')`);
			expect(err, 'expected a UNIQUE violation against the committed row').to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
			await db.exec(`rollback`);
		});

		it('still rejects a case-variant duplicate under the built-in NOCASE', async () => {
			// Regression guard: NOCASE resolves in both registries, so this would keep
			// passing under a wiring mistake that picks the wrong one — it catches only a
			// mistake that breaks enforcement outright.
			await db.exec(`create table t (id integer primary key, code text collate NOCASE unique) using isolated`);
			await db.exec(`insert into t values (1, 'abc')`);

			await db.exec(`begin`);
			const err = await attempt(db, `insert into t values (2, 'ABC')`);
			expect(err, 'expected a UNIQUE violation').to.not.be.null;
			expect(err!.message).to.match(/UNIQUE constraint failed/i);
			await db.exec(`rollback`);
		});
	});

	describe('unregistered collation', () => {
		it('raises rather than falling back to BINARY', async () => {
			const err = await attempt(
				db,
				`create table t (k integer collate FROBNICATE primary key, v text) using isolated`,
			);
			expect(err, 'expected an unresolvable-collation error').to.not.be.null;
			expect(err!.message).to.match(/no such collation sequence: FROBNICATE/i);
		});
	});
});
