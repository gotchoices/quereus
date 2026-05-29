import { expect } from 'chai';
import { Database } from '../src/index.js';

/**
 * The bag-body contract: a v1 materialized view must be a *set*. A
 * duplicate-producing body fails with a purpose-built diagnostic that names the
 * MV and explains the contract — NOT the raw `UNIQUE constraint failed:
 * _mv_<name> PK` that leaks the hidden backing table.
 *
 * The sqllogic harness (`51-materialized-views.sqllogic` §9) covers the positive
 * "must be a set" substring and the create/refresh behavior; it cannot express
 * the *negative* assertion below, so this focused spec locks the user-facing
 * wording in.
 */
describe('Materialized view bag-body diagnostic', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	it('names the MV and the set contract, not the backing table', async () => {
		await db.exec(`
			create table orders (id integer primary key, status text);
			insert into orders values (1, 'open'), (2, 'open'), (3, 'shipped');
		`);

		const err = await captureError('create materialized view mv_status as select status from orders;');

		// Purpose-built, user-facing wording…
		expect(err.message).to.contain('must be a set');
		expect(err.message).to.contain("mv_status");
		// …and it never leaks the hidden backing-table implementation detail.
		expect(err.message).to.not.contain('_mv_');
		expect(err.message).to.not.contain('PK.');
	});

	it('rolls the backing table back so the MV name stays free after a failed create', async () => {
		await db.exec(`
			create table orders (id integer primary key, status text);
			insert into orders values (1, 'open'), (2, 'open'), (3, 'shipped');
		`);
		await captureError('create materialized view mv_status as select status from orders;');

		// A de-duplicated body over the same source must succeed — proving the
		// failed create did not half-register the name or leave a backing table.
		await db.exec('create materialized view mv_status as select distinct status from orders;');
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval('select * from mv_status order by status')) {
			rows.push(row);
		}
		expect(rows).to.deep.equal([{ status: 'open' }, { status: 'shipped' }]);
	});
});

/**
 * Incremental-apply failure visibility: a failed on-commit incremental
 * maintenance must never silently leave the MV diverged from its sources and
 * keep serving wrong data. The manager escalates in two tiers — Tier 1 self-heals
 * via a full rebuild (a different code path from the per-binding residual that
 * failed), and Tier 2 sets a `diverged` flag that makes reads error
 * unconditionally until a successful refresh/rebuild. The user's commit always
 * stands (no rollback).
 *
 * Faults are forced through the test-only `_setMaterializedViewMaintenanceFault`
 * seam: throwing on `'residual'` simulates the per-binding recompute failing,
 * and throwing on `'rebuild'` simulates the recovery full-rebuild failing too.
 */
