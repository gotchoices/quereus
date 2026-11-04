/**
 * The optional `VirtualTableModule.alterTags` hook: what the engine hands a module that opted
 * in, what it does with the answer, and what it keeps from the module when the statement
 * cannot apply. The fallback for a module without the hook is pinned by the tag-verb
 * sqllogic coverage and by `alter-table-schema-events.spec.ts`.
 */

import assert from 'node:assert/strict';
import { Database, MemoryTableModule, QuereusError, StatusCode, type DatabaseSchemaChangeEvent, type TagChangeInfo, type TagChangeTarget, type TagEdit } from '../../src/index.js';
import type { Database as DatabaseType } from '../../src/core/database.js';
import type { TableSchema } from '../../src/schema/table.js';

/** A tag the engine's own computation could never produce: its presence proves whose answer was registered. */
const MARKER = { marker: 'from-module' } as const;

interface RecordedCall {
	schemaName: string;
	tableName: string;
	change: TagChangeInfo;
}

/**
 * Answers every tag edit with a schema carrying only {@link MARKER} at the target, and no
 * `statistics`, as a module building its return from its own stored view would. `failWith`
 * makes it refuse instead.
 */
class TagHookModule extends MemoryTableModule {
	readonly calls: RecordedCall[] = [];
	failWith: QuereusError | undefined;

	async alterTags(db: DatabaseType, schemaName: string, tableName: string, change: TagChangeInfo): Promise<TableSchema> {
		this.calls.push({ schemaName, tableName, change });
		if (this.failWith) throw this.failWith;
		const { statistics: _statistics, ...live } = db.schemaManager.getTable(schemaName, tableName)!;
		return withMarker(live, change);
	}
}

function withMarker(live: TableSchema, { target }: TagChangeInfo): TableSchema {
	switch (target.kind) {
		case 'table':
			return { ...live, tags: MARKER };
		case 'column':
			return { ...live, columns: Object.freeze(live.columns.map(c => (c.name === target.columnName ? { ...c, tags: MARKER } : c))) };
		case 'constraint':
			return { ...live, uniqueConstraints: Object.freeze(live.uniqueConstraints!.map(c => (c.name === target.constraintName ? { ...c, tags: MARKER } : c))) };
	}
}

async function rows(db: Database, sql: string): Promise<Record<string, unknown>[]> {
	const out: Record<string, unknown>[] = [];
	for await (const row of db.eval(sql)) out.push(row);
	return out;
}

async function failure(db: Database, sql: string): Promise<QuereusError> {
	try {
		await db.exec(sql);
	} catch (e) {
		if (e instanceof QuereusError) return e;
		throw e;
	}
	assert.fail(`expected to fail: ${sql}`);
}

