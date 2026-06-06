/**
 * `refresh materialized view` re-derives the backing table's *shape*
 * (columns/types/PK/ordering) and rebuilds the backing table when a source
 * `alter` has shifted the re-planned body's output shape — instead of only
 * swapping the new rows into the stale create-time schema (which surfaced body
 * values under the wrong column labels: a latent direct-read corruption for
 * schema-shifting `select *` bodies). A refresh with no shape change keeps the
 * data-only fast path (backing identity + warm caches preserved).
 *
 * See `mv-refresh-rebuilds-backing-schema`. The join-rewrite re-enable that the
 * realignment restores is covered in `query-rewrite-join.spec.ts`; this spec
 * covers the direct-read shape, the fast-path identity, the explicit-column
 * count-shift error, and row-time maintenance against the rebuilt backing.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';

/** Each result row as a JSON object string (keys = column names, in column order;
 *  bigints normalized), sorted — so a wrong value-under-label surfaces as a
 *  key/value mismatch, not just a reordering. */
async function readObjectsSorted(db: Database, sql: string): Promise<string[]> {
	const rows: string[] = [];
	for await (const row of db.eval(sql)) {
		rows.push(JSON.stringify(row, (_k, v) => (typeof v === 'bigint' ? `${v}n` : v)));
	}
	return rows.sort();
}

/** customers (parent, PK id) ⋈ orders (child, NOT-NULL FK customer_id → id). The
 *  `select *` join body collides the two `id` columns, so the second surfaces as
 *  `id:1` — exactly the shape the corruption mislabeled. */
const JOIN_SCHEMA = [
	'create table customers (id integer primary key, name text not null)',
	'create table orders (id integer primary key, customer_id integer not null '
		+ 'references customers(id), amt integer not null)',
	'create materialized view v as select * from orders o join customers c on o.customer_id = c.id',
	"insert into customers values (1,'alice')",
	'insert into orders values (10,1,100)',
];

describe('materialized view refresh — backing-schema rebuild', () => {
	it('direct read of a select* join MV is correct after a source ALTER+refresh (corruption regression)', async () => {
		const db = new Database();
		try {
			for (const stmt of JOIN_SCHEMA) await db.exec(stmt);

			// Before: 5 cols [id, customer_id, amt, id:1, name].
			expect(await readObjectsSorted(db, 'select * from v')).to.deep.equal([
				'{"id":10,"customer_id":1,"amt":100,"id:1":1,"name":"alice"}',
			]);

			await db.exec("alter table orders add column extra text default 'x'");
			await db.exec('refresh materialized view v');

			// After: the backing is rebuilt to the 6-col re-planned body, so every value
			// is under the RIGHT label. (Pre-fix this returned the corrupted shape:
			// extra under "id:1", c.id under "name", c.name under a fabricated "col_5".)
			expect(await readObjectsSorted(db, 'select * from v')).to.deep.equal([
				'{"id":10,"customer_id":1,"amt":100,"extra":"x","id:1":1,"name":"alice"}',
			]);
		} finally {
			await db.close();
		}
	});

	it('a non-* join body that gains a source column rebuilds and stays correct', async () => {
		const db = new Database();
		try {
			await db.exec('create table customers (id integer primary key, name text not null)');
			await db.exec('create table orders (id integer primary key, customer_id integer not null '
				+ 'references customers(id), amt integer not null)');
			await db.exec('create materialized view v2 as select o.*, c.name '
				+ 'from orders o join customers c on o.customer_id = c.id');
			await db.exec("insert into customers values (1,'alice')");
			await db.exec('insert into orders values (10,1,100)');

			expect(await readObjectsSorted(db, 'select * from v2')).to.deep.equal([
				'{"id":10,"customer_id":1,"amt":100,"name":"alice"}',
			]);

			await db.exec("alter table orders add column extra text default 'x'");
			await db.exec('refresh materialized view v2');

			// `o.*` gained `extra`, which interleaves BEFORE `c.name`.
			expect(await readObjectsSorted(db, 'select * from v2')).to.deep.equal([
				'{"id":10,"customer_id":1,"amt":100,"extra":"x","name":"alice"}',
			]);
		} finally {
			await db.close();
		}
	});

	it('fast path: a refresh with no source change preserves the backing TableSchema identity', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (x integer primary key, y text)');
			await db.exec("insert into t values (1,'a'),(2,'b')");
			await db.exec('create materialized view mv as select x, y from t');

			const before = db.schemaManager.getTable('main', '_mv_mv');
			await db.exec('refresh materialized view mv');
			const after = db.schemaManager.getTable('main', '_mv_mv');

			// Same object ⇒ the conditional took the data-only fast path (no drop+recreate),
			// so cached prepared plans and the MV body-root cache stay warm.
			expect(after, 'fast-path keeps the same backing TableSchema object').to.equal(before);
			expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal([
				'{"x":1,"y":"a"}', '{"x":2,"y":"b"}',
			]);
		} finally {
			await db.close();
		}
	});

	it('an explicit-column MV whose body output count shifts errors at refresh (no silent reshape)', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (x integer primary key, y text)');
			await db.exec("insert into t values (1,'a')");
			await db.exec('create materialized view mv(a, b) as select * from t'); // 2 declared, body 2

			await db.exec('alter table t add column z integer null'); // body now 3 → marks mv stale
			expect(db.schemaManager.getMaterializedView('main', 'mv')!.stale).to.equal(true);

			let err: Error | undefined;
			try { await db.exec('refresh materialized view mv'); } catch (e) { err = e as Error; }
			expect(err, 'refresh errors on the explicit-column count shift').to.not.be.undefined;
			expect(err!.message).to.match(/declared with 2 columns but its body now produces 3/);

			// The MV stays stale (coherent) rather than silently widening the declared list.
			expect(db.schemaManager.getMaterializedView('main', 'mv')!.stale).to.equal(true);
		} finally {
			await db.close();
		}
	});

	it('row-time maintenance after a reshape propagates the new source column', async () => {
		const db = new Database();
		try {
			for (const stmt of JOIN_SCHEMA) await db.exec(stmt);
			await db.exec("alter table orders add column extra text default 'x'");
			await db.exec('refresh materialized view v');

			// A source insert AFTER the reshape must maintain the rebuilt 6-col backing,
			// including the new `extra` column.
			await db.exec("insert into orders values (20,1,200,'custom')");

			expect(await readObjectsSorted(db, 'select * from v')).to.deep.equal([
				'{"id":10,"customer_id":1,"amt":100,"extra":"x","id:1":1,"name":"alice"}',
				'{"id":20,"customer_id":1,"amt":200,"extra":"custom","id:1":1,"name":"alice"}',
			]);
		} finally {
			await db.close();
		}
	});
});