describe('Materialized view incremental-apply failure visibility', () => {
	let db: Database;
	beforeEach(() => { db = new Database(); });
	afterEach(async () => { await db.close(); });

	async function selectAll(sql: string): Promise<Record<string, unknown>[]> {
		const rows: Record<string, unknown>[] = [];
		for await (const row of db.eval(sql)) rows.push(row);
		return rows;
	}

	async function captureError(sql: string): Promise<Error> {
		try {
			await selectAll(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	function divergedFlag(): boolean | undefined {
		return db.schemaManager.getMaterializedView('main', 'mv')?.diverged;
	}

	// A row-preserving incremental MV with enough rows that a single-row UPDATE
	// stays on the per-binding path (delta 1 / rowCount ≥ 4 < 0.5 fallback ratio).
	async function setupRowMv(): Promise<void> {
		await db.exec(`
			create table t (id integer primary key, x integer);
			insert into t values (1, 10), (2, 20), (3, 30), (4, 40);
			create materialized view mv as select id, x from t with refresh = 'on-commit-incremental';
		`);
	}

	it('Tier 1 — a residual-only failure self-heals via full rebuild (no divergence)', async () => {
		await setupRowMv();
		// Fail only the per-binding residual; the full-rebuild recovery is untouched.
		db._setMaterializedViewMaintenanceFault((phase) => {
			if (phase === 'residual') throw new Error('injected residual failure');
		});

		await db.exec('update t set x = 999 where id = 2;');

		// The recovery rebuild healed the MV with correct data; not diverged.
		expect(divergedFlag()).to.not.equal(true);
		const rows = await selectAll('select id, x from mv order by id');
		expect(rows).to.deep.equal([
			{ id: 1, x: 10 }, { id: 2, x: 999 }, { id: 3, x: 30 }, { id: 4, x: 40 },
		]);
	});

	it('Tier 1 — an apply-write failure (residual succeeded) self-heals via full rebuild', async () => {
		await setupRowMv();
		// The per-binding residual recomputes fine; the maintenance *write* fails.
		// Recovery still routes through the separate full-rebuild path.
		db._setMaterializedViewMaintenanceFault((phase) => {
			if (phase === 'apply') throw new Error('injected apply (write) failure');
		});

		await db.exec('update t set x = 999 where id = 2;');

		expect(divergedFlag()).to.not.equal(true);
		const rows = await selectAll('select id, x from mv order by id');
		expect(rows).to.deep.equal([
			{ id: 1, x: 10 }, { id: 2, x: 999 }, { id: 3, x: 30 }, { id: 4, x: 40 },
		]);
	});

	it('Tier 2 — residual + rebuild both fail → diverged, reads error, commit stands', async () => {
		await setupRowMv();
		// Both the per-binding recompute AND the recovery rebuild fail.
		db._setMaterializedViewMaintenanceFault((phase) => {
			if (phase === 'residual' || phase === 'rebuild') throw new Error(`injected ${phase} failure`);
		});

		await db.exec('update t set x = 999 where id = 2;');

		expect(divergedFlag()).to.equal(true);

		// Reads error with a divergence diagnostic naming the MV + the refresh remedy.
		const err = await captureError('select id, x from mv order by id');
		expect(err.message).to.contain('mv');
		expect(err.message).to.contain('diverged');
		expect(err.message).to.contain('refresh materialized view mv');

		// The user's commit stood — the source reflects the write even though the
		// MV could not be maintained.
		const src = await selectAll('select x from t where id = 2');
		expect(src).to.deep.equal([{ x: 999 }]);
	});

	it('self-heal retry — a later commit while diverged rebuilds and clears the flag', async () => {
		await setupRowMv();
		db._setMaterializedViewMaintenanceFault((phase) => {
			if (phase === 'residual' || phase === 'rebuild') throw new Error(`injected ${phase} failure`);
		});
		await db.exec('update t set x = 999 where id = 2;');
		expect(divergedFlag()).to.equal(true);

		// Fault becomes transient: clear it, then commit another source change. The
		// diverged self-heal retry does a full rebuild (ignoring the incremental
		// delta) and clears the flag — both deltas are now reflected.
		db._setMaterializedViewMaintenanceFault(undefined);
		await db.exec('update t set x = 888 where id = 3;');

		expect(divergedFlag()).to.not.equal(true);
		const rows = await selectAll('select id, x from mv order by id');
		expect(rows).to.deep.equal([
			{ id: 1, x: 10 }, { id: 2, x: 999 }, { id: 3, x: 888 }, { id: 4, x: 40 },
		]);
	});

	it('refresh clears diverged', async () => {
		await setupRowMv();
		db._setMaterializedViewMaintenanceFault((phase) => {
			if (phase === 'residual' || phase === 'rebuild') throw new Error(`injected ${phase} failure`);
		});
		await db.exec('update t set x = 999 where id = 2;');
		expect(divergedFlag()).to.equal(true);

		// An explicit refresh re-materializes and clears divergence; reads succeed.
		db._setMaterializedViewMaintenanceFault(undefined);
		await db.exec('refresh materialized view mv;');

		expect(divergedFlag()).to.not.equal(true);
		const rows = await selectAll('select id, x from mv order by id');
		expect(rows).to.deep.equal([
			{ id: 1, x: 10 }, { id: 2, x: 999 }, { id: 3, x: 30 }, { id: 4, x: 40 },
		]);
	});
});
