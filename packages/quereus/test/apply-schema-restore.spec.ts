/**
 * `apply schema` is all-or-nothing: a migration that fails partway is unwound through the
 * plan's undo journal (`MigrationStep.undo`, see docs/schema-undo-plan.md) and the catalog is
 * verified back at its pre-apply state before the step's own error is rethrown. The stated
 * residual is a data-destroying step (`DROP TABLE`, `DROP COLUMN`, `SET DATA TYPE`): once one
 * has run the apply cannot be taken back, and a later failure reports the schema as partially
 * migrated. See docs/schema.md § Failure and restoration; the executor is
 * `runBatchedMigrationLoop` in `runtime/emit/schema-declarative.ts`.
 *
 * The cross-backend half of this contract — constraint tightening against a violating row on
 * both the memory and the store backend — lives in
 * `test/logic/50.4-declare-schema-apply-restore.sqllogic`. This spec covers what the sqllogic
 * runner cannot reach: the catalog fingerprint, the schema-event channel, the shape of the
 * error, a module whose undo fails, and the strict DDL-transaction policy.
 */

import { expect } from 'chai';
import { Database, DefaultVTableEventEmitter, MemoryTableModule, type DatabaseSchemaChangeEvent } from '../src/index.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import { QuereusError } from '../src/common/errors.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { renderCatalogForComparison, renderCatalogForRestoreCheck } from '../src/schema/catalog-rendering.js';
import type { SqlValue } from '../src/common/types.js';

