import { expect } from 'chai';
import { Database, createScalarFunction } from '../src/index.js';
import type { SqlValue } from '../src/index.js';

/**
 * A write statement running in autocommit must open its implicit transaction
 * BEFORE any of the plan's instructions evaluate — a scalar function pulled
 * from a `values` row (or an update/delete expression) that reads the open
 * transaction otherwise sees `autocommit = true` and no implicit transaction.
 * See `docs/module-authoring-transactions.md § Connection lifecycle`.
 */
describe('Writing statement starts its implicit transaction before evaluating', () => {
	let db: Database;

	/** Row of (autocommit, implicitTx) captured at each `probe()` call. */
	type Probe = { autocommit: boolean; implicitTx: boolean };

	const installProbe = (name: string, captured: Probe[]): void => {
		db.registerFunction(createScalarFunction(
			{ name, numArgs: 0, deterministic: false },
			() => {
				captured.push({
					autocommit: db.getAutocommit(),
					implicitTx: db._isImplicitTransaction(),
				});
				// Return a small integer so the probe can be used as a key or value.
				return captured.length;
			},
		));
	};

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table t (id integer primary key, body text)');
	});

	afterEach(async () => {
		await db.close();
	});

	it('insert … values (fn(), …) — probe sees the open implicit transaction', async () => {
		const seen: Probe[] = [];
		installProbe('probe', seen);

		await db.exec("insert into t(id, body) values (probe(), 'a')");

		expect(seen).to.have.length(1);
		expect(seen[0].autocommit).to.equal(false);
		expect(seen[0].implicitTx).to.equal(true);
		// Autocommit restores at the statement boundary.
		expect(db.getAutocommit()).to.equal(true);
	});

	it('multi-row values list — every row sees the same open implicit transaction', async () => {
		const seen: Probe[] = [];
		installProbe('probe', seen);

		await db.exec("insert into t(id, body) values (probe(), 'a'), (probe(), 'b')");

		expect(seen).to.have.length(2);
		for (const row of seen) {
			expect(row.autocommit).to.equal(false);
			expect(row.implicitTx).to.equal(true);
		}
	});

	it('insert … select — regression guard for the already-working path', async () => {
		const seen: Probe[] = [];
		installProbe('probe', seen);

		await db.exec("insert into t(id, body) select probe(), 'c'");

		expect(seen).to.have.length(1);
		expect(seen[0].autocommit).to.equal(false);
		expect(seen[0].implicitTx).to.equal(true);
	});

	it('insert … on conflict … do update set col = fn() — both arms see it', async () => {
		const seen: Probe[] = [];
		installProbe('probe', seen);

		await db.exec("insert into t(id, body) values (10, 'u')");
		seen.length = 0;

		// Conflict arm: id=10 already exists; `probe()` on the do-update side runs.
		await db.exec(
			"insert into t(id, body) values (10, 'u2') on conflict(id) do update set body = 'c' || cast(probe() as text)"
		);
		expect(seen).to.have.length.greaterThan(0);
		for (const row of seen) {
			expect(row.autocommit).to.equal(false);
			expect(row.implicitTx).to.equal(true);
		}
	});

	it('insert … returning — returning wrapper does not disable the eager begin', async () => {
		const seen: Probe[] = [];
		installProbe('probe', seen);

		for await (const _row of db.eval("insert into t(id, body) values (probe(), 'r') returning id")) {
			// Drain rows so returning path runs end-to-end.
		}

		expect(seen).to.have.length(1);
		expect(seen[0].autocommit).to.equal(false);
		expect(seen[0].implicitTx).to.equal(true);
	});

	it('update … set col = fn() — writing update triggers the eager begin', async () => {
		const seen: Probe[] = [];
		installProbe('probe', seen);

		await db.exec("insert into t(id, body) values (1, 'x')");
		seen.length = 0;

		await db.exec("update t set body = cast(probe() as text) where id = 1");

		expect(seen).to.have.length.greaterThan(0);
		for (const row of seen) {
			expect(row.autocommit).to.equal(false);
			expect(row.implicitTx).to.equal(true);
		}
	});

	it('delete … where expr = fn() — writing delete triggers the eager begin', async () => {
		const seen: Probe[] = [];
		installProbe('probe', seen);

		await db.exec("insert into t(id, body) values (1, 'x'), (2, 'y')");
		seen.length = 0;

		await db.exec("delete from t where id = probe()");

		expect(seen).to.have.length.greaterThan(0);
		for (const row of seen) {
			expect(row.autocommit).to.equal(false);
			expect(row.implicitTx).to.equal(true);
		}
	});

	it('select fn() in autocommit — read-only statement leaves autocommit intact', async () => {
		const seen: Probe[] = [];
		installProbe('probe', seen);

		for await (const _row of db.eval('select probe() as v')) {
			// drain
		}

		expect(seen).to.have.length(1);
		expect(seen[0].autocommit).to.equal(true);
		expect(seen[0].implicitTx).to.equal(false);
		expect(db.getAutocommit()).to.equal(true);
	});

	it('a values-row expression throwing before any row lands is rolled back cleanly', async () => {
		let seenInsideTx = false;
		db.registerFunction(createScalarFunction(
			{ name: 'fails', numArgs: 0, deterministic: false },
			(): SqlValue => {
				seenInsideTx = db._isImplicitTransaction();
				throw new Error('boom');
			},
		));

		let caught: unknown;
		try {
			await db.exec("insert into t(id, body) values (fails(), 'x')");
		} catch (err) {
			caught = err;
		}
		expect(caught).to.exist;
		// The eager begin opened the implicit transaction at throw time ...
		expect(seenInsideTx).to.equal(true);
		// ... and _execBatchAutocommit's catch rolled it back.
		expect(db.getAutocommit()).to.equal(true);
		// No row was stored.
		let count = 0;
		for await (const _row of db.eval('select 1 from t')) count++;
		expect(count).to.equal(0);
	});

	it('BEGIN … COMMIT batch does not acquire an implicit transaction up front', async () => {
		const seen: Probe[] = [];
		installProbe('probe', seen);

		// Multi-statement batch: `BEGIN` is a TransactionPlanNode (readonly: true,
		// no eager begin). The `insert` that follows writes and, under the user's
		// explicit transaction, `ensureTransaction` finds the explicit one and
		// does not open a second implicit layer. `probe()` runs inside that
		// explicit transaction (autocommit=false, implicitTx=false).
		await db.exec("begin; insert into t(id, body) values (probe(), 'b'); commit;");

		expect(seen).to.have.length(1);
		expect(seen[0].autocommit).to.equal(false);
		expect(seen[0].implicitTx).to.equal(false);
		expect(db.getAutocommit()).to.equal(true);
	});
});
