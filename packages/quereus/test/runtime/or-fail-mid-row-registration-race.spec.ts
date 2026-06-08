/**
 * Locks the OR FAIL per-row `__or_fail_N` savepoint broadcast against the
 * `registerConnection`-replay race documented at `dml-executor.ts` (the
 * comment block above the per-row create inside `runInsert`).
 *
 * The race only manifests when a brand-new `VirtualTableConnection` is
 * registered DURING the OR FAIL bracket. Audit at the time the broadcast
 * landed (see `tickets/complete/quereus-or-fail-savepoint-broadcast.md`)
 * found no current code path that triggers a mid-row registration — the
 * fix is defensive. This test wires a custom vtab whose `update()` side-
 * effects a `db.registerConnection` for an instrumented sibling, then
 * inspects the sibling's recorded savepoint trace.
 *
 * Without broadcast, the sibling's stack drifts relative to the
 * TransactionManager's stack — subsequent broadcasts (release-on-success,
 * rollback-to under a surrounding user SAVEPOINT) hit the wrong depth and
 * the rollback restores the sibling to a stale replayed layer instead of
 * the user-savepoint layer.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { type Row, type UpdateResult } from '../../src/common/types.js';
import { VirtualTable, type UpdateArgs } from '../../src/vtab/table.js';
import type { VirtualTableModule, BaseModuleConfig } from '../../src/vtab/module.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { VirtualTableConnection } from '../../src/vtab/connection.js';
import type { BestAccessPlanRequest, BestAccessPlanResult } from '../../src/vtab/best-access-plan.js';

type SavepointEvent =
	| { op: 'begin' }
	| { op: 'commit' }
	| { op: 'rollback' }
	| { op: 'create'; depth: number }
	| { op: 'release'; depth: number }
	| { op: 'rollbackTo'; depth: number }
	| { op: 'disconnect' };

/**
 * Instrumented sibling connection — records every transaction/savepoint
 * call. Holds no data; its only job is to receive broadcasts and let the
 * test inspect what the DML executor's per-row OR FAIL bracket sent.
 */
class RecordingSiblingConnection implements VirtualTableConnection {
	readonly connectionId: string;
	readonly tableName: string;
	readonly trace: SavepointEvent[] = [];

	constructor(id: string) {
		this.connectionId = id;
		this.tableName = `shadow_${id}`;
	}

	begin(): void { this.trace.push({ op: 'begin' }); }
	commit(): void { this.trace.push({ op: 'commit' }); }
	rollback(): void { this.trace.push({ op: 'rollback' }); }
	createSavepoint(depth: number): void { this.trace.push({ op: 'create', depth }); }
	releaseSavepoint(depth: number): void { this.trace.push({ op: 'release', depth }); }
	rollbackToSavepoint(depth: number): void { this.trace.push({ op: 'rollbackTo', depth }); }
	disconnect(): void { this.trace.push({ op: 'disconnect' }); }
}

/**
 * Custom vtab whose `update()` for `insert` lazily registers a sibling
 * `RecordingSiblingConnection` on the first row — exactly the mid-row
 * registration the broadcast guards against. After registration the
 * sibling lives until db.close().
 *
 * The "registered yet?" flag and the sibling reference both live on the
 * module (not the per-instance table) so they survive across statements:
 * each new DML statement constructs a fresh `RaceParentTable` via
 * `connect()`, and we don't want each statement to register a fresh
 * sibling. The race we're locking is one-time: a sibling that registers
 * mid-bracket must continue receiving broadcasts after the bracket
 * closes, across subsequent statements, and across user-level
 * ROLLBACK TO / RELEASE.
 */
class RaceParentTable extends VirtualTable {
	private readonly parentModule: RaceParentModule;

	constructor(
		db: Database,
		module: RaceParentModule,
		schemaName: string,
		tableName: string,
		schema?: TableSchema,
	) {
		super(db, module, schemaName, tableName);
		this.parentModule = module;
		if (schema) this.tableSchema = schema;
	}

	async disconnect(): Promise<void> {}