describe('VirtualTableModule.alterTags', () => {
	let db: Database;
	let module: TagHookModule;

	beforeEach(async () => {
		db = new Database();
		module = new TagHookModule();
		db.registerModule('hooked', module);
		await db.exec(`
			create table t (
				id integer primary key,
				v text null with tags (unit = 'ms'),
				e text null,
				constraint uq_e unique (e) with tags (msg = 'dup')
			) using hooked with tags (owner = 'a')
		`);
	});

	afterEach(async () => {
		await db.close();
	});

	/** The tags of the statement's target as the introspection functions report them. */
	async function reportedTags(kind: TagChangeTarget['kind']): Promise<string | null> {
		const query = kind === 'table' ? "select tags from schema() where type = 'table' and name = 't'"
			: kind === 'column' ? "select tags from table_info('t') where name = 'v'"
			: "select tags from unique_constraint_info('t') where name = 'uq_e'";
		return (await rows(db, query))[0].tags as string | null;
	}

	describe('receives the statement as written and registers the answer', () => {
		const COLUMN = { kind: 'column', columnName: 'v' } as const;
		const CONSTRAINT = { kind: 'constraint', constraintName: 'uq_e' } as const;
		const TABLE = { kind: 'table' } as const;
		// The statements spell the column and constraint in upper case, so what the module is
		// handed is the stored spelling and not the statement's. Tag keys stay verbatim.
		const cases: { sql: string; target: TagChangeTarget; edit: TagEdit }[] = [
			{ sql: "alter table t set tags (k = 'x')", target: TABLE, edit: { mode: 'replace', tags: { k: 'x' } } },
			{ sql: 'alter table t add tags (k = null)', target: TABLE, edit: { mode: 'merge', tags: { k: null } } },
			{ sql: 'alter table t drop tags (owner)', target: TABLE, edit: { mode: 'drop', keys: ['owner'] } },
			{ sql: "alter table t alter column V set tags (k = 'x')", target: COLUMN, edit: { mode: 'replace', tags: { k: 'x' } } },
			{ sql: "alter table t alter column V add tags (K = 'x')", target: COLUMN, edit: { mode: 'merge', tags: { K: 'x' } } },
			{ sql: 'alter table t alter column V drop tags (unit)', target: COLUMN, edit: { mode: 'drop', keys: ['unit'] } },
			{ sql: "alter table t alter constraint UQ_E set tags (k = 'x')", target: CONSTRAINT, edit: { mode: 'replace', tags: { k: 'x' } } },
			{ sql: "alter table t alter constraint UQ_E add tags (k = 'x')", target: CONSTRAINT, edit: { mode: 'merge', tags: { k: 'x' } } },
			{ sql: 'alter table t alter constraint UQ_E drop tags (msg)', target: CONSTRAINT, edit: { mode: 'drop', keys: ['msg'] } },
		];

		for (const { sql, target, edit } of cases) {
			it(sql, async () => {
				await db.exec(sql);

				assert.deepEqual(module.calls, [{ schemaName: 'main', tableName: 't', change: { target, ...edit, ddl: sql } }]);
				assert.equal(await reportedTags(target.kind), JSON.stringify(MARKER));
			});
		}
	});

	it('a refusal fails the statement with the module\'s error and changes nothing', async () => {
		module.failWith = new QuereusError('storage meaning cannot change', StatusCode.CONSTRAINT);
		const before = db.schemaManager.getTable('main', 't');
		const modified: string[] = [];
		const unsubscribe = db.schemaManager.getChangeNotifier().addListener(e => { modified.push(e.type); });
		try {
			const error = await failure(db, "alter table t alter column v set tags (k = 'x')");

			assert.equal(error.code, StatusCode.CONSTRAINT);
			assert.match(error.message, /storage meaning cannot change/);
			assert.equal(db.schemaManager.getTable('main', 't'), before);
			assert.deepEqual(modified, []);
		} finally {
			unsubscribe();
		}
	});

	describe('validates before asking the module', () => {
		for (const sql of [
			"alter table t alter column nope set tags (k = 'x')",
			"alter table t alter constraint nope add tags (k = 'x')",
			'alter table t drop tags (absent)',
			'alter table t alter column v drop tags (unit, absent)',
		]) {
			it(`NOTFOUND with no call: ${sql}`, async () => {
				assert.equal((await failure(db, sql)).code, StatusCode.NOTFOUND);
				assert.deepEqual(module.calls, []);
			});
		}

		it('an empty ADD or DROP has nothing to ask about, but still resolves its target', async () => {
			await db.exec('alter table t add tags ()');
			await db.exec('alter table t drop tags ()');
			assert.deepEqual(module.calls, []);
			assert.equal((await failure(db, 'alter table t alter column nope add tags ()')).code, StatusCode.NOTFOUND);
		});

		it('an empty SET is a real clear, so it does ask', async () => {
			await db.exec('alter table t set tags ()');
			assert.equal(module.calls.length, 1);
			assert.deepEqual(module.calls[0].change, { target: { kind: 'table' }, mode: 'replace', tags: {}, ddl: 'alter table t set tags ()' });
		});
	});

	it('keeps ANALYZE statistics when the answer omits them', async () => {
		await db.exec("insert into t values (1, 'a', 'x'), (2, 'b', 'y')");
		await db.exec('analyze t');
		const measured = db.schemaManager.getTable('main', 't')!.statistics;
		assert.ok(measured, 'analyze recorded statistics');

		await db.exec("alter table t set tags (k = 'x')");

		assert.deepEqual(db.schemaManager.getTable('main', 't')!.statistics, measured);
	});

	describe('announces through the auto-event gate when the module has no emitter', () => {
		let events: DatabaseSchemaChangeEvent[];
		let unsubscribe: () => void;

		beforeEach(() => {
			events = [];
			unsubscribe = db.onSchemaChange(e => events.push(e));
		});

		afterEach(() => unsubscribe());

		it('alter/column for a column target', async () => {
			await db.exec("alter table t alter column v set tags (k = 'x')");
			assert.deepEqual(
				events.map(e => [e.type, e.objectType, e.objectName, e.columnName, e.ddl]),
				[['alter', 'column', 't', 'v', "alter table t alter column v set tags (k = 'x')"]],
			);
		});

		it('alter/table for a constraint target', async () => {
			await db.exec("alter table t alter constraint uq_e set tags (k = 'x')");
			assert.deepEqual(
				events.map(e => [e.type, e.objectType, e.objectName, e.columnName, e.ddl]),
				[['alter', 'table', 't', undefined, "alter table t alter constraint uq_e set tags (k = 'x')"]],
			);
		});
	});
});
