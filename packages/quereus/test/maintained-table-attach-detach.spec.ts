import { expect } from 'chai';
import { Database } from '../src/index.js';
import type { BackingRowChange } from '../src/index.js';
import { isMaintainedTable } from '../src/schema/derivation.js';
import type { MaintainedTableSchema } from '../src/schema/derivation.js';
import { generateMaintainedTableDDL } from '../src/schema/ddl-generator.js';
import type { SchemaChangeEvent } from '../src/schema/change-events.js';

/**
 * Attach/detach verb pins that sqllogic cannot express — the diff-fidelity and
 * event contracts of `alter table … set maintained as` / `… drop maintained`
 * (ticket maintained-table-attach-detach-verbs):
 *
 *  - verify-by-diff reports ONLY the genuine changes: an attach over identical
 *    derivable content dispatches NOTHING to consumers; a divergent attach
 *    dispatches exactly the minimal keyed diff (one insert, one update, one
 *    delete — one case each);
 *  - the lifecycle events: one `materialized_view_added` on fresh attach, one
 *    `materialized_view_modified` on re-attach, one `materialized_view_removed`
 *    (and deliberately NO `table_modified`/`table_removed`) on detach —
 *    consumers reading the detached table stay live;
 *  - cached statement plans flip with the catalog: a prepared direct write
 *    becomes write-through after attach, and a prepared write-through becomes a
 *    direct write after detach;
 *  - the canonical table-form DDL of an attach-created derivation round-trips
 *    through `importCatalog` to the same record (`bodyHash` fixed point), as
 *    does the MV-sugar-with-renames form.
 */
