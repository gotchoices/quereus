/**
 * `refresh materialized view` reconciles the maintained table's *shape*
 * (columns/types/PK/ordering) to the re-planned body when a source `alter` has
 * shifted it — **identity-preservingly**. An expressible delta (trailing column
 * adds, drops, positional renames, per-column attribute shifts, with the
 * surviving columns' relative order and the physical PK preserved) is applied
 * **in place** via the host module's `alterTable` plus a data reconcile, keeping
 * the same table incarnation: no `table_removed`/`table_added`, so a replicated
 * basis table's row metadata survives and a consumer MV is NOT incarnation-
 * cascaded (it goes stale via `table_modified` and recovers by its own refresh).
 *
 * An **inexpressible** delta — an interleaving column reorder (a `select *` body
 * whose new source column lands mid-output) or a physical-PK definition change —
 * is a **sited error**: the table and its rows are left untouched and the
 * derivation stays stale, recoverable by detach→alter→attach or drop+recreate.
 *
 * A refresh with no shape change keeps the data-only fast path (TableSchema
 * identity + warm caches preserved). The explicit-column count-shift error and
 * row-time maintenance against the reshaped table are covered too.
 *
 * See `mv-refresh-rebuilds-backing-schema` (the prior drop+recreate this replaces)
 * and `6.5-maintained-table-identity-preserving-reshape`.
 */

import { expect } from 'chai';
import { Database } from '../src/core/database.js';
import type { SchemaChangeEvent } from '../src/schema/change-events.js';

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

/** Captures schema-change events naming `objectName` (case-insensitive) for the
 *  duration of `body`, returning their types in fire order. Used to assert the
 *  in-place reshape fires `table_modified` and NOT `table_removed`/`table_added`. */
async function captureEventsFor(db: Database, objectName: string, body: () => Promise<void>): Promise<string[]> {
	const seen: string[] = [];
	const target = objectName.toLowerCase();
	const off = db.schemaManager.getChangeNotifier().addListener((e: SchemaChangeEvent) => {
		if (e.objectName.toLowerCase() === target) seen.push(e.type);
	});
	try {
		await body();
	} finally {
		off();
	}
	return seen;
}

/** customers (parent, PK id) ⋈ orders (child, NOT-NULL FK customer_id → id). The
 *  `select *` join body collides the two `id` columns, so the second surfaces as
 *  `id:1`. Adding a column to `orders` makes it land *between* the orders columns
 *  and the customers columns — the canonical interleaving (inexpressible) reshape. */
const JOIN_SCHEMA = [
	'create table customers (id integer primary key, name text not null)',
	'create table orders (id integer primary key, customer_id integer not null '
		+ 'references customers(id), amt integer not null)',
	'create materialized view v as select * from orders o join customers c on o.customer_id = c.id',
	"insert into customers values (1,'alice')",
	'insert into orders values (10,1,100)',
];

