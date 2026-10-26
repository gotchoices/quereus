import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTable } from '../../src/vtab/memory/table.js';
import type { TableSchema } from '../../src/schema/table.js';
import type { MemoryTableConfig } from '../../src/vtab/memory/types.js';
import type { UpdateArgs } from '../../src/vtab/table.js';
import type { RowOp } from '../../src/common/types.js';
import type { TableWrite } from '../../src/planner/analysis/write-scope.js';

interface CapturedWrite {
	readonly table: string;
	readonly operation: RowOp;
	readonly writeScope: TableWrite | undefined;
}

/**
 * Memory module whose tables opt in to `wantWriteScope` (unless constructed with
 * `optIn = false`) and record the `writeScope` of every `update()` call. Built on the
 * memory module rather than a bare `VirtualTable` so the upsert path sees a real
 * conflict report.
 */
class CaptureModule extends MemoryTableModule {
	readonly writes: CapturedWrite[] = [];

	constructor(private readonly optIn: boolean) {
		super();
	}

	private instrument(table: MemoryTable): MemoryTable {
		table.wantWriteScope = this.optIn;
		const original = table.update.bind(table);
		table.update = (args: UpdateArgs) => {
			this.writes.push({ table: table.tableName.toLowerCase(), operation: args.operation, writeScope: args.writeScope });
			return original(args);
		};
		return table;
	}

	override async create(db: Database, tableSchema: TableSchema): Promise<MemoryTable> {
		return this.instrument(await super.create(db, tableSchema));
	}

	override async connect(
		db: Database,
		pAux: unknown,
		moduleName: string,
		schemaName: string,
		tableName: string,
		options: MemoryTableConfig,
		tableSchema?: TableSchema,
	): Promise<MemoryTable> {
		return this.instrument(await super.connect(db, pAux, moduleName, schemaName, tableName, options, tableSchema));
	}
}

describe('UpdateArgs.writeScope (module write-scope hook)', () => {
	let db: Database;
	let module: CaptureModule;

	async function setup(optIn: boolean): Promise<void> {
		db = new Database();
		module = new CaptureModule(optIn);
		db.registerModule('capture', module);
		await db.exec('create table t (id integer primary key, v integer null) using capture()');
		module.writes.length = 0;
	}

	afterEach(async () => {
		await db.close();
	});

	it('is absent when the table does not opt in', async () => {
		await setup(false);
		await db.exec('insert into t values (1, 10)');
		expect(module.writes).to.have.length(1);
		expect(module.writes[0].writeScope).to.equal(undefined);
	});

	it('hands every row of one execution the same description', async () => {
		await setup(true);
		await db.exec('insert into t values (1, 10), (2, 20)');
		expect(module.writes).to.have.length(2);
		const [first, second] = module.writes;
		expect(first.writeScope?.operation).to.equal('insert');
		expect(first.writeScope?.table).to.deep.equal({ schema: 'main', table: 't' });
		expect(second.writeScope).to.equal(first.writeScope);
	});

	it('binds the parameters of a prepared statement', async () => {
		await setup(true);
		await db.exec('insert into t values (7, 0)');
		module.writes.length = 0;
		const stmt = db.prepare('update t set v = :v where id = :id');
		await stmt.run({ ':v': 5, ':id': 7 });
		await stmt.finalize();
		expect(module.writes).to.have.length(1);
		expect(module.writes[0].writeScope?.selection).to.deep.equal({ kind: 'rows', key: ['id'], values: [[7]] });
	});

	it('describes a write run through db.exec, with its parameters bound', async () => {
		await setup(true);
		await db.exec('insert into t values (3, 0)');
		module.writes.length = 0;
		await db.exec('delete from t where id = ?', [3]);
		expect(module.writes).to.have.length(1);
		expect(module.writes[0].writeScope?.operation).to.equal('delete');
		expect(module.writes[0].writeScope?.selection).to.deep.equal({ kind: 'rows', key: ['id'], values: [[3]] });
	});

	it('hands the DO UPDATE arm of an upsert the INSERT\'s description', async () => {
		await setup(true);
		await db.exec('insert into t values (1, 10)');
		module.writes.length = 0;
		await db.exec('insert into t values (1, 99) on conflict (id) do update set v = new.v');
		// The insert attempt, then the arm's update on the conflicting row.
		expect(module.writes.map(w => w.operation)).to.deep.equal(['insert', 'update']);
		const [attempt, arm] = module.writes;
		expect(arm.writeScope).to.equal(attempt.writeScope);
		expect(arm.writeScope?.disposition.kind).to.equal('upsert');
	});

	it('withholds the description from an FK cascade child write', async () => {
		await setup(true);
		await db.exec('create table c (id integer primary key, pid integer null references t(id) on delete cascade) using capture()');
		await db.exec('insert into t values (1, 0)');
		await db.exec('insert into c values (10, 1)');
		module.writes.length = 0;
		await db.exec('delete from t where id = 1');
		const parent = module.writes.find(w => w.table === 't');
		const child = module.writes.find(w => w.table === 'c');
		expect(parent?.writeScope?.operation).to.equal('delete');
		expect(child?.operation).to.equal('delete');
		expect(child?.writeScope).to.equal(undefined);
	});
});
