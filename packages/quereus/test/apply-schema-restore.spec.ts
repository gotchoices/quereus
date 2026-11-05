/**
 * `apply schema` is all-or-nothing: a migration that fails partway is unwound through the
 * plan's undo journal (`MigrationStep.undo`, see docs/schema-undo-plan.md) and the catalog is
 * verified back at its pre-apply state before the step's own error is rethrown. The stated
 * residual is a data-destroying step (`DROP TABLE`, `DROP COLUMN`, `SET DATA TYPE`): once one
 * has run the apply cannot be taken back, and a later failure reports the schema as partially
 * migrated. See docs/schema-declarative.md § Failure and restoration; the executor is
 * `runBatchedMigrationLoop` in `runtime/emit/schema-declarative.ts`.
 *
 * The cross-backend half of this contract — constraint tightening against a violating row on
 * both the memory and the store backend — lives in
 * `test/logic/50.4-declare-schema-apply-restore.sqllogic`. This spec covers what the sqllogic
 * runner cannot reach: the catalog fingerprint, the schema-event channel, the shape of the
 * error, a module whose undo fails, the strict DDL-transaction policy, and the primary-key
 * rebuild the journal cannot restore rows for, which is refused instead.
 */

import { expect } from 'chai';
import { Database, DefaultVTableEventEmitter, MemoryTableModule, type DatabaseSchemaChangeEvent } from '../src/index.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import { QuereusError } from '../src/common/errors.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { renderCatalogForComparison, renderCatalogForRestoreCheck } from '../src/schema/catalog-rendering.js';
import { StatusCode, type SqlValue } from '../src/common/types.js';
import type { AnyVirtualTableModule } from '../src/vtab/module.js';
import { makeNoAlterModule } from './no-alter-module.js';

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

		it('unnamed CHECK: the old rule is back under its stored auto-name', async () => {
			// An unnamed constraint is matched by body, so a body edit is a DROP of the stored
			// `_check_v` + an ADD; the DROP's undo must find it among the unnamed constraints.
			await db.exec('create table t (id integer primary key, v integer check (v > 0))');
			await db.exec('insert into t values (1, 5)');
			await db.exec(`
				declare schema main {
					table t { id INTEGER PRIMARY KEY, v INTEGER check (v > 10) }
				}
			`);
			expect(await planOf(db)).to.deep.equal([
				'ALTER TABLE t DROP CONSTRAINT _check_v',
				'ALTER TABLE t ADD constraint _check_v check (v > 10)',
			]);
			const before = restoreFingerprint(db);

			const err = await rejection(db.exec('apply schema main'));
			expect(err.message, 'a verified restore rethrows the step error unchanged').to.not.match(/could not be restored/);

			expect(restoreFingerprint(db)).to.equal(before);
			const t = collectSchemaCatalog(db, 'main').tables.find(x => x.name === 't')!;
			expect(t.unnamedConstraints.map(c => `${c.name} ${c.definition}`)).to.deep.equal(['_check_v check (v > 0)']);
			await rejection(db.exec('insert into t values (2, -1)'));
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

	it('a UNIQUE the stored rows no longer satisfy is restored, and its covering index is rebuilt', async () => {
		// Redefining the collation is the way through the public API to make rows collide
		// without touching them, so the plan cannot have changed what the undo's scan reads.
		db.registerCollation('FOLD', (a, b) => (a < b ? -1 : a > b ? 1 : 0));
		await db.exec('create table t (id integer primary key, b integer null)');
		await db.exec('insert into t values (1, 1), (2, 1)');
		await db.exec('create table e (id integer primary key, x text collate FOLD null, constraint c unique (x))');
		await db.exec("insert into e values (1, 'a'), (2, 'A')");
		db.registerCollation('FOLD', (a, b) => {
			const [x, y] = [a.toLowerCase(), b.toLowerCase()];
			return x < y ? -1 : x > y ? 1 : 0;
		});
		await db.exec(`
			declare schema main {
				table t {
					id INTEGER PRIMARY KEY,
					b INTEGER NULL,
					constraint ub unique (b)
				}
				table e {
					id INTEGER PRIMARY KEY,
					x TEXT COLLATE FOLD NULL
				}
			}
		`);
		const before = restoreFingerprint(db);

		const err = await rejection(db.exec('apply schema main'));
		expect(err.message).to.match(/ub|UNIQUE/);
		expect(err.message, 'a verified restore rethrows the step error unchanged').to.not.match(/could not be restored/);

		expect(restoreFingerprint(db)).to.equal(before);
		expect(await rows(db, 'select id from e order by id')).to.deep.equal([{ id: 1 }, { id: 2 }]);
		await db.exec("insert into e values (3, 'b')");
		const duplicate = await rejection(db.exec("insert into e values (4, 'B')"));
		expect(duplicate.message).to.match(/UNIQUE constraint failed/);
	});

	describe('a multi-step migration', () => {
		beforeEach(async () => {
			await db.exec(TABLE_T);
			await db.exec("insert into t values (1, 'a')");
			// create table n1, the failing ALTER TABLE t ADD COLUMN, then (never reached) create index ix_v.
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

	describe('views built on other views', () => {
		const NEW_T = 'table T { Id INTEGER PRIMARY KEY, N INTEGER, At TEXT NULL }';

		/** `add column` fails on a module with no `alterTable`, so the step after the view drops fails. */
		async function startOnNoAlterModule(...views: string[]): Promise<void> {
			db.registerModule('noalter', makeNoAlterModule());
			db.setDefaultVtabName('noalter');
			await db.exec('create table T (Id integer primary key, N integer)');
			await db.exec('insert into T values (1, 2)');
			for (const view of views) await db.exec(view);
		}

		async function expectStepErrorAndRestore(): Promise<void> {
			const before = fingerprint(db);
			const err = await rejection(db.exec('apply schema main'));
			expect(err.message).to.match(/^Failed to execute DDL: ALTER TABLE T ADD COLUMN/);
			expect(err.message).to.not.match(/could not be restored/);
			expect(fingerprint(db)).to.equal(before);
		}

		it('restores a chain of views both redefined, written in the order they read each other', async () => {
			await startOnNoAlterModule(
				'create view V1 as select sum(N) as S from T',
				'create view V2 as select S * 2 as D from V1',
			);
			await db.exec(`declare schema main {
				${NEW_T}
				view V1 as select sum(N) + 1 as S from T
				view V2 as select S * 3 as D from V1
			}`);

			await expectStepErrorAndRestore();
			expect(await rows(db, 'select D from V2')).to.deep.equal([{ D: 4 }]);
		});

		it('restores a chain through a view the plan leaves alone', async () => {
			await startOnNoAlterModule(
				'create view V1 as select sum(N) as S from T',
				'create view M as select S from V1',
				'create view V3 as select S as D from M',
			);
			await db.exec(`declare schema main {
				${NEW_T}
				view V1 as select sum(N) + 1 as S from T
				view M as select S from V1
				view V3 as select S * 3 as D from M
			}`);

			await expectStepErrorAndRestore();
			expect(await rows(db, 'select D from V3')).to.deep.equal([{ D: 2 }]);
		});

		it('creates a view after a new view it reads through a view the plan leaves alone, whichever is written first', async () => {
			await db.exec('create table T (Id integer primary key, N integer)');
			await db.exec('insert into T values (1, 2)');
			await db.exec('create view V1 as select sum(N) as S from T');
			await db.exec('create view M as select S from V1');
			await db.exec('create view V3 as select S as D from M');
			await db.exec(`declare schema main {
				table T { Id INTEGER PRIMARY KEY, N INTEGER }
				view V3 as select S * 3 as D from M
				view M as select S from V1
				view V1 as select sum(N) + 1 as S from T
			}`);

			await db.exec('apply schema main');

			expect(await planOf(db)).to.deep.equal([]);
			expect(await rows(db, 'select D from V3')).to.deep.equal([{ D: 9 }]);
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
		// nor left lying (see docs/schema-declarative.md § Applied-state snapshot).
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

	describe('a primary-key rebuild that is not the only effect of the apply', () => {
		const REKEYABLE = { withRenameTable: true };
		const WORKAROUND = /alter table t alter primary key \(\.\.\.\)` on its own/;
		/** The key moved from `a` to `c`. `extras` adds the rest of the plan. */
		const rekeyedT = (extras = '') => `table t { a INTEGER, c INTEGER, b INTEGER, primary key (c) ${extras} }`;

		async function startOn(module: AnyVirtualTableModule): Promise<void> {
			db.registerModule('stub', module);
			db.setDefaultVtabName('stub');
			await db.exec('create table t (a integer, c integer, b integer, primary key (a))');
			await db.exec('insert into t values (1, 10, 1), (2, 20, 1)');
		}

		async function expectAllRows(): Promise<void> {
			expect(await rows(db, 'select a, c, b from t order by a')).to.deep.equal([{ a: 1, c: 10, b: 1 }, { a: 2, c: 20, b: 1 }]);
		}

		/** Asserts `apply` is refused with the workaround and leaves the catalog, the key included, and the rows alone. */
		async function expectRefused(apply = 'apply schema main'): Promise<Error> {
			const before = fingerprint(db);
			const err = await rejection(db.exec(apply));
			expect(err.message).to.match(WORKAROUND);
			expect(err.message, 'a refusal leaves nothing to report as partially migrated').to.not.match(/could not be restored/);
			expect(fingerprint(db)).to.equal(before);
			await expectAllRows();
			return err;
		}

		it('a hookless module: the refusal names the workaround, and following it succeeds', async () => {
			await startOn(makeNoAlterModule(REKEYABLE));
			// Without the refusal, the rebuild commits and the ADD then fails on b = 1, past undoing.
			await db.exec(`declare schema main { ${rekeyedT(', constraint ck check (b > 1)')} }`);
			expect(await planOf(db)).to.have.length(2);

			const err = await expectRefused();
			expect((err as QuereusError).code).to.equal(StatusCode.ERROR);
			expect(err.message).to.contain("module 'stub'");

			await db.exec('alter table t alter primary key (c)');
			await expectAllRows();
			expect(await planOf(db), 'no key change is left to plan').to.deep.equal(['ALTER TABLE t ADD constraint ck check (b > 1)']);
			await db.exec('update t set b = 2');
			await db.exec('apply schema main');
			expect(await planOf(db)).to.deep.equal([]);
			expect(await rows(db, 'select a from t order by a')).to.deep.equal([{ a: 1 }, { a: 2 }]);
		});

		it('refuses before any step runs, so a table the plan drops first survives', async () => {
			await startOn(makeNoAlterModule(REKEYABLE));
			await db.exec('create table old (id integer primary key)');
			await db.exec('insert into old values (1)');
			await db.exec(`declare schema main { ${rekeyedT()} }`);
			expect(await planOf(db)).to.deep.equal(['DROP TABLE IF EXISTS old', 'ALTER TABLE t ALTER PRIMARY KEY (c)']);

			await expectRefused();
			expect(await rows(db, 'select id from old')).to.deep.equal([{ id: 1 }]);
		});

		it('finds a table the plan renames under its live name, before any step runs', async () => {
			await startOn(makeNoAlterModule(REKEYABLE));
			await db.exec('create table old (id integer primary key)');
			await db.exec(`declare schema main {
				table renamed { a INTEGER, c INTEGER, b INTEGER, primary key (c) } with tags ("quereus.previous_name" = 't')
			}`);
			expect(await planOf(db)).to.deep.equal([
				'ALTER TABLE t RENAME TO renamed',
				'DROP TABLE IF EXISTS old',
				'ALTER TABLE renamed ALTER PRIMARY KEY (c)',
			]);

			await expectRefused();
			expect(await rows(db, 'select count(*) as n from old')).to.deep.equal([{ n: 0 }]);
		});

		it('a hook that declines: refused at the rebuild, with the earlier step unwound', async () => {
			await startOn(makeNoAlterModule({ ...REKEYABLE, declineAlterPrimaryKey: true }));
			await db.exec(`declare schema main { ${rekeyedT()} table n1 { id INTEGER PRIMARY KEY } }`);
			expect(await planOf(db)).to.deep.equal(['create table n1 (id INTEGER primary key)', 'ALTER TABLE t ALTER PRIMARY KEY (c)']);

			const err = await expectRefused();
			expect(err.message).to.match(/^Failed to execute DDL: ALTER TABLE t ALTER PRIMARY KEY/);
			await rejection(rows(db, 'select * from n1'));
		});

		it('a one-step plan is refused when a registered module could refuse the commit', async () => {
			await startOn(makeNoAlterModule(REKEYABLE));
			db.registerModule('refuses_commit', {
				...makeNoAlterModule(),
				beginSchemaBatch: async () => {},
				endSchemaBatch: async () => { throw new Error('forced commit refusal'); },
			});
			await db.exec(`declare schema main { ${rekeyedT()} }`);
			expect(await planOf(db)).to.have.length(1);

			await expectRefused();
		});

		it('a one-step plan is refused when seed rows would follow it', async () => {
			await startOn(makeNoAlterModule(REKEYABLE));
			await db.exec(`declare schema main { ${rekeyedT()} seed t ((3, 30, 3)) }`);
			expect(await planOf(db)).to.have.length(1);

			await expectRefused('apply schema main with seed');
		});

		it('a module that can never rebuild gets that answer rather than a workaround that cannot work', async () => {
			await startOn(makeNoAlterModule());
			await db.exec(`declare schema main { ${rekeyedT()} table n1 { id INTEGER PRIMARY KEY } }`);

			const err = await rejection(db.exec('apply schema main'));
			expect(err.message).to.match(/does not support ALTER PRIMARY KEY/);
			await rejection(rows(db, 'select * from n1'));
		});

		it('a one-step plan with nothing following it still rebuilds and keeps its rows', async () => {
			await startOn(makeNoAlterModule(REKEYABLE));
			await db.exec(`declare schema main { ${rekeyedT()} }`);
			expect(await planOf(db)).to.have.length(1);

			// `with seed` and no seed rows declared: nothing will be seeded, so this still qualifies.
			await db.exec('apply schema main with seed');

			await expectAllRows();
			expect(await planOf(db), 'the key did change').to.deep.equal([]);
		});

		it('a one-step plan over a foreign key orphan still rebuilds and keeps its rows', async () => {
			db.registerModule('stub', makeNoAlterModule(REKEYABLE));
			db.setDefaultVtabName('stub');
			const fk = 'constraint fk foreign key (b) references p(id) deferrable initially deferred';
			await db.exec(`create table p (id integer primary key)`);
			await db.exec(`create table t (a integer, c integer, b integer, primary key (a), ${fk})`);
			await db.exec('pragma foreign_keys = false');
			await db.exec('insert into t values (1, 10, 1), (2, 20, 1)');
			await db.exec('pragma foreign_keys = true');
			await db.exec(`declare schema main { table p { id INTEGER PRIMARY KEY } ${rekeyedT(`, ${fk}`)} }`);
			expect(await planOf(db)).to.have.length(1);

			await db.exec('apply schema main');

			await expectAllRows();
			expect(await planOf(db), 'the key did change').to.deep.equal([]);
		});
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