	async update(args: UpdateArgs): Promise<UpdateResult> {
		if (args.operation === 'insert' && !this.parentModule.siblingRegistered) {
			this.parentModule.siblingRegistered = true;
			const sibling = new RecordingSiblingConnection(`recording-sibling-${this.tableName}`);
			this.parentModule.sibling = sibling;
			await this.db.registerConnection(sibling);
		}

		switch (args.operation) {
			case 'insert':
				if (args.values) {
					// Vtab-level constraint violation lets us exercise the
					// in-executor error-path broadcast (rollbackTo+release on
					// the failing row's __or_fail_N bracket). Engine-level
					// CHECK throws above DmlExecutor so it never reaches that
					// branch — only a vtab-returned constraint result does.
					if (this.parentModule.failOnInsertValue !== undefined
						&& Number(args.values[0]) === this.parentModule.failOnInsertValue) {
						return { status: 'constraint', constraint: 'check', message: 'race-parent forced constraint' };
					}
					this.parentModule.rowsStore.push(args.values);
					return { status: 'ok', row: args.values };
				}
				return { status: 'ok' };
			case 'delete':
				return { status: 'ok' };
			case 'update':
				return { status: 'ok', row: args.values };
		}
		return { status: 'ok' };
	}

	async *query(): AsyncIterable<Row> {
		for (const row of this.parentModule.rowsStore) yield row;
	}
}

class RaceParentModule implements VirtualTableModule<RaceParentTable, BaseModuleConfig> {
	/** Set once when the first insert triggers sibling registration. */
	siblingRegistered = false;
	/** The registered sibling — exposed to the test for trace assertions. */
	sibling: RecordingSiblingConnection | undefined;
	/** Shared row store across per-statement table instances. */
	readonly rowsStore: Row[] = [];
	/**
	 * When set, an insert whose first column equals this number returns
	 * `{ status: 'constraint', constraint: 'check' }` from `update()`. Used
	 * to drive the in-executor error-path broadcast that engine-level CHECK
	 * cannot reach (CHECK throws above the DmlExecutor in the plan tree).
	 */
	failOnInsertValue: number | undefined;

	async create(db: Database, tableSchema: TableSchema): Promise<RaceParentTable> {
		return new RaceParentTable(db, this, tableSchema.schemaName, tableSchema.name, tableSchema);
	}

	async connect(
		db: Database,
		_pAux: unknown,
		_moduleName: string,
		schemaName: string,
		tableName: string,
		_options: BaseModuleConfig,
		importedTableSchema?: TableSchema,
	): Promise<RaceParentTable> {
		const schema = importedTableSchema ?? db.schemaManager.getTable(schemaName, tableName);
		if (!schema) {
			throw new Error(`Table ${schemaName}.${tableName} not found`);
		}
		return new RaceParentTable(db, this, schemaName, tableName, schema);
	}

	async destroy(): Promise<void> {}

	getBestAccessPlan(
		_db: Database,
		_tableInfo: TableSchema,
		request: BestAccessPlanRequest,
	): BestAccessPlanResult {
		return {
			cost: 100,
			rows: 0,
			explains: 'race-parent full scan',
			handledFilters: request.filters.map(() => false),
		};
	}
}

