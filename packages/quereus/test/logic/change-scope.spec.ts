import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import {
	deserializeChangeScope,
	serializeChangeScope,
	type ChangeScope,
	type WatchEvent,
	type WatchScope,
	type ParamScopeValue,
} from '../../src/planner/analysis/change-scope.js';

describe('Statement.getChangeScope (integration)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	it('two prepared statements over equivalent SQL produce deepEqual scopes', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const a = db.prepare('select * from t where id = ?').getChangeScope([5]);
		const b = db.prepare('select * from t where id = ?').getChangeScope([5]);
		expect(a.unboundParameters).to.deep.equal(b.unboundParameters);
		expect(a.watches.length).to.equal(b.watches.length);
		expect(a.watches[0].scope).to.deep.equal(b.watches[0].scope);
		expect(a.watches[0].table).to.deep.equal(b.watches[0].table);
	});

	it('serialized scope round-trips and matches the live one', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		const live = db.prepare('select v from t where id = ?').getChangeScope();
		const round = deserializeChangeScope(JSON.parse(JSON.stringify(serializeChangeScope(live))));
		expect(round.unboundParameters).to.deep.equal(live.unboundParameters);
		expect(round.watches[0].table).to.deep.equal(live.watches[0].table);
		expect(round.watches[0].scope).to.deep.equal(live.watches[0].scope);
	});

	it('parameter placeholders carry a portable type descriptor', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		const scope = stmt.getChangeScope();
		const w = scope.watches[0];
		expect(w.scope.kind).to.equal('rows');
		const r = w.scope as Extract<WatchScope, { kind: 'rows' }>;
		const v = r.values[0][0] as ParamScopeValue;
		expect(v.kind).to.equal('param');
		expect(v.type).to.have.property('typeName').that.is.a('string');
		expect(v.type).to.have.property('nullable');
	});

	it('getChangeScope on Statement without prior bind returns scope with unbound params', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		const scope = stmt.getChangeScope();
		expect(scope.unboundParameters).to.deep.equal([1]);
	});

	it('getChangeScope on prepared statement with bound params resolves placeholders', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		stmt.bind(1, 99);
		const scope = stmt.getChangeScope();
		expect(scope.unboundParameters).to.deep.equal([]);
		const r = scope.watches[0].scope as Extract<WatchScope, { kind: 'rows' }>;
		expect(r.values).to.deep.equal([[99]]);
	});
});