describe('materialized view refresh — identity-preserving reshape', () => {
	describe('expressible in place', () => {
		it('a trailing source-column add reaches a select* body and reshapes in place (no incarnation events)', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, a integer)');
				await db.exec('insert into t values (1, 10)');
				await db.exec('create materialized view mv as select * from t');

				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"a":10}']);

				await db.exec('alter table t add column b integer default 5');
				const events = await captureEventsFor(db, 'mv', async () => {
					await db.exec('refresh materialized view mv');
				});

				// The reshape reconciles in place: only table_modified (cached-plan +
				// consumer invalidation), never a drop+recreate's table_removed/table_added.
				expect(events, 'in-place reshape fires table_modified, not drop+recreate events')
					.to.not.include.members(['table_removed', 'table_added']);
				expect(events).to.include('table_modified');

				// The appended column lands trailing and the reconcile fills it.
				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"a":10,"b":5}']);
				expect(db.schemaManager.getTable('main', 'mv')!.columns.map(c => c.name))
					.to.deep.equal(['id', 'a', 'b']);
			} finally {
				await db.close();
			}
		});

		it('a NOT NULL trailing add reshapes in place (added nullable, tightened after the reconcile)', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, a integer)');
				await db.exec('insert into t values (1, 10)');
				await db.exec('create materialized view mv as select * from t');

				// A NOT NULL source add: the backing is non-empty, so the column is added
				// NULLABLE, the reconcile fills it, then NOT NULL is asserted post-reconcile.
				await db.exec('alter table t add column b integer not null default 0');
				await db.exec('refresh materialized view mv');

				const reshaped = db.schemaManager.getTable('main', 'mv')!;
				expect(reshaped.columns.map(c => c.name)).to.deep.equal(['id', 'a', 'b']);
				expect(reshaped.columns[2].notNull, 'added column is NOT NULL after the tighten').to.equal(true);
				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"a":10,"b":0}']);

				// The reshape converged: a second refresh sees no further shape change (fast path).
				const before = db.schemaManager.getTable('main', 'mv');
				await db.exec('refresh materialized view mv');
				expect(db.schemaManager.getTable('main', 'mv'), 'converged: no re-reshape loop').to.equal(before);
			} finally {
				await db.close();
			}
		});

		it('an output column dropped (source drop column) reshapes in place', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, a integer, b integer)');
				await db.exec('insert into t values (1, 10, 99)');
				await db.exec('create materialized view mv as select * from t');
				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"a":10,"b":99}']);

				await db.exec('alter table t drop column b');
				const events = await captureEventsFor(db, 'mv', async () => {
					await db.exec('refresh materialized view mv');
				});

				expect(events).to.not.include.members(['table_removed', 'table_added']);
				expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal(['{"id":1,"a":10}']);
				expect(db.schemaManager.getTable('main', 'mv')!.columns.map(c => c.name)).to.deep.equal(['id', 'a']);
			} finally {
				await db.close();
			}
		});

		it('a non-PK attribute shift (source set collate) reshapes in place', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, name text)');
				await db.exec("insert into t values (1, 'Bob')");
				await db.exec('create materialized view mv as select id, name from t');
				expect(db.schemaManager.getTable('main', 'mv')!.columns[1].collation).to.equal('BINARY');

				await db.exec('alter table t alter column name set collate nocase');
				const events = await captureEventsFor(db, 'mv', async () => {
					await db.exec('refresh materialized view mv');
				});

				expect(events).to.not.include.members(['table_removed', 'table_added']);
				// The non-key collation follows the source through the passthrough projection.
				expect(db.schemaManager.getTable('main', 'mv')!.columns[1].collation).to.equal('NOCASE');
				expect(await readObjectsSorted(db, 'select id, name from mv')).to.deep.equal(['{"id":1,"name":"Bob"}']);
			} finally {
				await db.close();
			}
		});

		it('row-time maintenance after an in-place reshape maintains the reshaped backing', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (id integer primary key, a integer)');
				await db.exec('insert into t values (1, 10)');
				await db.exec('create materialized view mv as select * from t');

				await db.exec('alter table t add column b integer default 5');
				await db.exec('refresh materialized view mv');

				// A source insert AFTER the reshape must maintain the reshaped 3-col backing,
				// including the new `b` column (maintenance re-registered against the new shape).
				await db.exec('insert into t values (2, 20, 7)');

				expect(await readObjectsSorted(db, 'select * from mv'))
					.to.deep.equal(['{"id":1,"a":10,"b":5}', '{"id":2,"a":20,"b":7}']);
				// read(MV) == evaluate(body): the maintained table matches a fresh body eval.
				expect(await readObjectsSorted(db, 'select * from mv'))
					.to.deep.equal(await readObjectsSorted(db, 'select * from t'));
			} finally {
				await db.close();
			}
		});
	});

	describe('inexpressible → sited error', () => {
		it('an interleaving select* reorder errors at refresh; the table and rows are untouched', async () => {
			const db = new Database();
			try {
				for (const stmt of JOIN_SCHEMA) await db.exec(stmt);

				const before = ['{"id":10,"customer_id":1,"amt":100,"id:1":1,"name":"alice"}'];
				expect(await readObjectsSorted(db, 'select * from v')).to.deep.equal(before);

				// Adding `extra` to orders interleaves it BEFORE the customers columns — an
				// append-only reshape cannot place it, so refresh errors.
				await db.exec("alter table orders add column extra text default 'x'");

				let err: Error | undefined;
				const events = await captureEventsFor(db, 'v', async () => {
					try { await db.exec('refresh materialized view v'); } catch (e) { err = e as Error; }
				});
				expect(err, 'refresh errors on the interleaving reshape').to.not.be.undefined;
				expect(err!.message).to.match(/changed incompatibly|interleaving|lands mid-table/);

				// The table is untouched: no reshape event, still 5 columns, MV still stale,
				// and the stored snapshot still reads correctly.
				expect(events).to.not.include.members(['table_removed', 'table_added', 'table_modified']);
				expect(db.schemaManager.getTable('main', 'v')!.columns.length, 'shape untouched').to.equal(5);
				expect(db.schemaManager.getMaintainedTable('main', 'v')!.derivation.stale).to.equal(true);
				expect(await readObjectsSorted(db, 'select * from v')).to.deep.equal(before);
			} finally {
				await db.close();
			}
		});

		it('a physical-PK collation change errors at refresh (re-keying the row identity is not in-place)', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (name text primary key, v integer)');
				await db.exec("insert into t values ('bob', 1)");
				await db.exec('create materialized view mv as select name, v from t');
				expect(db.schemaManager.getTable('main', 'mv')!.primaryKeyDefinition.length).to.equal(1);

				// Collating the source PK column re-keys the MV's *physical row identity* —
				// the one reshape we refuse to apply silently.
				await db.exec('alter table t alter column name set collate nocase');

				let err: Error | undefined;
				try { await db.exec('refresh materialized view mv'); } catch (e) { err = e as Error; }
				expect(err, 'refresh errors on the PK-definition change').to.not.be.undefined;
				expect(err!.message).to.match(/changed incompatibly|primary-key/);
				expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);
			} finally {
				await db.close();
			}
		});

		it('an explicit-column MV whose body output count shifts errors at refresh (declared interface)', async () => {
			const db = new Database();
			try {
				await db.exec('create table t (x integer primary key, y text)');
				await db.exec("insert into t values (1,'a')");
				await db.exec('create materialized view mv(a, b) as select * from t'); // 2 declared, body 2

				await db.exec('alter table t add column z integer null'); // body now 3 → marks mv stale
				expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);

				let err: Error | undefined;
				try { await db.exec('refresh materialized view mv'); } catch (e) { err = e as Error; }
				expect(err, 'refresh errors on the explicit-column count shift').to.not.be.undefined;
				expect(err!.message).to.match(/declared with 2 columns but its body now produces 3/);

				// The MV stays stale (coherent) rather than silently widening the declared list.
				expect(db.schemaManager.getMaintainedTable('main', 'mv')!.derivation.stale).to.equal(true);
			} finally {
				await db.close();
			}
		});
	});

	it('fast path: a refresh with no source change preserves the MV TableSchema identity', async () => {
		const db = new Database();
		try {
			await db.exec('create table t (x integer primary key, y text)');
			await db.exec("insert into t values (1,'a'),(2,'b')");
			await db.exec('create materialized view mv as select x, y from t');

			const before = db.schemaManager.getTable('main', 'mv');
			await db.exec('refresh materialized view mv');
			const after = db.schemaManager.getTable('main', 'mv');

			// Same object ⇒ the conditional took the data-only fast path (no reshape),
			// so cached prepared plans and the MV body-root cache stay warm.
			expect(after, 'fast-path keeps the same TableSchema object').to.equal(before);
			expect(await readObjectsSorted(db, 'select * from mv')).to.deep.equal([
				'{"x":1,"y":"a"}', '{"x":2,"y":"b"}',
			]);
		} finally {
			await db.close();
		}
	});

	it('a producer in-place reshape cascades staleness to a consumer via table_modified (no incarnation cascade)', async () => {
		// MV-over-MV: the producer `p` reshapes IN PLACE (trailing add), firing
		// table_modified — NOT table_removed/table_added — on `p`. The manager's
		// source-tracking listener (the consumer's sourceTables include `main.p`)
		// marks the consumer stale and detaches its row-time plan. Refreshing the
		// consumer re-derives its shape over the now-3-col producer and reshapes in
		// place too. The consumer recovers by refresh exactly as docs describe for
		// any source alter — it is not torn down and rebuilt.
		const db = new Database();
		try {
			await db.exec('create table t (id integer primary key, a integer not null)');
			await db.exec('insert into t values (1,10)');
			await db.exec('create materialized view p as select * from t');
			await db.exec('create materialized view c as select * from p');

			expect(await readObjectsSorted(db, 'select * from c')).to.deep.equal(['{"id":1,"a":10}']);

			await db.exec('alter table t add column b integer default 5');
			const events = await captureEventsFor(db, 'p', async () => {
				await db.exec('refresh materialized view p'); // reshapes the table `p` in place
			});

			// In-place: only table_modified on `p`, never a drop+recreate.
			expect(events).to.not.include.members(['table_removed', 'table_added']);
			expect(events).to.include('table_modified');
			// The producer's table_modified cascaded staleness to the consumer.
			expect(db.schemaManager.getMaintainedTable('main', 'c')!.derivation.stale, 'consumer marked stale by cascade').to.equal(true);

			// Refreshing the consumer realigns it to the reshaped producer (gains `b`).
			await db.exec('refresh materialized view c');
			expect(db.schemaManager.getMaintainedTable('main', 'c')!.derivation.stale).to.not.equal(true);
			expect(await readObjectsSorted(db, 'select * from c')).to.deep.equal(['{"id":1,"a":10,"b":5}']);
		} finally {
			await db.close();
		}
	});
});