describe('OR FAIL per-row savepoint broadcast — mid-row registration race', () => {
	let db: Database;
	let module: RaceParentModule;

	beforeEach(() => {
		db = new Database();
		module = new RaceParentModule();
		db.registerModule('race_parent', module);
	});

	afterEach(async () => {
		await db.close();
	});

	it('broadcasts create/release/rollback-to to a sibling that registers mid-bracket', async () => {
		// The sibling registers DURING __or_fail_0 (row 1). Subsequent rows'
		// brackets (__or_fail_1, __or_fail_2) and the ROLLBACK TO sp1 must
		// each reach the sibling via getAllConnections().
		await db.exec('create table parent (id integer primary key) using race_parent');

		await db.exec('begin');
		await db.exec('savepoint sp1');
		await db.exec('insert or fail into parent values (1), (2), (3)');

		const sibling = module.sibling;
		expect(sibling, 'sibling must have been registered during update()').to.exist;

		// At this point the sibling has seen:
		//   - begin (from registerConnection's `connection.begin()` call)
		//   - create(0), create(1)   ← registerConnection's depth-replay
		//                              loop with activeDepth = 2 (sp1 +
		//                              __or_fail_0).
		//   - release(1)             ← end of row 1's __or_fail_0 bracket
		//   - create(1)              ← row 2's __or_fail_1 bracket open
		//   - release(1)             ← row 2's __or_fail_1 bracket close
		//   - create(1)              ← row 3's __or_fail_2 bracket open
		//   - release(1)             ← row 3's __or_fail_2 bracket close
		//
		// The strict-race guarantee the broadcast secures: the three
		// post-registration creates+releases (rows 2/3 broadcast create,
		// rows 1/2/3 broadcast release) all reach the sibling. Without
		// broadcast on per-row create, only the replay creates show up;
		// without broadcast on per-row release, only the replay shows up.

		const creates = sibling!.trace.filter(e => e.op === 'create');
		const releases = sibling!.trace.filter(e => e.op === 'release');

		// 2 replay creates (depths 0, 1) + 2 broadcast creates for rows 2 and 3
		// (each at depth 1, since __or_fail_N opens at TxnMgr depth 1 above sp1).
		expect(creates.map(e => (e as { depth: number }).depth)).to.deep.equal([0, 1, 1, 1]);

		// 3 broadcast releases — one per row's bracket close, all at depth 1.
		expect(releases.map(e => (e as { depth: number }).depth)).to.deep.equal([1, 1, 1]);

		// ROLLBACK TO sp1 must broadcast rollbackToSavepoint(0).
		await db.exec('rollback to savepoint sp1');

		const rollbacks = sibling!.trace.filter(e => e.op === 'rollbackTo');
		expect(rollbacks).to.have.lengthOf(1);
		expect((rollbacks[0] as { depth: number }).depth).to.equal(0);

		// Re-INSERT after ROLLBACK TO must re-broadcast __or_fail_N creates.
		// (Locks the rollback didn't leave the sibling's stack stuck at a
		// stale depth where subsequent broadcasts would be out of range.)
		const traceLenBeforeReinsert = sibling!.trace.length;
		await db.exec('insert or fail into parent values (4), (5)');

		const postReinsert = sibling!.trace.slice(traceLenBeforeReinsert);
		const reinsertCreates = postReinsert.filter(e => e.op === 'create');
		const reinsertReleases = postReinsert.filter(e => e.op === 'release');
		expect(reinsertCreates.map(e => (e as { depth: number }).depth)).to.deep.equal([1, 1]);
		expect(reinsertReleases.map(e => (e as { depth: number }).depth)).to.deep.equal([1, 1]);

		// Clean shutdown — RELEASE then COMMIT must reach the sibling too,
		// otherwise db.close() would tear down a connection mid-transaction
		// and the trace would show no commit. (RELEASE sp1 broadcasts
		// releaseSavepoint(0); COMMIT broadcasts commit().)
		await db.exec('release savepoint sp1');
		await db.exec('commit');

		const finalReleases = sibling!.trace.filter(e => e.op === 'release');
		expect(finalReleases.some(e => (e as { depth: number }).depth === 0),
			'RELEASE sp1 must broadcast releaseSavepoint(0)').to.equal(true);
		expect(sibling!.trace.some(e => e.op === 'commit'),
			'COMMIT must broadcast commit() to the sibling').to.equal(true);
	});

	it('mid-row registration: rollback-to-savepoint after a CHECK-failing row reaches the sibling', async () => {
		// Engine-level CHECK is evaluated by a ConstraintCheckNode sitting
		// ABOVE the DmlExecutorNode (see planner/building/insert.ts), so
		// the failing row's exception is thrown from the source iterator
		// BEFORE `processInsertRow` runs — meaning the failing row's
		// per-row `__or_fail_N` bracket never opens. Rows that did open a
		// bracket release it normally; the surrounding user-level sp1 is
		// the rollback layer that wipes the survivors.
		await db.exec(`
			create table parent (id integer primary key, n integer check (n > 0))
			using race_parent
		`);

		await db.exec('begin');
		await db.exec('savepoint sp1');

		let thrown: unknown;
		try {
			await db.exec('insert or fail into parent values (1, 1), (2, 2), (3, -1)');
		} catch (e) {
			thrown = e;
		}
		expect(thrown, 'middle row must violate CHECK').to.exist;

		const sibling = module.sibling;
		expect(sibling).to.exist;

		// Trace for the sibling (registered during row 1's __or_fail_0):
		//   begin, create(0), create(1)   ← replay at register time
		//   release(1)                     ← row 1 success
		//   create(1), release(1)          ← row 2 success
		//   (no row-3 bracket: CHECK throws above the executor)

		const creates = sibling!.trace.filter(e => e.op === 'create')
			.map(e => (e as { depth: number }).depth);
		const releases = sibling!.trace.filter(e => e.op === 'release')
			.map(e => (e as { depth: number }).depth);
		const rollbacks = sibling!.trace.filter(e => e.op === 'rollbackTo')
			.map(e => (e as { depth: number }).depth);

		expect(creates).to.deep.equal([0, 1, 1]);
		expect(releases).to.deep.equal([1, 1]);
		expect(rollbacks).to.deep.equal([]);

		// Surrounding sp1 still aligned — ROLLBACK TO must reach the
		// sibling and bring it back in lockstep with TxnMgr depth 0.
		const tracePos = sibling!.trace.length;
		await db.exec('rollback to savepoint sp1');
		const postRollback = sibling!.trace.slice(tracePos);
		const userRollback = postRollback.find(e => e.op === 'rollbackTo');
		expect(userRollback, 'ROLLBACK TO sp1 must broadcast').to.exist;
		expect((userRollback as { depth: number }).depth).to.equal(0);

		await db.exec('release savepoint sp1');
		await db.exec('commit');
	});

	it('autocommit OR FAIL with mid-row registration: the per-row bracket still broadcasts', async () => {
		// No surrounding user SAVEPOINT — autocommit. The DML executor's
		// per-row OR FAIL bracket still creates `__or_fail_N` savepoints
		// inside the implicit transaction, and the broadcast must reach a
		// connection that registers mid-row. Engine-level CHECK throws
		// above the executor (see prior test), so the failing row never
		// opens its own bracket and the implicit transaction rollback is
		// the cleanup path.
		await db.exec(`
			create table parent (id integer primary key, n integer check (n > 0))
			using race_parent
		`);

		let thrown: unknown;
		try {
			await db.exec('insert or fail into parent values (1, 1), (2, 2), (3, -1)');
		} catch (e) {
			thrown = e;
		}
		expect(thrown, 'middle row must violate CHECK').to.exist;

		const sibling = module.sibling;
		expect(sibling).to.exist;

		// Under autocommit, activeDepth at register time = 1 (only the
		// per-row __or_fail_0). Expected trace:
		//   begin, create(0)            ← replay
		//   release(0)                   ← row 1 success
		//   create(0), release(0)        ← row 2 success
		//   (no row-3 bracket: CHECK throws above the executor)
		//   rollback                     ← implicit-tx rollback on error
		//
		// The strict invariant: rows after registration (here, row 2) see
		// their bracket-open create AND bracket-close release on the
		// sibling. Without broadcast on per-row create this would be 0
		// post-replay creates; without broadcast on release this would be
		// 0 post-replay releases.

		const creates = sibling!.trace.filter(e => e.op === 'create')
			.map(e => (e as { depth: number }).depth);
		const releases = sibling!.trace.filter(e => e.op === 'release')
			.map(e => (e as { depth: number }).depth);
		const hasRollback = sibling!.trace.some(e => e.op === 'rollback');

		expect(creates).to.deep.equal([0, 0]);
		expect(releases).to.deep.equal([0, 0]);
		expect(hasRollback, 'implicit-tx rollback must reach the sibling on error').to.equal(true);
	});

	it('in-executor error path: vtab-level constraint broadcasts rollbackTo+release on the failing row\'s bracket', async () => {
		// Engine-level CHECK throws ABOVE the DmlExecutor, so the failing
		// row's per-row `__or_fail_N` bracket never opens — which means the
		// error-path broadcast inside the executor (rollbackTo+release on
		// the still-open bracket) is unreachable that way. A vtab that
		// returns `{ status: 'constraint', ... }` from `update()` IS inside
		// `processInsertRow`, so the failing row HAS already opened its
		// bracket; the catch block in dml-executor.ts then runs
		// rollbackToSavepoint + releaseSavepoint and broadcasts both.
		await db.exec('create table parent (id integer primary key) using race_parent');
		module.failOnInsertValue = 3;

		await db.exec('begin');
		await db.exec('savepoint sp1');

		let thrown: unknown;
		try {
			await db.exec('insert or fail into parent values (1), (2), (3)');
		} catch (e) {
			thrown = e;
		}
		expect(thrown, 'row 3 must surface as a constraint failure').to.exist;

		const sibling = module.sibling;
		expect(sibling).to.exist;

		// Expected trace (sibling registers during row 1's __or_fail_0,
		// activeDepth = 2 because sp1 + __or_fail_0 are both on the stack):
		//   begin                                 ← registerConnection
		//   create(0), create(1)                  ← replay
		//   release(1)                            ← row 1 success
		//   create(1), release(1)                 ← row 2 success
		//   create(1)                             ← row 3 bracket open (broadcast)
		//   rollbackTo(1), release(1)             ← in-executor error path
		//
		// Row 1's bracket-open broadcast happens BEFORE update() registers
		// the sibling, so the sibling does not record that create directly —
		// the replay's create(1) is the substitute. From the sibling's
		// perspective: replay [0, 1] + bracket-open creates for rows 2 and
		// 3 only = [0, 1, 1, 1].
		//
		// The strict invariant the broadcast secures here: the failing
		// row's rollbackTo AND release both reach the sibling. Without
		// either, the sibling's stack ends up one layer deeper than the
		// TransactionManager's after the bracket aborts.

		const creates = sibling!.trace.filter(e => e.op === 'create')
			.map(e => (e as { depth: number }).depth);
		const releases = sibling!.trace.filter(e => e.op === 'release')
			.map(e => (e as { depth: number }).depth);
		const rollbackTos = sibling!.trace.filter(e => e.op === 'rollbackTo')
			.map(e => (e as { depth: number }).depth);

		// 2 replay creates + 2 broadcast creates (rows 2, 3 open after registration).
		expect(creates).to.deep.equal([0, 1, 1, 1]);
		// 2 success releases (rows 1, 2) + 1 error-path release (row 3).
		expect(releases).to.deep.equal([1, 1, 1]);
		// Exactly one error-path rollbackTo on the failing row's bracket.
		expect(rollbackTos).to.deep.equal([1]);

		// And the rollbackTo MUST come before the failing-row release (the
		// executor does rollbackToSavepoint then releaseSavepoint on the
		// same bracket). Verify the temporal ordering on the trace, since
		// the swapped order would leave the sibling's stack in a wrong
		// state.
		const rollbackToIdx = sibling!.trace.findIndex(e => e.op === 'rollbackTo');
		const lastReleaseIdx = sibling!.trace.map((e, i) => ({ e, i }))
			.filter(({ e }) => e.op === 'release').pop()!.i;
		expect(rollbackToIdx).to.be.lessThan(lastReleaseIdx);

		// Surrounding sp1 still aligned: ROLLBACK TO sp1 must broadcast
		// rollbackToSavepoint(0).
		await db.exec('rollback to savepoint sp1');
		const userRollbacks = sibling!.trace.filter(e => e.op === 'rollbackTo')
			.map(e => (e as { depth: number }).depth);
		expect(userRollbacks).to.deep.equal([1, 0]);

		await db.exec('release savepoint sp1');
		await db.exec('commit');
	});
});
