import { expect } from 'chai';
import { Database, MemoryTableModule } from '../src/index.js';
import { createScalarFunction } from '../src/func/registration.js';
import type { BackingHost } from '../src/vtab/backing-host.js';

/**
 * The REPLICABLE determinism class (ticket `replicable-determinism-class`). A
 * derivation hosted on a backing that replicates across peers must additionally be
 * **bit-identical across platforms/app-versions** — strictly stronger than the engine's
 * per-database determinism gate. A function asserts this with `replicable: true`;
 * built-ins auto-qualify (Quereus owns its collation / case-folding / numeric formatting,
 * so a deterministic builtin cannot drift between peers' JS engines). The class is
 * **inert by default**: only a backing host that declares
 * `requiresReplicableDerivations` activates the create-time reject, so an ordinary
 * `using memory` MV sees zero behavior change.
 *
 * sqllogic cannot register UDFs or a custom backing host, so this focused spec defines a
 * `repl` host (the memory host with the requirement flipped on) and pins the gate.
 */

/** Wrap a memory {@link BackingHost} so it declares the replicable requirement, delegating
 *  every privileged operation to the inner host. */
function demandReplicable(inner: BackingHost): BackingHost {
	return {
		ownsConnection: conn => inner.ownsConnection(conn),
		connect: () => inner.connect(),
		applyMaintenance: (conn, ops) => inner.applyMaintenance(conn, ops),
		replaceContents: (rows, onDup) => inner.replaceContents(rows, onDup),
		scanEffective: (conn, req) => inner.scanEffective(conn, req),
		requiresReplicableDerivations: true,
	};
}

/** A memory module whose backing host demands REPLICABLE derivations — the future
 *  sync-store's behavior, modeled over the in-memory reference host. */
class ReplBackingModule extends MemoryTableModule {
	override getBackingHost(db: Database, schemaName: string, tableName: string): BackingHost | undefined {
		const inner = super.getBackingHost(db, schemaName, tableName);
		return inner ? demandReplicable(inner) : undefined;
	}
}

describe('Materialized view replicable-determinism gate', () => {
	let db: Database;

	beforeEach(async () => {
		db = new Database();
		db.registerModule('repl', new ReplBackingModule());
		// A non-replicable but DETERMINISTIC scalar UDF — deterministic so the determinism
		// gate passes and the *replicable* gate is the one that bites (the two are orthogonal).
		db.createScalarFunction('nonrepl', { numArgs: 1, deterministic: true }, (x) => Number(x) + 1);
		await db.exec(`
			create table t (id integer primary key, k integer, v integer);
			insert into t values (1, 10, 100), (2, 20, 200);
		`);
	});
	afterEach(async () => { await db.close(); });

	async function captureError(sql: string): Promise<Error> {
		try {
			await db.exec(sql);
		} catch (e) {
			return e instanceof Error ? e : new Error(String(e));
		}
		throw new Error(`Expected an error from: ${sql}`);
	}

	/** Assert the create rejected for the replicable reason, naming the function. */
	function expectReplicableReject(err: Error, fnName: string, mvName: string): void {
		expect(err.message).to.contain('cannot be materialized');
		expect(err.message).to.contain(mvName);
		expect(err.message).to.contain(fnName);
		expect(err.message).to.contain('replicable');
		expect(db.schemaManager.getMaintainedTable('main', mvName), `${mvName} must not register`).to.be.undefined;
	}

	it('accepts a builtin-only body on a demanding host (builtins auto-qualify)', async () => {
		// `abs` is a built-in → stamped replicable → the gate passes.
		await db.exec('create materialized view m_ok using repl as select id, abs(v) as av from t;');
		expect(db.schemaManager.getMaintainedTable('main', 'm_ok'), 'builtin-only body registers').to.not.be.undefined;
	});

	it('rejects a non-replicable scalar UDF in a projection on a demanding host', async () => {
		const err = await captureError('create materialized view m_proj using repl as select id, nonrepl(v) as nv from t;');
		expectReplicableReject(err, 'nonrepl', 'm_proj');
	});

	it('accepts the same UDF once it is declared replicable', async () => {
		// A deterministic UDF declared replicable: true qualifies, so the demanding host accepts it.
		db.createScalarFunction('repl_udf', { numArgs: 1, deterministic: true, replicable: true }, (x) => Number(x) + 1);
		await db.exec('create materialized view m_repl using repl as select id, repl_udf(v) as nv from t;');
		expect(db.schemaManager.getMaintainedTable('main', 'm_repl'), 'replicable UDF body registers').to.not.be.undefined;
	});

	it('is inert on a non-demanding host: the non-replicable UDF creates `using memory`', async () => {
		// The load-bearing zero-behavior-change property: memory declares no requirement.
		await db.exec('create materialized view m_mem using memory as select id, nonrepl(v) as nv from t;');
		expect(db.schemaManager.getMaintainedTable('main', 'm_mem'), 'inert host accepts a non-replicable UDF').to.not.be.undefined;
	});

	it('rejects a non-replicable UDF in a WHERE predicate', async () => {
		const err = await captureError('create materialized view m_where using repl as select id, v from t where nonrepl(v) > 0;');
		expectReplicableReject(err, 'nonrepl', 'm_where');
	});

	it('rejects a non-replicable UDF in a GROUP BY key', async () => {
		const err = await captureError('create materialized view m_group using repl as select nonrepl(k) as gk, count(*) as c from t group by nonrepl(k);');
		expectReplicableReject(err, 'nonrepl', 'm_group');
	});

	it('rejects a non-replicable UDF in an aggregate argument', async () => {
		const err = await captureError('create materialized view m_agg using repl as select k, sum(nonrepl(v)) as s from t group by k;');
		expectReplicableReject(err, 'nonrepl', 'm_agg');
	});

	it('rejects a non-replicable UDF in a lateral TVF argument', async () => {
		const err = await captureError('create materialized view m_tvf using repl as select t.id, f.value from t cross join lateral generate_series(1, nonrepl(t.id)) f;');
		expectReplicableReject(err, 'nonrepl', 'm_tvf');
	});

	it('is NOT lifted by `pragma nondeterministic_schema` (orthogonal to the determinism gate)', async () => {
		// The pragma lifts the per-database determinism gate; the replicable class is a separate,
		// non-waivable concern, so the reject stands even with the pragma on.
		await db.exec('pragma nondeterministic_schema = true;');
		const err = await captureError('create materialized view m_pragma using repl as select id, nonrepl(v) as nv from t;');
		expectReplicableReject(err, 'nonrepl', 'm_pragma');
	});

	it('honors replicable on a hand-built schema via registerFunction', async () => {
		// The direct-schema registration path: a replicable: true field on a schema passed to
		// registerFunction is honored with no createScalarFunction-options plumbing.
		db.registerFunction(createScalarFunction(
			{ name: 'direct_repl', numArgs: 1, deterministic: true, replicable: true },
			(x) => Number(x) + 1,
		));
		await db.exec('create materialized view m_direct using repl as select id, direct_repl(v) as nv from t;');
		expect(db.schemaManager.getMaintainedTable('main', 'm_direct'), 'direct-schema replicable body registers').to.not.be.undefined;
	});
});
