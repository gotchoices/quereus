/**
 * `apply schema` gives up the thread during a long apply, so timers and interface events can run,
 * and nothing issued during a yield can see or damage a half-applied schema. See
 * docs/schema-declarative.md § Yielding during an apply.
 *
 * Whether a yield happens depends on the time budget, so the hooks here hold the thread past it.
 * That makes every step a yield, with no assertion on elapsed time.
 */

import { expect } from 'chai';
import { Database, MemoryTableModule, type DatabaseSchemaChangeEvent } from '../src/index.js';
import type { Database as DatabaseType } from '../src/core/database.js';
import { collectSchemaCatalog } from '../src/schema/catalog.js';
import { renderCatalogForRestoreCheck } from '../src/schema/catalog-rendering.js';
import type { TableSchema } from '../src/schema/table.js';
import type { SqlValue } from '../src/common/types.js';

/** Longer than the pacer's budget. */
function holdThreadPastBudget(): void {
	const until = Date.now() + 25;
	while (Date.now() < until) { /* busy-wait: this is the stall under test */ }
}

/** Memory tables whose schema hooks hold the thread, optionally failing on one table. */
class SlowHooksModule extends MemoryTableModule {
	readonly created: string[] = [];
	readonly destroyed: string[] = [];

	constructor(private readonly failOn?: string) {
		super();
	}

	override async create(db: DatabaseType, tableSchema: TableSchema) {
		holdThreadPastBudget();
		if (tableSchema.name === this.failOn) throw new Error(`forced create failure for ${tableSchema.name}`);
		this.created.push(tableSchema.name);
		return super.create(db, tableSchema);
	}

	override async destroy(db: DatabaseType, pAux: unknown, moduleName: string, schemaName: string, tableName: string): Promise<void> {
		holdThreadPastBudget();
		this.destroyed.push(tableName);
		return super.destroy(db, pAux, moduleName, schemaName, tableName);
	}
}

/** A declaration of tables n0..n(count-1), then a table named `boom` when `withBoom` is set. */
function declarationOf(count: number, withBoom = false): string {
	const names = Array.from({ length: count }, (_, i) => `n${i}`);
	if (withBoom) names.push('boom');
	return `declare schema main { ${names.map(n => `table ${n} { id INTEGER PRIMARY KEY }`).join(' ')} }`;
}

/** Runs `fn` on a 0 ms timer, which only fires once the apply gives up the thread. */
function onNextTurn<T>(fn: () => T | Promise<T>): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		setTimeout(() => {
			Promise.resolve().then(fn).then(resolve, reject);
		}, 0);
	});
}

/** Records `read()` on every event-loop turn until `work` settles. */
async function sampleEachTurnDuring<T>(work: Promise<unknown>, read: () => T): Promise<T[]> {
	const samples: T[] = [];
	const tick = () => {
		samples.push(read());
		timer = setTimeout(tick, 0);
	};
	let timer = setTimeout(tick, 0);
	try {
		await work;
	} finally {
		clearTimeout(timer);
	}
	return samples;
}

async function rejection(p: Promise<unknown>): Promise<Error> {
	try {
		await p;
	} catch (e) {
		return e as Error;
	}
	throw new Error('expected the statement to reject');
}

async function rows(db: Database, sql: string): Promise<Array<Record<string, SqlValue>>> {
	const out: Array<Record<string, SqlValue>> = [];
	for await (const r of db.eval(sql)) out.push(r);
	return out;
}

function restoreFingerprint(db: Database): string {
	return renderCatalogForRestoreCheck(collectSchemaCatalog(db, 'main'));
}