async function rows(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const out: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

/** The full comparison rendering — where nothing reorders, the restore must satisfy the STRICT rendering, not only the check the executor runs. */
function fingerprint(db: Database): string {
	return renderCatalogForComparison(collectSchemaCatalog(db, 'main'));
}

/** The rendering the executor verifies against: the strict one minus the table / view DDL text. */
function restoreFingerprint(db: Database): string {
	return renderCatalogForRestoreCheck(collectSchemaCatalog(db, 'main'));
}

/** Each named constraint of `table` as `name definition`, in STORAGE order. */
function constraintsOf(db: Database, table: string): string[] {
	return collectSchemaCatalog(db, 'main').tables.find(t => t.name === table)!.namedConstraints.map(c => `${c.name} ${c.definition}`);
}

async function planOf(db: Database): Promise<string[]> {
	return (await rows(db, 'diff schema main')).map(r => String(r.ddl));
}

/** Awaits a rejection and hands back the error, failing loudly when the promise resolves. */
async function rejection(p: Promise<unknown>): Promise<Error> {
	try {
		await p;
	} catch (e) {
		return e as Error;
	}
	throw new Error('expected the statement to reject');
}

/** One event rendered as `type/objectType/objectName` — the comparable contract. */
function shape(e: DatabaseSchemaChangeEvent): string {
	return `${e.type}/${e.objectType}/${e.objectName}`;
}

/** A table with a row, and a declaration whose only change is a NOT NULL column that row cannot satisfy. */
const TABLE_T = 'create table t (id integer primary key, v text null)';
const FAILING_T = `
	table t {
		id INTEGER PRIMARY KEY,
		v TEXT NULL,
		w INTEGER NOT NULL
	}`;

describe('apply schema restores the catalog when a migration fails partway', () => {
	let db: Database;

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('constraint tightening against a violating row', () => {
		// Every table carries a SECOND constraint of the same class, declared after the one
		// that is tightened. `ADD CONSTRAINT` appends, so the restored constraint comes back
		// LAST in storage order: the same constraints, spelled the same, in a different order.
		// The differ keys constraints by name and the restore check leaves the order-bearing
		// DDL text out (see `renderCatalogForRestoreCheck`), so the apply reports a verified
		// restore; the strict rendering — which embeds `generateTableDDL` — does move, and
		// `assertRestoredUpToConstraintOrder` pins exactly that and nothing else.

		async function assertRestoredUpToConstraintOrder(before: string, table: string, storageOrderBefore: string[]): Promise<void> {
			expect(restoreFingerprint(db)).to.equal(before);
			const after = constraintsOf(db, table);
			expect([...after].sort()).to.deep.equal([...storageOrderBefore].sort(), 'the same constraints are back');
			expect(after, 'the restored constraint was re-appended, so storage order moved').to.not.deep.equal(storageOrderBefore);
			expect(await planOf(db), 'the plan is the original DROP + ADD pair again').to.have.length(2);
		}

		it('CHECK: the old rule is back and still enforced', async () => {
			await db.exec('create table t (id integer primary key, v integer, w integer, constraint ck_v check (v > 0), constraint ck_w check (w > 0))');
			await db.exec('insert into t values (1, 5, 5)');
			await db.exec(`
				declare schema main {
					table t {
						id INTEGER PRIMARY KEY,
						v INTEGER,
						w INTEGER,
						constraint ck_v check (v > 10),
						constraint ck_w check (w > 0)
					}
				}
			`);
			const before = restoreFingerprint(db);
			const order = constraintsOf(db, 't');

			const err = await rejection(db.exec('apply schema main'));
			expect(err.message).to.match(/ck_v|CHECK/);
			expect(err.message, 'a verified restore rethrows the step error unchanged').to.not.match(/could not be restored/);

			await assertRestoredUpToConstraintOrder(before, 't', order);
			await rejection(db.exec('insert into t values (2, -1, 5)'));
			await db.exec('insert into t values (2, 7, 5)');
			expect(await rows(db, 'select id from t order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
		});

		it('UNIQUE: the old column set is back and still enforced', async () => {
			await db.exec('create table u (id integer primary key, a integer, b integer, c integer, constraint uq_ab unique (a, b), constraint uq_c unique (c))');
			await db.exec('insert into u values (1, 1, 1, 10), (2, 1, 2, 20)');
			await db.exec(`
				declare schema main {
					table u {
						id INTEGER PRIMARY KEY,
						a INTEGER,
						b INTEGER,
						c INTEGER,
						constraint uq_ab unique (a),
						constraint uq_c unique (c)
					}
				}
			`);
			const before = restoreFingerprint(db);
			const order = constraintsOf(db, 'u');

			const err = await rejection(db.exec('apply schema main'));
			expect(err.message).to.match(/UNIQUE|uq_ab/);

			await assertRestoredUpToConstraintOrder(before, 'u', order);
			await rejection(db.exec('insert into u values (3, 1, 1, 30)'));
			await db.exec('insert into u values (3, 1, 3, 30)');
		});

		it('FOREIGN KEY: the old reference is back and still enforced', async () => {
			await db.exec('create table p (id integer primary key, alt integer, constraint uq_alt unique (alt))');
			await db.exec('insert into p values (1, 100)');
			await db.exec('create table c (id integer primary key, pid integer, qid integer, constraint fk_p foreign key (pid) references p(id), constraint fk_q foreign key (qid) references p(id))');
			await db.exec('insert into c values (1, 1, 1)');
			await db.exec(`
				declare schema main {
					table p {
						id INTEGER PRIMARY KEY,
						alt INTEGER,
						constraint uq_alt unique (alt)
					}
					table c {
						id INTEGER PRIMARY KEY,
						pid INTEGER,
						qid INTEGER,
						constraint fk_p foreign key (pid) references p(alt),
						constraint fk_q foreign key (qid) references p(id)
					}
				}
			`);
			const before = restoreFingerprint(db);
			const order = constraintsOf(db, 'c');

			const err = await rejection(db.exec('apply schema main'));
			expect(err.message).to.match(/FOREIGN KEY|fk_p/);

			await assertRestoredUpToConstraintOrder(before, 'c', order);
			await rejection(db.exec('insert into c values (2, 999, 1)'));
			await db.exec('insert into c values (2, 1, 1)');
		});
	});

	describe('a multi-step migration', () => {
		beforeEach(async () => {
			await db.exec(TABLE_T);
			await db.exec("insert into t values (1, 'a')");
			// create table n1, create index ix_v, then the failing ALTER TABLE t ADD COLUMN.
			await db.exec(`
				declare schema main {
					${FAILING_T}
					table n1 {
						id INTEGER PRIMARY KEY
					}
					index ix_v on t (v);
				}
			`);
		});

		it('leaves the catalog exactly as it was, and diff schema reproduces the original plan', async () => {
			const before = fingerprint(db);
			const plan = await planOf(db);
			expect(plan, 'the failing step must not be the first one').to.have.length(3);

			const err = await rejection(db.exec('apply schema main'));
			expect(err.message).to.match(/NOT NULL constraint failed/);
			expect(err).to.be.instanceOf(QuereusError);

			expect(fingerprint(db)).to.equal(before);
			await rejection(rows(db, 'select * from n1'));
			expect(await planOf(db)).to.deep.equal(plan);
		});

		it('inside begin … commit: restored, the transaction still usable, and commit leaves the pre-apply schema', async () => {
			const before = fingerprint(db);

			await db.exec('begin');
			await db.exec("insert into t values (2, 'b')");
			await rejection(db.exec('apply schema main'));
			// Savepoint-like: the outer transaction is open and takes further work.
			await db.exec("insert into t values (3, 'c')");
			await db.exec('commit');

			expect(fingerprint(db)).to.equal(before);
			expect(await rows(db, 'select id from t order by id')).to.deep.equal([{ id: 1 }, { id: 2 }, { id: 3 }]);
			await rejection(rows(db, 'select * from n1'));
		});

		it('a later apply of the same declaration still migrates (nothing was cached by the failure)', async () => {
			await rejection(db.exec('apply schema main'));
			await db.exec('delete from t');
			await db.exec('apply schema main');
			expect(await planOf(db)).to.deep.equal([]);
			expect(await rows(db, 'select count(*) as n from n1')).to.deep.equal([{ n: 0 }]);
		});
	});

	it('the failing step is the first step: the original error passes through untouched', async () => {
		await db.exec(TABLE_T);
		await db.exec("insert into t values (1, 'a')");
		await db.exec(`declare schema main { ${FAILING_T} }`);
		expect(await planOf(db)).to.have.length(1);
		const before = fingerprint(db);

		const err = await rejection(db.exec('apply schema main'));
		expect(err.message).to.match(/^Failed to execute DDL: ALTER TABLE t ADD COLUMN/);
		expect(err.message).to.not.match(/could not be restored/);
		expect(fingerprint(db)).to.equal(before);
	});

	describe('the destructive residual', () => {
		it('a failure after a DROP TABLE leaves the schema partially migrated, and the error names the irreversible step', async () => {
			await db.exec('create table old (id integer primary key)');
			await db.exec(TABLE_T);
			await db.exec("insert into t values (1, 'a')");
			// Drops run before alters: DROP TABLE old lands, then the ADD COLUMN fails.
			await db.exec(`declare schema main { ${FAILING_T} }`);

			const err = await rejection(db.exec('apply schema main'));
			expect(err.message).to.match(/^Failed to execute DDL: ALTER TABLE t ADD COLUMN/);
			expect(err.message).to.match(/The schema is partially migrated and could not be restored/);
			expect(err.message).to.match(/the earlier step `DROP TABLE IF EXISTS old` cannot be undone/);
			expect(err.message).to.match(/discards its rows/);
			expect((err as QuereusError).cause, 'the step error rides as cause').to.be.instanceOf(QuereusError);
			expect(((err as QuereusError).cause as Error).message).to.match(/^Failed to execute DDL: ALTER TABLE t ADD COLUMN/);

			// Partially migrated: the drop stands, the failed add does not.
			await rejection(rows(db, 'select * from old'));
			expect(collectSchemaCatalog(db, 'main').tables.find(t => t.name === 't')!.columns.map(c => c.name)).to.deep.equal(['id', 'v']);
		});

		it('an irreversible step that itself fails is reported as unrestorable, not as restored', async () => {
			await db.exec('create table t (id integer primary key, v text)');
			await db.exec("insert into t values (1, 'not a number')");
			await db.exec(`
				declare schema main {
					table t {
						id INTEGER PRIMARY KEY,
						v INTEGER
					}
				}
			`);

			const err = await rejection(db.exec('apply schema main'));
			expect(err.message).to.match(/^Failed to execute DDL: ALTER TABLE t ALTER COLUMN v SET DATA TYPE/);
			expect(err.message).to.match(/The schema could not be restored: the failing step `ALTER TABLE t ALTER COLUMN v SET DATA TYPE INTEGER` cannot be undone/);
		});
	});

	describe('an undo statement that itself fails', () => {
		/** A memory module whose `destroy` refuses one table, so the undo of that table's CREATE fails. */
		class RefusingDestroyModule extends MemoryTableModule {
			constructor(private readonly refuse: string) {
				super();
			}
			override async destroy(db: DatabaseType, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
				if (tableName.toLowerCase() === this.refuse) throw new Error(`forced destroy failure for ${tableName}`);
				return super.destroy(db, pAux, moduleName, schemaName, tableName);
			}
		}

		it('stops the unwind and reports both failures, with the original as cause', async () => {
			db.registerModule('refusing', new RefusingDestroyModule('n1'));
			db.setDefaultVtabName('refusing');
			await db.exec(TABLE_T);
			await db.exec("insert into t values (1, 'a')");
			await db.exec(`
				declare schema main {
					${FAILING_T}
					table n1 {
						id INTEGER PRIMARY KEY
					}
				}
			`);

			const err = await rejection(db.exec('apply schema main'));
			expect(err.message).to.match(/^Failed to execute DDL: ALTER TABLE t ADD COLUMN/);
			expect(err.message).to.match(/could not be restored: undo statement `DROP TABLE IF EXISTS n1` failed \(forced destroy failure for n1\)/);
			expect(((err as QuereusError).cause as Error).message).to.match(/NOT NULL constraint failed/);

			// The unwind stopped where it failed: n1 is still there.
			expect(await rows(db, 'select count(*) as n from n1')).to.deep.equal([{ n: 0 }]);
		});
	});

	describe('schema events', () => {
		// Inside an explicit transaction, so a leaked event would be delivered at commit rather
		// than discarded by an autocommit rollback (the same reasoning as
		// ddl-schema-event-atomicity.spec.ts). Both producer paths: the engine's fallback and
		// a module that announces from inside its own create/destroy.
		const BACKENDS: ReadonlyArray<{ name: string; make: () => Database }> = [
			{ name: 'the engine\'s own fallback path', make: () => new Database() },
			{
				name: 'an emitter-backed module',
				make: () => {
					const d = new Database();
					d.registerModule('memory_events', new MemoryTableModule(new DefaultVTableEventEmitter()));
					d.setDefaultVtabName('memory_events');
					return d;
				},
			},
		];

		for (const backend of BACKENDS) {
			describe(`on ${backend.name}`, () => {
				let events: DatabaseSchemaChangeEvent[];
				let unsub: () => void;

				beforeEach(async () => {
					await db.close();
					db = backend.make();
					events = [];
					unsub = db.onSchemaChange(e => events.push(e));
					await db.exec(TABLE_T);
					await db.exec("insert into t values (1, 'a')");
				});

				afterEach(() => unsub());

				it('a restored failure announces nothing at all — not even the undo DDL', async () => {
					await db.exec(`
						declare schema main {
							${FAILING_T}
							table n1 {
								id INTEGER PRIMARY KEY
							}
						}
					`);
					events.length = 0;

					await db.exec('begin');
					await db.exec("insert into t values (2, 'b')");
					await rejection(db.exec('apply schema main'));
					await db.exec('commit');

					expect(events.map(shape)).to.deep.equal([]);
					expect(await rows(db, 'select id from t order by id'), 'the sibling write committed, so this is retraction, not rollback')
						.to.deep.equal([{ id: 1 }, { id: 2 }]);
				});

				it('a restored failure inside a savepoint that is then released still announces nothing', async () => {
					// The apply's events sit in the savepoint layer, not the base batch; the
					// discard walks every layer by stamp, and RELEASE then merges an emptied layer.
					await db.exec(`
						declare schema main {
							${FAILING_T}
							table n1 {
								id INTEGER PRIMARY KEY
							}
						}
					`);
					events.length = 0;

					await db.exec('begin');
					await db.exec('savepoint s');
					await db.exec("insert into t values (2, 'b')");
					await rejection(db.exec('apply schema main'));
					await db.exec('release s');
					await db.exec('commit');

					expect(events.map(shape)).to.deep.equal([]);
					expect(await rows(db, 'select id from t order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
					await rejection(rows(db, 'select * from n1'));
				});

				it('an unrestorable failure keeps the events of the steps that landed', async () => {
					await db.exec('create table old (id integer primary key)');
					await db.exec(`
						declare schema main {
							${FAILING_T}
							table n1 {
								id INTEGER PRIMARY KEY
							}
						}
					`);
					events.length = 0;

					await db.exec('begin');
					await rejection(db.exec('apply schema main'));
					await db.exec('commit');

					// Drops, then creates, then the ALTER that failed and retracted its own.
					expect(events.map(shape)).to.deep.equal(['drop/table/old', 'create/table/n1']);
				});

				it('a successful apply announces what it always did', async () => {
					await db.exec(`
						declare schema main {
							table t {
								id INTEGER PRIMARY KEY,
								v TEXT NULL
							}
							table n1 {
								id INTEGER PRIMARY KEY
							}
						}
					`);
					events.length = 0;

					await db.exec('apply schema main');

					expect(events.map(shape)).to.deep.equal(['create/table/n1']);
				});
			});
		}
	});

	it('an applied-state snapshot an earlier apply recorded survives a restored failure', async () => {
		// The snapshot is a claim that the catalog matched a declaration; a restore that
		// returns the catalog to that state leaves the claim true, so it is neither cleared
		// nor left lying (see docs/schema.md § Applied-state snapshot).
		const SETTLED = `
			declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					v TEXT NULL
				}
			}`;
		await db.exec(TABLE_T);
		await db.exec("insert into t values (1, 'a')");
		await db.exec(SETTLED);
		await db.exec('apply schema main');
		const snapshot = db.declaredSchemaManager.getAppliedSnapshot('main');
		expect(snapshot, 'an empty plan records the snapshot').to.exist;

		await db.exec(`
			declare schema main {
				${FAILING_T}
				table n1 {
					id INTEGER PRIMARY KEY
				}
			}
		`);
		await rejection(db.exec('apply schema main'));

		expect(db.declaredSchemaManager.getAppliedSnapshot('main')).to.deep.equal(snapshot);
		expect(snapshot!.catalogRendering, 'the snapshot still describes the live catalog').to.equal(fingerprint(db));
		await db.exec(SETTLED);
		expect(await planOf(db)).to.deep.equal([]);
	});

	it('under ddl_transaction_policy = strict the refused forward step is unwound like any other failure', async () => {
		await db.exec(TABLE_T);
		await db.exec('create view v as select id from t');
		// DROP VIEW v (not module-dispatching, allowed) then CREATE TABLE n1 — refused under
		// strict inside an explicit transaction, since the memory module is not transactional.
		await db.exec(`
			declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					v TEXT NULL
				}
				table n1 {
					id INTEGER PRIMARY KEY
				}
			}
		`);
		expect(await planOf(db)).to.deep.equal(['DROP VIEW IF EXISTS v', 'create table n1 (id INTEGER primary key)']);
		const before = fingerprint(db);

		await db.exec("pragma ddl_transaction_policy = 'strict'");
		await db.exec('begin');
		const err = await rejection(db.exec('apply schema main'));
		expect(err.message).to.match(/ddl_transaction_policy = strict/);
		expect(err.message).to.not.match(/could not be restored/);
		await db.exec('commit');

		expect(fingerprint(db), 'the view the plan dropped is back').to.equal(before);
		expect(await rows(db, 'select * from v')).to.deep.equal([]);
	});
});