describe('Database.watch (integration)', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	const handBuiltRowsScope = (table: string, key: string, values: number[][]): ChangeScope => ({
		watches: [{
			table: { schema: 'main', table },
			columns: new Set([key]),
			scope: { kind: 'rows', key: [key], values },
		}],
		nonDeterministicSources: [],
		unboundParameters: [],
	});

	it('plan-independent: hand-built ChangeScope (no Statement) fires on matching row mutation', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('INSERT INTO t VALUES (7, \'seven\'), (8, \'eight\')');
		const events: WatchEvent[] = [];
		const scope = handBuiltRowsScope('t', 'id', [[7]]);
		const sub = db.watch(scope, e => { events.push(e); });
		expect(sub.id).to.match(/^watch:/);

		await db.exec('UPDATE t SET v = \'updated\' WHERE id = 7');
		expect(events).to.have.length(1);
		expect(events[0].matched).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([[7]]);
		expect(events[0].txnId).to.be.a('string').and.not.empty;

		// Mutation of an unwatched row does not fire.
		await db.exec('UPDATE t SET v = \'also-updated\' WHERE id = 8');
		expect(events).to.have.length(1);

		sub.unsubscribe();
	});

	it("'groups' watch fires once per distinct group key touched", async () => {
		await db.exec('CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total INTEGER) USING memory');
		await db.exec('INSERT INTO orders VALUES (1, 10, 100), (2, 10, 200), (3, 20, 300)');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{
				table: { schema: 'main', table: 'orders' },
				columns: new Set(['customer_id']),
				scope: { kind: 'groups', groupBy: ['customer_id'] },
			}],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });

		await db.exec('UPDATE orders SET total = total + 1 WHERE customer_id = 10');
		expect(events).to.have.length(1);
		const hitGroups = events[0].matched[0].hits.map(h => h[0]);
		expect(hitGroups).to.include(10);
		expect(hitGroups).to.not.include(20);
		sub.unsubscribe();
	});

	it("'full' watch with columns:'all' fires on any row mutation with empty hits", async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('INSERT INTO t VALUES (1, \'a\')');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 't' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('UPDATE t SET v = \'b\' WHERE id = 1');
		expect(events).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([]);
		sub.unsubscribe();
	});

	it('unsubscribe stops further firings and is idempotent', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 't' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('INSERT INTO t VALUES (1)');
		expect(events).to.have.length(1);
		sub.unsubscribe();
		sub.unsubscribe(); // idempotent
		await db.exec('INSERT INTO t VALUES (2)');
		expect(events).to.have.length(1);
	});

	it('multi-table scope fires once per transaction with all matching watches', async () => {
		await db.exec('CREATE TABLE a (id INTEGER PRIMARY KEY) USING memory');
		await db.exec('CREATE TABLE b (id INTEGER PRIMARY KEY) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [
				{ table: { schema: 'main', table: 'a' }, columns: 'all', scope: { kind: 'full' } },
				{ table: { schema: 'main', table: 'b' }, columns: 'all', scope: { kind: 'full' } },
			],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });

		await db.exec('BEGIN; INSERT INTO a VALUES (1); INSERT INTO b VALUES (1); COMMIT');
		expect(events).to.have.length(1);
		const matchedTables = events[0].matched.map(m => m.watch.table.table).sort();
		expect(matchedTables).to.deep.equal(['a', 'b']);
		sub.unsubscribe();
	});

	it('end-to-end: stmt.getChangeScope([id]) → db.watch fires for the prepared key', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT) USING memory');
		await db.exec('INSERT INTO t VALUES (42, \'old\')');
		const stmt = db.prepare('select v from t where id = ?');
		const scope = stmt.getChangeScope([42]);
		expect(scope.unboundParameters).to.deep.equal([]);
		const events: WatchEvent[] = [];
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('UPDATE t SET v = \'new\' WHERE id = 42');
		expect(events).to.have.length(1);
		expect(events[0].matched[0].hits).to.deep.equal([[42]]);
		sub.unsubscribe();
		await stmt.finalize();
	});

	it('rejects scopes with unbound parameters', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const stmt = db.prepare('select * from t where id = ?');
		const scope = stmt.getChangeScope();
		expect(scope.unboundParameters.length).to.be.greaterThan(0);
		expect(() => db.watch(scope, () => { /* */ })).to.throw(/bindParameters/);
		await stmt.finalize();
	});

	it('rejects scopes referencing a missing table', () => {
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 'absent' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		expect(() => db.watch(scope, () => { /* */ })).to.throw(/main\.absent/);
	});

	it('accepts an empty / dead scope and never fires', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = { watches: [], nonDeterministicSources: [], unboundParameters: [] };
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('INSERT INTO t VALUES (1)');
		expect(events).to.have.length(0);
		sub.unsubscribe();
	});

	it('disposes subscription when its table is dropped (no fire on a re-created table)', async () => {
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'main', table: 't' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('INSERT INTO t VALUES (1)');
		expect(events).to.have.length(1);

		await db.exec('DROP TABLE t');
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		await db.exec('INSERT INTO t VALUES (2)');
		// Subscription was invalidated by the table_removed event; no further fire.
		expect(events).to.have.length(1);

		// unsubscribe is still safe (idempotent) after auto-invalidation.
		sub.unsubscribe();
	});

	it('accepts hand-built scope with non-lowercased schema/table names', async () => {
		// Hand-built scopes from external sources may not honor the lowercased
		// contract — the watcher must still resolve and fire.
		await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY) USING memory');
		const events: WatchEvent[] = [];
		const scope: ChangeScope = {
			watches: [{ table: { schema: 'Main', table: 'T' }, columns: 'all', scope: { kind: 'full' } }],
			nonDeterministicSources: [],
			unboundParameters: [],
		};
		const sub = db.watch(scope, e => { events.push(e); });
		await db.exec('INSERT INTO t VALUES (1)');
		expect(events).to.have.length(1);
		sub.unsubscribe();
	});
});