describe('apply schema gives up the thread during a long apply', () => {
	let db: Database;

	function useModule(module: SlowHooksModule): SlowHooksModule {
		db.registerModule('slow', module);
		db.setDefaultVtabName('slow');
		return module;
	}

	beforeEach(() => {
		db = new Database();
	});

	afterEach(async () => {
		await db.close();
	});

	describe('timers run', () => {
		it('between migration steps', async () => {
			const module = useModule(new SlowHooksModule());
			await db.exec(declarationOf(4));

			const samples = await sampleEachTurnDuring(db.exec('apply schema main'), () => module.created.length);

			expect(samples.some(n => n > 0 && n < 4), `created counts seen: ${samples.join()}`).to.equal(true);
		});

		it('between undo statements', async () => {
			const module = useModule(new SlowHooksModule('boom'));
			await db.exec(declarationOf(4, true));

			const samples = await sampleEachTurnDuring(rejection(db.exec('apply schema main')), () => module.destroyed.length);

			expect(samples.some(n => n > 0 && n < 4), `destroyed counts seen: ${samples.join()}`).to.equal(true);
		});

		it('between seed rows', async () => {
			let checked = 0;
			db.createScalarFunction('hold_thread', { numArgs: 1, deterministic: true }, v => {
				holdThreadPastBudget();
				checked++;
				return v;
			});
			await db.exec(`
				declare schema main {
					table t { id INTEGER PRIMARY KEY, constraint held check (hold_thread(id) = id) }
					seed t ((1), (2), (3), (4))
				}
			`);
			await db.exec('apply schema main');

			const samples = await sampleEachTurnDuring(db.exec('apply schema main with seed'), () => checked);

			expect(samples.some(n => n > 0 && n < 4), `rows checked seen: ${samples.join()}`).to.equal(true);
			expect(await rows(db, 'select count(*) as n from t')).to.deep.equal([{ n: 4 }]);
		});
	});

	describe('what is issued from a timer mid-apply', () => {
		it('a serialized statement runs after the apply and sees the whole catalog', async () => {
			const module = useModule(new SlowHooksModule());
			await db.exec(declarationOf(4));

			let createdWhenIssued = -1;
			const read = onNextTurn(() => {
				createdWhenIssued = module.created.length;
				return rows(db, 'select count(*) as n from n3');
			});
			await db.exec('apply schema main');

			expect(createdWhenIssued, 'issued mid-apply').to.equal(1);
			expect(await read, 'n3 is the last step of the plan').to.deep.equal([{ n: 0 }]);
		});

		it('a committed read does not see a table the failing plan undoes', async () => {
			const module = useModule(new SlowHooksModule('boom'));
			await db.exec(declarationOf(2, true));

			let createdWhenIssued = -1;
			const read = onNextTurn(() => {
				createdWhenIssued = module.created.length;
				return db.get('select count(*) as n from n0', undefined, { readConcurrency: 'committed' });
			});
			await rejection(db.exec('apply schema main'));

			expect(createdWhenIssued, 'issued while n0 was in the catalog').to.equal(1);
			expect((await rejection(read)).message).to.match(/n0.*not found/i);
		});

		it('close() rejects the apply, which creates nothing further and leaves no tables', async () => {
			const module = useModule(new SlowHooksModule());
			await db.exec(declarationOf(4));

			const closed = onNextTurn(() => db.close());
			const err = await rejection(db.exec('apply schema main'));
			await closed;

			expect(err.message).to.match(/Database is closed/);
			expect(err.message).to.match(/could not be restored/);
			expect(module.created.length).to.be.lessThan(4);
			expect([...db.schemaManager.getSchema('main')!.getAllTables()]).to.deep.equal([]);
		});
	});

	it('a step failing after yields restores the catalog and announces no events', async () => {
		useModule(new SlowHooksModule('boom'));
		await db.exec('create table kept (id integer primary key)');
		await db.exec(`declare schema main { table kept { id INTEGER PRIMARY KEY } table n0 { id INTEGER PRIMARY KEY } table n1 { id INTEGER PRIMARY KEY } table boom { id INTEGER PRIMARY KEY } }`);
		const before = restoreFingerprint(db);
		const events: DatabaseSchemaChangeEvent[] = [];
		const unsubscribe = db.onSchemaChange(e => events.push(e));

		// Inside an explicit transaction, so a leaked event would be delivered at commit rather
		// than discarded by an autocommit rollback.
		await db.exec('begin');
		let firedMidApply = false;
		void onNextTurn(() => { firedMidApply = true; });
		const err = await rejection(db.exec('apply schema main'));
		expect(firedMidApply, 'the apply yielded before it failed').to.equal(true);
		await db.exec('commit');
		unsubscribe();

		expect(err.message).to.match(/forced create failure for boom/);
		expect(err.message).to.not.match(/could not be restored/);
		expect(restoreFingerprint(db)).to.equal(before);
		expect(events).to.deep.equal([]);
	});
});