describe('Maintained-table attach/detach verbs', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function readAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push({ ...row });
		return rows;
	}

	function maintained(name: string): MaintainedTableSchema {
		const t = db.schemaManager.getTable('main', name);
		if (!t || !isMaintainedTable(t)) throw new Error(`expected '${name}' to be a maintained table`);
		return t;
	}

	/** Capture every change the attach cascade dispatches while `fn` runs. */
	async function captureDispatch(fn: () => Promise<void>): Promise<BackingRowChange[]> {
		const dispatched: BackingRowChange[] = [];
		const orig = db._maintainRowTimeCoveringStructures.bind(db);
		db._maintainRowTimeCoveringStructures = async (base, change, cache, deferred) => {
			dispatched.push(change);
			return orig(base, change, cache, deferred);
		};
		try {
			await fn();
		} finally {
			db._maintainRowTimeCoveringStructures = orig;
		}
		return dispatched;
	}

	describe('verify-by-diff fidelity', () => {
		beforeEach(async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				insert into src values (1, 'a'), (2, 'b'), (3, 'c');
				create table tgt (id integer primary key, v text);
			`);
		});

		it('attach over IDENTICAL content writes nothing and dispatches nothing', async () => {
			await db.exec(`insert into tgt values (1, 'a'), (2, 'b'), (3, 'c')`);
			const dispatched = await captureDispatch(async () => {
				await db.exec(`alter table tgt set maintained as select id, v from src`);
			});
			expect(dispatched, 'identical derivable content ⇒ zero reported changes').to.deep.equal([]);
			expect(await readAll('select * from tgt order by id')).to.deep.equal([
				{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' },
			]);
		});

		it('attach over DIVERGENT content dispatches exactly the minimal keyed diff (derived wins)', async () => {
			// 1 identical (skip), 2 lagged (update), 3 missing (insert), 4 extra (delete)
			await db.exec(`insert into tgt values (1, 'a'), (2, 'LAGGED'), (4, 'EXTRA')`);
			const dispatched = await captureDispatch(async () => {
				await db.exec(`alter table tgt set maintained as select id, v from src`);
			});
			const byOp = (op: BackingRowChange['op']) => dispatched.filter(c => c.op === op);
			expect(dispatched.length, 'only the three genuine changes report').to.equal(3);
			expect(byOp('update').map(c => c.newRow)).to.deep.equal([[2, 'b']]);
			expect(byOp('insert').map(c => c.newRow)).to.deep.equal([[3, 'c']]);
			expect(byOp('delete').map(c => c.oldRow)).to.deep.equal([[4, 'EXTRA']]);
			expect(await readAll('select * from tgt order by id')).to.deep.equal([
				{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' },
			]);
		});

		it('a consumer maintained table over the attach target sees no dispatch on an identical attach', async () => {
			await db.exec(`
				insert into tgt values (1, 'a'), (2, 'b'), (3, 'c');
				create materialized view consumer as select id, v from tgt;
			`);
			await db.exec(`alter table tgt set maintained as select id, v from src`);
			const consumer = maintained('consumer');
			expect(consumer.derivation.stale, 'consumer stays live across the attach').to.equal(false);
			expect(await readAll('select * from consumer order by id')).to.deep.equal([
				{ id: 1, v: 'a' }, { id: 2, v: 'b' }, { id: 3, v: 'c' },
			]);
		});
	});

	describe('lifecycle events', () => {
		let events: string[];
		let unsubscribe: () => void;

		beforeEach(async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				insert into src values (1, 'a');
				create table tgt (id integer primary key, v text);
			`);
			events = [];
			unsubscribe = db.schemaManager.getChangeNotifier().addListener((e: SchemaChangeEvent) => {
				events.push(`${e.type}:${'objectName' in e ? e.objectName : ''}`);
			});
		});
		afterEach(() => unsubscribe());

		it('fresh attach fires exactly one materialized_view_added', async () => {
			await db.exec(`alter table tgt set maintained as select id, v from src`);
			expect(events.filter(e => e.startsWith('materialized_view_'))).to.deep.equal(['materialized_view_added:tgt']);
		});

		it('re-attach fires exactly one materialized_view_modified', async () => {
			await db.exec(`alter table tgt set maintained as select id, v from src`);
			events.length = 0;
			await db.exec(`alter table tgt set maintained as select id, v from src where id > 0`);
			expect(events.filter(e => e.startsWith('materialized_view_'))).to.deep.equal(['materialized_view_modified:tgt']);
		});

		it('detach fires exactly one materialized_view_removed and NO table event (consumers stay live)', async () => {
			await db.exec(`alter table tgt set maintained as select id, v from src`);
			await db.exec(`create materialized view consumer as select id, v from tgt`);
			events.length = 0;
			await db.exec(`alter table tgt drop maintained`);
			expect(events).to.deep.equal(['materialized_view_removed:tgt']);
			// The consumer is unaffected by the detach and keeps maintaining off
			// subsequent USER writes to the (now plain) table.
			expect(maintained('consumer').derivation.stale).to.equal(false);
			await db.exec(`insert into tgt values (9, 'z')`);
			expect(await readAll(`select v from consumer where id = 9`)).to.deep.equal([{ v: 'z' }]);
		});
	});

	describe('cycle diagnostic', () => {
		it('names the cycle path in data-flow order, closed on the target', async () => {
			await db.exec(`
				create table a1 (id integer primary key, v text not null);
				insert into a1 values (1, 'a');
				create table b1 (id integer primary key, v text not null);
				alter table b1 set maintained as select id, v from a1;
			`);
			try {
				await db.exec(`alter table a1 set maintained as select id, v from b1`);
				expect.fail('expected a derivation-cycle error');
			} catch (e) {
				expect((e as Error).message).to.contain('main.a1 → main.b1 → main.a1');
			}
		});
	});

	describe('cached statement plans flip with the catalog', () => {
		beforeEach(async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				create table tgt (id integer primary key, v text);
			`);
		});

		it('a prepared direct write becomes write-through after attach', async () => {
			const stmt = db.prepare(`insert into tgt values (:id, :v)`);
			try {
				await stmt.run({ id: 1, v: 'direct' });
				expect(await readAll('select count(*) as n from src')).to.deep.equal([{ n: 0 }]);

				await db.exec(`delete from tgt; insert into src values (1, 'a')`);
				await db.exec(`alter table tgt set maintained as select id, v from src`);

				// The cached plan recompiles against the maintained record: the write
				// routes through to the source instead of hitting the table directly.
				await stmt.run({ id: 2, v: 'through' });
				expect(await readAll(`select v from src where id = 2`)).to.deep.equal([{ v: 'through' }]);
				expect(await readAll(`select v from tgt where id = 2`)).to.deep.equal([{ v: 'through' }]);
			} finally {
				await stmt.finalize();
			}
		});

		it('a prepared write-through becomes a direct write after detach', async () => {
			await db.exec(`insert into src values (1, 'a')`);
			await db.exec(`alter table tgt set maintained as select id, v from src`);
			const stmt = db.prepare(`insert into tgt values (:id, :v)`);
			try {
				await stmt.run({ id: 2, v: 'through' });
				expect(await readAll(`select v from src where id = 2`)).to.deep.equal([{ v: 'through' }]);

				await db.exec(`alter table tgt drop maintained`);

				await stmt.run({ id: 3, v: 'direct' });
				expect(await readAll(`select count(*) as n from src where id = 3`)).to.deep.equal([{ n: 0 }]);
				expect(await readAll(`select v from tgt where id = 3`)).to.deep.equal([{ v: 'direct' }]);
			} finally {
				await stmt.finalize();
			}
		});
	});

	describe('canonical table-form DDL round-trip', () => {
		it('an attach-created derivation round-trips through importCatalog (bodyHash fixed point)', async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				insert into src values (1, 'a'), (2, 'b');
				create table tgt (id integer primary key, v text);
				alter table tgt set maintained as select id, v from src;
			`);
			const exported = generateMaintainedTableDDL(maintained('tgt'));
			// Attach now records the IMPLICIT form (the verb's strict name check guarantees
			// the body's natural names already equal the table columns), so the canonical
			// table form omits the rename list — the bare `maintained as`, matching create-sugar.
			expect(exported, 'canonical form is the implicit table form').to.match(/create table .* maintained as /i);
			expect(exported, 'no explicit rename list on the implicit form').to.not.match(/maintained \(/i);
			const originalHash = maintained('tgt').derivation.bodyHash;

			const db2 = new Database();
			try {
				await db2.exec(`
					create table src (id integer primary key, v text);
					insert into src values (1, 'a'), (2, 'b');
				`);
				const imported = await db2.schemaManager.importCatalog([exported]);
				expect(imported.materializedViews).to.deep.equal(['main.tgt']);
				const t2 = db2.schemaManager.getTable('main', 'tgt');
				if (!t2 || !isMaintainedTable(t2)) throw new Error('imported tgt must be maintained');
				expect(t2.derivation.bodyHash, 'attach → persist → import is a fixed point').to.equal(originalHash);
				expect(generateMaintainedTableDDL(t2), 'export after import is byte-identical').to.equal(exported);

				// Maintenance is live in the importing session.
				await db2.exec(`insert into src values (3, 'c')`);
				const rows: unknown[] = [];
				for await (const row of db2.eval('select v from tgt where id = 3')) rows.push(row.v);
				expect(rows).to.deep.equal(['c']);
			} finally {
				await db2.close();
			}
		});

		it('MV sugar with an explicit column list (renames) round-trips through the table form', async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				insert into src values (1, 'a');
				create materialized view mv (key_id, val) as select id, v from src;
			`);
			const exported = generateMaintainedTableDDL(maintained('mv'));
			// Renamed columns became the table's declared column names; the body
			// keeps its original output names. The explicit rename also rides the
			// `maintained (…)` clause — the lossless signal that re-import must
			// arity-lock (vs an implicit body, which omits the clause and reshapes).
			expect(exported).to.match(/"key_id"/);
			expect(exported).to.match(/"val"/);
			expect(exported).to.match(/maintained \(key_id, val\) as select id, v from src/i);

			const db2 = new Database();
			try {
				await db2.exec(`
					create table src (id integer primary key, v text);
					insert into src values (1, 'a');
				`);
				await db2.schemaManager.importCatalog([exported]);
				const t2 = db2.schemaManager.getTable('main', 'mv');
				if (!t2 || !isMaintainedTable(t2)) throw new Error('imported mv must be maintained');
				expect(t2.columns.map(c => c.name)).to.deep.equal(['key_id', 'val']);
				expect(generateMaintainedTableDDL(t2), 'export after import is byte-identical').to.equal(exported);
			} finally {
				await db2.close();
			}
		});
	});

	/**
	 * Live-exec channel of `create table … maintained [(columns)] as` honors the
	 * rename-list clause (ticket mv-table-form-implicit-columns-roundtrip): the
	 * clause is the single source of truth for `derivation.columns` on every
	 * consumption channel, so live exec and catalog import of the same canonical
	 * DDL agree on the record AND the bodyHash.
	 *   - no list ⇒ implicit (columns === undefined, clause-free DDL, reshapes on reopen);
	 *   - list present ⇒ explicit (positional rename of the body, declared names recorded);
	 *   - a wrong-arity / mismatched-name / empty list is a sited error (no silent drop).
	 */
	describe('live-exec table-form authored columns', () => {
		beforeEach(async () => {
			await db.exec(`
				create table src (id integer primary key, v text);
				insert into src values (1, 'a'), (2, 'b');
			`);
		});

		/** Narrow a maintained table out of an arbitrary database. */
		function maintainedIn(target: Database, name: string): MaintainedTableSchema {
			const t = target.schemaManager.getTable('main', name);
			if (!t || !isMaintainedTable(t)) throw new Error(`expected '${name}' to be a maintained table`);
			return t;
		}

		it('implicit table form (no rename list) records columns === undefined and a clause-free body', async () => {
			await db.exec(`create table t (id integer primary key, v text) maintained as select * from src`);
			const mv = maintained('t');
			expect(mv.derivation.columns, 'implicit ⇒ no recorded rename list').to.be.undefined;
			const exported = generateMaintainedTableDDL(mv);
			expect(exported, 'canonical DDL keeps the bare `maintained as`').to.match(/maintained as /i);
			expect(exported, 'and emits no rename list').to.not.match(/maintained \(/i);
		});

		it('live exec and importCatalog of the same implicit DDL agree on derivation.columns AND bodyHash', async () => {
			await db.exec(`create table t (id integer primary key, v text) maintained as select * from src`);
			const liveHash = maintained('t').derivation.bodyHash;
			const exported = generateMaintainedTableDDL(maintained('t'));

			const db2 = new Database();
			try {
				await db2.exec(`
					create table src (id integer primary key, v text);
					insert into src values (1, 'a'), (2, 'b');
				`);
				await db2.schemaManager.importCatalog([exported]);
				const t2 = maintainedIn(db2, 't');
				expect(t2.derivation.columns, 'import records implicit too').to.be.undefined;
				expect(t2.derivation.bodyHash, 'live exec and import agree on bodyHash').to.equal(liveHash);
				expect(generateMaintainedTableDDL(t2), 'export after import is byte-identical').to.equal(exported);
			} finally {
				await db2.close();
			}
		});

		it('canonical renamed-MV DDL replays live with byte-identical regeneration (gap 2)', async () => {
			// Exactly the text generateMaintainedTableDDL emits for the MV sugar
			// `create materialized view mv (key_id, val) as select id, v from src`.
			await db.exec(`create materialized view mv (key_id, val) as select id, v from src`);
			const canonical = generateMaintainedTableDDL(maintained('mv'));
			expect(canonical, 'sugar exports the table form with the rename list')
				.to.match(/maintained \(key_id, val\) as select id, v from src/i);

			const db2 = new Database();
			try {
				await db2.exec(`
					create table src (id integer primary key, v text);
					insert into src values (1, 'a'), (2, 'b');
				`);
				// Replay the canonical table-form DDL through LIVE exec (a migration
				// script) — the channel gap 2 reported as broken (pre-fix this errored
				// "body output column 1 is named 'id' but the table declares 'key_id'").
				await db2.exec(canonical);
				const t2 = maintainedIn(db2, 'mv');
				expect(t2.columns.map(c => c.name)).to.deep.equal(['key_id', 'val']);
				expect(t2.derivation.columns, 'recorded explicit (declared casing)').to.deep.equal(['key_id', 'val']);
				expect(generateMaintainedTableDDL(t2), 'regeneration is byte-identical').to.equal(canonical);
				// Maintenance is live in the replaying session.
				await db2.exec(`insert into src values (3, 'c')`);
				expect(await readAllIn(db2, `select key_id, val from mv where key_id = 3`))
					.to.deep.equal([{ key_id: 3, val: 'c' }]);
			} finally {
				await db2.close();
			}
		});

		it('a mismatched rename list is a sited error — no silent drop (gap 3)', async () => {
			let message = '';
			try {
				await db.exec(`create table t4 (id integer primary key, v text) maintained (x, y) as select id, v from src`);
			} catch (e) { message = (e as Error).message; }
			expect(message).to.match(/maintained column 1 is named 'x' but the table declares 'id'/i);
			expect(db.schemaManager.getTable('main', 't4'), 'nothing registered').to.be.undefined;
		});

		it('a wrong-arity rename list is a sited error', async () => {
			let message = '';
			try {
				await db.exec(`create table t5 (id integer primary key, v text) maintained (id) as select id, v from src`);
			} catch (e) { message = (e as Error).message; }
			expect(message).to.match(/maintained column list has 1 columns but the table declares 2/i);
			expect(db.schemaManager.getTable('main', 't5')).to.be.undefined;
		});

		it('an empty rename list is rejected at parse time', async () => {
			let message = '';
			try {
				await db.exec(`create table t6 (id integer primary key, v text) maintained () as select id, v from src`);
			} catch (e) { message = (e as Error).message; }
			expect(message).to.match(/at least one column name in the maintained column list/i);
			expect(db.schemaManager.getTable('main', 't6')).to.be.undefined;
		});

		it('a rename list in different casing is accepted, recorded in declared casing', async () => {
			await db.exec(`create table t7 ("id" integer primary key, "v" text) maintained (ID, V) as select id, v from src`);
			expect(maintained('t7').derivation.columns, 'recorded in declared casing').to.deep.equal(['id', 'v']);
		});

		it('a present list whose body names already equal the declared shape still arity-locks (recorded explicit)', async () => {
			await db.exec(`create table t8 (id integer primary key, v text) maintained (id, v) as select id, v from src`);
			expect(maintained('t8').derivation.columns, 'presence is the contract, not need').to.deep.equal(['id', 'v']);
		});
	});

	/**
	 * Reshape-on-attach (ticket maintained-reattach-implicit-reshape): over the
	 * IMPLICIT form — the verb call has no rename list AND the prior record is
	 * implicit (a plain table or `derivation.columns === undefined`) — a body
	 * whose derived shape differs from the live table reshapes the backing in
	 * place to follow the body (classifyBackingReshape, the refresh reshape's
	 * classifier) instead of erroring at the strict shape check. The reconcile
	 * stays verify-by-diff: only the GENUINE per-row value changes dispatch — a
	 * schema-only relabel reports nothing. Inexpressible deltas (interleave /
	 * physical-PK change) keep the sited error with the table untouched, and an
	 * explicit-recorded table never reshapes.
	 */
	describe('reshape-on-attach (implicit form)', () => {
		beforeEach(async () => {
			await db.exec(`
				create table src (id integer primary key, x text not null, y text not null);
				insert into src values (1, 'a', 'a'), (2, 'b', 'B'), (3, 'c', 'C');
			`);
		});

		it('an output-column rename reshapes the backing and dispatches only the genuine value diffs', async () => {
			await db.exec(`create materialized view m as select id, x from src`);
			const dispatched = await captureDispatch(async () => {
				await db.exec(`alter table m set maintained as select id, y from src`);
			});
			// The rename op relabels column 2 (x→y) carrying the OLD values; the
			// replace-all diff then updates only the rows whose value actually
			// changed — row 1 has x == y, so it must NOT report (no relabel churn).
			expect(dispatched.map(c => [c.op, ...(c.newRow ?? [])])).to.deep.equal([
				['update', 2, 'B'], ['update', 3, 'C'],
			]);
			const mv = maintained('m');
			expect(mv.columns.map(c => c.name)).to.deep.equal(['id', 'y']);
			expect(mv.derivation.columns, 'still recorded implicit').to.be.undefined;
			expect(mv.derivation.stale).to.equal(false);
			expect(await readAll('select id, y from m order by id')).to.deep.equal([
				{ id: 1, y: 'a' }, { id: 2, y: 'B' }, { id: 3, y: 'C' },
			]);
			// Row-time maintenance re-bound to the reshaped backing.
			await db.exec(`insert into src values (4, 'd', 'D')`);
			expect(await readAll(`select y from m where id = 4`)).to.deep.equal([{ y: 'D' }]);
		});

		it('a pure relabel (same values under a new output name) reshapes the schema with ZERO dispatched changes', async () => {
			await db.exec(`create materialized view m2 as select id, x from src`);
			const dispatched = await captureDispatch(async () => {
				await db.exec(`alter table m2 set maintained as select id, x as renamed from src`);
			});
			expect(dispatched, 'schema-only relabel ⇒ no row changes').to.deep.equal([]);
			expect(maintained('m2').columns.map(c => c.name)).to.deep.equal(['id', 'renamed']);
			expect(await readAll('select renamed from m2 order by id')).to.deep.equal([
				{ renamed: 'a' }, { renamed: 'b' }, { renamed: 'c' },
			]);
		});

		it('a trailing column add (NOT NULL) reshapes and asserts the constraint against the RECONCILED rows', async () => {
			await db.exec(`create materialized view m3 as select id, x from src`);
			const dispatched = await captureDispatch(async () => {
				await db.exec(`alter table m3 set maintained as select id, x, y from src`);
			});
			// The column adds NULLABLE (committed rows hold NULL there until the
			// reconcile commits), so the deferred NOT NULL tighten must validate the
			// reconciled body rows — every row gains a y value, one update each.
			expect(dispatched.map(c => c.op)).to.deep.equal(['update', 'update', 'update']);
			const mv = maintained('m3');
			expect(mv.columns.map(c => c.name)).to.deep.equal(['id', 'x', 'y']);
			expect(mv.columns[2].notNull, 'NOT NULL tightened post-reconcile').to.equal(true);
			expect(await readAll('select * from m3 order by id')).to.deep.equal([
				{ id: 1, x: 'a', y: 'a' }, { id: 2, x: 'b', y: 'B' }, { id: 3, x: 'c', y: 'C' },
			]);
		});

		it('a trailing column drop reshapes with ZERO dispatched changes when the surviving values are unchanged', async () => {
			await db.exec(`create materialized view m4 as select id, x, y from src`);
			const dispatched = await captureDispatch(async () => {
				await db.exec(`alter table m4 set maintained as select id, x from src`);
			});
			expect(dispatched, 'drop is schema-only; survivors identical ⇒ no row changes').to.deep.equal([]);
			expect(maintained('m4').columns.map(c => c.name)).to.deep.equal(['id', 'x']);
			expect(await readAll('select * from m4 order by id')).to.deep.equal([
				{ id: 1, x: 'a' }, { id: 2, x: 'b' }, { id: 3, x: 'c' },
			]);
		});

		it('a NOT NULL tighten over divergent rows validates the reconciled body, not the stale backing', async () => {
			// The backing holds a NULL the new body resolves; the tighten runs
			// post-reconcile (and post-commit), so it sees the reconciled rows —
			// validating the stale backing would spuriously throw CONSTRAINT.
			await db.exec(`
				create table nsrc (id integer primary key, x text null, y text not null);
				insert into nsrc values (1, null, 'a'), (2, 'b', 'b');
				create materialized view m5 as select id, x from nsrc;
			`);
			const dispatched = await captureDispatch(async () => {
				await db.exec(`alter table m5 set maintained as select id, y as x from nsrc`);
			});
			// Row 2's value is unchanged ('b' → 'b'): only row 1's NULL→'a' reports.
			expect(dispatched.map(c => [c.op, ...(c.newRow ?? [])])).to.deep.equal([['update', 1, 'a']]);
			const mv = maintained('m5');
			expect(mv.columns[1].notNull, 'tightened against the reconciled rows').to.equal(true);
			expect(await readAll('select x from m5 order by id')).to.deep.equal([{ x: 'a' }, { x: 'b' }]);
		});

		it('an interleaving (mid-table) column is an inexpressible reshape — sited error, table untouched', async () => {
			await db.exec(`create materialized view m6 as select id, x from src`);
			const before = maintained('m6');
			const beforeHash = before.derivation.bodyHash;
			let message = '';
			try {
				await db.exec(`alter table m6 set maintained as select id, y, x from src`);
			} catch (e) { message = (e as Error).message; }
			expect(message).to.match(/changed incompatibly/i);
			expect(message).to.match(/lands mid-table/i);
			const after = maintained('m6');
			expect(after.columns.map(c => c.name), 'columns untouched').to.deep.equal(['id', 'x']);
			expect(after.derivation.bodyHash, 'prior derivation restored').to.equal(beforeHash);
			expect(after.derivation.stale).to.equal(false);
			// Maintenance still live on the prior body.
			await db.exec(`insert into src values (5, 'e', 'E')`);
			expect(await readAll(`select x from m6 where id = 5`)).to.deep.equal([{ x: 'e' }]);
		});

		it('a physical-PK definition change is an inexpressible reshape — sited error, table untouched', async () => {
			await db.exec(`create materialized view m7 as select id, x from src`);
			const beforeHash = maintained('m7').derivation.bodyHash;
			let message = '';
			try {
				// A body `order by` seeds the derived physical PK (ordering column
				// leads), changing the key definition — refused, never silently re-keyed.
				await db.exec(`alter table m7 set maintained as select id, x from src order by x`);
			} catch (e) { message = (e as Error).message; }
			expect(message).to.match(/changed incompatibly/i);
			expect(message).to.match(/primary-key/i);
			expect(maintained('m7').derivation.bodyHash, 'prior derivation restored').to.equal(beforeHash);
			expect(await readAll('select * from m7 order by id')).to.deep.equal([
				{ id: 1, x: 'a' }, { id: 2, x: 'b' }, { id: 3, x: 'c' },
			]);
		});

		it('a fresh attach over a PLAIN table whose columns differ reshapes to follow the body (rows discarded by the reconcile)', async () => {
			await db.exec(`
				create table pl (id integer primary key, a text);
				insert into pl values (1, 'junk'), (9, 'stale');
			`);
			const events: string[] = [];
			const unsubscribe = db.schemaManager.getChangeNotifier().addListener((e: SchemaChangeEvent) => {
				events.push(`${e.type}:${'objectName' in e ? e.objectName : ''}`);
			});
			try {
				await db.exec(`alter table pl set maintained as select id, x from src`);
			} finally {
				unsubscribe();
			}
			const mv = maintained('pl');
			expect(mv.columns.map(c => c.name), 'backing follows the body (a → x)').to.deep.equal(['id', 'x']);
			expect(await readAll('select * from pl order by id')).to.deep.equal([
				{ id: 1, x: 'a' }, { id: 2, x: 'b' }, { id: 3, x: 'c' },
			]);
			// Fresh attach: one materialized_view_added; the shape change fires one
			// table_modified (consumer invalidation) — never table_removed/added.
			expect(events.filter(e => e.startsWith('materialized_view_'))).to.deep.equal(['materialized_view_added:pl']);
			expect(events.filter(e => e === 'table_modified:pl').length).to.equal(1);
			expect(events.some(e => e.startsWith('table_removed') || e.startsWith('table_added')), 'same incarnation').to.equal(false);
		});

		it('a consumer maintained table over the reshaped table goes stale and re-derives the renamed column on refresh', async () => {
			await db.exec(`
				create materialized view base9 as select id, x from src;
				create materialized view consumer9 as select * from base9;
			`);
			const events: string[] = [];
			const unsubscribe = db.schemaManager.getChangeNotifier().addListener((e: SchemaChangeEvent) => {
				events.push(`${e.type}:${'objectName' in e ? e.objectName : ''}`);
			});
			try {
				await db.exec(`alter table base9 set maintained as select id, y from src`);
			} finally {
				unsubscribe();
			}
			// The reshape fires ONE table_modified for the reshaped table (the
			// modified-event channel has no maintenance listener, so this is what
			// invalidates consumers) plus the ordinary materialized_view_modified.
			expect(events.filter(e => e === 'table_modified:base9').length).to.equal(1);
			expect(events.filter(e => e.startsWith('materialized_view_'))).to.deep.equal(['materialized_view_modified:base9']);
			expect(maintained('consumer9').derivation.stale, 'consumer invalidated by the shape change').to.equal(true);
			// The consumer's own refresh re-derives `select *` against the reshaped
			// producer and reshapes ITS backing to the renamed column.
			await db.exec(`refresh materialized view consumer9`);
			expect(maintained('consumer9').columns.map(c => c.name)).to.deep.equal(['id', 'y']);
			expect(await readAll('select id, y from consumer9 order by id')).to.deep.equal([
				{ id: 1, y: 'a' }, { id: 2, y: 'B' }, { id: 3, y: 'C' },
			]);
		});

		it('an EXPLICIT-recorded maintained table never reshapes — the strict shape error stands', async () => {
			await db.exec(`create table ex (a integer primary key, b text not null) maintained (a, b) as select id, x from src`);
			let message = '';
			try {
				await db.exec(`alter table ex set maintained as select id, y from src`);
			} catch (e) { message = (e as Error).message; }
			expect(message, 'authored rename list is the arity-locked interface').to.match(/body output column 1 is named 'id' but the table declares 'a'/i);
			const after = maintained('ex');
			expect(after.columns.map(c => c.name), 'columns untouched').to.deep.equal(['a', 'b']);
			expect(after.derivation.columns, 'still recorded explicit').to.deep.equal(['a', 'b']);
		});
	});
});

/** Read every row of `sql` against `target` into plain objects (multi-db helper). */
async function readAllIn(target: Database, sql: string): Promise<Record<string, unknown>[]> {
	const rows: Record<string, unknown>[] = [];
	for await (const row of target.eval(sql)) rows.push({ ...row });
	return rows;
}
