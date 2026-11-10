/**
 * Regression: a frozen layer — an eager savepoint snapshot (`MemoryTableConnection.createSavepoint`)
 * or a newly committed head — used to leave its B-trees linked to their inheritree base, and the
 * next pending layer's trees were built over them. So the base chain grew one link per statement
 * inside a transaction (each DML statement opens a statement savepoint), one link per row under
 * `insert or fail` (a savepoint per row), and one link per autocommit statement. inheritree walks
 * that chain recursively on every tree access, so cost grew quadratically and past roughly 15,600
 * links the walk overflowed the stack. An in-transaction ALTER or CREATE INDEX, which rebuilds open
 * layers' trees over their parents', relinked the chain the same way.
 *
 * These cases assert the invariant directly — no tree a connection reads or writes is more than one
 * base link deep — at sizes far below the overflow, so they neither cost seconds nor depend on the
 * stack size.
 *
 * The layer-level parent chain had the same shape: each committed head kept the one before it (and
 * the statement savepoints below that) as its parent, so a table retained one layer per write
 * statement it had ever run. The last case pins that a published head's chain stays head → base.
 */
import { expect } from 'chai';
import { Database } from '../../src/core/database.js';
import { MemoryTableModule } from '../../src/vtab/memory/module.js';
import type { MemoryTableManager } from '../../src/vtab/memory/layer/manager.js';
import type { MemoryTableConnection } from '../../src/vtab/memory/layer/connection.js';
import type { Layer } from '../../src/vtab/memory/layer/interface.js';

/** The private member these cases read, named rather than cast to `any`. */
type ManagerInternals = { connections: Map<number, MemoryTableConnection> };

/** inheritree's `BTree.base`, private in its typings. */
type Linked = { base?: Linked };

/** Number of inheritree base links below `tree`. */
function baseLinks(tree: object | null): number {
	let links = 0;
	for (let t = (tree as Linked | null)?.base; t; t = t.base) links++;
	return links;
}

/** Number of layers in `layer`'s parent chain, `layer` and the base included. */
function layerChainLength(layer: Layer): number {
	let length = 0;
	for (let cur: Layer | null = layer; cur; cur = cur.getParent()) length++;
	return length;
}

/** Deepest base chain among `layer`'s primary tree and the named secondary-index trees. */
function deepestChain(layer: Layer, indexNames: readonly string[]): number {
	return Math.max(
		baseLinks(layer.getModificationTree('primary')),
		...indexNames.map(name => baseLinks(layer.getSecondaryIndexTree(name))),
	);
}

describe('frozen memory-table layers keep the B-tree chain shallow', () => {
	let db: Database;
	let manager: MemoryTableManager;

	beforeEach(async () => {
		db = new Database();
		await db.exec('create table big (id integer primary key, v text)');
		await db.exec('create index big_v on big(v)');
		const module = db.schemaManager.getModule('memory')!.module as MemoryTableModule;
		manager = module.tables.get('main.big')!;
	});

	afterEach(async () => {
		await db.close();
	});

	/** Deepest chain across every layer the table's connections read or write. */
	function deepestConnectionChain(indexNames: readonly string[]): number {
		const connections = [...(manager as unknown as ManagerInternals).connections.values()];
		expect(connections, 'table has an open connection').to.not.be.empty;
		return Math.max(...connections.flatMap(conn => [conn.readLayer, conn.pendingTransactionLayer]
			.filter((layer): layer is NonNullable<typeof layer> => layer !== null)
			.map(layer => deepestChain(layer, indexNames))));
	}

	async function insertRange(from: number, to: number): Promise<void> {
		const insert = db.prepare('insert into big values (?, ?)');
		for (let i = from; i <= to; i++) await insert.run([i, `v${i}`]);
		await insert.finalize();
	}

	it('keeps statement savepoints, rollback to one, and in-transaction DDL one link deep', async () => {
		await db.exec('begin');
		await insertRange(1, 40);
		await db.exec('savepoint sp');
		await insertRange(41, 60);
		expect(deepestConnectionChain(['big_v']), 'after 60 statements').to.be.at.most(1);

		await db.exec('rollback to sp');
		expect((await db.get('select count(*) as n from big'))?.n).to.equal(40);

		// Both rebuild every open layer's trees over its parent's: the column add all of them,
		// the index build the new index's.
		await db.exec('alter table big add column w integer default 7');
		expect(deepestConnectionChain(['big_v']), 'after add column').to.be.at.most(1);
		await db.exec('create index big_vw on big(v, w)');
		expect(deepestConnectionChain(['big_v', 'big_vw']), 'after create index').to.be.at.most(1);
		await db.exec('commit');

		expect(await db.get('select count(*) as n, sum(id) as s, sum(w) as sw from big'))
			.to.deep.equal({ n: 40, s: 820, sw: 280 });
		expect((await db.get("select id from big where v = 'v14' and w = 7"))?.id).to.equal(14);
		expect(await db.get("select id from big where v = 'v50'")).to.equal(undefined);
	});

	it('keeps the per-row savepoints of an insert or fail one link deep', async () => {
		await db.exec('begin');
		await db.exec("insert or fail into big select value, 'v' || value from generate_series(1, 50)");
		expect(deepestConnectionChain(['big_v'])).to.be.at.most(1);
		await db.exec('commit');
		expect((await db.get('select count(*) as n from big'))?.n).to.equal(50);
	});

	it('keeps the committed head one link deep across autocommit statements', async () => {
		await insertRange(1, 40);
		expect(deepestChain(manager.currentCommittedLayer, ['big_v'])).to.be.at.most(1);
	});

	it('releases the layers below each committed head', async () => {
		await insertRange(1, 30);
		expect(layerChainLength(manager.currentCommittedLayer), 'after 30 autocommit statements').to.equal(2);

		await db.exec('begin');
		await insertRange(31, 60);
		await db.exec('commit');
		expect(layerChainLength(manager.currentCommittedLayer), 'after a 30-statement transaction').to.equal(2);
		expect(await db.get('select count(*) as n, sum(id) as s from big')).to.deep.equal({ n: 60, s: 1830 });
	});
});
